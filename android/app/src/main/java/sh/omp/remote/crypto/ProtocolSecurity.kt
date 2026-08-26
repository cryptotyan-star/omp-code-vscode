package sh.omp.remote.crypto

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import sh.omp.remote.protocol.CapabilityManifest
import sh.omp.remote.protocol.StrictProtocolJson

object ProtocolSecurity {
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    fun canonicalJsonBytes(value: JsonElement): ByteArray = canonicalize(value).toByteArray(Charsets.UTF_8)

    fun handshakeProof(authKey: ByteArray, transcript: JsonArray): ByteArray {
        require(authKey.size == 32)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(authKey, "HmacSHA256"))
        mac.update("omp-code-remote/v1\u0000handshake\u0000".toByteArray(Charsets.UTF_8))
        return mac.doFinal(canonicalJsonBytes(transcript))
    }

    fun verifyCapabilitySignature(authKey: ByteArray, manifest: CapabilityManifest, signature: String): Boolean {
        val supplied = decodeCanonical(signature, 32) ?: return false
        val canonicalManifest = JsonObject(
            StrictProtocolJson.encodeToJsonElement(CapabilityManifest.serializer(), manifest).jsonObject.toMutableMap().apply {
                this["verbs"] = JsonArray(manifest.verbs.sorted().map(::JsonPrimitive))
                this["sessionIds"] = JsonArray(manifest.sessionIds.sorted().map(::JsonPrimitive))
                this["workspaceRoots"] = JsonArray(manifest.workspaceRoots.sorted().map(::JsonPrimitive))
            },
        )
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(authKey, "HmacSHA256"))
        val expected = mac.doFinal(canonicalJsonBytes(canonicalManifest))
        return MessageDigest.isEqual(expected, supplied).also { expected.fill(0); supplied.fill(0) }
    }

    fun credentialDigest(roomId: String, keyEpoch: Long, deviceId: String, roomKey: ByteArray, deviceToken: ByteArray): String {
        require(Regex("[0-9a-f]{32}").matches(roomId) && keyEpoch in 1..UInt.MAX_VALUE.toLong())
        require(roomKey.size == 32 && deviceToken.size == 32)
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update("omp-code-remote/v1\u0000credential\u0000$roomId\u0000$keyEpoch\u0000$deviceId\u0000".toByteArray(Charsets.UTF_8))
        digest.update(roomKey)
        digest.update(deviceToken)
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun encodeBase64Url(bytes: ByteArray): String = encoder.encodeToString(bytes)

    fun decodeCanonical(value: String, expectedBytes: Int): ByteArray? = runCatching {
        val bytes = decoder.decode(value)
        require(bytes.size == expectedBytes && encoder.encodeToString(bytes) == value)
        bytes
    }.getOrNull()

    private fun canonicalize(value: JsonElement): String = when (value) {
        JsonNull -> "null"
        is JsonPrimitive -> value.toString()
        is JsonArray -> value.joinToString(prefix = "[", postfix = "]", separator = ",") { canonicalize(it) }
        is JsonObject -> value.entries.sortedBy { it.key }.joinToString(prefix = "{", postfix = "}", separator = ",") {
            "${JsonPrimitive(it.key)}:${canonicalize(it.value)}"
        }
    }
}
