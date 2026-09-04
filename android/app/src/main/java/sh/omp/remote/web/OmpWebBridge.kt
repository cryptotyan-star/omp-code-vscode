package sh.omp.remote.web

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.annotation.RequiresApi
import java.util.ArrayDeque
import kotlin.math.roundToInt
import org.json.JSONObject
import sh.omp.remote.BuildConfig

class OmpWebBridge(
    private val context: Context,
    private val onMessage: (ValidatedBridgeMessage) -> Unit,
    private val onExternalUrl: (Uri) -> Unit,
    private val onModalState: (Boolean) -> Unit = {},
    private val onRendererGone: (Boolean) -> Unit = {},
) {
    private var replyProxy: JavaScriptReplyProxy? = null
    private val pendingMessages = ArrayDeque<String>()
    private var pendingOverflowed = false
    private var rendererHost: ViewGroup? = null
    private var rendererEntryUrl: String = ENTRY_URL

    @SuppressLint("SetJavaScriptEnabled")
    fun createWebView(entryUrl: String = ENTRY_URL): WebView {
        require(isPackagedUri(Uri.parse(entryUrl))) { "WebView entry must use the packaged HTTPS asset origin" }
        val loader = WebViewAssetLoader.Builder()
            .setDomain(APP_ASSET_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()
        val appearance = androidAppearance()
        return WebView(context).apply {
            // Compose's AndroidView hands a factory-built view WRAP_CONTENT layout
            // params, and an unconstrained height makes Android WebView resolve every
            // viewport-height unit to zero. Say the size out loud.
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = false
            settings.databaseEnabled = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.blockNetworkLoads = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.mediaPlaybackRequiresUserGesture = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.textZoom = (context.resources.configuration.fontScale * 100f)
                .roundToInt()
                .coerceIn(85, 200)
            settings.setGeolocationEnabled(false)
            isLongClickable = true
            setBackgroundColor(appearance.backgroundColor)
            setDownloadListener { _, _, _, _, _ -> /* packaged renderer cannot download directly */ }
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    loader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    if (request.isForMainFrame && isPackagedUri(uri)) return false
                    if (request.isForMainFrame && BridgeMessageValidator.isAllowedExternalUrl(uri.toString())) {
                        onExternalUrl(uri)
                    }
                    return true
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    super.onPageFinished(view, url)
                    val page = url?.let(Uri::parse) ?: return
                    if (isPackagedUri(page)) applyAndroidAppearance(view, appearance)
                }

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    // Returning false hands the dead renderer back to the framework, which
                    // kills the whole app process. The session lives on the desktop, so a
                    // lost renderer is recoverable: replace the view and say so.
                    val container = view.parent as? ViewGroup
                    container?.removeView(view)
                    view.destroy()
                    resetRendererState()
                    // A fresh WebView in the same container turns a crash into a reload
                    // instead of a permanently blank panel; the new renderer's `ready`
                    // asks the desktop for a full encrypted resync.
                    if (container != null && container === rendererHost) {
                        container.post { container.addView(createWebView(rendererEntryUrl)) }
                    }
                    onRendererGone(detail.didCrash())
                    return true
                }

                @RequiresApi(Build.VERSION_CODES.O_MR1)
                override fun onSafeBrowsingHit(
                    view: WebView,
                    request: WebResourceRequest,
                    threatType: Int,
                    callback: SafeBrowsingResponse,
                ) {
                    callback.backToSafety(true)
                }
            }
            installOriginScopedListener(this)
            loadUrl(entryUrl)
        }
    }

    /**
     * The renderer as the app mounts it: a container that owns the WebView.
     *
     * The indirection buys two things. The WebView is sized by a plain ViewGroup
     * that always passes MATCH_PARENT down, and a dead render process can be
     * replaced in place, so a lost renderer is a blink rather than a dead screen.
     */
    fun createRendererView(entryUrl: String = ENTRY_URL): ViewGroup {
        rendererEntryUrl = entryUrl
        val container = FrameLayout(context)
        container.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        rendererHost = container
        container.addView(createWebView(entryUrl))
        return container
    }

    /** Drop the current renderer and load a fresh one into the same container. */
    fun reloadRenderer() {
        val container = rendererHost ?: return
        for (index in container.childCount - 1 downTo 0) {
            val child = container.getChildAt(index) as? WebView ?: continue
            container.removeViewAt(index)
            child.destroy()
        }
        resetRendererState()
        container.addView(createWebView(rendererEntryUrl))
    }

    fun postHostMessage(message: String) {
        require(message.toByteArray(Charsets.UTF_8).size <= BridgeMessageValidator.MAX_MESSAGE_BYTES) {
            "Host message is too large for the renderer bridge"
        }
        val proxy = replyProxy
        if (proxy == null) {
            // Drop the oldest, never the newest. Clearing the queue and then refusing
            // everything after it meant one busy sync could strand the state the shell
            // was posted last -- the header kept its packaged placeholder for the whole
            // session. The renderer still gets told to ask for a fresh sync.
            while (pendingMessages.size >= MAX_PENDING_MESSAGES) {
                pendingMessages.removeFirst()
                pendingOverflowed = true
            }
            pendingMessages.addLast(message)
        } else {
            proxy.postMessage(message)
        }
    }

    private fun resetRendererState() {
        replyProxy = null
        pendingMessages.clear()
        pendingOverflowed = false
    }

    private fun installOriginScopedListener(webView: WebView) {
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            "This WebView does not support an origin-scoped message listener"
        }
        WebViewCompat.addWebMessageListener(
            webView,
            BRIDGE_OBJECT,
            setOf(APP_ORIGIN),
        ) { _, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, proxy: JavaScriptReplyProxy ->
            if (!isMainFrame || sourceOrigin.scheme != "https" || sourceOrigin.host != APP_ASSET_HOST) return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener
            val modalState = parseAndroidModalState(raw)
            val validated = if (modalState == null) {
                runCatching { BridgeMessageValidator.validate(raw) }.getOrNull()
                    ?: return@addWebMessageListener
            } else {
                null
            }
            replyProxy = proxy
            if (pendingOverflowed) {
                proxy.postMessage("""{"t":"frame","frame":{"type":"notice","level":"warning","message":"Renderer attached after its bootstrap queue overflowed; requesting a fresh encrypted sync."}}""")
                pendingOverflowed = false
            }
            while (pendingMessages.isNotEmpty()) proxy.postMessage(pendingMessages.removeFirst())
            if (modalState != null) {
                // Deferred off the message callback, but never through the view's run
                // queue: `View.post` on a detached WebView holds the runnable until the
                // view is attached, which silently strands the modal state.
                Handler(Looper.getMainLooper()).post { onModalState(modalState) }
            } else {
                onMessage(checkNotNull(validated))
            }
        }
    }

    private fun parseAndroidModalState(raw: String): Boolean? {
        if (raw.length > 128) return null
        val body = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        if (body.length() != 2 || body.optString("t") != ANDROID_MODAL_STATE || !body.has("open")) return null
        return body.opt("open") as? Boolean
    }

    private fun isPackagedUri(uri: Uri): Boolean =
        uri.scheme == "https" && uri.host == APP_ASSET_HOST && uri.path.orEmpty().startsWith("/assets/")

    private fun androidAppearance(): AndroidAppearance {
        val dark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
        return if (dark) {
            AndroidAppearance(
                backgroundColor = Color.rgb(0x11, 0x12, 0x18),
                colorScheme = "dark",
                cssVariables = mapOf(
                    "--bg" to "#111218",
                    "--fg" to "#F4F1FA",
                    "--muted" to "#B9B5C5",
                    "--border" to "#3A3B47",
                    "--input-bg" to "#252630",
                    "--widget-bg" to "#1B1C24",
                    "--code-bg" to "#252630",
                    "--err" to "#FFB4AB",
                ),
            )
        } else {
            AndroidAppearance(
                backgroundColor = Color.rgb(0xFC, 0xF8, 0xFF),
                colorScheme = "light",
                cssVariables = mapOf(
                    "--bg" to "#FCF8FF",
                    "--fg" to "#211F26",
                    "--muted" to "#625F69",
                    "--border" to "#D8D2DD",
                    "--input-bg" to "#F2EDF5",
                    "--widget-bg" to "#FFFBFF",
                    "--code-bg" to "#F3EDF7",
                    "--err" to "#BA1A1A",
                ),
            )
        }
    }

    private fun applyAndroidAppearance(webView: WebView, appearance: AndroidAppearance) {
        val languageTag = context.resources.configuration.locales[0].toLanguageTag()
        val variables = JSONObject(appearance.cssVariables).toString()
        val script = """
            (() => {
              const root = document.documentElement;
              root.lang = ${JSONObject.quote(languageTag)};
              root.style.setProperty("color-scheme", ${JSONObject.quote(appearance.colorScheme)});
              const body = document.body;
              if (body) {
                body.dataset.platform = "android";
                body.dataset.colorScheme = ${JSONObject.quote(appearance.colorScheme)};
              }
              const variables = $variables;
              for (const name of Object.keys(variables)) {
                root.style.setProperty(name, variables[name]);
                if (body) body.style.setProperty(name, variables[name]);
              }
            })();
        """.trimIndent()
        webView.evaluateJavascript(script, null)
    }

    private data class AndroidAppearance(
        val backgroundColor: Int,
        val colorScheme: String,
        val cssVariables: Map<String, String>,
    )

    companion object {
        const val APP_ASSET_HOST = "appassets.androidplatform.net"
        const val APP_ORIGIN = "https://$APP_ASSET_HOST"
        const val ENTRY_URL = "$APP_ORIGIN/assets/desktop-shared/android.html"
        const val BRIDGE_OBJECT = "ompHost"
        private const val ANDROID_MODAL_STATE = "androidModalState"
        private const val MAX_PENDING_MESSAGES = 64
    }
}
