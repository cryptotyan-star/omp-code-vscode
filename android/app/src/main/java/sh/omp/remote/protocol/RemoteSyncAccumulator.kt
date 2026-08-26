package sh.omp.remote.protocol

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

const val MAX_REMOTE_SYNC_PAYLOAD_BYTES = 180 * 1024
const val MAX_REASSEMBLED_SYNC_VALUE_BYTES = 2 * 1024 * 1024

data class RemoteSessionSummary(
    val id: String,
    val title: String,
    val cwd: String,
    val model: String,
    val provider: String,
    val status: String,
    val cost: Double,
    val closable: Boolean,
)

data class RemoteSessionBoard(
    val selectedSessionId: String? = null,
    val sessions: List<RemoteSessionSummary> = emptyList(),
)

sealed interface RemoteSyncAction {
    data class Begin(val syncId: String, val board: RemoteSessionBoard) : RemoteSyncAction
    data class Notice(
        val syncId: String,
        val code: String,
        val totalSessions: Int,
        val includedSessions: Int,
        val omittedSessions: Int,
    ) : RemoteSyncAction
    data class Reset(val syncId: String, val sessionId: String) : RemoteSyncAction
    data class Section(
        val syncId: String,
        val sessionId: String,
        val section: String,
        val value: JsonElement,
    ) : RemoteSyncAction

    data class Transcript(
        val syncId: String,
        val sessionId: String,
        val messages: JsonArray,
    ) : RemoteSyncAction

    /**
     * The native side validates and hashes the complete JSON value, but keeps the
     * original bounded base64 pieces for a bounded WebMessage transfer. This avoids
     * creating a single >256 KiB message at the Android/WebView boundary.
     */
    data class TranscriptFragments(
        val syncId: String,
        val sessionId: String,
        val messageIndex: Int,
        val fragments: List<String>,
        val totalBytes: Int,
        val sha256: String,
    ) : RemoteSyncAction

    data class SectionFragments(
        val syncId: String,
        val sessionId: String,
        val section: String,
        val fragments: List<String>,
        val totalBytes: Int,
        val sha256: String,
        val validatedValue: JsonElement,
    ) : RemoteSyncAction

    data class SessionComplete(val syncId: String, val sessionId: String) : RemoteSyncAction
    data class Complete(val syncId: String) : RemoteSyncAction
}

/**
 * Strict consumer for `src/remoteSync.ts`. The planner emits one session at a
 * time and all eight sections in a fixed order. Any omission, reordering,
 * conflicting fragment or oversized reassembly aborts the batch.
 */
class RemoteSyncAccumulator {
    private var batch: Batch? = null

    fun discard() {
        batch?.progress?.fragment?.destroy()
        batch = null
    }

    fun accept(payload: JsonObject): List<RemoteSyncAction> {
        require(payload.toString().toByteArray(Charsets.UTF_8).size <= MAX_REMOTE_SYNC_PAYLOAD_BYTES) {
            "Full-sync packet exceeds the wire limit"
        }
        val phase = requiredString(payload, "phase", 32)
        return try {
            when (phase) {
                "begin" -> begin(payload)
                "notice" -> notice(payload)
                "reset" -> reset(payload)
                "section" -> section(payload)
                "section-fragment" -> fragment(payload, transcript = false)
                "transcript" -> transcript(payload)
                "transcript-fragment" -> fragment(payload, transcript = true)
                "session-complete" -> sessionComplete(payload)
                "complete" -> complete(payload)
                else -> error("Unknown full-sync phase")
            }
        } catch (error: Throwable) {
            discard()
            throw error
        }
    }

