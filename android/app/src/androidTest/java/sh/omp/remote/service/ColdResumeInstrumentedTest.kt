package sh.omp.remote.service

import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.Base64
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import sh.omp.remote.MainActivity
import sh.omp.remote.data.DeviceCredential
import sh.omp.remote.data.SecurePairingStore

@RunWith(AndroidJUnit4::class)
class ColdResumeInstrumentedTest {
    @Test fun coldLauncherResumesSealedCredentialWithoutPairingAgain() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = SecurePairingStore(context)
        store.revokeAndDestroyKey()
        val zero32 = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32))
        val one32 = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { 1 })
        store.saveAfterEnrolled(
            DeviceCredential(
                deviceId = "cold-resume-device",
                enrolmentId = "123e4567-e89b-42d3-a456-426614174000",
                relayOrigin = "ws://127.0.0.1:1",
                roomId = "00112233445566778899aabbccddeeff",
                roomMasterKeyBase64Url = zero32,
                deviceTokenBase64Url = one32,
                keyEpoch = 1,
                assignedPeerId = "1",
                hostGeneration = "cold-resume-host",
                capabilityManifest = "{}",
                capabilitySignature = zero32,
                lastSequence = "0",
            ),
        )

        ActivityScenario.launch(MainActivity::class.java).use {
            val deadline = System.nanoTime() + 5_000_000_000L
            while (RemoteSessionService.state.value.phase == RemoteServiceState.Phase.STOPPED && System.nanoTime() < deadline) {
                Thread.sleep(25)
            }
            assertTrue(
                "cold launcher did not start authenticated resume",
                RemoteSessionService.state.value.phase in setOf(
                    RemoteServiceState.Phase.AUTHENTICATING,
                    RemoteServiceState.Phase.RECONNECTING,
                    RemoteServiceState.Phase.ACTIVE,
                ),
            )
        }

        RemoteSessionService.disconnect(context)
        val stoppedDeadline = System.nanoTime() + 5_000_000_000L
        while (RemoteSessionService.state.value.phase != RemoteServiceState.Phase.STOPPED && System.nanoTime() < stoppedDeadline) {
            Thread.sleep(25)
        }
        store.revokeAndDestroyKey()
    }
}
