package sh.omp.remote.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import sh.omp.remote.protocol.RemoteCommand

@RunWith(AndroidJUnit4::class)
class SecureOutboxInstrumentedTest {
    @Test fun sealedUiCorrelationSurvivesStoreRecreationUntilTerminalAck() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val first = SecureOutbox(context)
        first.clearForRevocation()
        val command = RemoteCommand(
            commandId = "123e4567-e89b-42d3-a456-426614174000",
            commandCounter = first.reserveCounter(),
            hostGeneration = "host-1",
            sessionId = "session-1",
            command = "files.search",
            payload = buildJsonObject { put("query", "README"); put("maxResults", 50) },
        )
        first.enqueue(
            OutboxItem(
                command = command,
                status = OutboxStatus.QUEUED,
                createdAtEpochMillis = 1,
                uiKind = "files",
                uiToken = "picker-token-1",
            ),
        )

        val restored = SecureOutbox(context).items().single()
        assertEquals("files", restored.uiKind)
        assertEquals("picker-token-1", restored.uiToken)
        SecureOutbox(context).removeTerminal(command.commandId)
        assertEquals(emptyList<OutboxItem>(), SecureOutbox(context).items())
        SecureOutbox(context).clearForRevocation()
    }
}
