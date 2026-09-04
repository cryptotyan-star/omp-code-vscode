package sh.omp.remote.crypto

import javax.crypto.AEADBadTagException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CryptoCodecTest {
    private val master = ByteArray(32) { it.toByte() }
    private val room = "00112233445566778899aabbccddeeff"

    @Test fun exactTypeScriptKnownAnswerVector() {
        val pairKey = HkdfSha256.protocolKey(master, room, 7, KeyPurpose.PAIR, TrafficDirection.DEVICE_TO_HOST)
        val authKey = HkdfSha256.protocolKey(master, room, 7, KeyPurpose.AUTH, TrafficDirection.DEVICE_TO_HOST)
        val traffic = HkdfSha256.connectionTrafficKey(
            master, room, 7,
            hex("000102030405060708090a0b0c0d0e0f"),
            hex("f0e0d0c0b0a090807060504030201000"),
            TrafficDirection.DEVICE_TO_HOST,
        )
        assertEquals("55bdc126ce3788a6cffa467a07bfc5388df77d21216770b56a3226bc59de6a2b", pairKey.hex())
        assertEquals("c6f9e238f1b0093c14225407a833bb680a0e79806518ac29cdfe02540adb576f", authKey.hex())
        assertEquals("379bc9cfccbf5200fcd04fb918ce9a7649be98905fa8912eb95d8d21ef991d17", traffic.hex())

        val header = AuthenticatedHeader(room, 7, TrafficDirection.DEVICE_TO_HOST, 0x10203040, 42u)
        assertEquals("4f4d50310101000000112233445566778899aabbccddeeff0000000710203040000000000000002a", header.encode().hex())
        assertEquals("44324831000000000000002a", header.nonce().hex())
        val plaintext = "{\"protocolVersion\":1,\"type\":\"hello\"}".toByteArray()
        val sealed = CryptoCodec.encrypt(traffic, header, plaintext)
        val envelope = RelayEnvelope.encode(0x10203040, sealed)
        assertEquals(
            "1020304044324831000000000000002ab451ae94cb8dd55060c878af3ca0abbb495de31a389ef77605fef692ea556fe6347d5ebb49323fd2548f0d4a867f1961bd1f8376",
            envelope.hex(),
        )
        assertArrayEquals(plaintext, CryptoCodec.decrypt(traffic, header, sealed))
        assertEquals(42uL, CryptoCodec.readCounter(sealed, TrafficDirection.DEVICE_TO_HOST))
    }

    @Test fun headerCiphertextAndTagTamperingFails() {
        val key = HkdfSha256.protocolKey(master, room, 7, KeyPurpose.TRAFFIC, TrafficDirection.DEVICE_TO_HOST)
        val header = AuthenticatedHeader(room, 7, TrafficDirection.DEVICE_TO_HOST, 9, 3u)
        val sealed = CryptoCodec.encrypt(key, header, "secret".toByteArray())
        val tampered = sealed.copyOf().also { it[it.lastIndex] = (it.last() xor 1) }
        assertTrue(runCatching { CryptoCodec.decrypt(key, header, tampered) }.isFailure)
        assertTrue(runCatching { CryptoCodec.decrypt(key, header.copy(logicalPeerId = 10), sealed) }.isFailure)
        assertTrue(runCatching { CryptoCodec.decrypt(key, header.copy(keyEpoch = 8), sealed) }.isFailure)
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private infix fun Byte.xor(value: Int): Byte = (toInt() xor value).toByte()
}