    private fun begin(payload: JsonObject): List<RemoteSyncAction> {
        requireKeys(payload, setOf("phase", "syncId", "selectedSessionId", "sessions"))
        val syncId = identifier(payload, "syncId")
        val selected = nullableIdentifier(payload["selectedSessionId"], "selectedSessionId")
        val rows = payload["sessions"] as? JsonArray ?: error("sessions must be an array")
        require(rows.size <= MAX_SYNC_SESSIONS) { "Too many synchronized sessions" }
        val summaries = rows.map { rowElement ->
            val row = rowElement as? JsonObject ?: error("sync session row must be an object")
            requireKeys(row, setOf("sessionId", "session"))
            val id = identifier(row, "sessionId")
            parseSummary(row["session"], id)
        }
        require(summaries.map { it.id }.toSet().size == summaries.size) { "Duplicate synchronized session" }
        require(selected == null || summaries.any { it.id == selected }) { "Selected session is absent from the board" }
        discard() // A new begin explicitly supersedes an incomplete batch.
        val board = RemoteSessionBoard(selected, summaries)
        batch = Batch(syncId, board)
        return listOf(RemoteSyncAction.Begin(syncId, board))
    }

    private fun reset(payload: JsonObject): List<RemoteSyncAction> {
        requireKeys(payload, setOf("phase", "syncId", "sessionId"))
        val current = requireBatch(payload)
        require(current.progress == null) { "Previous sync session is incomplete" }
        val sessionId = identifier(payload, "sessionId")
        val expected = current.board.sessions.getOrNull(current.sessionIndex)?.id
            ?: error("Unexpected session reset")
        require(sessionId == expected) { "Sessions are not synchronized in planner order" }
        current.progress = SessionProgress(sessionId)
        return listOf(RemoteSyncAction.Reset(current.syncId, sessionId))
    }

    private fun notice(payload: JsonObject): List<RemoteSyncAction> {
        requireKeys(payload, setOf("phase", "syncId", "code", "totalSessions", "includedSessions", "omittedSessions"))
        val current = requireBatch(payload)
        require(current.progress == null && current.sessionIndex == 0) { "Sync notice must follow begin" }
        val code = requiredString(payload, "code", 64)
        require(code == "session-limit")
        val total = requiredInt(payload, "totalSessions", 1, Int.MAX_VALUE)
        val included = requiredInt(payload, "includedSessions", 0, MAX_SYNC_SESSIONS)
        val omitted = requiredInt(payload, "omittedSessions", 1, Int.MAX_VALUE)
        require(total > MAX_SYNC_SESSIONS && included == MAX_SYNC_SESSIONS)
        require(included == current.board.sessions.size && Math.addExact(included, omitted) == total)
        return listOf(RemoteSyncAction.Notice(current.syncId, code, total, included, omitted))
    }

    private fun section(payload: JsonObject): List<RemoteSyncAction> {
        requireKeys(payload, setOf("phase", "syncId", "sessionId", "section", "value"))
        val current = requireProgress(payload)
        require(current.fragment == null) { "A fragmented value is incomplete" }
        val name = requiredString(payload, "section", 32)
        consumeSection(current, name)
        return listOf(RemoteSyncAction.Section(requireBatch(payload).syncId, current.sessionId, name, payload.getValue("value")))
    }

    private fun transcript(payload: JsonObject): List<RemoteSyncAction> {
        requireKeys(payload, setOf("phase", "syncId", "sessionId", "chunkIndex", "messages"))
        val batch = requireBatch(payload)
        val current = requireProgress(payload)
        require(current.fragment == null) { "A fragmented value is incomplete" }
        require(current.nextSection == SECTION_NAMES.size) { "Transcript arrived before all sections" }
        val chunkIndex = requiredInt(payload, "chunkIndex", 0, Int.MAX_VALUE)
        require(chunkIndex == current.nextChunkIndex) { "Transcript chunk is out of order" }
        val messages = payload["messages"] as? JsonArray ?: error("messages must be an array")
        require(messages.isNotEmpty()) { "Transcript chunks cannot be empty" }
        current.nextChunkIndex += 1
        current.nextMessageIndex = Math.addExact(current.nextMessageIndex, messages.size)
        return listOf(RemoteSyncAction.Transcript(batch.syncId, current.sessionId, messages))
    }

