package sh.omp.remote

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView
import androidx.activity.compose.BackHandler
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.result.PickVisualMediaRequest
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonPrimitive
import sh.omp.remote.protocol.PairingUri
import sh.omp.remote.qr.QrScanner
import sh.omp.remote.qr.hasCameraPermission
import sh.omp.remote.relay.RelayState
import sh.omp.remote.protocol.RemoteSessionSummary
import sh.omp.remote.service.RemoteServiceState
import sh.omp.remote.service.RemoteNativeShare
import sh.omp.remote.service.RemoteSessionService
import sh.omp.remote.ui.OmpTheme
import sh.omp.remote.web.OmpWebBridge

class MainActivity : ComponentActivity() {
    private val pendingPairing = mutableStateOf<String?>(null)
    private val requestedSession = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        // Edge to edge before super: the system bars become transparent scrims over
        // the window background, which values/values-night already colour per mode.
        // The deprecated statusBarColor/navigationBarColor writes this replaces are
        // no-ops from API 35 on, so they left light bars on a dark app.
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        consumeIntent(intent)
        setContent {
            OmpTheme {
                OmpRemoteApp(
                    pendingPairing.value,
                    requestedSession.value,
                    onPairingConsumed = { pendingPairing.value = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeIntent(intent)
    }

    private fun consumeIntent(intent: Intent?) {
        intent?.data?.toString()?.takeIf { it.startsWith("omp-code://pair?") }?.let { pendingPairing.value = it }
        intent?.data = null // Do not retain the one-time pairing key in the Activity intent.
        requestedSession.value = intent?.getStringExtra(EXTRA_SESSION_ID)
    }

    companion object {
        private const val EXTRA_SESSION_ID = "session_id"
        fun intentForSession(context: Context, sessionId: String): Intent =
            Intent(context, MainActivity::class.java).putExtra(EXTRA_SESSION_ID, sessionId).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}

internal fun shouldResumeStoredSession(deepLink: String?): Boolean = deepLink.isNullOrBlank()

/** Which build is actually on this phone, without having to ask anyone. */
@Composable
internal fun BuildIdentityLine(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    Text(
        stringResource(
            R.string.build_identity,
            BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE,
            remember(context) { installedAtLabel(context) },
        ),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier,
    )
}

/**
 * When this build landed on this phone, as a plain local timestamp.
 *
 * Split from the lookup so it can be tested without a Context.
 */
internal fun formatInstalledAt(epochMillis: Long, zone: ZoneId): String =
    Instant.ofEpochMilli(epochMillis)
        .atZone(zone)
        .format(DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm"))

/**
 * Install time, not compile time, and on purpose.
 *
 * A build-time constant would have to come from a BuildConfig field, and Gradle's
 * configuration cache captures those — the field would keep reporting whenever that
 * cache was last invalidated. A date that is quietly wrong is worse than no date.
 * The package manager's own record cannot drift.
 */
private fun installedAtLabel(context: Context): String = runCatching {
    val installed = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
    formatInstalledAt(installed, ZoneId.systemDefault())
}.getOrElse { "—" }

/** Sessions of one desktop folder, under the name that folder is known by. */
internal data class RemoteProjectGroup(
    val path: String,
    val name: String,
    val sessions: List<RemoteSessionSummary>,
)

/**
 * Group sessions by the folder their agent runs in.
 *
 * Ordering is by folder name rather than by full path so the list reads the way the
 * projects are spoken about, and sessions keep the order the desktop sent them in —
 * that order is the desktop's tab order, and reshuffling it would make the two views
 * disagree about which chat is which.
 */
internal fun groupSessionsByProject(sessions: List<RemoteSessionSummary>): List<RemoteProjectGroup> =
    sessions
        .groupBy { it.cwd }
        .map { (path, group) -> RemoteProjectGroup(path, projectName(path), group) }
        .sortedWith(compareBy({ it.name.lowercase() }, { it.path }))

/** The last non-empty path segment, which is what a project is actually called. */
internal fun projectName(path: String): String =
    path.trimEnd('/', '\\')
        .split('/', '\\')
        .lastOrNull { it.isNotBlank() }
        ?: path.ifBlank { "—" }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OmpRemoteApp(deepLink: String?, requestedSession: String?, onPairingConsumed: () -> Unit) {
    val context = LocalContext.current
    val serviceState by RemoteSessionService.state.collectAsStateWithLifecycle()
    // Pairing URLs contain a one-time secret and must never enter Activity saved state
    // — nor the visible text field. A scanned link is described, not displayed, so this
    // holds only what a person typed or pasted themselves.
    var pairingText by remember { mutableStateOf("") }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var cameraGranted by remember { mutableStateOf(hasCameraPermission(context)) }
    var pendingExternalUrl by remember { mutableStateOf<Uri?>(null) }
    var choosingAttachment by remember { mutableStateOf(false) }
    // A scanned link is held apart from the typed one. It carries a one-time key,
    // so it is described rather than displayed, and it is never kept past ON_STOP.
    var scanned by remember { mutableStateOf<ScannedPairing?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val lifecycleOwner = LocalLifecycleOwner.current

    // A local Disconnect deliberately keeps the sealed credential. On the next
    // cold launcher start, resume it without asking the user to pair again. A new
    // deep link always wins and must not race an older credential.
    LaunchedEffect(Unit) {
        if (shouldResumeStoredSession(deepLink)) RemoteSessionService.resume(context)
    }

    // Scanning a QR used to paste the raw URL into the text field and stop there.
    // With no prompt and no progress, a successful scan looked exactly like a scan
    // that had not registered — and the pairing key sat on screen in plain text,
    // where a screenshot or a shoulder would take it.
    LaunchedEffect(deepLink) {
        val link = deepLink?.takeIf { it.isNotBlank() } ?: return@LaunchedEffect
        val parsed = runCatching { PairingUri.parse(link, Clock.systemUTC()) }
        parsed.getOrNull()?.let { uri ->
            // Parsed only to validate and describe it; the key is wiped immediately and
            // the untouched original is what actually gets connected.
            val summary = uri.redactedDescription()
            uri.pairingKey.fill(0)
            scanned = ScannedPairing(link, summary)
        }
        parsed.exceptionOrNull()?.let { failure ->
            scanned = null
            snackbar.showSnackbar(failure.message ?: context.getString(R.string.invalid_pairing_link))
        }
        onPairingConsumed()
    }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                pairingText = ""
                scanned = null
                onPairingConsumed()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(requestedSession, serviceState.sessions) {
        requestedSession?.takeIf { wanted -> serviceState.sessions.any { it.id == wanted } }
            ?.let { RemoteSessionService.switchSession(context, it) }
    }
    LaunchedEffect(Unit) {
        RemoteSessionService.nativeShare.collect { share ->
            if (share != null) {
                runCatching { launchNativeShare(context, share) }
                    .onSuccess { RemoteSessionService.consumeNativeShare(context, share) }
                    .onFailure {
                        RemoteSessionService.consumeNativeShare(context, share)
                        snackbar.showSnackbar(context.getString(R.string.share_unavailable))
                    }
            }
        }
    }

    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> cameraGranted = granted }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let {
            // Forward only the one-shot read grant to the upload service; retaining every
            // picked document would leave an unnecessary long-lived privacy grant.
            RemoteSessionService.uploadAttachment(context, it)
        }
    }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri?.let { RemoteSessionService.uploadAttachment(context, it) }
    }

    if (scanning) {
        Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.scan_desktop_qr)) }, navigationIcon = { Button(onClick = { scanning = false }) { Text(stringResource(R.string.back)) } }) }) { padding ->
            QrScanner(
                permissionGranted = cameraGranted,
                requestPermission = { cameraPermission.launch(Manifest.permission.CAMERA) },
                onCode = { pairingText = it; scanning = false },
                modifier = Modifier.padding(padding),
            )
        }
        return
    }

    val pendingScan = scanned
    if (serviceState.phase == RemoteServiceState.Phase.STOPPED && pendingScan != null) {
        ScannedPairingScreen(
            summary = pendingScan.summary,
            onConnect = {
                if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
                RemoteSessionService.connect(context, pendingScan.link)
                scanned = null
            },
            onCancel = { scanned = null },
            snackbar = snackbar,
        )
    } else if (serviceState.phase == RemoteServiceState.Phase.STOPPED) {
        PairingScreen(
            error = serviceState.error,
            pairingText = pairingText,
            onPairingText = { pairingText = it.take(PairingUri.MAX_URI_LENGTH) },
            onPaste = {
                val clipboard = context.getSystemService(ClipboardManager::class.java)
                pairingText = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty().take(PairingUri.MAX_URI_LENGTH)
            },
            onScan = { scanning = true },
            onConnect = {
                val parsed = runCatching { PairingUri.parse(pairingText, Clock.systemUTC()) }
                if (parsed.isFailure) {
                    kotlinx.coroutines.MainScope().launch { snackbar.showSnackbar(parsed.exceptionOrNull()?.message ?: context.getString(R.string.invalid_pairing_link)) }
                } else {
                    parsed.getOrNull()?.pairingKey?.fill(0)
                    if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                    RemoteSessionService.connect(context, pairingText)
                    pairingText = ""
                }
            },
            snackbar = snackbar,
        )
    } else {
        RemoteWorkspace(
            serviceState = serviceState,
            sessions = serviceState.sessions,
            onPickAttachment = { choosingAttachment = true },
            onDisconnect = { RemoteSessionService.disconnect(context) },
            onRevoke = { RemoteSessionService.revoke(context) },
            onCreateSession = { RemoteSessionService.createSession(context) },
            onRenameSession = { id, title -> RemoteSessionService.renameSession(context, id, title) },
            onCloseSession = { id -> RemoteSessionService.closeSession(context, id) },
            onExternalUrl = { pendingExternalUrl = it },
            snackbar = snackbar,
        )
    }

    if (choosingAttachment) {
        AlertDialog(
            onDismissRequest = { choosingAttachment = false },
            title = { Text(stringResource(R.string.choose_attachment)) },
            text = {
                Column(Modifier.fillMaxWidth()) {
                    Button(
                        onClick = {
                            choosingAttachment = false
                            filePicker.launch(arrayOf("*/*"))
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(stringResource(R.string.choose_file)) }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = {
                            choosingAttachment = false
                            photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(stringResource(R.string.choose_photo)) }
                }
            },
            confirmButton = {},
            dismissButton = {
                OutlinedButton(onClick = { choosingAttachment = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }

    pendingExternalUrl?.let { uri ->
        AlertDialog(
            onDismissRequest = { pendingExternalUrl = null },
            title = { Text(stringResource(R.string.open_external_title)) },
            text = { Text(uri.toString()) },
            confirmButton = {
                Button(onClick = {
                    context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                    pendingExternalUrl = null
                }) { Text(stringResource(R.string.open)) }
            },
            dismissButton = { OutlinedButton(onClick = { pendingExternalUrl = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

private fun launchNativeShare(context: Context, share: RemoteNativeShare) {
    val send = Intent(Intent.ACTION_SEND)
        .setType(share.mimeType)
        .putExtra(Intent.EXTRA_STREAM, share.uri)
        .putExtra(Intent.EXTRA_TITLE, share.displayName)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    send.clipData = ClipData.newUri(context.contentResolver, share.displayName, share.uri)
    context.startActivity(Intent.createChooser(send, context.getString(R.string.share_transcript)))
}

/** A scanned link, held only long enough to ask about it. */
private data class ScannedPairing(val link: String, val summary: String)

/**
 * What a scan should look like: the computer it found, and one thing to press.
 *
 * The consent tap stays. A pairing link is a bearer secret, and one arriving from a
 * camera or a messaging app is not proof that its owner meant to hand over this
 * phone. What changes is that the choice is now legible instead of a raw URL in a
 * text box, and the key itself never reaches the screen.
 */
@Composable
private fun ScannedPairingScreen(
    summary: String,
    onConnect: () -> Unit,
    onCancel: () -> Unit,
    snackbar: SnackbarHostState,
) {
    Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 560.dp).fillMaxWidth().padding(24.dp)) {
                Text(stringResource(R.string.scanned_title), style = MaterialTheme.typography.headlineLarge)
                Spacer(Modifier.height(12.dp))
                Text(stringResource(R.string.scanned_body))
                Spacer(Modifier.height(20.dp))
                Text(summary, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(24.dp))
                Button(onClick = onConnect, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.connect_computer))
                }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.cancel))
                }
                Spacer(Modifier.height(12.dp))
                Text(
                    stringResource(R.string.scanned_note),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun PairingScreen(
    error: String?,
    pairingText: String,
    onPairingText: (String) -> Unit,
    onPaste: () -> Unit,
    onScan: () -> Unit,
    onConnect: () -> Unit,
    snackbar: SnackbarHostState,
) {
    Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
        // Unfolded, this screen is over 900dp wide. Left to fill it, the description
        // ran as a single 90-character line and the pairing field became a letterbox.
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
          Column(Modifier.widthIn(max = 560.dp).fillMaxWidth().padding(24.dp)) {
            Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.headlineLarge)
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.pair_description))
            // A resume that failed used to be invisible: the app simply arrived at the
            // pairing screen with no hint that a saved session had just been discarded.
            error?.let { message ->
                Spacer(Modifier.height(12.dp))
                Text(
                    message,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Spacer(Modifier.height(24.dp))
            OutlinedTextField(
                value = pairingText,
                onValueChange = onPairingText,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.pair_link)) },
                minLines = 3,
                maxLines = 6,
            )
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onPaste) { Icon(Icons.Default.ContentPaste, null); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.paste)) }
                OutlinedButton(onClick = onScan) { Icon(Icons.Default.CameraAlt, null); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.scan_qr)) }
            }
            Spacer(Modifier.height(16.dp))
            Button(onClick = onConnect, enabled = pairingText.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.connect_computer)) }
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.pair_security_note), style = MaterialTheme.typography.bodySmall)
          }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RemoteWorkspace(
    serviceState: RemoteServiceState,
    sessions: List<RemoteSessionSummary>,
    onPickAttachment: () -> Unit,
    onDisconnect: () -> Unit,
    onRevoke: () -> Unit,
    onCreateSession: () -> Unit,
    onRenameSession: (String, String) -> Unit,
    onCloseSession: (String) -> Unit,
    onExternalUrl: (Uri) -> Unit,
    snackbar: SnackbarHostState,
) {
    val context = LocalContext.current
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var webBridge by remember { mutableStateOf<OmpWebBridge?>(null) }
    // Bumped by every renderer that announces itself. The shell state is posted once
    // per change, so a renderer that boots (or reboots) after the last change would
    // otherwise keep the placeholder header the packaged HTML ships with.
    var rendererEpoch by remember { mutableIntStateOf(0) }
    var webModalOpen by remember { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<RemoteSessionSummary?>(null) }
    var renameText by remember { mutableStateOf("") }
    var confirmRevoke by remember { mutableStateOf(false) }
    val canManageSessions = "session.manage" in serviceState.capabilityVerbs
    val canAttachFiles = "files" in serviceState.capabilityVerbs
    val currentCanAttachFiles by rememberUpdatedState(canAttachFiles)
    val selectedTitle = sessions.firstOrNull { it.id == serviceState.selectedSessionId }
        ?.title
        ?.takeIf { it.isNotBlank() }
        ?: stringResource(R.string.default_session_title)
    val connectionState = when {
        serviceState.phase == RemoteServiceState.Phase.ACTIVE && serviceState.connection == RelayState.Connected -> "connected"
        serviceState.phase == RemoteServiceState.Phase.RECONNECTING &&
            serviceState.connection != RelayState.Offline &&
            serviceState.connection !is RelayState.Closed &&
            serviceState.connection != RelayState.Idle -> "reconnecting"
        serviceState.connection is RelayState.Reconnecting -> "reconnecting"
        serviceState.connection == RelayState.Offline ||
            serviceState.connection is RelayState.Closed ||
            serviceState.connection == RelayState.Idle -> "offline"
        else -> "connecting"
    }
    val connectionLabel = when (connectionState) {
        "connected" -> stringResource(R.string.remote_status_connected)
        "reconnecting" -> stringResource(R.string.remote_status_reconnecting)
        "offline" -> stringResource(R.string.remote_status_offline)
        else -> stringResource(R.string.remote_status_connecting)
    }

    LaunchedEffect(webBridge) {
        val bridge = webBridge ?: return@LaunchedEffect
        RemoteSessionService.messages.collect { bridge.postHostMessage(it) }
    }
    LaunchedEffect(webBridge, rendererEpoch, selectedTitle, connectionLabel, connectionState) {
        webBridge?.postHostMessage(
            buildJsonObject {
                put("t", "remoteShellState")
                put("title", selectedTitle)
                put("connectionLabel", connectionLabel)
                put("connectionState", connectionState)
            }.toString(),
        )
    }
    LaunchedEffect(webModalOpen) {
        if (webModalOpen && drawer.isOpen) drawer.close()
    }
    BackHandler(enabled = webModalOpen) {
        webBridge?.postHostMessage("""{"t":"androidBack"}""")
    }
    BackHandler(enabled = drawer.isOpen) {
        scope.launch { drawer.close() }
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        // Button only. The edge-swipe gesture kept catching vertical scrolls in the
        // transcript and yanking the drawer open mid-read; the hamburger is the one
        // way in, and the scrim still closes it.
        gesturesEnabled = false,
        drawerContent = {
            ModalDrawerSheet {
                Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.desktop_sessions), modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    if (canManageSessions && serviceState.allSessionsGranted) {
                        IconButton(onClick = onCreateSession) { Icon(Icons.Default.Add, stringResource(R.string.new_session)) }
                    }
                    // A drawer that opens by button has to close by button. Turning the
                    // gestures off also turned off Material's tap-the-scrim close, which
                    // left the system back gesture as the only way out of an open drawer.
                    IconButton(onClick = { scope.launch { drawer.close() } }) {
                        Icon(Icons.Default.Close, stringResource(R.string.close_sessions_menu))
                    }
                }
                HorizontalDivider()
                // One flat list stopped being readable the moment sessions spanned more
                // than one checkout. They arrive carrying the folder their agent runs in,
                // so the folder is what groups them.
                val projects = remember(sessions) { groupSessionsByProject(sessions) }
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                    if (sessions.isEmpty()) {
                        Text(stringResource(R.string.waiting_full_sync), modifier = Modifier.padding(20.dp))
                    }
                    if (!serviceState.allSessionsGranted) {
                        // Sessions cannot simply "appear" under a single-chat grant, and a
                        // list that silently stays one row long reads as a broken sync.
                        Text(
                            stringResource(R.string.single_session_grant_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                        )
                    }
                    projects.forEach { project ->
                        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp)) {
                            Text(project.name, style = MaterialTheme.typography.titleSmall)
                            // Two checkouts can share a folder name; the path is what tells
                            // them apart, so it stays even though it is rarely read.
                            Text(
                                project.path,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.MiddleEllipsis,
                            )
                        }
                        project.sessions.forEach { session ->
                            NavigationDrawerItem(
                                label = {
                                    Column {
                                        Text(session.title.ifBlank { "OMP Code" })
                                        Text(session.status, style = MaterialTheme.typography.bodySmall)
                                    }
                                },
                                selected = serviceState.selectedSessionId == session.id,
                                onClick = {
                                    RemoteSessionService.switchSession(context, session.id)
                                    scope.launch { drawer.close() }
                                },
                                badge = {
                                    if (canManageSessions) {
                                        Row {
                                            IconButton(onClick = {
                                                renameTarget = session
                                                renameText = session.title
                                            }) { Icon(Icons.Default.Edit, stringResource(R.string.rename_session)) }
                                            if (session.closable) {
                                                IconButton(onClick = { onCloseSession(session.id) }) {
                                                    Icon(Icons.Default.Close, stringResource(R.string.close_session))
                                                }
                                            }
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
                Column(Modifier.padding(20.dp)) {
                    OutlinedButton(
                        onClick = {
                            webBridge?.reloadRenderer()
                            scope.launch { drawer.close() }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Default.Refresh, null)
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(R.string.reload_chat_view))
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(onClick = onDisconnect, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.disconnect)) }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(onClick = { confirmRevoke = true }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.revoke_access)) }
                    Spacer(Modifier.height(16.dp))
                    BuildIdentityLine()
                }
            }
        },
    ) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbar) },
        ) { padding ->
            // enableEdgeToEdge() stops the window from being resized for the keyboard,
            // so the renderer has to be lifted off the IME explicitly or the composer
            // ends up underneath it.
            Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
                AndroidView(
                    factory = { webContext -> runCatching {
                        OmpWebBridge(
                            context = webContext,
                            onMessage = { message ->
                                when {
                                    message.type == "renderer.ready" -> Unit
                                    // A booted renderer has an empty header and an empty
                                    // transcript. Forward the ready so the desktop resyncs,
                                    // and re-post the shell state this renderer never saw.
                                    message.type == "ui.ready" -> {
                                        rendererEpoch++
                                        RemoteSessionService.postRendererMessage(message.body.toString())
                                    }
                                    message.type == "security-spike.result" -> Unit
                                    message.type == "local.openUrl" || message.type == "ui.openExternal" ->
                                        (message.body["url"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { onExternalUrl(Uri.parse(it)) }
                                    message.type == "local.copy" || message.type == "ui.copy" ->
                                        (message.body["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { value ->
                                        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("OMP Code", value))
                                    }
                                    message.type == "local.share" -> {
                                        val text = (message.body["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                                        val mime = (message.body["mime"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                                        if (text != null && mime != null) {
                                            runCatching {
                                                context.startActivity(
                                                    Intent.createChooser(
                                                        Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_TEXT, text),
                                                        context.getString(R.string.share_transcript),
                                                    ),
                                                )
                                            }.onFailure {
                                                scope.launch { snackbar.showSnackbar(context.getString(R.string.share_unavailable)) }
                                            }
                                        }
                                    }
                                    message.type == "ui.pickFiles" -> {
                                        if (currentCanAttachFiles) onPickAttachment()
                                        else scope.launch { snackbar.showSnackbar(context.getString(R.string.files_not_granted)) }
                                    }
                                    message.type.startsWith("ui.") -> RemoteSessionService.postRendererMessage(message.body.toString())
                                }
                            },
                            onExternalUrl = onExternalUrl,
                            onModalState = { webModalOpen = it },
                            onRendererGone = {
                                scope.launch { snackbar.showSnackbar(context.getString(R.string.renderer_restarted)) }
                            },
                        ).also { webBridge = it }.createRendererView()
                    }.getOrElse { failure ->
                        // AndroidView runs this during composition, so a throw here is an
                        // app crash rather than a blank panel. A WebView can be absent,
                        // disabled by policy, or mid-update; none of that is fatal.
                        TextView(webContext).apply {
                            gravity = Gravity.CENTER
                            setPadding(48, 48, 48, 48)
                            text = webContext.getString(R.string.renderer_unavailable, failure.message ?: "")
                        }
                    } },
                    modifier = Modifier.fillMaxSize(),
                )
                if (!webModalOpen) {
                    IconButton(
                        onClick = { scope.launch { drawer.open() } },
                        modifier = Modifier.align(Alignment.TopStart).padding(4.dp),
                    ) {
                        Icon(Icons.Default.Menu, stringResource(R.string.sessions))
                    }
                }
            }
        }
    }

    renameTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text(stringResource(R.string.rename_session)) },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it.take(256) },
                    label = { Text(stringResource(R.string.session_title)) },
                    singleLine = true,
                )
            },
            confirmButton = {
                Button(onClick = {
                    onRenameSession(target.id, renameText.trim())
                    renameTarget = null
                }, enabled = renameText.trim().isNotEmpty()) { Text(stringResource(R.string.save)) }
            },
            dismissButton = { OutlinedButton(onClick = { renameTarget = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
    if (confirmRevoke) {
        AlertDialog(
            onDismissRequest = { confirmRevoke = false },
            title = { Text(stringResource(R.string.revoke_confirm_title)) },
            text = { Text(stringResource(R.string.revoke_confirm_body)) },
            confirmButton = { Button(onClick = { confirmRevoke = false; onRevoke() }) { Text(stringResource(R.string.revoke_access)) } },
            dismissButton = { OutlinedButton(onClick = { confirmRevoke = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}
