package sh.omp.remote.protocol

import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.omp.remote.data.StoredCommandResult

class RemoteCommandResultAccumulatorTest {
    private val commandId = "123e4567-e89b-42d3-a456-426614174000"
    private val streamId = "result-stream-1"

    @Test fun exactDesktopStreamReassemblesCanonicalJson() {
        val bytes = """{"files":[{"path":"README.md"}]}""".toByteArray()
        val digest = sha(bytes)
        val accumulator = RemoteCommandResultAccumulator()
        assertNull(accumulator.accept(begin(bytes.size, 1, digest)))
        assertNull(accumulator.accept(chunk(0, 1, bytes)))
        val complete = accumulator.accept(commit(bytes.size, 1, digest))!!
        assertEquals(commandId, complete.commandId)
        assertEquals(digest, complete.sha256)
        assertTrue(complete.value is JsonObject)
    }

    @Test fun rejectsWrongOrderIdentityDigestAndNonCanonicalBase64() {
        val bytes = "{}".toByteArray()
        val digest = sha(bytes)
        fun fails(action: (RemoteCommandResultAccumulator) -> Unit) {
            assertTrue(runCatching { action(RemoteCommandResultAccumulator()) }.isFailure)
        }
        fails { it.accept(chunk(0, 1, bytes)) }
        fails { acc -> acc.accept(begin(bytes.size, 1, digest)); acc.accept(chunk(1, 1, bytes)) }
        fails { acc ->
            acc.accept(begin(bytes.size, 1, digest))
            acc.accept(buildJsonObject {
                put("phase", "chunk"); put("streamId", streamId); put("commandId", commandId)
                put("index", 0); put("chunkCount", 1); put("data", "e30")
            })
        }
        fails { acc -> acc.accept(begin(bytes.size, 1, "0".repeat(64))); acc.accept(chunk(0, 1, bytes)); acc.accept(commit(bytes.size, 1, "0".repeat(64))) }
    }

    @Test fun enforcesTwoMiBAndChunkBounds() {
        assertTrue(runCatching {
            RemoteCommandResultAccumulator().accept(begin(MAX_STREAMED_COMMAND_RESULT_BYTES + 1, 1, "0".repeat(64)))
        }.isFailure)
        val tooLarge = ByteArray(MAX_STREAMED_COMMAND_RESULT_CHUNK_BYTES + 1)
        val digest = sha(tooLarge)
        assertTrue(runCatching {
            val acc = RemoteCommandResultAccumulator()
            acc.accept(begin(tooLarge.size, 2, digest))
            acc.accept(chunk(0, 2, tooLarge))
        }.isFailure)
    }

    @Test fun sealedTerminalResultRestoresExactApplicationValueAndBridgeChunks() {
        val json = """{"markdown":"${"x".repeat(MAX_STREAMED_COMMAND_RESULT_CHUNK_BYTES + 7)}"}"""
        val bytes = json.toByteArray()
        val digest = sha(bytes)
        val restored = restoreCompletedCommandResult(
            StoredCommandResult(streamId, commandId, bytes.size, digest, json),
            StreamedResultMarker(bytes.size, digest),
        )!!
        assertEquals(2, restored.chunks.size)
        assertEquals(
            json,
            restored.chunks.joinToString("") { String(Base64.getDecoder().decode(it), Charsets.UTF_8) },
        )
        assertNull(
            restoreCompletedCommandResult(
                StoredCommandResult(streamId, commandId, bytes.size, digest, json),
                StreamedResultMarker(bytes.size, "0".repeat(64)),
            ),
        )
    }

    @Test fun terminalMarkerRequiresRealBooleanAndClosedFields() {
        assertNull(streamedResultMarker(buildJsonObject { put("streamed", "true") }))
        val marker = streamedResultMarker(buildJsonObject {
            put("streamed", true); put("totalBytes", 7); put("sha256", "a".repeat(64))
        })!!
        assertEquals(7, marker.totalBytes)
        assertTrue(runCatching {
            streamedResultMarker(buildJsonObject {
                put("streamed", true); put("totalBytes", 7); put("sha256", "a".repeat(64)); put("extra", 1)
            })
        }.isFailure)
    }

    private fun begin(total: Int, count: Int, sha: String) = buildJsonObject {
        put("phase", "begin"); put("streamId", streamId); put("commandId", commandId); put("encoding", "base64-json")
        put("totalBytes", total); put("chunkCount", count); put("sha256", sha)
    }

    private fun chunk(index: Int, count: Int, bytes: ByteArray) = buildJsonObject {
        put("phase", "chunk"); put("streamId", streamId); put("commandId", commandId)
        put("index", index); put("chunkCount", count); put("data", Base64.getEncoder().encodeToString(bytes))
    }

    private fun commit(total: Int, count: Int, sha: String) = buildJsonObject {
        put("phase", "commit"); put("streamId", streamId); put("commandId", commandId)
        put("totalBytes", total); put("chunkCount", count); put("sha256", sha)
    }

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
