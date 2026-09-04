package sh.omp.remote.service

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Binder
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.io.FileInputStream
import java.security.MessageDigest
import java.time.Clock
import java.util.UUID
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import sh.omp.remote.MainActivity
import sh.omp.remote.R
import sh.omp.remote.protocol.PairingUri
import sh.omp.remote.protocol.ProtocolEngineState
import sh.omp.remote.protocol.RemoteProtocolEngine
import sh.omp.remote.protocol.RemoteSessionSummary
import sh.omp.remote.protocol.RemoteNotificationEvent
import sh.omp.remote.protocol.RemoteNativeResultEvent
import sh.omp.remote.protocol.MAX_STREAMED_COMMAND_RESULT_BYTES
import sh.omp.remote.data.NativeShareStatus
import sh.omp.remote.data.SecureNativeShareStore
import sh.omp.remote.relay.RelayConnection
import sh.omp.remote.relay.RelayState

data class RemoteServiceState(
    val phase: Phase = Phase.STOPPED,
    val connection: RelayState = RelayState.Idle,
    val roomLabel: String? = null,
    val selectedSessionId: String? = null,
    val sessions: List<RemoteSessionSummary> = emptyList(),
    val capabilityVerbs: Set<String> = emptySet(),
    val allSessionsGranted: Boolean = false,
    val error: String? = null,
) {
    enum class Phase { STOPPED, PAIRING, AUTHENTICATING, ACTIVE, RECONNECTING }
}

data class RemoteNativeShare(
    val uri: Uri,
    val mimeType: String,
    val displayName: String,
    val token: String,
)

