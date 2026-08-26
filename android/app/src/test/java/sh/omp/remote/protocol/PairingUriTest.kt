package sh.omp.remote.protocol

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingUriTest {
    private val now = 1_800_000_000_000L
    private val clock = Clock.fixed(Instant.ofEpochMilli(now), ZoneOffset.UTC)
    private val key = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() })
    private val room = "00112233445566778899aabbccddeeff"

    @Test fun parsesCanonicalCrossLanguageFixture() {
        val parsed = PairingUri.parse(
            "omp-code://pair?v=1&relay=wss%3A%2F%2Frelay.example&room=$room&key=$key&expires=${now + 600_000}&epoch=7",
            clock,
        )
        assertEquals("wss://relay.example", parsed.relayOrigin.toString())
        assertEquals(room, parsed.roomId)
        assertEquals(7, parsed.keyEpoch)
        assertTrue(parsed.pairingKey.contentEquals(ByteArray(32) { it.toByte() }))
        assertEquals("wss://relay.example/r/$room?role=guest", parsed.guestWebSocketUri().toString())
        assertTrue("Pairing secret leaked through toString", key !in parsed.toString())
    }

    @Test fun convertsHttpsAndAllowsOnlyLoopbackPlaintext() {
        assertEquals("wss", PairingUri.parse(link("https%3A%2F%2Frelay.example%3A443"), clock).relayOrigin.scheme)
        assertEquals("ws", PairingUri.parse(link("ws%3A%2F%2Flocalhost%3A8080"), clock).relayOrigin.scheme)
        rejects(link("ws%3A%2F%2Frelay.example"))
    }

    @Test fun rejectsNonCanonicalOrAuthorityBearingLinks() {
        listOf(
            link("wss%3A%2F%2Frelay.example") + "&extra=x",
            link("wss%3A%2F%2Frelay.example").replace("&epoch=7", "&epoch=07"),
            link("wss%3A%2F%2Frelay.example").replace("&epoch=7", "&epoch=0"),
            link("wss%3A%2F%2Frelay.example").replace("expires=${now + 600_000}", "expires=0${now + 600_000}"),
            link("wss%3A%2F%2Frelay.example").replace(room, room.uppercase()),
            link("wss%3A%2F%2Frelay.example") + "&room=$room",
            link("wss%3A%2F%2Fuser%40relay.example"),
            "omp-code://other?v=1",
        ).forEach(::rejects)
    }

    @Test fun enforcesExpiryWindow() {
        rejects(link("wss%3A%2F%2Frelay.example").replace("expires=${now + 600_000}", "expires=$now"))
        rejects(link("wss%3A%2F%2Frelay.example").replace("expires=${now + 600_000}", "expires=${now + 600_001}"))
    }

    private fun link(relay: String) =
        "omp-code://pair?v=1&relay=$relay&room=$room&key=$key&expires=${now + 600_000}&epoch=7"

    private fun rejects(raw: String) {
        val result = runCatching { PairingUri.parse(raw, clock) }
        assertTrue("Expected rejection: $raw", result.isFailure)
    }
}
