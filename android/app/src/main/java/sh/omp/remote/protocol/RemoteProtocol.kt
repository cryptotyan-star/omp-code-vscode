package sh.omp.remote.protocol

import java.math.BigInteger
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

const val REMOTE_PROTOCOL_VERSION = 1
const val MAX_JSON_FRAME_BYTES = 256 * 1024
const val MAX_ATTACHMENT_BYTES = 20L * 1024L * 1024L
const val MAX_ATTACHMENT_CHUNK_BYTES = 256 * 1024
/** Operational sender size leaves relay-envelope headroom under a 256 KiB opaque-frame deployment cap. */
const val MAX_ATTACHMENT_SEND_CHUNK_BYTES = 240 * 1024

@Serializable
data class HostEvent(
    val protocolVersion: Int,
    val type: String,
    val hostGeneration: String,
    val sequence: String,
    val sessionId: String,
    val eventId: String,
    val event: String,
    val payload: JsonObject = JsonObject(emptyMap()),
)

/** Exact command wire shape frozen in desktop `src/remoteProtocol.ts`. */
@Serializable
data class RemoteCommand(
    val protocolVersion: Int = REMOTE_PROTOCOL_VERSION,
    val type: String = "command",
    val commandId: String,
    val commandCounter: String,
    val hostGeneration: String,
    val sessionId: String? = null,
    val command: String,
    val payload: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class CommandAck(
    val protocolVersion: Int,
    val commandId: String,
    val status: AckStatus,
    val errorCode: String? = null,
)

@Serializable
enum class AckStatus { ACCEPTED, COMPLETED, REJECTED, ERROR, INDETERMINATE }

@Serializable
data class CapabilityManifest(
    val protocolVersion: Int,
    val manifestId: String,
    val deviceId: String,
    val keyEpoch: Long,
    val issuedAt: Long,
    val expiresAt: Long,
    val verbs: List<String>,
    val sessionIds: List<String>,
    val workspaceRoots: List<String>,
    val allSessions: Boolean,
)

fun validateCapabilityWindow(
    manifest: CapabilityManifest,
    nowEpochMillis: Long = System.currentTimeMillis(),
    clockSkewMillis: Long = 2 * 60 * 1000L,
) {
    require(clockSkewMillis in 0..10 * 60 * 1000L)
    require(manifest.issuedAt <= nowEpochMillis + clockSkewMillis) { "Capability was issued in the future; check phone time" }
    require(manifest.expiresAt > nowEpochMillis - clockSkewMillis) { "Capability expired; pair this phone again" }
}

enum class ApplyResult { APPLIED, DUPLICATE, GAP_REQUIRES_FULL_SYNC, GENERATION_REQUIRES_FULL_SYNC }

class ProtocolReducer {
    var hostGeneration: String? = null
        private set
    var lastAppliedSequence: BigInteger = BigInteger.ZERO
        private set

    fun beginFullSync(generation: String, sequence: String) {
        requireIdentifier(generation, "host generation")
        lastAppliedSequence = parseUint64Decimal(sequence)
        hostGeneration = generation
    }

    fun apply(event: HostEvent): ApplyResult {
        require(event.protocolVersion == REMOTE_PROTOCOL_VERSION) { "Unsupported protocol version" }
        require(event.type == "event") { "Host message type must be event" }
        val sequence = parseUint64Decimal(event.sequence)
        require(sequence > BigInteger.ZERO) { "Invalid event sequence" }
        requireIdentifier(event.hostGeneration, "host generation")
        requireIdentifier(event.sessionId, "session id")
        requireIdentifier(event.eventId, "event id")
        val generation = hostGeneration
        if (generation == null || generation != event.hostGeneration) return ApplyResult.GENERATION_REQUIRES_FULL_SYNC
        if (sequence <= lastAppliedSequence) return ApplyResult.DUPLICATE
        if (sequence != lastAppliedSequence + BigInteger.ONE) return ApplyResult.GAP_REQUIRES_FULL_SYNC
        lastAppliedSequence = sequence
        return ApplyResult.APPLIED
    }
}

object RemoteCommandValidator {
    private val uuidPattern = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")
    private val identifierPattern = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
    private val shaPattern = Regex("[0-9a-f]{64}")

    val allowedCommands = setOf(
        "session.sync", "transcript.get", "prompt.send", "turn.abort", "approval.respond", "model.set", "models.probe",
        "thinking.set", "approval-mode.set", "attachment.start", "attachment.commit", "attachment.cancel",
        "files.search", "diff.get", "revert.apply", "editor.insert", "transcript.export", "sessions.list",
        "session.create", "session.switch", "session.rename", "session.reset", "session.compact", "session.restart",
        "session.close", "history.list", "history.open", "settings.update", "profile.update", "auth.login", "credentials.set", "credentials.clear", "diagnostics.get",
        "remote.stop",
    )

    fun validate(command: RemoteCommand, encodedSize: Int) {
        require(encodedSize in 1..MAX_JSON_FRAME_BYTES) { "Command frame is too large" }
        require(command.protocolVersion == REMOTE_PROTOCOL_VERSION) { "Unsupported protocol version" }
        require(command.type == "command") { "Message type must be command" }
        require(uuidPattern.matches(command.commandId)) { "Command id must be a UUID" }
        parseUint64Decimal(command.commandCounter)
        requireIdentifier(command.hostGeneration, "host generation")
        command.sessionId?.let { requireIdentifier(it, "session id") }
        require(command.command in allowedCommands) { "Command is not allowlisted" }
        validatePayload(command.command, command.payload)
    }

    private fun validatePayload(command: String, payload: JsonObject) {
        when (command) {
            "session.sync", "transcript.get", "turn.abort", "sessions.list", "models.probe", "session.reset", "session.compact",
            "session.restart", "session.close", "diagnostics.get", "remote.stop" -> require(payload.isEmpty()) {
                "$command payload must be empty"
            }
            "prompt.send" -> {
                require(payload.keys.all { it in setOf("text", "attachmentIds", "forModel") })
                val text = requireUtf8String(payload, "text", 0, MAX_JSON_FRAME_BYTES)
                val attachments = payload["attachmentIds"]
                var attachmentCount = 0
                if (attachments != null) {
                    require(attachments is JsonArray && attachments.size <= 32) { "attachmentIds must be a bounded array" }
                    attachments.forEach { require(uuidPattern.matches(stringValue(it, "attachmentId", 36))) }
                    attachmentCount = attachments.size
                }
                payload["forModel"]?.let { routeElement ->
                    val route = routeElement as? JsonObject ?: error("forModel must be an object")
                    require(route.keys == setOf("provider", "modelId"))
                    require(identifierPattern.matches(string(route, "provider", 128)))
                    string(route, "modelId", 256).also { require(it.none { char -> char.code < 0x20 || char.code == 0x7f }) }
                }
                require(text.isNotEmpty() || attachmentCount > 0) { "Prompt must contain text or an attachment" }
            }
            "approval.respond" -> {
                require(identifierPattern.matches(string(payload, "requestId", 128)))
                validateApproval(payload["response"] as? JsonObject ?: error("response must be an object"))
            }
            "model.set" -> {
                require(identifierPattern.matches(string(payload, "provider", 128)))
                string(payload, "modelId", 256).also { require(it.none { char -> char.code < 0x20 || char.code == 0x7f }) }
            }
            "thinking.set" -> require(string(payload, "level", 8) in THINKING_LEVELS)
            "approval-mode.set" -> require(string(payload, "mode", 16) in APPROVAL_MODES)
            "attachment.start" -> validateAttachmentStart(payload)
            "attachment.commit", "attachment.cancel" -> require(uuidPattern.matches(string(payload, "attachmentId", 36)))
            "files.search" -> {
                string(payload, "query", 1024)
                optionalInt(payload, "maxResults", 1, 200)
            }
            "diff.get" -> require(identifierPattern.matches(string(payload, "changeId", 128)))
            "revert.apply" -> {
                require(identifierPattern.matches(string(payload, "changeId", 128)))
                require(shaPattern.matches(string(payload, "expectedAfterSha256", 64)))
            }
            "editor.insert" -> requireUtf8String(payload, "text", 1, 1024 * 1024)
            "transcript.export" -> require(string(payload, "format", 16) == "markdown")
            "session.create" -> payload["workspaceRoot"]?.let { stringValue(it, "workspaceRoot", 4096) }
            "session.switch" -> require(identifierPattern.matches(string(payload, "targetSessionId", 128)))
            "session.rename" -> string(payload, "title", 256)
            "history.list" -> {
                payload["query"]?.let { stringValue(it, "query", 1024) }
                optionalInt(payload, "limit", 1, 500)
            }
            "history.open" -> string(payload, "sessionPath", 4096)
            "settings.update" -> {
                require(string(payload, "key", 32) in setOf("defaultModel", "thinkingLevel", "approvalMode"))
                string(payload, "value", 256)
            }
            "profile.update" -> {
                require(payload.keys == setOf("family", "field", "value"))
                require(identifierPattern.matches(string(payload, "family", 128)))
                val field = string(payload, "field", 32)
                require(field in setOf("runtime.thinking", "spawn.approvalMode"))
                val value = payload["value"]
                if (value !is kotlinx.serialization.json.JsonNull) {
                    val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
                        ?: error("profile value must be a string or null")
                    val allowed = if (field == "runtime.thinking") {
                        setOf("inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto")
                    } else setOf("always-ask", "write", "yolo")
                    require(text in allowed)
                }
            }
            "auth.login" -> {
                require(payload.keys == setOf("providerId"))
                require(string(payload, "providerId", 32) in setOf("anthropic", "kimi-code"))
            }
            "credentials.set" -> {
                require(identifierPattern.matches(string(payload, "provider", 128)))
                string(payload, "value", 16 * 1024)
            }
            "credentials.clear" -> require(identifierPattern.matches(string(payload, "provider", 128)))
        }
    }

    private fun validateApproval(response: JsonObject) {
        when (val kind = string(response, "kind", 16)) {
            "confirm" -> require((response["value"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() != null)
            "select" -> require(int(response, "index") in 0..1023)
            "input" -> string(response, "value", 64 * 1024)
            "editor" -> string(response, "value", 1024 * 1024)
            "cancel" -> Unit
            else -> throw IllegalArgumentException("Unsupported approval response: $kind")
        }
    }

    private fun validateAttachmentStart(payload: JsonObject) {
        require(uuidPattern.matches(string(payload, "attachmentId", 36)))
        val fileName = string(payload, "fileName", 255)
        require(fileName != "." && fileName != ".." && '/' !in fileName && '\\' !in fileName)
        require(fileName.none { it.code < 0x20 || it.code == 0x7f })
        payload["mediaType"]?.let {
            val mediaType = stringValue(it, "mediaType", 127)
            require(Regex("[A-Za-z0-9!#\u0024&^_.+\\-]+/[A-Za-z0-9!#\u0024&^_.+\\-]+").matches(mediaType))
        }
        require(int(payload, "totalBytes") in 0..MAX_ATTACHMENT_BYTES)
        require(shaPattern.matches(string(payload, "sha256", 64)))
    }

    private fun optionalInt(payload: JsonObject, key: String, min: Int, max: Int): Long? =
        payload[key]?.let { element ->
            val value = (element as? JsonPrimitive)?.takeUnless { it.isString }?.content?.toLongOrNull()
                ?: throw IllegalArgumentException("$key must be an integer")
            require(value in min.toLong()..max.toLong())
            value
        }

    private fun int(payload: JsonObject, key: String): Long = optionalInt(payload, key, Int.MIN_VALUE, Int.MAX_VALUE)
        ?: throw IllegalArgumentException("$key is required")

    private fun string(payload: JsonObject, key: String, max: Int): String =
        stringValue(payload[key] ?: throw IllegalArgumentException("$key is required"), key, max)

    private fun stringValue(element: JsonElement, key: String, max: Int): String {
        val value = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw IllegalArgumentException("$key must be a string")
        require(value.isNotEmpty() && value.length <= max) { "$key has an invalid length" }
        return value
    }

    private fun requireUtf8String(payload: JsonObject, key: String, minBytes: Int, maxBytes: Int): String {
        val element = payload[key] ?: throw IllegalArgumentException("$key is required")
        val value = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw IllegalArgumentException("$key must be a string")
        require(value.length <= maxBytes && (minBytes == 0 || value.isNotEmpty())) { "$key has an invalid length" }
        require(value.toByteArray(Charsets.UTF_8).size in minBytes..maxBytes) { "$key exceeds the byte limit" }
        return value
    }

    private val THINKING_LEVELS = setOf("off", "minimal", "low", "medium", "high", "xhigh", "max", "auto")
    private val APPROVAL_MODES = setOf("always-ask", "write", "yolo")
}

fun parseUint64Decimal(value: String): BigInteger {
    require(Regex("0|[1-9][0-9]{0,19}").matches(value)) { "Counter must be canonical uint64 decimal" }
    val parsed = value.toBigInteger()
    require(parsed <= UINT64_MAX) { "Counter exceeds uint64" }
    return parsed
}

private val UINT64_MAX = BigInteger("18446744073709551615")
private val IDENTIFIER = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")

private fun requireIdentifier(value: String, label: String) {
    require(IDENTIFIER.matches(value)) { "Invalid $label" }
}

val StrictProtocolJson = Json {
    ignoreUnknownKeys = false
    explicitNulls = false
    encodeDefaults = true
    isLenient = false
    allowStructuredMapKeys = false
}
