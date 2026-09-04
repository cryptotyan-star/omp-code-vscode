package sh.omp.remote.service

import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeExportInstrumentedTest {
    @Test fun privateMarkdownCacheIsExposedOnlyAsGrantableContentUri() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.cacheDir, "remote-share").apply { mkdirs() }
        val file = File(directory, "omp-transcript.md")
        file.writeText("# encrypted transcript")
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            assertEquals("content", uri.scheme)
            assertEquals("${context.packageName}.files", uri.authority)
            val content = context.contentResolver.openInputStream(uri)!!.use { it.readBytes().toString(Charsets.UTF_8) }
            assertEquals("# encrypted transcript", content)
        } finally {
            file.delete()
            directory.delete()
        }
    }
}
