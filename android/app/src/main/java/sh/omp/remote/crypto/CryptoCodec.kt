package sh.omp.remote.crypto

import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class AuthenticatedHeader(
    val roomId: String,
    val keyEpoch: Long,
    val direction: TrafficDirection,
    val logicalPeerId: Long,
    val counter: ULong,
) {
    init {
        require(Regex("[0-9a-f]{32}").matches(roomId)) { "Invalid room id" }
        require(keyEpoch in 1..UInt.MAX_VALUE.toLong()) { "Invalid key epoch" }
        require(logicalPeerId in 0..UInt.MAX_VALUE.toLong()) { "Invalid peer id" }
    }

    fun nonce(): ByteArray = ByteBuffer.allocate(12)
        .order(ByteOrder.BIG_ENDIAN)
        .putInt(direction.nonceConstant.toInt())
        .putLong(counter.toLong())
        .array()

    /** Canonical 40-byte v1 AAD; integers are unsigned-width, big-endian. */
    fun encode(): ByteArray {
        val room = roomId.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        return ByteBuffer.allocate(40)
            .order(ByteOrder.BIG_ENDIAN)
            .put(byteArrayOf(0x4f, 0x4d, 0x50, 0x31)) // OMP1
            .put(1) // protocol version
            .put(direction.wireId)
            .putShort(0) // reserved flags
            .put(room)
            .putInt(keyEpoch.toInt())
            .putInt(logicalPeerId.toInt())
            .putLong(counter.toLong())
            .array()
    }
}

object CryptoCodec {
    const val MAX_CONTROL_PLAINTEXT_BYTES = 256 * 1024
    const val ATTACHMENT_CHUNK_HEADER_BYTES = 36
    const val MAX_ENCRYPTED_PLAINTEXT_BYTES = MAX_CONTROL_PLAINTEXT_BYTES + ATTACHMENT_CHUNK_HEADER_BYTES
    const val NONCE_BYTES = 12
    const val TAG_BYTES = 16

    /** Returns `[12-byte nonce][ciphertext][16-byte tag]`. */
    fun encrypt(key: ByteArray, header: AuthenticatedHeader, plaintext: ByteArray): ByteArray {
        require(key.size == 32) { "AES-256 requires a 32-byte key" }
        require(plaintext.size <= MAX_ENCRYPTED_PLAINTEXT_BYTES) { "Encrypted plaintext frame is too large" }
        val nonce = header.nonce()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
        cipher.updateAAD(header.encode())
        return nonce + cipher.doFinal(plaintext)
    }

    @Throws(AEADBadTagException::class)
    fun decrypt(key: ByteArray, header: AuthenticatedHeader, sealed: ByteArray): ByteArray {
        require(key.size == 32) { "AES-256 requires a 32-byte key" }
        require(sealed.size in (NONCE_BYTES + TAG_BYTES)..(NONCE_BYTES + TAG_BYTES + MAX_ENCRYPTED_PLAINTEXT_BYTES)) {
            "Encrypted frame has an invalid size"
        }
        val expectedNonce = header.nonce()
        require(sealed.copyOfRange(0, NONCE_BYTES).contentEquals(expectedNonce)) { "Nonce does not match authenticated counter" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, expectedNonce))
        cipher.updateAAD(header.encode())
        return cipher.doFinal(sealed, NONCE_BYTES, sealed.size - NONCE_BYTES)
    }

    fun readCounter(sealed: ByteArray, expectedDirection: TrafficDirection): ULong {
        require(sealed.size >= NONCE_BYTES + TAG_BYTES) { "Encrypted frame is truncated" }
        val nonce = ByteBuffer.wrap(sealed, 0, NONCE_BYTES).order(ByteOrder.BIG_ENDIAN)
        require(nonce.int.toUInt() == expectedDirection.nonceConstant) { "Encrypted frame direction is invalid" }
        return nonce.long.toULong()
    }
}

object RelayEnvelope {
    const val PEER_PREFIX_BYTES = 4

    fun encode(peerId: Long, encryptedPayload: ByteArray): ByteArray {
        require(peerId in 0..UInt.MAX_VALUE.toLong()) { "Invalid peer id" }
        require(encryptedPayload.isNotEmpty()) { "Encrypted payload is empty" }
        return ByteBuffer.allocate(PEER_PREFIX_BYTES + encryptedPayload.size)
            .order(ByteOrder.BIG_ENDIAN)
            .putInt(peerId.toInt())
            .put(encryptedPayload)
            .array()
    }

    fun decode(frame: ByteArray): Pair<Long, ByteArray> {
        require(frame.size > PEER_PREFIX_BYTES) { "Relay envelope is truncated" }
        val buffer = ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN)
        val peer = buffer.int.toUInt().toLong()
        val payload = ByteArray(buffer.remaining())
        buffer.get(payload)
        return peer to payload
    }
}
