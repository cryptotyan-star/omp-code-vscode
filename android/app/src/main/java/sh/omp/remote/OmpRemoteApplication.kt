package sh.omp.remote

import android.app.Application
import android.webkit.WebView

class OmpRemoteApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // A distinct process data directory would be required if a future app adds another WebView process.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }
}
