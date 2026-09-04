package sh.omp.remote.data

import android.content.Context
import java.net.URI
import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sh.omp.remote.protocol.parseUint64Decimal

@Serializable
data class PendingEnrolment(
    val relayOrigin: String,
    val roomId: String,
    val pairingKeyBase64Url: String,
    val expiresAtEpochMillis: Long,
    val keyEpoch: Long,
    val pairFrameJson: String,
) {
    fun validate(): PendingEnrolment {
        require(Regex("[0-9a-f]{32}").matches(roomId))
        require(pairingKeyBase64Url.matches(Regex("[A-Za-z0-9_-]{43}")))
        val key = Base64.getUrlDecoder().decode(pairingKeyBase64Url)
        require(key.size == 32 && Base64.getUrlEncoder().withoutPadding().encodeToString(key) == pairingKeyBase64Url)
        key.fill(0)
        require(keyEpoch in 1..UInt.MAX_VALUE.toLong() && expiresAtEpochMillis > 0)
        require(pairFrameJson.toByteArray(Charsets.UTF_8).size in 1..256 * 1024)
        return this
    }
}

@Serializable
data class DeviceCredential(
    val deviceId: String,
    val enrolmentId: String,
    val relayOrigin: String,
    val roomId: String,
    val roomMasterKeyBase64Url: String,
    val deviceTokenBase64Url: String,
    val keyEpoch: Long,
    val assignedPeerId: String,
    val hostGeneration: String,
    val capabilityManifest: String,
    val capabilitySignature: String,
    val lastSequence: String = "0",
) {
    override fun toString(): String =
        "DeviceCredential(deviceId=$deviceId, room=${roomId.take(8)}…, epoch=$keyEpoch, secrets=<redacted>)"

    fun validate(): DeviceCredential {
        require(deviceId.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")))
        require(enrolmentId.matches(Regex("[0-9a-fA-F-]{36}")))
        require(Regex("[0-9a-f]{32}").matches(roomId))
        require(keyEpoch in 1..UInt.MAX_VALUE.toLong())
        require(decode32(roomMasterKeyBase64Url).size == 32)
        require(decode32(deviceTokenBase64Url).size == 32)
        require(parseUint64Decimal(assignedPeerId) <= UInt.MAX_VALUE.toLong().toBigInteger())
        val relay = URI(relayOrigin)
        require(relay.scheme == "wss" || (relay.scheme == "ws" && relay.host in LOOPBACKS))
        require(relay.userInfo == null && relay.query == null && relay.fragment == null)
        require(hostGeneration.length in 1..128)
        require(capabilityManifest.toByteArray().size <= 64 * 1024)
        require(decode32(capabilitySignature).size == 32)
        parseUint64Decimal(lastSequence)
        return this
    }

    fun roomMasterKey(): ByteArray = decode32(roomMasterKeyBase64Url)
    fun deviceToken(): ByteArray = decode32(deviceTokenBase64Url)

    private fun decode32(value: String): ByteArray {
        require(value.matches(Regex("[A-Za-z0-9_-]{43}")))
        val decoded = Base64.getUrlDecoder().decode(value)
        require(Base64.getUrlEncoder().withoutPadding().encodeToString(decoded) == value)
        return decoded
    }

    companion object {
        private val LOOPBACKS = setOf("localhost", "127.0.0.1", "::1", "[::1]")
    }
}

class SecurePairingStore(context: Context) {
    private val storage = EncryptedBlobStore(
        context.applicationContext,
        alias = "omp.remote.device.v1",
        preferencesName = "omp_remote_device_sealed",
    )
    private val json = Json { ignoreUnknownKeys = false; encodeDefaults = true }

    @Synchronized
    fun saveAfterEnrolled(credential: DeviceCredential) {
        val validated = credential.validate()
        storage.put(CREDENTIAL, json.encodeToString(validated).toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun load(): DeviceCredential? =
        readSealed(CREDENTIAL) { json.decodeFromString<DeviceCredential>(it).validate() }

    @Synchronized
    fun savePending(value: PendingEnrolment) {
        storage.put(PENDING, json.encodeToString(value.validate()).toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun loadPending(): PendingEnrolment? =
        readSealed(PENDING) { json.decodeFromString<PendingEnrolment>(it).validate() }

    /**
     * Decode one sealed blob, or drop it.
     *
     * A blob that no longer decodes -- written by an older build of this app, or
     * failing its own `validate()` -- is unusable either way. Leaving it in place was
     * fatal rather than merely useless: the decode runs on the main thread inside
     * `Service.onStartCommand` on every cold start, so a throw killed the process on
     * launch, forever, with nothing in the app able to clear it. Discarding it costs
     * one re-pairing. Keeping it cost the whole app.
     *
     * Nothing unvalidated is ever returned: the decoder runs `validate()` itself, and
     * a failure yields null, never a partially-trusted credential.
     */
    private fun <T> readSealed(name: String, decode: (String) -> T): T? {
        val bytes = storage.get(name) ?: return null
        val text = try {
            bytes.toString(Charsets.UTF_8)
        } finally {
            bytes.fill(0)
        }
        return runCatching { decode(text) }.getOrElse {
            storage.remove(name)
            null
        }
    }

    @Synchronized
    fun clearPending() = storage.remove(PENDING)

    @Synchronized
    fun clearCredential() = storage.remove(CREDENTIAL)

    @Synchronized
    fun revokeAndDestroyKey() = storage.destroy()

    companion object {
        private const val CREDENTIAL = "active_credential"
        private const val PENDING = "pending_enrolment"
    }
}
