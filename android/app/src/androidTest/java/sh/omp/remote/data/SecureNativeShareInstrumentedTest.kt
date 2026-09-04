package sh.omp.remote.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class SecureNativeShareInstrumentedTest {
    @Test fun processRecreationRestoresPendingButNeverResurrectsConsumedShare() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val first = SecureNativeShareStore(context)
        first.clear()
        val token = "123e4567-e89b-42d3-a456-426614174000"
        val pending = first.savePending(token, "omp-transcript.md", 12, "a".repeat(64), 100)
        assertEquals(NativeShareStatus.PENDING, SecureNativeShareStore(context).load()?.status)
        assertEquals(pending.sha256, SecureNativeShareStore(context).load()?.sha256)

        SecureNativeShareStore(context).markConsumed(token, 200)
        val recreated = SecureNativeShareStore(context).load()
        assertEquals(NativeShareStatus.CONSUMED, recreated?.status)
        assertEquals(200L, recreated?.consumedAtEpochMillis)
        SecureNativeShareStore(context).clear()
        assertNull(SecureNativeShareStore(context).load())
    }

    @Test fun delayedOrConcurrentConsumeCannotConsumeAReplacementExport() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = SecureNativeShareStore(context)
        store.clear()
        val tokenA = "123e4567-e89b-42d3-a456-426614174000"
        val tokenB = "223e4567-e89b-42d3-a456-426614174000"
        store.savePending(tokenA, "omp-transcript.md", 12, "a".repeat(64), 100)
        store.savePending(tokenB, "omp-transcript.md", 13, "b".repeat(64), 200)
        assertNull(store.markConsumed(tokenA, 300))
        assertEquals(NativeShareStatus.PENDING, store.load()?.status)
        assertEquals(tokenB, store.load()?.token)

        store.savePending(tokenA, "omp-transcript.md", 12, "a".repeat(64), 400)
        val start = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val replace = executor.submit {
                start.await()
                store.savePending(tokenB, "omp-transcript.md", 13, "b".repeat(64), 500)
            }
            val staleConsume = executor.submit {
                start.await()
                store.markConsumed(tokenA, 600)
            }
            start.countDown()
            replace.get(5, TimeUnit.SECONDS)
            staleConsume.get(5, TimeUnit.SECONDS)
            assertEquals(tokenB, store.load()?.token)
            assertEquals(NativeShareStatus.PENDING, store.load()?.status)
        } finally {
            executor.shutdownNow()
            store.clear()
        }
    }
}
