package sh.omp.remote.protocol

import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteSyncAccumulatorTest {
    @Test fun rebuildsTranscriptLargerThan256KiBIncrementally() {
        val accumulator = RemoteSyncAccumulator()
        val messages = List(320) { index ->
            buildJsonObject {
                put("role", if (index % 2 == 0) "user" else "assistant")
                put("content", "$index:${"Ж".repeat(700)}")
            }
        }
        assertTrue(JsonArray(messages).toString().toByteArray().size > 256 * 1024)
        accumulator.accept(begin("sync-1"))
        accumulator.accept(reset("sync-1"))
        sections("sync-1").forEach(accumulator::accept)
        val rebuilt = mutableListOf<JsonElement>()
        messages.chunked(40).forEachIndexed { index, chunk ->
            val packet = buildJsonObject {
                put("phase", "transcript"); put("syncId", "sync-1"); put("sessionId", "session-1")
                put("chunkIndex", index); put("messages", JsonArray(chunk))
            }
            assertTrue(packet.toString().toByteArray().size <= MAX_REMOTE_SYNC_PAYLOAD_BYTES)
            val action = accumulator.accept(packet).single() as RemoteSyncAction.Transcript
            rebuilt.addAll(action.messages)
        }
        accumulator.accept(sessionComplete("sync-1"))
        assertTrue(accumulator.accept(buildJsonObject { put("phase", "complete"); put("syncId", "sync-1") }).single() is RemoteSyncAction.Complete)
        assertEquals(messages, rebuilt)
    }

    @Test fun validatesAndForwardsOversizedTranscriptMessageAsBoundedFragments() {
        val accumulator = RemoteSyncAccumulator()
        accumulator.accept(begin("sync-2"))
        accumulator.accept(reset("sync-2"))
        sections("sync-2").forEach(accumulator::accept)
        val message = buildJsonObject { put("role", "assistant"); put("content", "x".repeat(400_000)) }
        val bytes = message.toString().toByteArray(Charsets.UTF_8)
        val pieces = bytes.asList().chunked(96 * 1024).map { chunk ->
            Base64.getEncoder().encodeToString(chunk.toByteArray())
        }
        var completed: RemoteSyncAction.TranscriptFragments? = null
        pieces.forEachIndexed { index, data ->
            val actions = accumulator.accept(buildJsonObject {
                put("phase", "transcript-fragment"); put("syncId", "sync-2"); put("sessionId", "session-1")
                put("encoding", "base64-json"); put("fragmentIndex", index); put("fragmentCount", pieces.size)
                put("data", data); put("messageIndex", 0)
            })
            if (actions.isNotEmpty()) completed = actions.single() as RemoteSyncAction.TranscriptFragments
        }
        val result = requireNotNull(completed)
        assertEquals(bytes.size, result.totalBytes)
        assertEquals(pieces, result.fragments)
        assertEquals(MessageDigest.getInstance("SHA-256").digest(bytes).hex(), result.sha256)
    }

    @Test fun rejectsMissingOrConflictingFragmentsAndAllowsFreshBegin() {
        val accumulator = RemoteSyncAccumulator()
        accumulator.accept(begin("sync-a"))
        accumulator.accept(reset("sync-a"))
        val value = JsonPrimitive("x".repeat(110_000)).toString().toByteArray()
        val pieces = value.asList().chunked(96 * 1024).map { Base64.getEncoder().encodeToString(it.toByteArray()) }
        accumulator.accept(sectionFragment("sync-a", 0, pieces.size, pieces[0]))
        assertTrue(runCatching { accumulator.accept(sectionFragment("sync-a", 0, pieces.size, pieces[0])) }.isFailure)

        val begin = accumulator.accept(begin("sync-b")).single() as RemoteSyncAction.Begin
        assertEquals("sync-b", begin.syncId)
        assertTrue(runCatching { accumulator.accept(reset("sync-a")) }.isFailure)
    }

    @Test fun fragmentedApprovalsRetainValidatedNativeValue() {
        val accumulator = RemoteSyncAccumulator()
        accumulator.accept(begin("sync-approvals"))
        accumulator.accept(reset("sync-approvals"))
        RemoteSyncAccumulator.SECTION_NAMES.dropLast(1).forEach { name ->
            accumulator.accept(section("sync-approvals", name, JsonNull))
        }
        val approvals = buildJsonArray {
            add(buildJsonObject { put("type", "extension_ui_request"); put("id", "ask-1"); put("method", "confirm") })
        }
        val bytes = approvals.toString().toByteArray()
        val encoded = Base64.getEncoder().encodeToString(bytes)
        val action = accumulator.accept(buildJsonObject {
            put("phase", "section-fragment"); put("syncId", "sync-approvals"); put("sessionId", "session-1")
            put("encoding", "base64-json"); put("fragmentIndex", 0); put("fragmentCount", 1)
            put("data", encoded); put("section", "approvals")
        }).single() as RemoteSyncAction.SectionFragments
        assertEquals(approvals, action.validatedValue)
    }

    @Test fun acceptsBoundedSessionLimitNoticeAfterBegin() {
        val accumulator = RemoteSyncAccumulator()
        accumulator.accept(begin("sync-notice", 128))
        val action = accumulator.accept(buildJsonObject {
            put("phase", "notice"); put("syncId", "sync-notice"); put("code", "session-limit")
            put("totalSessions", 130); put("includedSessions", 128); put("omittedSessions", 2)
        }).single() as RemoteSyncAction.Notice
        assertEquals(2, action.omittedSessions)
        accumulator.accept(reset("sync-notice"))
    }

    private fun begin(syncId: String, sessionCount: Int = 1): JsonObject = buildJsonObject {
        put("phase", "begin"); put("syncId", syncId); put("selectedSessionId", "session-1")
        put("sessions", buildJsonArray {
            repeat(sessionCount) { index ->
                val id = "session-${index + 1}"
                add(buildJsonObject {
                put("sessionId", id)
                put("session", buildJsonObject {
                    put("id", id); put("title", "Test"); put("cwd", "/tmp/project")
                    put("model", "model"); put("provider", "provider"); put("status", "idle")
                    put("cost", 0.0); put("closable", true)
                })
            })
            }
        })
    }

    private fun reset(syncId: String): JsonObject = buildJsonObject {
        put("phase", "reset"); put("syncId", syncId); put("sessionId", "session-1")
    }

    private fun section(syncId: String, name: String, value: JsonElement): JsonObject = buildJsonObject {
        put("phase", "section"); put("syncId", syncId); put("sessionId", "session-1")
        put("section", name); put("value", value)
    }

    private fun sections(syncId: String): List<JsonObject> = RemoteSyncAccumulator.SECTION_NAMES.map { name ->
        section(syncId, name, if (name == "approvals") JsonArray(emptyList()) else JsonNull)
    }

    private fun sectionFragment(syncId: String, index: Int, count: Int, data: String): JsonObject = buildJsonObject {
        put("phase", "section-fragment"); put("syncId", syncId); put("sessionId", "session-1")
        put("encoding", "base64-json"); put("fragmentIndex", index); put("fragmentCount", count)
        put("data", data); put("section", "state")
    }

    private fun sessionComplete(syncId: String): JsonObject = buildJsonObject {
        put("phase", "session-complete"); put("syncId", syncId); put("sessionId", "session-1")
    }

    private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }
}