    private fun fragment(payload: JsonObject, transcript: Boolean): List<RemoteSyncAction> {
        val expectedKeys = if (transcript) {
            setOf("phase", "syncId", "sessionId", "encoding", "fragmentIndex", "fragmentCount", "data", "messageIndex")
        } else {
            setOf("phase", "syncId", "sessionId", "encoding", "fragmentIndex", "fragmentCount", "data", "section")
        }
        requireKeys(payload, expectedKeys)
        val batch = requireBatch(payload)
        val current = requireProgress(payload)
        require(requiredString(payload, "encoding", 32) == "base64-json") { "Unsupported sync fragment encoding" }
        if (transcript) {
            require(current.nextSection == SECTION_NAMES.size) { "Transcript arrived before all sections" }
        }
        val index = requiredInt(payload, "fragmentIndex", 0, MAX_SYNC_FRAGMENTS - 1)
        val count = requiredInt(payload, "fragmentCount", 1, MAX_SYNC_FRAGMENTS)
        require(index < count) { "Fragment index exceeds fragment count" }
        val identity = if (transcript) {
            val messageIndex = requiredInt(payload, "messageIndex", 0, Int.MAX_VALUE)
            require(messageIndex == current.nextMessageIndex) { "Transcript message fragment is out of order" }
            FragmentIdentity.Transcript(messageIndex)
        } else {
            val section = requiredString(payload, "section", 32)
            val expected = SECTION_NAMES.getOrNull(current.nextSection) ?: error("Unexpected section fragment")
            require(section == expected) { "Full-sync section is out of order" }
            FragmentIdentity.Section(section)
        }
        val data = requiredString(payload, "data", MAX_FRAGMENT_BASE64_CHARS)
        val decoded = decodeCanonicalBase64(data)
        require(decoded.size <= MAX_FRAGMENT_SOURCE_BYTES) { "Sync fragment source is oversized" }

        var assembly = current.fragment
        if (assembly == null) {
            require(index == 0) { "First fragment index must be zero" }
            assembly = FragmentAssembly(identity, count)
            current.fragment = assembly
        }
        require(assembly.identity == identity && assembly.count == count) { "Conflicting fragment metadata" }
        require(index == assembly.fragments.size) { "Fragment is duplicated or out of order" }
        assembly.append(data, decoded)
        decoded.fill(0)
        if (assembly.fragments.size != count) return emptyList()

        current.fragment = null
        val complete = assembly.finish()
        val parsed = decodeJson(complete.bytes)
        complete.bytes.fill(0)
        return when (identity) {
            is FragmentIdentity.Section -> {
                consumeSection(current, identity.name)
                listOf(
                    RemoteSyncAction.SectionFragments(
                        batch.syncId,
                        current.sessionId,
                        identity.name,
                        complete.fragments,
                        complete.totalBytes,
                        complete.sha256,
                        parsed,
                    ),
                )
            }
            is FragmentIdentity.Transcript -> {
                current.nextMessageIndex += 1
                listOf(
                    RemoteSyncAction.TranscriptFragments(
                        batch.syncId,
                        current.sessionId,
                        identity.messageIndex,
                        complete.fragments,
                        complete.totalBytes,
                        complete.sha256,
                    ),
                )
            }
        }
    }

    private fun sessionComplete(payload: JsonObject): List<RemoteSyncAction> {
        requireKeys(payload, setOf("phase", "syncId", "sessionId"))
        val batch = requireBatch(payload)
        val current = requireProgress(payload)
        require(current.fragment == null) { "A fragmented value is incomplete" }
        require(current.nextSection == SECTION_NAMES.size) { "A synchronized session is missing sections" }
        batch.progress = null
        batch.sessionIndex += 1
        return listOf(RemoteSyncAction.SessionComplete(batch.syncId, current.sessionId))
    }

    private fun complete(payload: JsonObject): List<RemoteSyncAction> {
        requireKeys(payload, setOf("phase", "syncId"))
        val current = requireBatch(payload)
        require(current.progress == null && current.sessionIndex == current.board.sessions.size) {
            "Full sync completed with missing sessions"
        }
        val action = RemoteSyncAction.Complete(current.syncId)
        batch = null
        return listOf(action)
    }

