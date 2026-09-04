package sh.omp.remote.relay

import java.net.URI
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayConnectionTest {
    @Test fun validatesSecureAndLoopbackGuestEndpoints() {
        RelayConnection.validateRelayUri(URI("wss://relay.example/r/00112233445566778899aabbccddeeff?role=guest"))
        RelayConnection.validateRelayUri(URI("ws://localhost:8080/r/00112233445566778899aabbccddeeff?role=guest"))
        assertTrue(runCatching { RelayConnection.validateRelayUri(URI("ws://relay.example/r/00112233445566778899aabbccddeeff?role=guest")) }.isFailure)
        assertTrue(runCatching { RelayConnection.validateRelayUri(URI("wss://relay.example/r/nope?role=guest")) }.isFailure)
        assertTrue(runCatching { RelayConnection.validateRelayUri(URI("wss://relay.example/r/00112233445566778899aabbccddeeff?role=host")) }.isFailure)
    }

    @Test fun wireLimitIncludesMaximumAttachmentHeader() {
        assertEquals(4 + 12 + 36 + 256 * 1024 + 16, RelayConnection.MAX_RELAY_FRAME_BYTES)
    }

    @Test fun onlyProtocolAndAuthorizationCloseCodesAreFatal() {
        assertTrue(RelayConnection.isFatalCloseCode(4400))
        assertTrue(RelayConnection.isFatalCloseCode(4401))
        assertTrue(RelayConnection.isFatalCloseCode(4409))
        assertTrue(!RelayConnection.isFatalCloseCode(1000))
        assertTrue(!RelayConnection.isFatalCloseCode(1012))
    }

    @Test fun automaticReconnectDropsFailedSocketBacklogBeforeFreshFrames() = runBlocking {
        val server = MockWebServer()
        val opens = AtomicInteger()
        val secondOpen = CompletableDeferred<Unit>()
        val secondClosed = CompletableDeferred<Unit>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                opens.incrementAndGet()
                repeat(32) { webSocket.send("old-$it") }
                webSocket.close(1012, "restart")
            }
        }))
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                opens.incrementAndGet()
                webSocket.send("new-socket")
                secondOpen.complete(Unit)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                secondClosed.complete(Unit)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }
        }))
        val connection = RelayConnection(this)
        try {
            val uri = server.url("/r/00112233445566778899aabbccddeeff?role=guest").toString()
                .replaceFirst("http://", "ws://")
            connection.connect(URI(uri))
            withTimeout(5_000) { secondOpen.await() }
            // Start consuming only after the retry. The channel still contains the
            // first socket backlog, which must be rejected by its old socket epoch.
            val event = withTimeout(5_000) { async { connection.events.first() }.await() }
            assertEquals("new-socket", (event as RelayEvent.Text).value)
            assertEquals(2, opens.get())
        } finally {
            connection.close()
            runCatching { withTimeout(2_000) { secondClosed.await() } }
            server.shutdown()
        }
    }
}
