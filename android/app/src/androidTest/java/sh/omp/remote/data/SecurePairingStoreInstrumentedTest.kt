package sh.omp.remote.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SecurePairingStoreInstrumentedTest {
    @Test fun keystoreSealedPendingEnrollmentRoundTripsAndClears() {
        val store = SecurePairingStore(ApplicationProvider.getApplicationContext())
        store.revokeAndDestroyKey()
        val pending = PendingEnrolment(
            relayOrigin = "wss://relay.example",
            roomId = "00112233445566778899aabbccddeeff",
            pairingKeyBase64Url = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            expiresAtEpochMillis = 2_000_000_000_000,
            keyEpoch = 7,
            pairFrameJson = """{"protocolVersion":1,"type":"pair"}""",
        )
        store.savePending(pending)
        assertEquals(pending, store.loadPending())
        store.clearPending()
        assertNull(store.loadPending())
        store.revokeAndDestroyKey()
    }

    /**
     * A sealed blob this build cannot decode must be dropped, not thrown over.
     *
     * `load()` runs on the main thread inside `Service.onStartCommand` on every cold
     * start. When a blob written by an older build failed `decodeFromString` or
     * `validate()`, the exception killed the process before any UI existed — and since
     * nothing cleared the blob, it killed it again on the next launch, forever. The
     * only escape was uninstalling the app.
     */
    @Test fun anUndecodableSealedBlobIsDiscardedInsteadOfThrowing() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = SecurePairingStore(context)
        store.revokeAndDestroyKey()

        // Sealed correctly, so it decrypts — but the plaintext is not this build's schema,
        // which is exactly the shape an upgrade from an older release leaves behind.
        val sealedStore = EncryptedBlobStore(
            context,
            alias = "omp.remote.device.v1",
            preferencesName = "omp_remote_device_sealed",
        )
        sealedStore.put("active_credential", """{"deviceId":"d","goneField":1}""".toByteArray())
        sealedStore.put("pending_enrolment", """not json at all""".toByteArray())

        assertNull(store.load())
        assertNull(store.loadPending())
        // Discarded, not merely rejected: a second read finds nothing left to fail on.
        assertNull(sealedStore.get("active_credential"))
        assertNull(sealedStore.get("pending_enrolment"))

        store.revokeAndDestroyKey()
    }

    /** A blob that decodes but fails its own validate() is equally unusable. */
    @Test fun aSealedBlobFailingValidationIsAlsoDiscarded() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = SecurePairingStore(context)
        store.revokeAndDestroyKey()
        val sealedStore = EncryptedBlobStore(
            context,
            alias = "omp.remote.device.v1",
            preferencesName = "omp_remote_device_sealed",
        )
        // Every field present and well-typed; roomId is not 32 lowercase hex, so
        // PendingEnrolment.validate() rejects it.
        sealedStore.put(
            "pending_enrolment",
            """{"relayOrigin":"wss://relay.example","roomId":"NOT-HEX","pairingKeyBase64Url":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","expiresAtEpochMillis":2000000000000,"keyEpoch":7,"pairFrameJson":"{}"}""".toByteArray(),
        )

        assertNull(store.loadPending())
        assertNull(sealedStore.get("pending_enrolment"))

        store.revokeAndDestroyKey()
    }
}
