package sh.omp.remote.web

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

data class ValidatedBridgeMessage(
    val type: String,
    val body: JsonObject,
)

object BridgeMessageValidator {
    const val MAX_MESSAGE_BYTES = 256 * 1024
    private val json = Json { ignoreUnknownKeys = false; isLenient = false }

    private val schemas = mapOf(
        "renderer.ready" to setOf("type", "protocolVersion"),
        "security-spike.result" to setOf("type", "protocolVersion", "passed", "fixtureCount"),
        "local.copy" to setOf("type", "protocolVersion", "text"),
        "local.openUrl" to setOf("type", "protocolVersion", "url"),
        "local.pickFile" to setOf("type", "protocolVersion", "accept"),
        "local.pickPhoto" to setOf("type", "protocolVersion"),
        "local.share" to setOf("type", "protocolVersion", "text", "mime"),
        "remote.command" to setOf("type", "protocolVersion", "command"),
    )

    fun validate(raw: String): ValidatedBridgeMessage {
        require(raw.toByteArray(Charsets.UTF_8).size in 1..MAX_MESSAGE_BYTES) { "Bridge message size is invalid" }
        val body = runCatching { json.parseToJsonElement(raw).jsonObject }
            .getOrElse { throw IllegalArgumentException("Bridge message must be a JSON object") }
        val uiType = (body["t"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (uiType != null) return validateSharedRenderer(uiType, body)
        val type = (body["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw IllegalArgumentException("Bridge message type is missing")
        val allowed = schemas[type] ?: throw IllegalArgumentException("Bridge message type is not allowlisted")
        require(body.keys.all { it in allowed }) { "Bridge message contains unsupported fields" }
        val version = (body["protocolVersion"] as? JsonPrimitive)?.content?.toIntOrNull()
        require(version == 1) { "Unsupported renderer protocol version" }
        when (type) {
            "local.copy" -> requireString(body, "text", 0, 256 * 1024)
            "local.share" -> {
                requireString(body, "text", 0, 256 * 1024)
                require(requireString(body, "mime", 1, 64) in setOf("text/plain", "text/markdown"))
            }
            "local.openUrl" -> {
                val url = requireString(body, "url", 1, 4096)
                require(isAllowedExternalUrl(url)) { "Only HTTP(S) links can be opened" }
            }
            "local.pickFile" -> requireString(body, "accept", 0, 512)
            "security-spike.result" -> {
                require((body["passed"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() != null)
                require((body["fixtureCount"] as? JsonPrimitive)?.content?.toIntOrNull() in 1..100)
            }
            "remote.command" -> require(body["command"] is JsonObject) { "Remote command must be an object" }
        }
        return ValidatedBridgeMessage(type, body)
    }

    private fun validateSharedRenderer(type: String, body: JsonObject): ValidatedBridgeMessage {
        val schemas = mapOf(
            "ready" to setOf("t"), "abort" to setOf("t"), "compact" to setOf("t"),
            "restart" to setOf("t"), "newSession" to setOf("t"), "openNewTab" to setOf("t"),
            "exportTranscript" to setOf("t"), "getHistory" to setOf("t"), "getModels" to setOf("t"),
            "getState" to setOf("t"), "recheckModels" to setOf("t"), "diagnostics" to setOf("t"),
            "pickFiles" to setOf("t"), "openProfileSettings" to setOf("t"),
            "prompt" to setOf("t", "text", "attachments", "forModel"),
            "uiResponse" to setOf("t", "frame"),
            "setModel" to setOf("t", "provider", "modelId"),
            "setThinking" to setOf("t", "level"), "setApproval" to setOf("t", "mode"),
            "findFiles" to setOf("t", "query", "token"), "copy" to setOf("t", "text"),
            "openExternal" to setOf("t", "url"), "insertAtCursor" to setOf("t", "text"),
            "openSession" to setOf("t", "path"), "login" to setOf("t", "providerId"),
            "openDiff" to setOf("t", "toolCallId"), "rejectEdit" to setOf("t", "toolCallId"),
            "attachPaths" to setOf("t", "paths"),
            "attachData" to setOf("t", "token", "name", "mime", "data"),
            "cancelAttachment" to setOf("t", "attachmentId"),
            "clearKey" to setOf("t", "which"), "setKeys" to setOf("t", "keys"),
            "setProfileField" to setOf("t", "family", "field", "value"),
            "uiError" to setOf("t", "message", "context"),
        )[type] ?: throw IllegalArgumentException("Renderer command is not allowlisted")
        require(body.keys.all { it in schemas }) { "Renderer command contains unsupported fields" }
        when (type) {
            "prompt" -> requireString(body, "text", 0, 256 * 1024)
            "setModel" -> { requireString(body, "provider", 1, 128); requireString(body, "modelId", 1, 256) }
            "setThinking" -> require(requireString(body, "level", 1, 16) in setOf("off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"))
            "setApproval" -> require(requireString(body, "mode", 1, 16) in setOf("always-ask", "write", "yolo"))
            "openExternal" -> require(isAllowedExternalUrl(requireString(body, "url", 1, 4096)))
            "copy", "insertAtCursor" -> requireString(body, "text", 0, 256 * 1024)
            "findFiles" -> requireString(body, "query", 1, 1024)
            "uiResponse" -> require(body["frame"] is JsonObject)
            "openDiff", "rejectEdit" -> require(requireString(body, "toolCallId", 1, 128).matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")))
            "openSession" -> requireString(body, "path", 1, 4096)
            "attachPaths" -> {
                val paths = body["paths"] as? kotlinx.serialization.json.JsonArray ?: error("paths must be an array")
                require(paths.size in 1..32)
                paths.forEach { element ->
                    val path = (element as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("path must be a string")
                    require(path.length in 1..4096)
                }
            }
            "attachData" -> {
                requireString(body, "token", 1, 128)
                requireString(body, "name", 1, 255)
                requireString(body, "mime", 0, 127)
                requireString(body, "data", 1, MAX_MESSAGE_BYTES)
            }
            "cancelAttachment" -> require(
                requireString(body, "attachmentId", 36, 36)
                    .matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")),
            )
            "login" -> require(requireString(body, "providerId", 1, 32) in setOf("anthropic", "kimi-code"))
            "setProfileField" -> {
                require(requireString(body, "family", 1, 128).matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")))
                val field = requireString(body, "field", 1, 32)
                require(field in setOf("runtime.thinking", "spawn.approvalMode"))
                val value = body["value"]
                require(value is kotlinx.serialization.json.JsonNull || (value is JsonPrimitive && value.isString))
                if (value is JsonPrimitive) {
                    val allowed = if (field == "runtime.thinking") {
                        setOf("inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto")
                    } else setOf("always-ask", "write", "yolo")
                    require(value.content in allowed)
                }
            }
            "clearKey" -> require(requireString(body, "which", 1, 128).matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")))
            "setKeys" -> {
                val keys = body["keys"] as? JsonObject ?: error("keys must be an object")
                require(keys.size in 1..16)
                keys.forEach { (provider, element) ->
                    require(provider.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")))
                    val secret = (element as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("key must be a string")
                    require(secret.length in 1..16 * 1024)
                }
            }
        }
        return ValidatedBridgeMessage("ui.$type", body)
    }

    fun isAllowedExternalUrl(raw: String): Boolean = runCatching {
        val uri = java.net.URI(raw)
        uri.isAbsolute && uri.host != null && uri.userInfo == null &&
            (uri.scheme.equals("https", true) || uri.scheme.equals("http", true))
    }.getOrDefault(false)

    private fun requireString(body: JsonObject, key: String, min: Int, max: Int): String {
        val value = (body[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw IllegalArgumentException("$key must be a string")
        require(value.length in min..max) { "$key has an invalid length" }
        return value
    }
}
