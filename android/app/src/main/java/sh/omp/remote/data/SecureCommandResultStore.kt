package sh.omp.remote.data

import android.content.Context
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sh.omp.remote.protocol.MAX_STREAMED_COMMAND_RESULT_BYTES
import sh.omp.remote.protocol.StrictProtocolJson

@Serializable
data class StoredCommandResult(
    val streamId: String,
    val commandId: String,
    val totalBytes: Int,
    val sha256: String,
    val json: String,
) {
    fun validate(): StoredCommandResult {
        require(streamId.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")))
        require(commandId.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")))
        val bytes = json.toByteArray(Charsets.UTF_8)
        require(totalBytes in 1..MAX_STREAMED_COMMAND_RESULT_BYTES && bytes.size == totalBytes)
        val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        bytes.fill(0)
        require(sha256.matches(Regex("[0-9a-f]{64}")) && actual == sha256)
        StrictProtocolJson.parseToJsonElement(json)
        return this
    }
}

/** One sealed in-flight terminal result; desktop serializes result streams atomically. */
class SecureCommandResultStore(context: Context) {
    private val storage = EncryptedBlobStore(
        context.applicationContext,
        alias = "omp.remote.command-result.v1",
        preferencesName = "omp_remote_command_result_sealed",
    )
    private val json = Json(StrictProtocolJson) { ignoreUnknownKeys = false; encodeDefaults = true }

    @Synchronized
    fun save(value: StoredCommandResult) {
        storage.put(SNAPSHOT, json.encodeToString(value.validate()).toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun load(commandId: String): StoredCommandResult? = storage.get(SNAPSHOT)?.let { bytes ->
        try {
            json.decodeFromString<StoredCommandResult>(bytes.toString(Charsets.UTF_8)).validate()
                .takeIf { it.commandId.equals(commandId, true) }
        } finally {
            bytes.fill(0)
        }
    }

    /** Removes only the matching transaction; a later serialized stream is preserved. */
    @Synchronized
    fun remove(commandId: String) {
        val current = load(commandId) ?: return
        if (current.commandId.equals(commandId, true)) storage.destroy()
    }

    @Synchronized
    fun clear() = storage.destroy()

    companion object { private const val SNAPSHOT = "pending_result" }
}