class RemoteSessionService : Service() {
    private val serviceJob: Job = SupervisorJob()
    /**
     * Nothing this service does is worth taking the app down for.
     *
     * A coroutine that throws here kills the process, and START_STICKY then restarts
     * it straight back into the same failure — a crash loop that reads, from the
     * outside, as "the app just closes". Report it and stand down instead.
     */
    private val crashGuard = CoroutineExceptionHandler { _, failure -> reportFatal(failure) }
    private val scope = CoroutineScope(serviceJob + Dispatchers.IO + crashGuard)
    private var pairingWatchdog: Job? = null
    private lateinit var relay: RelayConnection
    private lateinit var engine: RemoteProtocolEngine
    private lateinit var connectivity: ConnectivityManager
    private lateinit var nativeShareStore: SecureNativeShareStore
    private val binder = LocalBinder()
    private var pairing: PairingUri? = null
    private var nativeShareCleanupJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        clearMessageReplay()
        createNotificationChannels()
        nativeShareStore = SecureNativeShareStore(applicationContext)
        relay = RelayConnection(scope)
        engine = RemoteProtocolEngine(applicationContext, relay, scope, nativeResultSink = { event ->
            when (event) {
                is RemoteNativeResultEvent.ExportMarkdown -> publishMarkdownExport(event.content)
            }
        })
        restoreNativeShareCache()
        connectivity = getSystemService(ConnectivityManager::class.java)
        connectivity.registerNetworkCallback(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), networkCallback)
        scope.launch {
            relay.state.collect { connection ->
                val phase = when (connection) {
                    RelayState.Connected -> when (engine.state.value) {
                        is ProtocolEngineState.Active -> RemoteServiceState.Phase.ACTIVE
                        ProtocolEngineState.Pairing -> RemoteServiceState.Phase.PAIRING
                        else -> RemoteServiceState.Phase.AUTHENTICATING
                    }
                    is RelayState.Reconnecting, RelayState.Offline -> RemoteServiceState.Phase.RECONNECTING
                    is RelayState.Closed, RelayState.Idle -> RemoteServiceState.Phase.STOPPED
                    is RelayState.Connecting -> _state.value.phase.takeUnless { it == RemoteServiceState.Phase.STOPPED }
                        ?: RemoteServiceState.Phase.PAIRING
                }
                // A relay that closes the socket outright during pairing has given a
                // verdict, not hit a blip -- "no such room" for a stale or wrong-relay
                // QR arrives this way. Say so now instead of waiting out the link's
                // whole TTL on the watchdog.
                val closedWhilePairing = connection is RelayState.Closed &&
                    _state.value.phase == RemoteServiceState.Phase.PAIRING
                if (closedWhilePairing) cancelPairingWatchdog()
                _state.value = _state.value.copy(
                    phase = phase,
                    connection = connection,
                    error = if (closedWhilePairing) {
                        getString(R.string.pairing_relay_refused, (connection as RelayState.Closed).reason)
                    } else {
                        _state.value.error
                    },
                )
                if (connection is RelayState.Connected) {
                    // The relay can accept the socket and close it in the same breath —
                    // an unknown or expired room does exactly that — so the first frame
                    // races the close and `check(relay.sendBinary(...))` loses. Losing
                    // that race is a failed pairing, not a reason to die.
                    runCatching { engine.onTransportConnected() }
                        .onFailure { failure -> reportFatal(failure) }
                }
                updateForegroundNotification()
            }
        }
        scope.launch {
            engine.state.collect { protocol ->
                val phase = when (protocol) {
                    ProtocolEngineState.Idle -> RemoteServiceState.Phase.STOPPED
                    ProtocolEngineState.Pairing -> RemoteServiceState.Phase.PAIRING
                    ProtocolEngineState.Authenticating -> RemoteServiceState.Phase.AUTHENTICATING
                    is ProtocolEngineState.Active -> {
                        cancelPairingWatchdog()
                        RemoteServiceState.Phase.ACTIVE
                    }
                    is ProtocolEngineState.Recovering -> RemoteServiceState.Phase.RECONNECTING
                    is ProtocolEngineState.Failed -> _state.value.phase
                }
                if (protocol is ProtocolEngineState.Active) {
                    pairing?.pairingKey?.fill(0)
                    pairing = null
                }
                _state.value = _state.value.copy(
                    phase = phase,
                    // Only a live session earns a clean slate. Clearing unconditionally
                    // erased whatever had just been reported: tearing down after a
                    // failure drives the engine to Idle, and that emission wiped the
                    // very message explaining the failure.
                    error = when {
                        protocol is ProtocolEngineState.Failed -> protocol.reason
                        protocol is ProtocolEngineState.Active -> null
                        else -> _state.value.error
                    },
                )
                updateForegroundNotification()
            }
        }
        scope.launch { engine.hostMessages.collect { _messages.emit(it) } }
        scope.launch {
            engine.notifications.collect { event ->
                val title = _state.value.sessions.firstOrNull { it.id == when (event) {
                    is RemoteNotificationEvent.Approval -> event.sessionId
                    is RemoteNotificationEvent.TurnCompleted -> event.sessionId
                } }?.title?.ifBlank { "OMP Code" } ?: "OMP Code"
                when (event) {
                    is RemoteNotificationEvent.Approval -> notifyActionRequired(event.sessionId, title, event.detail)
                    is RemoteNotificationEvent.TurnCompleted -> notifyTurnCompleted(event.sessionId, title)
                }
            }
        }
        scope.launch {
            engine.board.collect { board ->
                _state.value = _state.value.copy(
                    selectedSessionId = board.selectedSessionId,
                    sessions = board.sessions,
                )
            }
        }
        scope.launch {
            engine.capabilities.collect { capability ->
                _state.value = _state.value.copy(
                    capabilityVerbs = capability.verbs,
                    allSessionsGranted = capability.allSessions,
                )
            }
        }
        scope.launch {
            _uiMessages.collect { raw ->
                runCatching { engine.handleUiMessage(raw) }.onFailure { error ->
                    _messages.emit("""{"t":"frame","frame":{"type":"notice","level":"error","message":${org.json.JSONObject.quote(error.message ?: "Remote command rejected")}}}""")
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_RESUME, null -> {
                if (_state.value.phase != RemoteServiceState.Phase.STOPPED) return START_STICKY
                clearMessageReplay()
                // startForegroundService callers require this before any storage/network
                // work, including the no-credential branch.
                startForegroundSafely(notification(getString(R.string.service_connecting)))
                // This whole branch runs on the main thread on every cold start. Anything
                // that throws here is not a failed resume, it is a permanent crash loop:
                // the app dies before any UI, relaunches, and dies again. Failing back to
                // the pairing screen with a message is always the better outcome.
                val resumeUri = runCatching { engine.resumeStoredCredential() }
                    .getOrElse { failure ->
                        _state.value = RemoteServiceState(error = resumeFailureMessage(failure))
                        null
                    }
                if (resumeUri == null) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelfResult(startId)
                    return START_NOT_STICKY
                }
                _state.value = RemoteServiceState(
                    phase = RemoteServiceState.Phase.AUTHENTICATING,
                    connection = RelayState.Connecting(1),
                    roomLabel = "${resumeUri.host ?: "relay"}/…",
                )
                val connected = runCatching { relay.connect(resumeUri) }.isSuccess
                if (!connected) {
                    _state.value = RemoteServiceState(error = getString(R.string.resume_failed))
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelfResult(startId)
                    return START_NOT_STICKY
                }
            }
            ACTION_CONNECT_PAIRING -> {
                clearMessageReplay()
                clearNativeShareCache()
                startForegroundSafely(notification(getString(R.string.service_connecting)))
                val raw = intent.getStringExtra(EXTRA_PAIRING_URI)
                val parsed = raw?.let { runCatching { PairingUri.parse(it, Clock.systemUTC()) }.getOrNull() }
                if (parsed == null) {
                    _state.value = RemoteServiceState(error = "Invalid or expired pairing link")
                    stopSelfResult(startId)
                    return START_NOT_STICKY
                }
                pairing?.pairingKey?.fill(0)
                pairing = parsed
                engine.startPairing(parsed)
                _state.value = RemoteServiceState(
                    phase = RemoteServiceState.Phase.PAIRING,
                    connection = RelayState.Connecting(1),
                    roomLabel = parsed.redactedDescription(),
                )
                armPairingWatchdog(parsed)
                relay.connect(parsed.guestWebSocketUri())
            }
            ACTION_DISCONNECT -> {
                cancelPairingWatchdog()
                clearMessageReplay()
                clearNativeShareCache()
                pairing?.pairingKey?.fill(0)
                pairing = null
                engine.disconnect()
                relay.disconnect("user")
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            ACTION_REVOKE -> {
                scope.launch {
                    runCatching { engine.revokeRemote() }
                        .onSuccess {
                            clearMessageReplay()
                            clearNativeShareCache()
                            pairing?.pairingKey?.fill(0)
                            pairing = null
                            relay.disconnect("revoked")
                            stopForeground(STOP_FOREGROUND_REMOVE)
                            stopSelf()
                        }
                        .onFailure { error ->
                            _messages.emit(
                                """{"t":"frame","frame":{"type":"notice","level":"error","message":${org.json.JSONObject.quote(error.message ?: getString(R.string.revoke_failed))}}}""",
                            )
                        }
                }
            }
            ACTION_SHOW_APPROVAL -> intent.getStringExtra(EXTRA_SESSION_ID)?.let { sessionId ->
                runCatching { engine.switchSession(sessionId) }
            }
            ACTION_SWITCH_SESSION -> intent.getStringExtra(EXTRA_SESSION_ID)?.let { sessionId ->
                runCatching { engine.switchSession(sessionId) }.onFailure { error ->
                    scope.launch {
                        _messages.emit("""{"t":"frame","frame":{"type":"notice","level":"error","message":${org.json.JSONObject.quote(error.message ?: "Session switch failed")}}}""")
                    }
                }
            }
            ACTION_CREATE_SESSION -> runSessionAction { engine.createSession() }
            ACTION_RENAME_SESSION -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
                val title = intent.getStringExtra(EXTRA_SESSION_TITLE)
                if (sessionId != null && title != null) runSessionAction { engine.renameSession(sessionId, title) }
            }
            ACTION_CLOSE_SESSION -> intent.getStringExtra(EXTRA_SESSION_ID)?.let { sessionId ->
                runSessionAction { engine.closeSession(sessionId) }
            }
            ACTION_UPLOAD_ATTACHMENT -> intent.data?.let { uri ->
                scope.launch {
                    runCatching { engine.uploadAttachment(uri) }.onFailure { error ->
                        _messages.emit("""{"t":"attached","files":[],"rejected":[${org.json.JSONObject.quote(error.message ?: "Attachment upload failed")}]}""")
                    }
                }
            }
            ACTION_CONSUME_NATIVE_SHARE -> {
                val raw = intent.getStringExtra(EXTRA_NATIVE_SHARE_URI)
                val token = intent.getStringExtra(EXTRA_NATIVE_SHARE_TOKEN)
                if (raw != null && token != null) markNativeShareConsumed(Uri.parse(raw), token)
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    private fun runSessionAction(action: () -> Unit) {
        runCatching(action).onFailure { error ->
            scope.launch {
                _messages.emit("""{"t":"frame","frame":{"type":"notice","level":"error","message":${org.json.JSONObject.quote(error.message ?: "Session action failed")}}}""")
            }
        }
    }

    override fun onDestroy() {
        clearMessageReplay()
        runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
        pairing?.pairingKey?.fill(0)
        pairing = null
        engine.disconnect()
        relay.close()
        scope.cancel()
        // Keep the reason. Stopping is usually how a failure ends, and wiping the
        // message on the way out left the pairing screen looking like nothing had
        // happened -- which is precisely the failure being reported.
        _state.value = RemoteServiceState(error = _state.value.error)
        super.onDestroy()
    }

    @Synchronized
    private fun publishMarkdownExport(content: String) {
        val bytes = content.toByteArray(Charsets.UTF_8)
        require(bytes.size in 1..MAX_STREAMED_COMMAND_RESULT_BYTES) { "Export exceeds the native share limit" }
        val directory = File(cacheDir, NATIVE_SHARE_DIRECTORY).apply { mkdirs() }
        require(directory.isDirectory) { "Unable to prepare the private export cache" }
        val temporary = File(directory, "$NATIVE_SHARE_FILE.tmp")
        val target = File(directory, NATIVE_SHARE_FILE)
        try {
            nativeShareCleanupJob?.cancel()
            _nativeShare.value = null
            FileOutputStream(temporary).use { stream ->
                stream.write(bytes)
                stream.fd.sync()
            }
            var committed = temporary.renameTo(target)
            if (!committed) {
                if (target.exists()) target.delete()
                committed = temporary.renameTo(target)
            }
            require(committed) { "Unable to commit the private export" }
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val token = UUID.randomUUID().toString()
            nativeShareStore.savePending(token, NATIVE_SHARE_FILE, bytes.size, digest, System.currentTimeMillis())
            val uri = FileProvider.getUriForFile(this, "$packageName.files", target)
            _nativeShare.value = RemoteNativeShare(uri, "text/markdown", NATIVE_SHARE_FILE, token)
        } catch (error: Throwable) {
            target.delete()
            runCatching { nativeShareStore.clear() }
            throw error
        } finally {
            bytes.fill(0)
            if (temporary.exists()) temporary.delete()
        }
    }

    @Synchronized
    private fun clearNativeShareCache() {
        nativeShareCleanupJob?.cancel()
        nativeShareCleanupJob = null
        _nativeShare.value = null
        val directory = File(cacheDir, NATIVE_SHARE_DIRECTORY)
        File(directory, NATIVE_SHARE_FILE).delete()
        File(directory, "$NATIVE_SHARE_FILE.tmp").delete()
        directory.delete()
        runCatching { nativeShareStore.clear() }
    }

    @Synchronized
    private fun restoreNativeShareCache() {
        val record = runCatching { nativeShareStore.load() }.getOrNull()
        val target = File(File(cacheDir, NATIVE_SHARE_DIRECTORY), NATIVE_SHARE_FILE)
        val valid = record != null && target.isFile && target.length() == record.totalBytes.toLong() &&
            runCatching { sha256(target) }.getOrNull() == record.sha256
        if (!valid) {
            clearNativeShareCache()
            return
        }
        checkNotNull(record)
        if (record.status == NativeShareStatus.CONSUMED) {
            scheduleNativeShareDeletion(record.consumedAtEpochMillis ?: System.currentTimeMillis())
            return
        }
        _nativeShare.value = RemoteNativeShare(
            FileProvider.getUriForFile(this, "$packageName.files", target), "text/markdown", NATIVE_SHARE_FILE, record.token,
        )
    }

    @Synchronized
    private fun markNativeShareConsumed(uri: Uri, token: String) {
        val pending = _nativeShare.value ?: return
        if (pending.uri != uri || pending.token != token) return
        val consumed = nativeShareStore.markConsumed(token, System.currentTimeMillis()) ?: return
        _nativeShare.value = null
        scheduleNativeShareDeletion(consumed.consumedAtEpochMillis ?: System.currentTimeMillis())
    }

    @Synchronized
    private fun scheduleNativeShareDeletion(consumedAtEpochMillis: Long) {
        nativeShareCleanupJob?.cancel()
        val elapsed = (System.currentTimeMillis() - consumedAtEpochMillis).coerceAtLeast(0)
        val remaining = (NATIVE_SHARE_RETENTION_MILLIS - elapsed).coerceIn(0, NATIVE_SHARE_RETENTION_MILLIS)
        nativeShareCleanupJob = scope.launch {
            kotlinx.coroutines.delay(remaining)
            clearNativeShareCache()
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(32 * 1024)
        FileInputStream(file).use { input ->
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count > 0) digest.update(buffer, 0, count)
            }
        }
        buffer.fill(0)
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun notifyActionRequired(sessionId: String, title: String, detail: String) {
        if (!canPostNotifications()) return
        val intent = PendingIntent.getActivity(
            this,
            sessionId.hashCode(),
            MainActivity.intentForSession(this, sessionId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        postNotification(
            ACTION_NOTIFICATION_BASE + sessionId.hashCode(),
            NotificationCompat.Builder(this, CHANNEL_ACTION)
                .setSmallIcon(R.drawable.ic_app)
                .setContentTitle(title.take(120))
                .setContentText(detail.take(240))
                .setContentIntent(intent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .build(),
        )
    }

    fun notifyTurnCompleted(sessionId: String, title: String) {
        if (!canPostNotifications()) return
        postNotification(
            TURN_NOTIFICATION_BASE + sessionId.hashCode(),
            NotificationCompat.Builder(this, CHANNEL_TURN)
                .setSmallIcon(R.drawable.ic_app)
                .setContentTitle(title.take(120))
                .setContentText(getString(R.string.turn_channel))
                .setContentIntent(PendingIntent.getActivity(this, sessionId.hashCode(), MainActivity.intentForSession(this, sessionId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                .setAutoCancel(true)
                .build(),
        )
    }

    private fun startForegroundSafely(value: Notification) {
        val foregroundType = if (android.os.Build.VERSION.SDK_INT >= 34) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
        } else {
            0
        }
        // API 31+ throws ForegroundServiceStartNotAllowedException when the system
        // decides this start came from the background, and API 34+ adds its own type
        // checks. Neither is worth killing the app over -- the session simply cannot
        // run in the background right now.
        runCatching {
            ServiceCompat.startForeground(
                this,
                FOREGROUND_NOTIFICATION_ID,
                value,
                foregroundType,
            )
        }
    }

    /** Tear down cleanly and leave a message behind, from any thread. */
    private fun reportFatal(failure: Throwable) {
        // `pairing` is the durable signal: by the time this runs the phase may already
        // have been driven to STOPPED by the transport closing.
        // `pairing` is the durable signal: by the time this runs the phase may already
        // have been driven to STOPPED by the transport closing.
        val whilePairing = pairing != null
        cancelPairingWatchdog()
        // The message is published before anything is torn down. Disconnecting drives
        // the engine to Idle, and that emission reads the current error -- publish last
        // and the collector copies the null that was there a moment ago.
        _state.value = RemoteServiceState(
            // Mid-pairing, the internals are noise: what a person can act on is that the
            // link did not work and a fresh QR is needed. Elsewhere the detail is the
            // only clue there is, so it stays.
            error = if (whilePairing) {
                getString(R.string.pairing_link_rejected)
            } else {
                getString(R.string.remote_stopped_error, failure.message ?: failure.javaClass.simpleName)
            },
        )
        runCatching { engine.disconnect() }
        runCatching { relay.disconnect("internal-error") }
        pairing?.pairingKey?.fill(0)
        pairing = null
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        runCatching { stopSelf() }
    }

    /**
     * Stop pretending a dead pairing link is still connecting.
     *
     * RelayConnection reconnects forever with backoff, which is right for an
     * established session on a flaky network and wrong for pairing: the link carries
     * its own expiry, and once that passes no amount of retrying can succeed. Without
     * this the phone sat on "Connecting securely…" indefinitely after scanning a QR
     * that pointed nowhere — the failure mode looked identical to nothing happening.
     */
    private fun armPairingWatchdog(uri: PairingUri) {
        pairingWatchdog?.cancel()
        val remaining = uri.expiresAtEpochMillis - System.currentTimeMillis()
        pairingWatchdog = scope.launch {
            if (remaining > 0) delay(remaining)
            if (_state.value.phase != RemoteServiceState.Phase.PAIRING) return@launch
            engine.disconnect()
            relay.disconnect("pairing-expired")
            pairing?.pairingKey?.fill(0)
            pairing = null
            _state.value = RemoteServiceState(error = getString(R.string.pairing_never_connected))
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun cancelPairingWatchdog() {
        pairingWatchdog?.cancel()
        pairingWatchdog = null
    }

    /**
     * Why a stored session could not be resumed, in words a person can act on.
     *
     * The underlying failure is a deserialisation or validation error against a blob
     * this build cannot read, and the only remedy is to pair again.
     */
    private fun resumeFailureMessage(failure: Throwable): String =
        getString(R.string.resume_failed) + (failure.message?.let { " ($it)" } ?: "")

    private fun updateForegroundNotification() {
        if (_state.value.phase == RemoteServiceState.Phase.STOPPED) return
        val text = when (_state.value.connection) {
            RelayState.Connected -> getString(R.string.service_connected)
            is RelayState.Reconnecting, RelayState.Offline -> getString(R.string.service_offline)
            else -> getString(R.string.service_connecting)
        }
        postNotification(FOREGROUND_NOTIFICATION_ID, notification(text))
    }

    private fun notification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val disconnectIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, RemoteSessionService::class.java).setAction(ACTION_DISCONNECT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_app)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, "Disconnect", disconnectIntent)
            .build()
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_SERVICE, getString(R.string.service_channel), NotificationManager.IMPORTANCE_LOW).apply {
                    description = getString(R.string.service_channel_description)
                    setShowBadge(false)
                },
                NotificationChannel(CHANNEL_ACTION, getString(R.string.action_channel), NotificationManager.IMPORTANCE_HIGH),
                NotificationChannel(CHANNEL_TURN, getString(R.string.turn_channel), NotificationManager.IMPORTANCE_DEFAULT),
            ),
        )
    }

    private fun canPostNotifications(): Boolean =
        android.os.Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun postNotification(id: Int, value: Notification) {
        if (!canPostNotifications()) return
        try {
            NotificationManagerCompat.from(this).notify(id, value)
        } catch (_: SecurityException) {
            // Permission can be revoked between the check and notify. The encrypted
            // foreground connection remains usable without an auxiliary alert.
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = relay.updateNetworkAvailability(true)
        override fun onLost(network: Network) {
            val available = connectivity.activeNetwork?.let(connectivity::getNetworkCapabilities)
                ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
            relay.updateNetworkAvailability(available)
        }
    }

    inner class LocalBinder : Binder() {
        fun service(): RemoteSessionService = this@RemoteSessionService
    }

    companion object {
        private const val ACTION_CONNECT_PAIRING = "sh.omp.remote.action.CONNECT_PAIRING"
        private const val ACTION_RESUME = "sh.omp.remote.action.RESUME"
        private const val ACTION_DISCONNECT = "sh.omp.remote.action.DISCONNECT"
        private const val ACTION_REVOKE = "sh.omp.remote.action.REVOKE"
        private const val ACTION_SHOW_APPROVAL = "sh.omp.remote.action.SHOW_APPROVAL"
        private const val ACTION_SWITCH_SESSION = "sh.omp.remote.action.SWITCH_SESSION"
        private const val ACTION_CREATE_SESSION = "sh.omp.remote.action.CREATE_SESSION"
        private const val ACTION_RENAME_SESSION = "sh.omp.remote.action.RENAME_SESSION"
        private const val ACTION_CLOSE_SESSION = "sh.omp.remote.action.CLOSE_SESSION"
        private const val ACTION_UPLOAD_ATTACHMENT = "sh.omp.remote.action.UPLOAD_ATTACHMENT"
        private const val ACTION_CONSUME_NATIVE_SHARE = "sh.omp.remote.action.CONSUME_NATIVE_SHARE"
        private const val EXTRA_PAIRING_URI = "pairing_uri"
        private const val EXTRA_SESSION_ID = "session_id"
        private const val EXTRA_SESSION_TITLE = "session_title"
        private const val EXTRA_NATIVE_SHARE_URI = "native_share_uri"
        private const val EXTRA_NATIVE_SHARE_TOKEN = "native_share_token"
        private const val CHANNEL_SERVICE = "remote_session"
        private const val CHANNEL_ACTION = "remote_action"
        private const val CHANNEL_TURN = "remote_turn"
        private const val FOREGROUND_NOTIFICATION_ID = 4100
        private const val ACTION_NOTIFICATION_BASE = 4200
        private const val TURN_NOTIFICATION_BASE = 4300
        private const val NATIVE_SHARE_DIRECTORY = "remote-share"
        private const val NATIVE_SHARE_FILE = "omp-transcript.md"
        private const val NATIVE_SHARE_RETENTION_MILLIS = 5 * 60 * 1_000L

        private val _state = MutableStateFlow(RemoteServiceState())
        val state: StateFlow<RemoteServiceState> = _state.asStateFlow()
        // Never replay plaintext renderer messages across a disconnect/re-pair.
        // `ui.ready` always requests a fresh deterministic encrypted full sync.
        private val _messages = MutableSharedFlow<String>(replay = 0, extraBufferCapacity = 256)
        val messages: SharedFlow<String> = _messages.asSharedFlow()
        private val _uiMessages = MutableSharedFlow<String>(extraBufferCapacity = 128)
        private val _nativeShare = MutableStateFlow<RemoteNativeShare?>(null)
        val nativeShare: StateFlow<RemoteNativeShare?> = _nativeShare.asStateFlow()

        @OptIn(ExperimentalCoroutinesApi::class)
        private fun clearMessageReplay() {
            _messages.resetReplayCache()
        }

        fun postRendererMessage(message: String): Boolean {
            require(message.toByteArray(Charsets.UTF_8).size <= 256 * 1024)
            return _uiMessages.tryEmit(message)
        }

        fun consumeNativeShare(context: Context, share: RemoteNativeShare) {
            context.startService(
                Intent(context, RemoteSessionService::class.java)
                    .setAction(ACTION_CONSUME_NATIVE_SHARE)
                    .putExtra(EXTRA_NATIVE_SHARE_URI, share.uri.toString())
                    .putExtra(EXTRA_NATIVE_SHARE_TOKEN, share.token),
            )
        }

        fun connect(context: Context, pairingUri: String) {
            val intent = Intent(context, RemoteSessionService::class.java)
                .setAction(ACTION_CONNECT_PAIRING)
                .putExtra(EXTRA_PAIRING_URI, pairingUri)
            ContextCompat.startForegroundService(context, intent)
        }

        fun resume(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, RemoteSessionService::class.java).setAction(ACTION_RESUME),
            )
        }

        fun disconnect(context: Context) {
            context.startService(Intent(context, RemoteSessionService::class.java).setAction(ACTION_DISCONNECT))
        }

        fun revoke(context: Context) {
            context.startService(Intent(context, RemoteSessionService::class.java).setAction(ACTION_REVOKE))
        }

        fun uploadAttachment(context: Context, uri: android.net.Uri) {
            val intent = Intent(context, RemoteSessionService::class.java)
                .setAction(ACTION_UPLOAD_ATTACHMENT)
                .setData(uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            context.startService(intent)
        }

        fun switchSession(context: Context, sessionId: String) {
            require(sessionId.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")))
            context.startService(
                Intent(context, RemoteSessionService::class.java)
                    .setAction(ACTION_SWITCH_SESSION)
                    .putExtra(EXTRA_SESSION_ID, sessionId),
            )
        }

        fun createSession(context: Context) {
            context.startService(Intent(context, RemoteSessionService::class.java).setAction(ACTION_CREATE_SESSION))
        }

        fun renameSession(context: Context, sessionId: String, title: String) {
            context.startService(
                Intent(context, RemoteSessionService::class.java)
                    .setAction(ACTION_RENAME_SESSION)
                    .putExtra(EXTRA_SESSION_ID, sessionId)
                    .putExtra(EXTRA_SESSION_TITLE, title),
            )
        }

        fun closeSession(context: Context, sessionId: String) {
            context.startService(
                Intent(context, RemoteSessionService::class.java)
                    .setAction(ACTION_CLOSE_SESSION)
                    .putExtra(EXTRA_SESSION_ID, sessionId),
            )
        }
    }
}