    private fun consumeSection(progress: SessionProgress, name: String) {
        val expected = SECTION_NAMES.getOrNull(progress.nextSection) ?: error("Too many full-sync sections")
        require(name == expected) { "Full-sync section is out of order" }
        progress.nextSection += 1
    }

    private fun requireBatch(payload: JsonObject): Batch {
        val current = batch ?: error("Full-sync packet arrived before begin")
        require(identifier(payload, "syncId") == current.syncId) { "Full-sync id changed mid-batch" }
        return current
    }

    private fun requireProgress(payload: JsonObject): SessionProgress {
        val current = requireBatch(payload)
        val progress = current.progress ?: error("Full-sync session has not been reset")
        require(identifier(payload, "sessionId") == progress.sessionId) { "Full-sync session id changed" }
        return progress
    }

    private data class Batch(
        val syncId: String,
        val board: RemoteSessionBoard,
        var sessionIndex: Int = 0,
        var progress: SessionProgress? = null,
    )

    private data class SessionProgress(
        val sessionId: String,
        var nextSection: Int = 0,
        var nextChunkIndex: Int = 0,
        var nextMessageIndex: Int = 0,
        var fragment: FragmentAssembly? = null,
    )

    private sealed interface FragmentIdentity {
        data class Section(val name: String) : FragmentIdentity
        data class Transcript(val messageIndex: Int) : FragmentIdentity
    }

    private class FragmentAssembly(val identity: FragmentIdentity, val count: Int) {
        val fragments = mutableListOf<String>()
        private val bytes = ArrayList<Byte>()

        fun append(encoded: String, decoded: ByteArray) {
            require(bytes.size + decoded.size <= MAX_REASSEMBLED_SYNC_VALUE_BYTES) { "Reassembled sync value is oversized" }
            fragments += encoded
            decoded.forEach(bytes::add)
        }

        fun finish(): CompleteFragments {
            require(fragments.size == count)
            val output = ByteArray(bytes.size) { bytes[it] }
            val hash = MessageDigest.getInstance("SHA-256").digest(output).joinToString("") { "%02x".format(it) }
            bytes.fill(0)
            bytes.clear()
            return CompleteFragments(fragments.toList(), output, output.size, hash)
        }

        fun destroy() {
            bytes.fill(0)
            bytes.clear()
            fragments.clear()
        }
    }

    private data class CompleteFragments(
        val fragments: List<String>,
        val bytes: ByteArray,
        val totalBytes: Int,
        val sha256: String,
    )

