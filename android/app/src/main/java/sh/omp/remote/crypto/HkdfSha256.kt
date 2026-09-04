package sh.omp.remote.crypto

import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object HkdfSha256 {
    private const val HASH_LENGTH = 32

    fun derive(inputKeyMaterial: ByteArray, salt: ByteArray, info: ByteArray, length: Int = HASH_LENGTH): ByteArray {
        require(inputKeyMaterial.isNotEmpty()) { "Input key material must not be empty" }
        require(length in 1..(255 * HASH_LENGTH)) { "Invalid HKDF output length" }
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(HASH_LENGTH) else salt, "HmacSHA256"))
        val pseudoRandomKey = mac.doFinal(inputKeyMaterial)
        try {
            mac.init(SecretKeySpec(pseudoRandomKey, "HmacSHA256"))
            val output = ByteArray(length)
            var previous = ByteArray(0)
            var written = 0
            var counter = 1
            while (written < length) {
                mac.reset()
                mac.update(previous)
                mac.update(info)
                mac.update(counter.toByte())
                val block = mac.doFinal()
                val count = minOf(block.size, length - written)
                block.copyInto(output, written, 0, count)
                previous.fill(0)
                previous = block
                written += count
                counter++
            }
            previous.fill(0)
            return output
        } finally {
            pseudoRandomKey.fill(0)
        }
    }

    fun protocolKey(
        masterKey: ByteArray,
        roomId: String,
        keyEpoch: Long,
        purpose: KeyPurpose,
        direction: TrafficDirection,
    ): ByteArray {
        require(Regex("[0-9a-f]{32}").matches(roomId)) { "Invalid room id" }
        require(keyEpoch in 1..UInt.MAX_VALUE.toLong()) { "Invalid key epoch" }
        val salt = baseSalt(roomId, keyEpoch)
        val info = directionalInfo(purpose, direction)
        return derive(masterKey, salt, info)
    }

    fun connectionTrafficKey(
        roomMasterKey: ByteArray,
        roomId: String,
        keyEpoch: Long,
        hostNonce: ByteArray,
        deviceNonce: ByteArray,
        direction: TrafficDirection,
    ): ByteArray {
        require(hostNonce.size == 16 && deviceNonce.size == 16) { "Handshake nonces must be 128-bit" }
        val salt = baseSalt(roomId, keyEpoch) +
            "\u0000connection\u0000".toByteArray(StandardCharsets.UTF_8) +
            hostNonce + deviceNonce
        return derive(roomMasterKey, salt, directionalInfo(KeyPurpose.TRAFFIC, direction))
    }

    private fun baseSalt(roomId: String, keyEpoch: Long): ByteArray =
        "omp-code-remote/v1\u0000$roomId\u0000$keyEpoch".toByteArray(StandardCharsets.UTF_8)

    private fun directionalInfo(purpose: KeyPurpose, direction: TrafficDirection): ByteArray =
        "omp-code-remote/v1\u0000${purpose.wire}\u0000${direction.wire}".toByteArray(StandardCharsets.UTF_8)
}

enum class KeyPurpose(val wire: String) {
    PAIR("pair"),
    AUTH("auth"),
    TRAFFIC("traffic"),
}

enum class TrafficDirection(val wire: String, val wireId: Byte, val nonceConstant: UInt) {
    DEVICE_TO_HOST("device-to-host", 1, 0x44324831u),
    HOST_TO_DEVICE("host-to-device", 2, 0x48324431u),
}
