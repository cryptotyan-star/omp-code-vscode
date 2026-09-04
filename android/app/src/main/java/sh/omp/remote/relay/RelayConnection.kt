package sh.omp.remote.relay

import java.net.URI
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

sealed interface RelayState {
    data object Idle : RelayState
    data class Connecting(val attempt: Int) : RelayState
    data object Connected : RelayState
    data class Reconnecting(val attempt: Int, val delayMillis: Long) : RelayState
    data object Offline : RelayState
    data class Closed(val reason: String) : RelayState
}

sealed interface RelayEvent {
    data class Text(val value: String) : RelayEvent
    data class Binary(val value: ByteArray) : RelayEvent
}

class RelayConnection(
    private val scope: CoroutineScope,
    private val client: OkHttpClient = defaultClient(),
    private val random: Random = Random.Default,
) : AutoCloseable {
    private val _state = MutableStateFlow<RelayState>(RelayState.Idle)
    val state: StateFlow<RelayState> = _state.asStateFlow()

    private val eventQueue = Channel<QueuedRelayEvent>(capacity = EVENT_QUEUE_CAPACITY)
    val events: Flow<RelayEvent> = eventQueue.receiveAsFlow().mapNotNull { queued ->
        queued.event.takeIf { queued.generation == generation }
    }

    @Volatile private var requestedUri: URI? = null
    @Volatile private var socket: WebSocket? = null
    @Volatile private var networkAvailable = true
    private var reconnectJob: Job? = null
    /** Unique socket epoch. It changes for every open, including automatic retries. */
    @Volatile private var generation = 0L
    private var attempt = 0

    @Synchronized
    fun connect(uri: URI) {
        validateRelayUri(uri)
        requestedUri = uri
        generation++
        attempt = 0
        reconnectJob?.cancel()
        socket?.cancel()
        open(generation)
    }

    fun sendBinary(frame: ByteArray): Boolean {
        require(frame.size in 1..MAX_RELAY_FRAME_BYTES) { "Relay frame size is invalid" }
        return socket?.send(ByteString.of(*frame)) == true
    }

    fun sendControlJson(json: String): Boolean {
        require(json.toByteArray(Charsets.UTF_8).size in 1..MAX_CONTROL_BYTES) { "Relay control is too large" }
        return socket?.send(json) == true
    }

    @Synchronized
    fun updateNetworkAvailability(available: Boolean) {
        networkAvailable = available
        if (!available) {
            reconnectJob?.cancel()
            socket?.cancel()
            socket = null
            generation++ // invalidate queued callbacks/frames immediately
            _state.value = RelayState.Offline
        } else if (requestedUri != null && _state.value !is RelayState.Connected) {
            generation++
            attempt = 0
            open(generation)
        }
    }

    @Synchronized
    fun disconnect(reason: String = "user") {
        requestedUri = null
        generation++
        reconnectJob?.cancel()
        reconnectJob = null
        socket?.close(1000, reason.take(120))
        socket = null
        _state.value = RelayState.Closed(reason)
    }

    @Synchronized
    private fun open(expectedGeneration: Long) {
        val uri = requestedUri ?: return
        if (!networkAvailable || expectedGeneration != generation) return
        val currentAttempt = ++attempt
        _state.value = RelayState.Connecting(currentAttempt)
        val request = Request.Builder()
            .url(uri.toASCIIString())
            .header("User-Agent", "OMP-Code-Remote-Android/0.1")
            .build()
        socket = client.newWebSocket(request, listener(expectedGeneration))
    }

    private fun listener(expectedGeneration: Long) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(this@RelayConnection) {
                if (expectedGeneration != generation || requestedUri == null) {
                    webSocket.close(1000, "superseded")
                    return
                }
                socket = webSocket
                attempt = 0
                _state.value = RelayState.Connected
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (isCurrentSocket(expectedGeneration, webSocket) && text.toByteArray(Charsets.UTF_8).size <= MAX_CONTROL_BYTES) {
                enqueue(expectedGeneration, webSocket, RelayEvent.Text(text))
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (isCurrentSocket(expectedGeneration, webSocket) && bytes.size in 1..MAX_RELAY_FRAME_BYTES) {
                enqueue(expectedGeneration, webSocket, RelayEvent.Binary(bytes.toByteArray()))
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            handleTermination(expectedGeneration, webSocket, code, reason)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            handleTermination(expectedGeneration, webSocket, null, t.message ?: "relay failure")
        }
    }

    private fun enqueue(expectedGeneration: Long, webSocket: WebSocket, event: RelayEvent) {
        if (eventQueue.trySend(QueuedRelayEvent(expectedGeneration, event)).isSuccess) return
        // OkHttp callbacks cannot suspend. Overflow is explicit and recoverable:
        // tear down this socket so sequence recovery/full-sync runs, never drop
        // an authenticated frame while pretending it was delivered.
        synchronized(this) {
            if (!isCurrentSocket(expectedGeneration, webSocket)) return
            webSocket.cancel()
            socket = null
            scheduleReconnect(expectedGeneration)
        }
    }

    @Synchronized
    private fun handleTermination(
        expectedGeneration: Long,
        candidate: WebSocket,
        code: Int?,
        reason: String,
    ) {
        if (!isCurrentSocket(expectedGeneration, candidate)) return
        socket = null
        if (code != null && isFatalCloseCode(code)) {
            requestedUri = null
            generation++
            reconnectJob?.cancel()
            reconnectJob = null
            _state.value = RelayState.Closed("Relay rejected the connection ($code): ${reason.take(120)}")
            return
        }
        // A normal 1000 close is only terminal when disconnect() cleared
        // requestedUri first. Otherwise it is an unexpected server close.
        scheduleReconnect(expectedGeneration)
    }

    @Synchronized
    private fun scheduleReconnect(expectedGeneration: Long) {
        if (expectedGeneration != generation || requestedUri == null || !networkAvailable) return
        if (reconnectJob?.isActive == true) return
        socket = null
        val retry = min(attempt + 1, MAX_BACKOFF_EXPONENT)
        val base = min(MAX_BACKOFF_MILLIS, INITIAL_BACKOFF_MILLIS shl (retry - 1))
        val jittered = (base * random.nextDouble(0.8, 1.2)).toLong().coerceAtLeast(250)
        _state.value = RelayState.Reconnecting(retry, jittered)
        reconnectJob = scope.launch {
            delay(jittered)
            synchronized(this@RelayConnection) {
                reconnectJob = null
                if (expectedGeneration == generation) {
                    // A retry is a new cryptographic transport boundary. Increment
                    // before opening so queued frames from the failed socket cannot
                    // enter the fresh handshake state machine.
                    generation++
                    open(generation)
                }
            }
        }
    }

    @Synchronized
    private fun isCurrentSocket(expectedGeneration: Long, candidate: WebSocket): Boolean =
        expectedGeneration == generation && requestedUri != null && socket === candidate

    override fun close() = disconnect("closed")

    private data class QueuedRelayEvent(val generation: Long, val event: RelayEvent)

    companion object {
        const val MAX_CONTROL_BYTES = 256 * 1024
        const val MAX_RELAY_FRAME_BYTES = 4 + 12 + 36 + 256 * 1024 + 16
        private const val EVENT_QUEUE_CAPACITY = 256
        private const val INITIAL_BACKOFF_MILLIS = 1_000L
        private const val MAX_BACKOFF_MILLIS = 30_000L
        private const val MAX_BACKOFF_EXPONENT = 6

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        fun validateRelayUri(uri: URI) {
            val loopback = uri.host in setOf("localhost", "127.0.0.1", "::1", "[::1]")
            require(uri.scheme == "wss" || (uri.scheme == "ws" && loopback)) { "Relay transport must be secure" }
            require(uri.userInfo == null && uri.fragment == null) { "Relay URI contains forbidden data" }
            require(Regex("/r/[0-9a-f]{32}").matches(uri.path)) { "Relay room path is invalid" }
            require(uri.rawQuery == "role=guest") { "Relay role must be guest" }
        }

        fun isFatalCloseCode(code: Int): Boolean = code in setOf(4400, 4401, 4409)
    }
}
