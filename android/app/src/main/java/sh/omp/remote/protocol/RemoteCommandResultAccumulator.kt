package sh.omp.remote.protocol

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import sh.omp.remote.data.StoredCommandResult

const val MAX_STREAMED_COMMAND_RESULT_BYTES = 2 * 1024 * 1024
const val MAX_STREAMED_COMMAND_RESULT_CHUNKS = 32
const val MAX_STREAMED_COMMAND_RESULT_CHUNK_BYTES = 96 * 1024

data class CompletedCommandResult(
    val streamId: String,
    val commandId: String,
    val totalBytes: Int,
    val chunkCount: Int,
    val sha256: String,
    val value: JsonElement,
    val json: String,
    /** Original canonical base64 chunks, each safe for an origin-scoped WebMessage. */
    val chunks: List<String>,
)

/** Strict, ordered consumer for encrypted `event:"command-result"` packets. */
class RemoteCommandResultAccumulator {
    private var active: Active? = null

    fun accept(payload: JsonObject): CompletedCommandResult? {
        val phase = string(payload, "phase", 16)
        return try {
            when (phase) {
                "begin" -> begin(payload)
                "chunk" -> chunk(payload)
                "commit" -> commit(payload)
                else -> error("Unknown command-result phase")
            }
        } catch (error: Throwable) {
            discard()
            throw error
        }
    }

    fun discard() {
        active?.destroy()
        active = null
    }

    private fun begin(payload: JsonObject): CompletedCommandResult? {
        requireKeys(payload, setOf("phase", "streamId", "commandId", "encoding", "totalBytes", "chunkCount", "sha256"))
        require(active == null) { "A command-result stream is already active" }
        val streamId = identifier(payload, "streamId")
        val commandId = uuid(payload, "commandId")
        require(string(payload, "encoding", 32) == "base64-json")
        val totalBytes = integer(payload, "totalBytes", 1, MAX_STREAMED_COMMAND_RESULT_BYTES)
        val chunkCount = integer(payload, "chunkCount", 1, MAX_STREAMED_COMMAND_RESULT_CHUNKS)
        val sha256 = string(payload, "sha256", 64).also { require(SHA256.matches(it)) }
        require(chunkCount >= (totalBytes + MAX_STREAMED_COMMAND_RESULT_CHUNK_BYTES - 1) / MAX_STREAMED_COMMAND_RESULT_CHUNK_BYTES) {
            "Command-result chunk count cannot contain the declared bytes"
        }
        active = Active(streamId, commandId, totalBytes, chunkCount, sha256)
        return null
    }

    private fun chunk(payload: JsonObject): CompletedCommandResult? {
        requireKeys(payload, setOf("phase", "streamId", "commandId", "index", "chunkCount", "data"))
        val current = active ?: error("Command-result chunk arrived before begin")
        require(identifier(payload, "streamId") == current.streamId)
        require(uuid(payload, "commandId") == current.commandId)
        require(integer(payload, "chunkCount", 1, MAX_STREAMED_COMMAND_RESULT_CHUNKS) == current.chunkCount)
        val index = integer(payload, "index", 0, current.chunkCount - 1)
        require(index == current.chunks.size) { "Command-result chunk is duplicated or out of order" }
        val data = string(payload, "data", MAX_CHUNK_BASE64_CHARS)
        val decoded = runCatching { Base64.getDecoder().decode(data) }
            .getOrElse { throw IllegalArgumentException("Command-result chunk is not base64") }
        require(decoded.isNotEmpty() && decoded.size <= MAX_STREAMED_COMMAND_RESULT_CHUNK_BYTES)
        require(Base64.getEncoder().encodeToString(decoded) == data) { "Command-result chunk base64 is not canonical" }
        require(current.offset + decoded.size <= current.totalBytes) { "Command-result exceeds declared size" }
        current.chunks += data
        decoded.copyInto(current.bytes, current.offset)
        current.offset += decoded.size
        decoded.fill(0)
        return null
    }

