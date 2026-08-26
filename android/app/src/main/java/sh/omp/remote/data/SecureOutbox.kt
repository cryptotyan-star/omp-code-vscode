package sh.omp.remote.data

import android.content.Context
import java.math.BigInteger
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sh.omp.remote.protocol.RemoteCommand
import sh.omp.remote.protocol.RemoteCommandValidator
import sh.omp.remote.protocol.StrictProtocolJson
import sh.omp.remote.protocol.parseUint64Decimal

@Serializable
enum class OutboxStatus { QUEUED, ACCEPTED }

@Serializable
data class OutboxItem(
    val command: RemoteCommand,
    val status: OutboxStatus,
    val createdAtEpochMillis: Long,
    /** Bounded renderer correlation, sealed with the command for process-death recovery. */
    val uiKind: String? = null,
    val uiToken: String? = null,
)

@Serializable
private data class OutboxSnapshot(
    val nextCounter: String = "1",
    val items: List<OutboxItem> = emptyList(),
)

class SecureOutbox(context: Context) {
    private val storage = EncryptedBlobStore(
        context.applicationContext,
        alias = "omp.remote.outbox.v1",
        preferencesName = "omp_remote_outbox_sealed",
    )
    private val json = Json(StrictProtocolJson) { ignoreUnknownKeys = false }

    @Synchronized
    fun reserveCounter(): String {
        val snapshot = read()
        val counter = parseUint64Decimal(snapshot.nextCounter)
        require(counter <= UINT64_MAX) { "Command counter exhausted" }
        val next = counter + BigInteger.ONE
        write(snapshot.copy(nextCounter = next.toString()))
        return counter.toString()
    }

    @Synchronized
    fun enqueue(item: OutboxItem) {
        val encoded = json.encodeToString(item.command).toByteArray(Charsets.UTF_8)
        RemoteCommandValidator.validate(item.command, encoded.size)
        require(encoded.size <= 256 * 1024)
        require(item.uiKind == null || item.uiKind in UI_KINDS) { "Unknown outbox UI correlation" }
        require(item.uiToken == null || item.uiToken.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"))) {
            "Invalid outbox UI token"
        }
        val snapshot = read()
        require(snapshot.items.size < MAX_ITEMS) { "Remote outbox is full" }
        require(snapshot.items.none { it.command.commandId.equals(item.command.commandId, true) }) { "Duplicate command id" }
        write(snapshot.copy(items = snapshot.items + item))
    }

    @Synchronized
    fun markAccepted(commandId: String) {
        val snapshot = read()
        write(snapshot.copy(items = snapshot.items.map {
            if (it.command.commandId.equals(commandId, true)) it.copy(status = OutboxStatus.ACCEPTED) else it
        }))
    }

    /** Terminal ACK only; accepted commands remain durable across process recreation. */
    @Synchronized
    fun removeTerminal(commandId: String) {
        val snapshot = read()
        write(snapshot.copy(items = snapshot.items.filterNot { it.command.commandId.equals(commandId, true) }))
    }

    @Synchronized
    fun items(): List<OutboxItem> = read().items

    @Synchronized
    fun clearForRevocation() = storage.destroy()

    private fun read(): OutboxSnapshot {
        val bytes = storage.get(SNAPSHOT) ?: return OutboxSnapshot()
        return try {
            json.decodeFromString<OutboxSnapshot>(bytes.toString(Charsets.UTF_8))
        } finally {
            bytes.fill(0)
        }
    }

    private fun write(snapshot: OutboxSnapshot) {
        storage.put(SNAPSHOT, json.encodeToString(snapshot).toByteArray(Charsets.UTF_8))
    }

    companion object {
        private const val SNAPSHOT = "outbox"
        private const val MAX_ITEMS = 100
        private val UI_KINDS = setOf("prompt", "history", "files", "export", "diagnostics", "models-probe", "approval", "diff")
        private val UINT64_MAX = BigInteger("18446744073709551615")
    }
}
