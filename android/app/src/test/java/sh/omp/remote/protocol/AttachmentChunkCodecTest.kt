package sh.omp.remote.protocol

import java.util.UUID
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentChunkCodecTest {
    @Test fun exactHeaderRoundTripAndMaximumChunk() {
        val id = UUID.fromString("123e4567-e89b-12d3-a456-426614174000")
        val data = ByteArray(MAX_ATTACHMENT_CHUNK_BYTES) { (it and 0xff).toByte() }
        val encoded = AttachmentChunkCodec.encode(AttachmentChunk(id, 42u, data))
        assertEquals(AttachmentChunkCodec.HEADER_BYTES + MAX_ATTACHMENT_CHUNK_BYTES, encoded.size)
        assertEquals("4f4d504101000024123e4567e89b12d3a456426614174000000000000000002a00040000", encoded.copyOfRange(0, 36).hex())
        val decoded = AttachmentChunkCodec.decode(encoded)
        assertEquals(id, decoded.attachmentId)
        assertEquals(42uL, decoded.offset)
        assertArrayEquals(data, decoded.data)
    }

    @Test fun emptyOversizedAndLengthMismatchRejected() {
        val id = UUID.randomUUID()
        assertTrue(runCatching { AttachmentChunkCodec.encode(AttachmentChunk(id, 0u, ByteArray(0))) }.isFailure)
        assertTrue(runCatching { AttachmentChunkCodec.encode(AttachmentChunk(id, 0u, ByteArray(MAX_ATTACHMENT_CHUNK_BYTES + 1))) }.isFailure)
        val valid = AttachmentChunkCodec.encode(AttachmentChunk(id, 0u, byteArrayOf(1, 2, 3)))
        assertTrue(runCatching { AttachmentChunkCodec.decode(valid.copyOf(valid.size - 1)) }.isFailure)
    }

    @Test fun operationalSenderLeavesOpaqueRelayHeadroom() {
        assertEquals(240 * 1024, MAX_ATTACHMENT_SEND_CHUNK_BYTES)
        assertTrue(MAX_ATTACHMENT_SEND_CHUNK_BYTES < MAX_ATTACHMENT_CHUNK_BYTES)
        assertTrue(4 + 12 + AttachmentChunkCodec.HEADER_BYTES + MAX_ATTACHMENT_SEND_CHUNK_BYTES + 16 < 256 * 1024)
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
}
