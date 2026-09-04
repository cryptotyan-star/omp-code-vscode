package sh.omp.remote.web

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OmpWebBridgeInstrumentedTest {
    private var webView: WebView? = null

    @After fun destroyWebView() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            webView?.destroy()
            webView = null
        }
    }

    @Test fun hostileFixtureRunsAtPackagedHttpsOriginWithoutExecution() {
        val ready = CountDownLatch(1)
        val spike = CountDownLatch(1)
        val passed = AtomicBoolean(false)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val bridge = OmpWebBridge(
                ApplicationProvider.getApplicationContext(),
                onMessage = { message ->
                    if (message.type == "renderer.ready") ready.countDown()
                    if (message.type == "security-spike.result") {
                        passed.set(message.body["passed"]?.toString() == "true")
                        spike.countDown()
                    }
                },
                onExternalUrl = { error("Fixture must not navigate externally") },
            )
            webView = bridge.createWebView("${OmpWebBridge.APP_ORIGIN}/assets/index.html")
        }
        assertTrue("renderer did not become ready", ready.await(10, TimeUnit.SECONDS))
        assertTrue("security spike did not report", spike.await(10, TimeUnit.SECONDS))
        assertTrue("hostile fixture executed or created active DOM", passed.get())
    }

    @Test fun sharedRendererReceivesOriginScopedNativeReply() {
        val bridge = createSharedRenderer()
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            bridge.postHostMessage("""{"t":"transcriptReset","syncId":"test-sync","sessionId":"session-1"}""")
            bridge.postHostMessage("""{"t":"transcriptAppend","syncId":"test-sync","sessionId":"session-1","messages":[{"role":"user","content":"Android bridge roundtrip"},{"role":"assistant","content":"Encrypted Android Remote Control E2E harness connected."}]}""")
        }

        awaitJavascriptTrue(
            "native reply did not reach ompHost.onmessage",
            "document.body.innerText.includes('Android bridge roundtrip') && " +
                "document.body.innerText.includes('Encrypted Android Remote Control E2E harness connected.')",
        )
        assertEquals("https://appassets.androidplatform.net", OmpWebBridge.APP_ORIGIN)
    }

    @Test fun sharedRendererUsesAndroidThemeAndSingleWebTopbar() {
        createSharedRenderer()

        awaitJavascriptTrue(
            "Android marker, opaque theme, single web topbar or fixed viewport shell is invalid",
            """
                (() => {
                  const body = document.body;
                  const app = document.getElementById('app');
                  const topbar = document.querySelector('.topbar');
                  const navSlot = document.querySelector('.mobile-nav-slot');
                  if (!body || !app || !topbar || !navSlot || body.dataset.platform !== 'android') return false;
                  const bodyStyle = getComputedStyle(body);
                  const appStyle = getComputedStyle(app);
                  const topbarStyle = getComputedStyle(topbar);
                  const appRect = app.getBoundingClientRect();
                  const topbarRect = topbar.getBoundingClientRect();
                  const navSlotRect = navSlot.getBoundingClientRect();
                  const transparent = value => value === 'transparent' ||
                    /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\)$/.test(value);
                  return !transparent(bodyStyle.backgroundColor) &&
                    !transparent(bodyStyle.color) &&
                    bodyStyle.backgroundColor !== bodyStyle.color &&
                    appStyle.position === 'fixed' &&
                    document.querySelectorAll('.topbar').length === 1 &&
                    topbarStyle.display !== 'none' &&
                    topbarRect.height >= 54 &&
                    navSlotRect.width >= 48 && navSlotRect.height >= 48 &&
                    Math.abs(appRect.left) <= 1 &&
                    Math.abs(appRect.top) <= 1 &&
                    Math.abs(appRect.right - innerWidth) <= 1 &&
                    Math.abs(appRect.bottom - innerHeight) <= 2;
                })()
            """.trimIndent(),
        )
    }

    @Test fun transcriptUsesAlignedOpaqueConversationBubbles() {
        val bridge = createSharedRenderer()
        postTranscript(
            bridge,
            """[
                {"role":"user","content":"Проверь диалоговое представление сообщения на телефоне."},
                {"role":"assistant","content":[
                    {"type":"thinking","thinking":"Проверяю вертикальную компоновку."},
                    {"type":"text","text":"Диалог синхронизирован с активной сессией на ноутбуке."},
                    {"type":"text","text":"Второй блок ответа остаётся ниже первого."}
                ]}
            ]""".trimIndent(),
        )
        awaitJavascriptTrue(
            "conversation bubbles were not rendered",
            "document.querySelectorAll('#messages .msg').length === 2",
        )

        // 0.94 is the shipped bound: the cover-screen rule in main.css widens both
        // bubbles to 94% below 400px, which is the width this renderer runs at.
        awaitJavascriptTrue(
            "conversation bubbles are not bounded, aligned, rounded and opaque",
            """
                (() => {
                  const messages = document.getElementById('messages');
                  const user = document.querySelector('.msg.user .bubble');
                  const assistant = document.querySelector('.msg.assistant .md');
                  const assistantBlocks = Array.from(document.querySelectorAll('.msg.assistant > *'));
                  if (!messages || !user || !assistant) return false;
                  const container = messages.getBoundingClientRect();
                  const containerStyle = getComputedStyle(messages);
                  const userRect = user.getBoundingClientRect();
                  const assistantRect = assistant.getBoundingClientRect();
                  const userStyle = getComputedStyle(user);
                  const assistantStyle = getComputedStyle(assistant);
                  const left = container.left + parseFloat(containerStyle.paddingLeft || '0');
                  const right = container.right - parseFloat(containerStyle.paddingRight || '0');
                  const width = right - left;
                  const opaque = value => value !== 'transparent' &&
                    !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\)$/.test(value);
                  const verticallyStacked = assistantBlocks.length === 3 && assistantBlocks.every((block, index) =>
                    index === 0 || assistantBlocks[index - 1].getBoundingClientRect().bottom <= block.getBoundingClientRect().top + 1
                  );
                  return width > 0 && verticallyStacked &&
                    user.textContent.includes('диалоговое') &&
                    assistant.textContent.includes('синхронизирован') &&
                    Math.abs(userRect.right - right) <= 4 &&
                    Math.abs(assistantRect.left - left) <= 4 &&
                    userRect.width <= width * 0.94 &&
                    assistantRect.width <= width * 0.94 &&
                    userRect.left > assistantRect.left &&
                    parseFloat(userStyle.borderRadius) >= 12 &&
                    parseFloat(assistantStyle.borderRadius) >= 12 &&
                    opaque(userStyle.backgroundColor) &&
                    opaque(assistantStyle.backgroundColor);
                })()
            """.trimIndent(),
        )
    }

    @Test fun approvalModalBlocksTheWholeWebShellAndAndroidBackCancelsIt() {
        val opened = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val bridge = createSharedRenderer(
            onModalState = { open -> if (open) opened.countDown() else closed.countDown() },
        )
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            bridge.postHostMessage(
                """{"t":"frame","frame":{"type":"extension_ui_request","method":"confirm","id":"approval-1","title":"Allow command?","message":"Review this action."}}""",
            )
        }
        assertTrue("native shell was not told that the modal opened", opened.await(3, TimeUnit.SECONDS))
        awaitJavascriptTrue(
            "approval dialog or full-screen scrim is missing",
            """
                (() => {
                  const holder = document.getElementById('modal-holder');
                  const dialog = holder && holder.querySelector('[role="dialog"][aria-modal="true"]');
                  if (!holder || !dialog || !holder.classList.contains('active')) return false;
                  const rect = holder.getBoundingClientRect();
                  return Math.abs(rect.top) <= 1 && Math.abs(rect.bottom - innerHeight) <= 2;
                })()
            """.trimIndent(),
        )

        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            bridge.postHostMessage("""{"t":"androidBack"}""")
        }
        assertTrue("native shell was not told that the modal closed", closed.await(3, TimeUnit.SECONDS))
        awaitJavascriptTrue(
            "Android Back did not remove the approval dialog and scrim",
            "!document.querySelector('#modal-holder.active') && !document.querySelector('#modal-holder [role=dialog]')",
        )
    }

    @Test fun narrowViewportKeepsComposerVisibleAndTouchTargetsUsable() {
        val bridge = createSharedRenderer(widthDp = 320, heightDp = 640)
        val messages = (0 until 24).joinToString(",") { index ->
            val role = if (index % 2 == 0) "user" else "assistant"
            """{"role":"$role","content":"Message $index keeps the mobile transcript long enough to exercise scrolling."}"""
        }
        postTranscript(bridge, "[$messages]")
        awaitJavascriptTrue(
            "long transcript was not rendered and scrolled into view",
            """
                (() => {
                  const items = document.querySelectorAll('#messages .msg');
                  const messages = document.getElementById('messages');
                  if (items.length !== 24 || !messages) return false;
                  const last = items[items.length - 1].getBoundingClientRect();
                  const viewport = messages.getBoundingClientRect();
                  return last.bottom <= viewport.bottom + 2 && last.bottom >= viewport.top;
                })()
            """.trimIndent(),
        )

        awaitJavascriptTrue(
            "composer overlaps the transcript, leaves the viewport or exposes undersized touch targets",
            """
                (() => {
                  const app = document.getElementById('app');
                  const messages = document.getElementById('messages');
                  const topbar = document.querySelector('.topbar');
                  const composer = document.querySelector('footer.composer');
                  const send = document.getElementById('btn-send');
                  const attach = document.getElementById('btn-attach');
                  const items = document.querySelectorAll('#messages .msg');
                  if (!app || !messages || !topbar || !composer || !send || !attach || !items.length) return false;
                  const appRect = app.getBoundingClientRect();
                  const messagesRect = messages.getBoundingClientRect();
                  const topbarRect = topbar.getBoundingClientRect();
                  const composerRect = composer.getBoundingClientRect();
                  const lastRect = items[items.length - 1].getBoundingClientRect();
                  const sendRect = send.getBoundingClientRect();
                  const attachRect = attach.getBoundingClientRect();
                  return innerWidth > 0 &&
                    Math.abs(appRect.bottom - innerHeight) <= 2 &&
                    Math.abs(composerRect.bottom - innerHeight) <= 2 &&
                    messagesRect.top >= topbarRect.bottom - 1 &&
                    messagesRect.bottom <= composerRect.top + 1 &&
                    lastRect.bottom <= messagesRect.bottom + 2 &&
                    sendRect.width >= 48 && sendRect.height >= 48 &&
                    attachRect.width >= 48 && attachRect.height >= 48 &&
                    document.documentElement.scrollWidth <= innerWidth + 1 &&
                    document.body.scrollWidth <= innerWidth + 1;
                })()
            """.trimIndent(),
        )
    }

    @Test fun shellKeepsFullHeightWhenTheHostLeavesTheWebViewHeightUnconstrained() {
        // Compose's AndroidView hands a factory-built view WRAP_CONTENT layout params,
        // and in that state Android WebView resolves vh/dvh/svh/lvh to zero. #app is
        // fixed, inset 0 and overflow hidden, so sizing it in those units collapsed the
        // entire UI: the app showed a bare background with only the drawer button.
        createSharedRenderer(
            widthDp = 360,
            heightDp = 720,
            layoutParamsHeight = ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        awaitJavascriptTrue(
            "the shell collapsed, so it is still sized in viewport-height units",
            """
                (() => {
                  const app = document.getElementById('app');
                  const topbar = document.querySelector('.topbar');
                  const composer = document.querySelector('footer.composer');
                  if (!app || !topbar || !composer) return false;
                  const appRect = app.getBoundingClientRect();
                  const topbarRect = topbar.getBoundingClientRect();
                  const composerRect = composer.getBoundingClientRect();
                  return innerHeight > 0 &&
                    Math.abs(appRect.height - innerHeight) <= 2 &&
                    topbarRect.height > 0 &&
                    composerRect.height > 0 &&
                    composerRect.bottom <= appRect.bottom + 2;
                })()
            """.trimIndent(),
        )
    }

    @Test fun reloadRendererReplacesTheRendererInsideTheSameContainer() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val ready = AtomicInteger(0)
        lateinit var bridge: OmpWebBridge
        lateinit var container: ViewGroup
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            bridge = OmpWebBridge(
                context,
                onMessage = { message -> if (message.type == "ui.ready") ready.incrementAndGet() },
                onExternalUrl = { error("Renderer reload test must not navigate externally") },
            )
            container = bridge.createRendererView()
            layoutRendererView(container)
        }
        awaitReadyCount(ready, 1)
        val first = singleWebView(container)
        assertEquals(
            ViewGroup.LayoutParams.MATCH_PARENT.toLong(),
            first.layoutParams.height.toLong(),
        )

        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            bridge.reloadRenderer()
            layoutRendererView(container)
        }
        awaitReadyCount(ready, 2)
        val second = singleWebView(container)
        webView = second
        assertTrue("reload kept the previous renderer alive", first !== second)
    }

    /**
     * The header used to keep the placeholder the packaged HTML ships with.
     *
     * A busy sync could fill the pre-attach queue, and the queue then cleared itself
     * and refused everything after it — including the one shell state the renderer
     * needed. The newest message must always survive.
     */
    @Test fun aBusyBootstrapQueueStillDeliversTheNewestShellState() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val ready = CountDownLatch(1)
        lateinit var bridge: OmpWebBridge
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            bridge = OmpWebBridge(
                context,
                onMessage = { message -> if (message.type == "ui.ready") ready.countDown() },
                onExternalUrl = { error("Shared renderer test must not navigate externally") },
            )
            val density = context.resources.displayMetrics.density
            val widthPx = (360 * density).roundToInt()
            val heightPx = (720 * density).roundToInt()
            webView = bridge.createWebView().also { view ->
                view.layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                view.measure(
                    View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY),
                )
                view.layout(0, 0, widthPx, heightPx)
            }
            // The renderer cannot have attached yet, so all of this queues, and there is
            // far more of it than the queue holds.
            repeat(200) { index -> bridge.postHostMessage("""{"t":"queueFiller","index":$index}""") }
            bridge.postHostMessage(
                """{"t":"remoteShellState","title":"Overflow probe","connectionLabel":"Connected securely","connectionState":"connected"}""",
            )
        }
        assertTrue("shared renderer did not post ready", ready.await(10, TimeUnit.SECONDS))

        awaitJavascriptTrue(
            "the newest shell state did not survive the bootstrap queue",
            "document.getElementById('connection-state').getAttribute('data-state') === 'connected' && " +
                "document.getElementById('connection-state').textContent.trim() === 'Connected securely'",
        )
    }

    /**
     * The gear opens a window, not a dropdown.
     *
     * It has to cover the whole WebView on the phone, offer every group the old
     * menu held, and close again — a settings surface with no way out is worse
     * than the crowded menu it replaced.
     */
    @Test fun theGearOpensAFullScreenSettingsWindowThatClosesAgain() {
        createSharedRenderer()

        evaluateJavascript("(document.getElementById('btn-settings').click(), true)")
        awaitJavascriptTrue(
            "the settings window did not cover the shell",
            """
                (() => {
                  const screen = document.querySelector('.settings-screen');
                  if (!screen) return false;
                  const style = getComputedStyle(screen);
                  const rect = screen.getBoundingClientRect();
                  const groups = [...screen.querySelectorAll('.settings-group h2')].map(h => h.textContent);
                  const rows = screen.querySelectorAll('.settings-row').length;
                  return style.position === 'fixed' &&
                    Math.round(rect.width) >= Math.round(document.documentElement.clientWidth) &&
                    Math.round(rect.height) >= Math.round(document.documentElement.clientHeight) &&
                    rows >= 8 &&
                    groups.length >= 4 &&
                    Boolean(screen.querySelector('.settings-close'));
                })()
            """.trimIndent(),
        )

        evaluateJavascript("(document.querySelector('.settings-close').click(), true)")
        awaitJavascriptTrue(
            "the settings window would not close",
            "document.querySelector('.settings-screen') === null",
        )
    }

    private fun createSharedRenderer(
        widthDp: Int = 360,
        heightDp: Int = 720,
        onModalState: (Boolean) -> Unit = {},
        layoutParamsHeight: Int = ViewGroup.LayoutParams.MATCH_PARENT,
    ): OmpWebBridge {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val ready = CountDownLatch(1)
        lateinit var bridge: OmpWebBridge
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            bridge = OmpWebBridge(
                context,
                onMessage = { message -> if (message.type == "ui.ready") ready.countDown() },
                onExternalUrl = { error("Shared renderer test must not navigate externally") },
                onModalState = onModalState,
            )
            val density = context.resources.displayMetrics.density
            val widthPx = (widthDp * density).roundToInt()
            val heightPx = (heightDp * density).roundToInt()
            webView = bridge.createWebView().also { view ->
                view.layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    layoutParamsHeight,
                )
                view.measure(
                    View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY),
                )
                view.layout(0, 0, widthPx, heightPx)
            }
        }
        assertTrue("shared renderer did not post ready", ready.await(10, TimeUnit.SECONDS))
        return bridge
    }

    private fun postTranscript(bridge: OmpWebBridge, messagesJson: String) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            bridge.postHostMessage("""{"t":"transcriptReset","syncId":"ui-sync","sessionId":"session-1"}""")
            bridge.postHostMessage(
                """{"t":"transcriptAppend","syncId":"ui-sync","sessionId":"session-1","messages":$messagesJson}""",
            )
        }
    }

    private fun awaitJavascriptTrue(description: String, expression: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var actual = "not evaluated"
        do {
            actual = evaluateJavascript("Boolean(($expression))")
            if (actual == "true") return
            Thread.sleep(25)
        } while (System.nanoTime() < deadline)
        assertEquals("$description; last JavaScript result=$actual", "true", actual)
    }

    private fun evaluateJavascript(script: String): String {
        val completed = CountDownLatch(1)
        val result = AtomicReference("callback not invoked")
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            checkNotNull(webView).evaluateJavascript(script) { value ->
                result.set(value ?: "null")
                completed.countDown()
            }
        }
        assertTrue("evaluateJavascript callback timed out", completed.await(3, TimeUnit.SECONDS))
        return result.get()
    }

    private fun layoutRendererView(view: View, widthDp: Int = 360, heightDp: Int = 720) {
        val density = view.context.resources.displayMetrics.density
        val widthPx = (widthDp * density).roundToInt()
        val heightPx = (heightDp * density).roundToInt()
        view.measure(
            View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, widthPx, heightPx)
    }

    private fun singleWebView(container: ViewGroup): WebView {
        assertEquals("renderer container must own exactly one view", 1L, container.childCount.toLong())
        return container.getChildAt(0) as WebView
    }

    private fun awaitReadyCount(ready: AtomicInteger, expected: Int) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        while (System.nanoTime() < deadline) {
            if (ready.get() >= expected) return
            Thread.sleep(25)
        }
        assertEquals("renderer did not post ready", expected.toLong(), ready.get().toLong())
    }
}
