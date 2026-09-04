package sh.omp.remote.protocol

import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import sh.omp.remote.data.OutboxItem
import sh.omp.remote.data.OutboxStatus
import sh.omp.remote.data.SecureOutbox

class AndroidHostPort(
    private val outbox: SecureOutbox,
    private val onQueued: () -> Unit = {},
) : HostPort {
    private val inbound = MutableSharedFlow<String>(extraBufferCapacity = 128)
    override val messages: Flow<String> = inbound.asSharedFlow()
    override val capabilities: Set<String> = setOf("webMessage", "files", "share", "notifications", "sessions")

    override suspend fun post(command: RemoteCommand): HostPostResult = runCatching {
        enqueue(command, null, null)
    }.getOrElse { HostPostResult.Rejected(it.message ?: "Command validation failed") }

    suspend fun post(command: RemoteCommand, uiKind: String?, uiToken: String?): HostPostResult = runCatching {
        enqueue(command, uiKind, uiToken)
    }.getOrElse { HostPostResult.Rejected(it.message ?: "Command validation failed") }

    private fun enqueue(command: RemoteCommand, uiKind: String?, uiToken: String?): HostPostResult {
        val encoded = StrictProtocolJson.encodeToString(command)
        RemoteCommandValidator.validate(command, encoded.toByteArray(Charsets.UTF_8).size)
        outbox.enqueue(OutboxItem(command, OutboxStatus.QUEUED, System.currentTimeMillis(), uiKind, uiToken))
        onQueued()
        return HostPostResult.Queued(command.commandId, command.commandCounter)
    }

    fun createCommand(
        hostGeneration: String,
        sessionId: String?,
        command: String,
        payload: JsonObject,
    ): RemoteCommand = RemoteCommand(
        commandId = UUID.randomUUID().toString(),
        commandCounter = outbox.reserveCounter(),
        hostGeneration = hostGeneration,
        sessionId = sessionId,
        command = command,
        payload = payload,
    )

    fun deliverHostMessage(json: String): Boolean {
        require(json.toByteArray(Charsets.UTF_8).size <= MAX_JSON_FRAME_BYTES)
        return inbound.tryEmit(json)
    }
}
