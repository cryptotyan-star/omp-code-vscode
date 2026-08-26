package sh.omp.remote.protocol

import kotlinx.coroutines.flow.Flow

/** Platform-neutral seam shared renderer code targets instead of VS Code globals. */
interface HostPort {
    val messages: Flow<String>
    suspend fun post(command: RemoteCommand): HostPostResult
    val capabilities: Set<String>
}

sealed interface HostPostResult {
    data class Queued(val commandId: String, val commandCounter: String) : HostPostResult
    data class Rejected(val reason: String) : HostPostResult
}