    private fun commit(payload: JsonObject): CompletedCommandResult {
        requireKeys(payload, setOf("phase", "streamId", "commandId", "totalBytes", "chunkCount", "sha256"))
        val current = active ?: error("Command-result commit arrived before begin")
        require(identifier(payload, "streamId") == current.streamId)
        require(uuid(payload, "commandId") == current.commandId)
        require(integer(payload, "totalBytes", 1, MAX_STREAMED_COMMAND_RESULT_BYTES) == current.totalBytes)
        require(integer(payload, "chunkCount", 1, MAX_STREAMED_COMMAND_RESULT_CHUNKS) == current.chunkCount)
        require(string(payload, "sha256", 64) == current.sha256)
        require(current.chunks.size == current.chunkCount && current.offset == current.totalBytes) {
            "Command-result stream is incomplete"
        }
        val bytes = current.bytes.copyOf()
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        require(digest == current.sha256) { "Command-result digest mismatch" }
        val jsonText = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
        val value = StrictProtocolJson.parseToJsonElement(jsonText)
        bytes.fill(0)
        val complete = CompletedCommandResult(
            current.streamId,
            current.commandId,
            current.totalBytes,
            current.chunkCount,
            current.sha256,
            value,
            jsonText,
            current.chunks.toList(),
        )
        current.destroy()
        active = null
        return complete
    }

    private class Active(
        val streamId: String,
        val commandId: String,
        val totalBytes: Int,
        val chunkCount: Int,
        val sha256: String,
        val chunks: MutableList<String> = mutableListOf(),
        val bytes: ByteArray = ByteArray(totalBytes),
        var offset: Int = 0,
    ) {
        fun destroy() {
            bytes.fill(0)
            offset = 0
            chunks.clear()
        }
    }

    companion object {
        private const val MAX_CHUNK_BASE64_CHARS = ((MAX_STREAMED_COMMAND_RESULT_CHUNK_BYTES + 2) / 3) * 4
        private val IDENTIFIER = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
        private val UUID = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")
        private val SHA256 = Regex("[0-9a-f]{64}")

        private fun requireKeys(value: JsonObject, keys: Set<String>) {
            require(value.keys == keys) { "Command-result contains unknown or missing fields" }
        }

        private fun string(value: JsonObject, key: String, max: Int): String =
            (value[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?.also { require(it.isNotEmpty() && it.length <= max) { "$key has invalid length" } }
                ?: error("$key must be a string")

        private fun identifier(value: JsonObject, key: String): String =
            string(value, key, 128).also { require(IDENTIFIER.matches(it)) { "$key is invalid" } }

        private fun uuid(value: JsonObject, key: String): String =
            string(value, key, 36).also { require(UUID.matches(it)) { "$key is invalid" } }

        private fun integer(value: JsonObject, key: String, min: Int, max: Int): Int {
            val primitive = value[key] as? JsonPrimitive ?: error("$key must be an integer")
            require(!primitive.isString)
            return primitive.content.toIntOrNull()?.also { require(it in min..max) { "$key is out of range" } }
                ?: error("$key must be an integer")
        }
    }
}

/** Rebuilds bridge-safe chunks from the sealed result committed before event ACK. */
internal fun restoreCompletedCommandResult(
    stored: StoredCommandResult,
    marker: StreamedResultMarker,
): CompletedCommandResult? {
    if (stored.totalBytes != marker.totalBytes || stored.sha256 != marker.sha256) return null
    val bytes = stored.json.toByteArray(Charsets.UTF_8)
    return try {
        if (bytes.size != marker.totalBytes) return null
        val chunks = buildList {
            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(bytes.size, offset + MAX_STREAMED_COMMAND_RESULT_CHUNK_BYTES)
                val chunk = bytes.copyOfRange(offset, end)
                try {
                    add(Base64.getEncoder().encodeToString(chunk))
                } finally {
                    chunk.fill(0)
                }
                offset = end
            }
        }
        if (chunks.isEmpty() || chunks.size > MAX_STREAMED_COMMAND_RESULT_CHUNKS) return null
        CompletedCommandResult(
            streamId = stored.streamId,
            commandId = stored.commandId,
            totalBytes = stored.totalBytes,
            chunkCount = chunks.size,
            sha256 = stored.sha256,
            value = StrictProtocolJson.parseToJsonElement(stored.json),
            json = stored.json,
            chunks = chunks,
        )
    } finally {
        bytes.fill(0)
    }
}
