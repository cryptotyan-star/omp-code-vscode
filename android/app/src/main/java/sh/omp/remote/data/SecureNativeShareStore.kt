package sh.omp.remote.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sh.omp.remote.protocol.MAX_STREAMED_COMMAND_RESULT_BYTES
import sh.omp.remote.protocol.StrictProtocolJson

@Serializable
enum class NativeShareStatus { PENDING, CONSUMED }

@Serializable
data class NativeShareRecord(
    val token: String,
    val fileName: String,
    val totalBytes: Int,
    val sha256: String,
    val status: NativeShareStatus,
    val createdAtEpochMillis: Long,
    val consumedAtEpochMillis: Long? = null,
) {
    fun validate(): NativeShareRecord {
        require(token.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")))
        require(fileName == "omp-transcript.md")
        require(totalBytes in 1..MAX_STREAMED_COMMAND_RESULT_BYTES)
        require(sha256.matches(Regex("[0-9a-f]{64}")))
        require(createdAtEpochMillis > 0)
        require((status == NativeShareStatus.PENDING) == (consumedAtEpochMillis == null))
        consumedAtEpochMillis?.let { require(it >= createdAtEpochMillis) }
        return this
    }
}

/** Sealed lifecycle marker; the transcript bytes themselves remain in app-private cache. */
class SecureNativeShareStore(context: Context) {
    private val storage = EncryptedBlobStore(
        context.applicationContext,
        alias = "omp.remote.native-share.v1",
        preferencesName = "omp_remote_native_share_sealed",
    )
    private val json = Json(StrictProtocolJson) { ignoreUnknownKeys = false; encodeDefaults = true }

    @Synchronized
    fun savePending(token: String, fileName: String, totalBytes: Int, sha256: String, now: Long): NativeShareRecord {
        val record = NativeShareRecord(token, fileName, totalBytes, sha256, NativeShareStatus.PENDING, now).validate()
        storage.put(SNAPSHOT, json.encodeToString(record).toByteArray(Charsets.UTF_8))
        return record
    }

    @Synchronized
    fun markConsumed(expectedToken: String, now: Long): NativeShareRecord? {
        val pending = load()?.takeIf { it.status == NativeShareStatus.PENDING } ?: return null
        if (pending.token != expectedToken) return null
        val consumed = pending.copy(status = NativeShareStatus.CONSUMED, consumedAtEpochMillis = maxOf(now, pending.createdAtEpochMillis)).validate()
        storage.put(SNAPSHOT, json.encodeToString(consumed).toByteArray(Charsets.UTF_8))
        return consumed
    }

    @Synchronized
    fun load(): NativeShareRecord? = storage.get(SNAPSHOT)?.let { bytes ->
        try {
            json.decodeFromString<NativeShareRecord>(bytes.toString(Charsets.UTF_8)).validate()
        } finally {
            bytes.fill(0)
        }
    }

    @Synchronized
    fun clear() = storage.destroy()

    companion object { private const val SNAPSHOT = "native_share" }
}
