package sh.omp.remote.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

data class AttachmentChunk(val attachmentId: UUID, val offset: ULong, val data: ByteArray)

object AttachmentChunkCodec {
    const val HEADER_BYTES = 36
    private const val MAGIC = 0x4f4d5041 // OMPA

    fun encode(value: AttachmentChunk): ByteArray {
        require(value.data.size in 1..MAX_ATTACHMENT_CHUNK_BYTES) { "Attachment chunk must contain 1..256 KiB" }
        return ByteBuffer.allocate(HEADER_BYTES + value.data.size)
            .order(ByteOrder.BIG_ENDIAN)
            .putInt(MAGIC)
            .put(1)
            .put(0)
            .putShort(HEADER_BYTES.toShort())
            .putLong(value.attachmentId.mostSignificantBits)
            .putLong(value.attachmentId.leastSignificantBits)
            .putLong(value.offset.toLong())
            .putInt(value.data.size)
            .put(value.data)
            .array()
    }

    fun decode(bytes: ByteArray): AttachmentChunk {
        require(bytes.size in HEADER_BYTES..(HEADER_BYTES + MAX_ATTACHMENT_CHUNK_BYTES)) { "Attachment chunk size is invalid" }
        val input = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        require(input.int == MAGIC && input.get().toInt() == 1 && input.get().toInt() == 0) { "Attachment chunk header is invalid" }
        require(input.short.toInt() == HEADER_BYTES) { "Attachment chunk header length is invalid" }
        val id = UUID(input.long, input.long)
        val offset = input.long.toULong()
        val length = input.int
        require(length > 0 && length == input.remaining()) { "Attachment chunk data length does not match" }
        return AttachmentChunk(id, offset, ByteArray(length).also(input::get))
    }
}
