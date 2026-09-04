package sh.omp.remote.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SecureCommandResultInstrumentedTest {
    @Test fun committedPrivateResultSurvivesProcessStoreRecreationUntilMatchingTerminalAck() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val json = """{"files":[{"path":"README.md"}]}"""
        val bytes = json.toByteArray()
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val commandId = "123e4567-e89b-42d3-a456-426614174000"
        val value = StoredCommandResult("stream-1", commandId, bytes.size, digest, json)
        val first = SecureCommandResultStore(context)
        first.clear()
        first.save(value)
        assertEquals(value, SecureCommandResultStore(context).load(commandId))
        SecureCommandResultStore(context).remove("223e4567-e89b-42d3-a456-426614174000")
        assertEquals(value, SecureCommandResultStore(context).load(commandId))
        SecureCommandResultStore(context).remove(commandId)
        assertNull(SecureCommandResultStore(context).load(commandId))
        bytes.fill(0)
    }
}