    companion object {
        val SECTION_NAMES = listOf("state", "models", "commands", "stats", "approvalMode", "profile", "configuration", "approvals")
        private const val MAX_SYNC_SESSIONS = 128
        private const val MAX_SYNC_FRAGMENTS = 32
        private const val MAX_FRAGMENT_SOURCE_BYTES = 96 * 1024
        private const val MAX_FRAGMENT_BASE64_CHARS = ((MAX_FRAGMENT_SOURCE_BYTES + 2) / 3) * 4
        private val IDENTIFIER = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")

        fun parseBoardPayload(payload: JsonObject): RemoteSessionBoard {
            requireKeys(payload, setOf("sessions", "selectedSessionId"))
            val sessions = payload["sessions"] as? JsonArray ?: error("sessions must be an array")
            require(sessions.size <= MAX_SYNC_SESSIONS)
            val summaries = sessions.map { parseSummary(it, null) }
            require(summaries.map { it.id }.toSet().size == summaries.size)
            val selected = nullableIdentifier(payload["selectedSessionId"], "selectedSessionId")
            require(selected == null || summaries.any { it.id == selected })
            return RemoteSessionBoard(selected, summaries)
        }

        private fun parseSummary(value: JsonElement?, expectedId: String?): RemoteSessionSummary {
            if (value == null || value is JsonNull) {
                val id = expectedId ?: error("Session summary cannot be null")
                return RemoteSessionSummary(id, "OMP Code", "Desktop", "", "", "starting", 0.0, false)
            }
            val summary = value as? JsonObject ?: error("session summary must be an object")
            if (summary.keys == setOf("remoteSyncNotice")) {
                val notice = summary["remoteSyncNotice"] as? JsonObject ?: error("session metadata notice is invalid")
                require(notice.keys == setOf("code", "originalBytes", "message", "sessionId"))
                require(requiredString(notice, "code", 64) == "session-metadata-too-large")
                requiredInt(notice, "originalBytes", 1, Int.MAX_VALUE)
                requiredString(notice, "message", 1024)
                require(identifier(notice, "sessionId") == expectedId)
                val id = expectedId ?: error("Session metadata notice has no row identity")
                return RemoteSessionSummary(id, "OMP Code", "Desktop", "", "", "starting", 0.0, false)
            }
            requireKeys(summary, setOf("id", "title", "cwd", "model", "provider", "status", "cost", "closable"))
            val id = identifier(summary, "id")
            require(expectedId == null || id == expectedId) { "Session row id mismatch" }
            val status = requiredString(summary, "status", 16)
            require(status in setOf("starting", "asks", "working", "idle"))
            val costPrimitive = summary["cost"] as? JsonPrimitive ?: error("cost must be numeric")
            require(!costPrimitive.isString)
            val cost = costPrimitive.content.toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0.0 }
                ?: error("cost must be a finite non-negative number")
            val closablePrimitive = summary["closable"] as? JsonPrimitive ?: error("closable must be boolean")
            require(!closablePrimitive.isString)
            val closable = closablePrimitive.content.toBooleanStrictOrNull() ?: error("closable must be boolean")
            return RemoteSessionSummary(
                id,
                requiredString(summary, "title", 256, allowEmpty = true),
                requiredString(summary, "cwd", 4096, allowEmpty = true),
                requiredString(summary, "model", 256, allowEmpty = true),
                requiredString(summary, "provider", 128, allowEmpty = true),
                status,
                cost,
                closable,
            )
        }

        private fun requireKeys(value: JsonObject, keys: Set<String>) {
            require(value.keys == keys) { "Full-sync object has unknown or missing fields" }
        }

        private fun identifier(value: JsonObject, key: String): String =
            requiredString(value, key, 128).also { require(IDENTIFIER.matches(it)) { "$key is invalid" } }

        private fun nullableIdentifier(value: JsonElement?, key: String): String? {
            if (value == null || value is JsonNull) return null
            val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("$key must be a string or null")
            require(IDENTIFIER.matches(text)) { "$key is invalid" }
            return text
        }

        private fun requiredString(value: JsonObject, key: String, max: Int, allowEmpty: Boolean = false): String {
            val text = (value[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("$key must be a string")
            require(text.length <= max && (allowEmpty || text.isNotEmpty())) { "$key has an invalid length" }
            return text
        }

        private fun requiredInt(value: JsonObject, key: String, min: Int, max: Int): Int {
            val primitive = value[key] as? JsonPrimitive ?: error("$key must be an integer")
            require(!primitive.isString)
            val parsed = primitive.content.toIntOrNull() ?: error("$key must be an integer")
            require(parsed in min..max) { "$key is outside its range" }
            return parsed
        }

        private fun decodeCanonicalBase64(value: String): ByteArray {
            val decoded = runCatching { Base64.getDecoder().decode(value) }
                .getOrElse { throw IllegalArgumentException("Fragment data is not base64") }
            require(Base64.getEncoder().encodeToString(decoded) == value) { "Fragment base64 is not canonical" }
            return decoded
        }

        private fun decodeJson(bytes: ByteArray): JsonElement {
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val text = runCatching { decoder.decode(ByteBuffer.wrap(bytes)).toString() }
                .getOrElse { throw IllegalArgumentException("Fragment JSON is not valid UTF-8") }
            return runCatching { StrictProtocolJson.parseToJsonElement(text) }
                .getOrElse { throw IllegalArgumentException("Fragment JSON is invalid") }
        }
    }
}
