package sh.omp.remote.protocol

import android.content.Context
import android.os.Build
import android.net.Uri
import android.provider.OpenableColumns
import java.net.URI
import java.security.SecureRandom
import java.security.MessageDigest
import java.text.Normalizer
import java.util.UUID
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import sh.omp.remote.crypto.AuthenticatedHeader
import sh.omp.remote.crypto.CryptoCodec
import sh.omp.remote.crypto.HkdfSha256
import sh.omp.remote.crypto.KeyPurpose
import sh.omp.remote.crypto.ProtocolSecurity
import sh.omp.remote.crypto.RelayEnvelope
import sh.omp.remote.crypto.TrafficDirection
import sh.omp.remote.data.DeviceCredential
import sh.omp.remote.data.OutboxItem
import sh.omp.remote.data.PendingEnrolment
import sh.omp.remote.data.SecureCounterStore
import sh.omp.remote.data.SecureCommandResultStore
import sh.omp.remote.data.SecureOutbox
import sh.omp.remote.data.SecurePairingStore
import sh.omp.remote.data.StoredCommandResult
import sh.omp.remote.relay.RelayConnection
import sh.omp.remote.relay.RelayEvent

sealed interface ProtocolEngineState {
    data object Idle : ProtocolEngineState
    data object Pairing : ProtocolEngineState
    data object Authenticating : ProtocolEngineState
    data class Active(val hostGeneration: String, val lastSequence: String) : ProtocolEngineState
    data class Recovering(val reason: String) : ProtocolEngineState
    data class Failed(val reason: String, val retryable: Boolean) : ProtocolEngineState
}

sealed interface RemoteNotificationEvent {
    data class Approval(val sessionId: String, val detail: String) : RemoteNotificationEvent
    data class TurnCompleted(val sessionId: String) : RemoteNotificationEvent
}

sealed interface RemoteNativeResultEvent {
    data class ExportMarkdown(val content: String) : RemoteNativeResultEvent
}

data class RemoteCapabilityUi(
    val verbs: Set<String> = emptySet(),
    val allSessions: Boolean = false,
)

private val approvalIdentifierPattern = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")

/** Mirrors OmpSession's nullish extraction for a select approval response. */
internal fun normalizeApprovalOption(item: JsonElement): JsonElement {
    if (item !is JsonObject) return item
    for (key in listOf("value", "label", "name", "title")) {
        val candidate = item[key]
        if (candidate != null && candidate !is JsonNull) return candidate
    }
    return JsonPrimitive("")
}

internal fun actionableApprovalRequestId(frame: JsonObject): String? {
    if ((frame["type"] as? JsonPrimitive)?.content != "extension_ui_request") return null
    val method = (frame["method"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (method !in setOf("confirm", "select", "input", "editor")) return null
    return (frame["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?.takeIf(approvalIdentifierPattern::matches)
}

internal fun approvalResponseRequestId(body: JsonObject): String {
    val frame = body["frame"] as? JsonObject ?: error("UI response frame is missing")
    return (frame["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?.takeIf(approvalIdentifierPattern::matches)
        ?: error("Approval request id is invalid")
}

internal fun approvalResolutionRequestId(value: JsonObject): String? {
    if ((value["t"] as? JsonPrimitive)?.content != "approvalResolved") return null
    require(value.keys == setOf("t", "requestId", "outcome", "winner")) { "Approval resolution has unknown fields" }
    val requestId = (value["requestId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?.takeIf(approvalIdentifierPattern::matches)
        ?: error("Approval resolution request id is invalid")
    val outcome = (value["outcome"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val winner = (value["winner"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    require(outcome in setOf("answered", "cancelled")) { "Approval resolution outcome is invalid" }
    require(winner in setOf("desktop", "remote", "agent")) { "Approval resolution winner is invalid" }
    return requestId
}

internal fun shouldRetainApprovalAfter(status: String, errorCode: String? = null): Boolean =
    status != "completed" && errorCode !in setOf("host-not-pending", "answer-won")

internal fun shouldSendSessionSwitch(selectedSessionId: String?, targetSessionId: String): Boolean =
    selectedSessionId != targetSessionId

internal fun isSessionInsideSignedGrant(manifest: CapabilityManifest, sessionId: String?): Boolean =
    sessionId != null && sessionId in manifest.sessionIds

internal fun hasDurableUiResult(uiKind: String, result: JsonElement?): Boolean {
    if (uiKind in setOf("prompt", "approval")) return true
    val body = result as? JsonObject ?: return false
    return when (uiKind) {
        "history" -> body["sessions"] is JsonArray
        "files" -> body["files"] is JsonArray
        "export" ->
            (body["format"] as? JsonPrimitive)?.takeIf { it.isString }?.content == "markdown" &&
                (body["content"] as? JsonPrimitive)?.isString == true
        "diagnostics" -> (body["markdown"] as? JsonPrimitive)?.isString == true
        "models-probe" -> body["results"] is JsonObject
        "diff" ->
            (body["changeId"] as? JsonPrimitive)?.isString == true &&
                (body["afterSha256"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.matches(Regex("[0-9a-f]{64}")) == true
        else -> false
    }
}

internal data class StreamedResultMarker(val totalBytes: Int, val sha256: String)

internal fun streamedResultMarker(value: JsonElement?): StreamedResultMarker? {
    val body = value as? JsonObject ?: return null
    val streamed = body["streamed"] as? JsonPrimitive ?: return null
    if (streamed.isString || streamed.content != "true") return null
    require(body.keys == setOf("streamed", "totalBytes", "sha256")) { "Streamed result marker has unknown fields" }
    val total = (body["totalBytes"] as? JsonPrimitive)?.takeUnless { it.isString }?.content?.toIntOrNull()
        ?.takeIf { it in 1..MAX_STREAMED_COMMAND_RESULT_BYTES }
        ?: error("Streamed result size is invalid")
    val sha = (body["sha256"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?.takeIf { it.matches(Regex("[0-9a-f]{64}")) }
        ?: error("Streamed result digest is invalid")
    return StreamedResultMarker(total, sha)
}

/**
 * Android guest for the normative OMP Remote v1 wire. It never forwards arbitrary relay
 * JSON to OMP RPC: only closed handshake/data schemas reach the UI or durable outbox.
 */
class RemoteProtocolEngine(
    context: Context,
    private val relay: RelayConnection,
    private val scope: CoroutineScope,
    private val nativeResultSink: (RemoteNativeResultEvent) -> Unit,
) {
    private val pairingStore = SecurePairingStore(context)
    private val contentResolver = context.applicationContext.contentResolver
    private val counterStore = SecureCounterStore(context)
    private val outbox = SecureOutbox(context)
    private val androidHostPort = AndroidHostPort(outbox) { flushOutbox() }
    private val syncAccumulator = RemoteSyncAccumulator()
    private val commandResultAccumulator = RemoteCommandResultAccumulator()
    private val commandResultStore = SecureCommandResultStore(context)
    private val random = SecureRandom()

    private val _state = MutableStateFlow<ProtocolEngineState>(ProtocolEngineState.Idle)
    val state: StateFlow<ProtocolEngineState> = _state.asStateFlow()
    private val _hostMessages = MutableSharedFlow<String>(extraBufferCapacity = 256)
    val hostMessages: SharedFlow<String> = _hostMessages.asSharedFlow()
    private val _board = MutableStateFlow(RemoteSessionBoard())
    val board: StateFlow<RemoteSessionBoard> = _board.asStateFlow()
    private val _notifications = MutableSharedFlow<RemoteNotificationEvent>(extraBufferCapacity = 32)
    val notifications: SharedFlow<RemoteNotificationEvent> = _notifications.asSharedFlow()
    private val _capabilities = MutableStateFlow(RemoteCapabilityUi())
    val capabilities: StateFlow<RemoteCapabilityUi> = _capabilities.asStateFlow()

    private var pending: PendingPairing? = null
    private var credential: DeviceCredential? = null
    private var hello: HelloContext? = null
    private var connection: ConnectionContext? = null
    private var pendingFallback: Job? = null
    private var phaseTimeout: Job? = null
    private var selectedSessionId: String? = null
    private val approvals = mutableMapOf<String, ApprovalRequest>()
    private val commandWaiters = mutableMapOf<String, CompletableDeferred<AckOutcome>>()
    private val chunkWaiters = mutableMapOf<String, CompletableDeferred<String>>()
    private val pendingUiCommands = mutableMapOf<String, PendingUiCommand>()
    private var commandResultVolatileSequence: java.math.BigInteger? = null

    init {
        scope.launch {
            relay.events.collect(::onRelayEvent)
        }
    }

    @Synchronized
    fun startPairing(value: PairingUri) {
        discardVolatileAccumulators()
        commandResultStore.clear()
        _board.value = RemoteSessionBoard()
        _capabilities.value = RemoteCapabilityUi()
        val nonce = ByteArray(16).also(random::nextBytes)
        val frame = RemoteHandshakeCodec.pair(
            deviceId = "android-${UUID.randomUUID()}",
            deviceName = Build.MODEL.filter { it.code in 0x20..0x7e }.take(128).ifBlank { "Android" },
            deviceNonce = ProtocolSecurity.encodeBase64Url(nonce),
        )
        pending?.destroy()
        pending = PendingPairing(value, nonce, frame)
        pairingStore.savePending(
            PendingEnrolment(
                relayOrigin = value.relayOrigin.toASCIIString(),
                roomId = value.roomId,
                pairingKeyBase64Url = Base64.getUrlEncoder().withoutPadding().encodeToString(value.pairingKey),
                expiresAtEpochMillis = value.expiresAtEpochMillis,
                keyEpoch = value.keyEpoch,
                pairFrameJson = frame.raw.toString(),
            ),
        )
        credential = null
        hello = null
        connection = null
        _state.value = ProtocolEngineState.Pairing
    }

    /** Returns the guest relay URI when an enrolled credential can be resumed. */
    @Synchronized
    fun resumeStoredCredential(): URI? {
        discardVolatileAccumulators()
        pairingStore.loadPending()?.let { saved ->
            if (saved.expiresAtEpochMillis > System.currentTimeMillis()) {
                // Rebuilding a pending enrolment used to be three unguarded throws in a
                // row -- a cast, a !! and a URI constructor -- on the main thread inside
                // Service.onStartCommand. An enrolment that cannot be rebuilt is simply
                // not resumable, so it is dropped and pairing starts over.
                val resumed = runCatching {
                    val pairFrame = RemoteHandshakeCodec
                        .parse(saved.pairFrameJson.toByteArray(Charsets.UTF_8)) as? PairFrame
                        ?: error("stored pending enrolment is not a pair frame")
                    val nonce = ProtocolSecurity.decodeCanonical(pairFrame.deviceNonce, 16)
                        ?: error("stored pending enrolment carries an unusable device nonce")
                    val uri = PairingUri(
                        relayOrigin = URI(saved.relayOrigin),
                        roomId = saved.roomId,
                        pairingKey = Base64.getUrlDecoder().decode(saved.pairingKeyBase64Url),
                        expiresAtEpochMillis = saved.expiresAtEpochMillis,
                        keyEpoch = saved.keyEpoch,
                    )
                    PendingPairing(uri, nonce, pairFrame)
                }.getOrNull()
                if (resumed != null) {
                    pending = resumed
                    credential = pairingStore.load()
                    hello = null
                    connection = null
                    _state.value = ProtocolEngineState.Pairing
                    return resumed.uri.guestWebSocketUri()
                }
            }
            pairingStore.clearPending()
            if (pairingStore.load() == null) pairingStore.clearCredential()
        }
        val stored = pairingStore.load() ?: return null
        credential = stored
        pending = null
        hello = null
        connection = null
        _state.value = ProtocolEngineState.Authenticating
        return URI(stored.relayOrigin).resolve("/r/${stored.roomId}?role=guest")
    }

    @Synchronized
    fun onTransportConnected() {
        discardVolatileAccumulators()
        phaseTimeout?.cancel(); phaseTimeout = null
        when {
            pending != null -> {
                hello?.destroy(); hello = null
                connection?.destroy(); connection = null
                if (credential != null) {
                    // ACK delivery is unknowable after process death. Try the durable credential
                    // first; if the host is still pending, fall back to the byte-identical pair.
                    sendHello()
                    pendingFallback?.cancel()
                    pendingFallback = scope.launch {
                        delay(PENDING_HELLO_FALLBACK_MILLIS)
                        synchronized(this@RemoteProtocolEngine) {
                            if (pending != null && connection == null && _state.value !is ProtocolEngineState.Active) {
                                hello?.destroy(); hello = null
                                sendPair()
                            }
                        }
                    }
                } else sendPair()
            }
            credential != null -> sendHello()
            else -> _state.value = ProtocolEngineState.Failed("No enrolled device or pending pairing", false)
        }
    }

    @Synchronized
    fun flushOutbox() {
        if (_state.value !is ProtocolEngineState.Active) return
        for (item in outbox.items()) {
            val encoded = StrictProtocolJson.encodeToString(item.command).toByteArray(Charsets.UTF_8)
            RemoteCommandValidator.validate(item.command, encoded.size)
            if (!sendTraffic(encoded)) return
        }
    }

    /** Strict shared-renderer command adapter. Local-only commands never reach the host. */
    @Synchronized
    fun handleUiMessage(raw: String) {
        require(raw.toByteArray(Charsets.UTF_8).size in 1..MAX_JSON_FRAME_BYTES)
        val body = StrictProtocolJson.parseToJsonElement(raw).jsonObject
        val type = (body["t"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("UI command type is missing")
        if (type in setOf("copy", "openExternal", "pickFiles", "uiError")) return
        val stored = credential ?: error("Remote credential is unavailable")
        val selected = selectedSessionId ?: capability(stored).sessionIds.firstOrNull()
        if (type == "ready") emitRemoteCapabilities(stored)
        if (type == "cancelAttachment") {
            val attachmentId = string(body, "attachmentId", 36)
            UUID.fromString(attachmentId)
            scope.launch {
                runCatching {
                    sendCommandAndAwait("attachment.cancel", buildJsonObject { put("attachmentId", attachmentId) })
                }.onFailure { error ->
                    emitHostMessage(buildJsonObject {
                        put("t", "frame")
                        put("frame", buildJsonObject { put("type", "notice"); put("level", "error"); put("message", error.message ?: "Attachment cancellation failed") })
                    }.toString())
                }
            }
            return
        }
        if (type == "attachData") {
            requireFilesCapability()
            val token = string(body, "token", 128)
            val name = string(body, "name", 255)
            val mime = string(body, "mime", 127, allowEmpty = true).takeIf { it.isNotEmpty() }
            val encoded = string(body, "data", MAX_JSON_FRAME_BYTES)
            val bytes = runCatching { Base64.getDecoder().decode(encoded) }
                .getOrElse { throw IllegalArgumentException("Attachment data is not base64") }
            require(Base64.getEncoder().encodeToString(bytes) == encoded) { "Attachment data base64 is not canonical" }
            scope.launch {
                runCatching { uploadAttachmentBytes(token, name, mime, bytes) }.onFailure { error ->
                    bytes.fill(0)
                    emitHostMessage(buildJsonObject {
                        put("t", "attached"); put("token", token); put("files", JsonArray(emptyList()))
                        put("rejected", JsonArray(listOf(JsonPrimitive(error.message ?: "Attachment upload failed"))))
                    }.toString())
                }
            }
            return
        }
        if (type == "attachPaths") error("Desktop filesystem paths cannot be imported from Android; use the secure file picker")
        if (type == "setKeys" || type == "clearKey") {
            val requests = if (type == "setKeys") {
                val keys = body["keys"] as? JsonObject ?: error("keys must be an object")
                require(keys.size in 1..16)
                keys.map { (provider, element) ->
                    require(provider.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")))
                    val secret = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
                        ?: error("credential value must be a string")
                    require(secret.length in 1..16 * 1024)
                    "credentials.set" to buildJsonObject { put("provider", provider); put("value", secret) }
                }
            } else {
                val provider = string(body, "which", 128)
                listOf("credentials.clear" to buildJsonObject { put("provider", provider) })
            }
            scope.launch { handleCredentialCommands(requests) }
            return
        }
        if (type == "openDiff" || type == "rejectEdit") {
            val changeId = string(body, "toolCallId", 128)
            require(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}").matches(changeId))
            scope.launch { handleDiffAction(changeId, revert = type == "rejectEdit") }
            return
        }
        var uiContext: PendingUiCommand? = null
        val mapping = when (type) {
            "ready", "getState", "getModels" -> "session.sync" to JsonObject(emptyMap())
            "prompt" -> {
                uiContext = PendingUiCommand.Prompt
                val text = string(body, "text", 256 * 1024, allowEmpty = true)
                val attachmentIds = (body["attachments"] as? JsonArray).orEmpty().mapNotNull { item ->
                    val row = item as? JsonObject ?: return@mapNotNull null
                    val explicit = (row["attachmentId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    explicit ?: (row["path"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                        ?.takeIf { it.startsWith("remote:") }?.removePrefix("remote:")
                }.onEach { UUID.fromString(it) }
                val forModel = body["forModel"]?.let { routeElement ->
                    val route = routeElement as? JsonObject ?: error("forModel must be an object")
                    require(route.keys == setOf("provider", "modelId"))
                    buildJsonObject {
                        put("provider", string(route, "provider", 128))
                        put("modelId", string(route, "modelId", 256))
                    }
                }
                "prompt.send" to buildJsonObject {
                    put("text", text)
                    put("attachmentIds", JsonArray(attachmentIds.map(::JsonPrimitive)))
                    forModel?.let { put("forModel", it) }
                }
            }
            "abort" -> "turn.abort" to JsonObject(emptyMap())
            "compact" -> "session.compact" to JsonObject(emptyMap())
            "restart" -> "session.restart" to JsonObject(emptyMap())
            "newSession" -> "session.reset" to JsonObject(emptyMap())
            "openNewTab" -> "session.create" to JsonObject(emptyMap())
            "exportTranscript" -> {
                uiContext = PendingUiCommand.ExportTranscript
                "transcript.export" to buildJsonObject { put("format", "markdown") }
            }
            "getHistory" -> {
                uiContext = PendingUiCommand.History
                "history.list" to buildJsonObject { put("limit", 100) }
            }
            "openSession" -> "history.open" to buildJsonObject { put("sessionPath", string(body, "path", 4096)) }
            "recheckModels" -> {
                uiContext = PendingUiCommand.ModelsProbe
                "models.probe" to JsonObject(emptyMap())
            }
            "diagnostics" -> {
                uiContext = PendingUiCommand.Diagnostics
                "diagnostics.get" to JsonObject(emptyMap())
            }
            "login" -> "auth.login" to buildJsonObject { put("providerId", string(body, "providerId", 32)) }
            "setProfileField" -> {
                val profileValue = body["value"] ?: error("profile value is required")
                require(profileValue is JsonNull || (profileValue is JsonPrimitive && profileValue.isString))
                "profile.update" to buildJsonObject {
                    put("family", string(body, "family", 128)); put("field", string(body, "field", 32)); put("value", profileValue)
                }
            }
            "setModel" -> "model.set" to buildJsonObject {
                put("provider", string(body, "provider", 128)); put("modelId", string(body, "modelId", 256))
            }
            "setThinking" -> "thinking.set" to buildJsonObject { put("level", string(body, "level", 16)) }
            "setApproval" -> "approval-mode.set" to buildJsonObject { put("mode", string(body, "mode", 16)) }
            "findFiles" -> {
                uiContext = PendingUiCommand.Files(string(body, "token", 128))
                "files.search" to buildJsonObject {
                    put("query", string(body, "query", 1024)); put("maxResults", 50)
                }
            }
            "insertAtCursor" -> "editor.insert" to buildJsonObject { put("text", string(body, "text", 1024 * 1024, allowEmpty = true)) }
            "uiResponse" -> {
                val requestId = approvalResponseRequestId(body)
                uiContext = PendingUiCommand.Approval(requestId)
                "approval.respond" to approvalPayload(body)
            }
            else -> error("Shared renderer command is not remotely supported: $type")
        }
        val global = mapping.first in setOf("session.create", "history.list", "diagnostics.get")
        require(global || selected != null) { "No selected desktop session" }
        requireCommandCapability(stored, mapping.first, if (global) null else selected)
        val command = androidHostPort.createCommand(
            hostGeneration = stored.hostGeneration,
            sessionId = if (global) null else selected,
            command = mapping.first,
            payload = mapping.second,
        )
        uiContext?.let { pendingUiCommands[command.commandId] = it }
        val durableCorrelation = uiContext?.durableCorrelation()
        scope.launch {
            val result = androidHostPort.post(command, durableCorrelation?.first, durableCorrelation?.second)
            if (result is HostPostResult.Rejected) {
                synchronized(this@RemoteProtocolEngine) { pendingUiCommands.remove(command.commandId) }
                _hostMessages.emit(buildJsonObject {
                    put("t", "frame")
                    put("frame", buildJsonObject { put("type", "notice"); put("level", "error"); put("message", result.reason) })
                }.toString())
            }
        }
    }

    suspend fun uploadAttachment(uri: Uri): String {
        require(_state.value is ProtocolEngineState.Active) { "Remote session is not active" }
        // Refuse before query/openInputStream: without a signed files grant the app
        // must not inspect a URI the user selected.
        requireFilesCapability()
        val metadata = queryAttachment(uri)
        val digest = MessageDigest.getInstance("SHA-256")
        var actualSize = 0L
        contentResolver.openInputStream(uri)?.use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                actualSize += count
                require(actualSize <= MAX_ATTACHMENT_BYTES) { "Attachment exceeds 20 MiB" }
                digest.update(buffer, 0, count)
            }
            buffer.fill(0)
        } ?: error("Unable to open selected attachment")
        metadata.size?.let { require(it == actualSize) { "Attachment changed while being read" } }
        val attachmentId = UUID.randomUUID()
        val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
        val startPayload = buildJsonObject {
            put("attachmentId", attachmentId.toString())
            put("fileName", metadata.safeName)
            metadata.mediaType?.let { put("mediaType", it) }
            put("totalBytes", actualSize)
            put("sha256", sha256)
        }
        sendCommandAndAwait("attachment.start", startPayload)
        try {
            var offset = 0uL
            contentResolver.openInputStream(uri)?.use { input ->
                val buffer = ByteArray(MAX_ATTACHMENT_SEND_CHUNK_BYTES)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (count == 0) continue
                    val waiter = CompletableDeferred<String>()
                    synchronized(this) { chunkWaiters[attachmentId.toString()] = waiter }
                    val chunk = AttachmentChunkCodec.encode(AttachmentChunk(attachmentId, offset, buffer.copyOf(count)))
                    synchronized(this) {
                        check(sendTraffic(chunk)) { "Relay disconnected during attachment upload" }
                    }
                    val decision = withTimeout(30_000) { waiter.await() }
                    require(decision == "chunk-accepted") { "Attachment chunk rejected: $decision" }
                    offset += count.toULong()
                }
                buffer.fill(0)
            } ?: error("Unable to reopen selected attachment")
            require(offset == actualSize.toULong()) { "Attachment size changed during upload" }
            sendCommandAndAwait("attachment.commit", buildJsonObject { put("attachmentId", attachmentId.toString()) })
            _hostMessages.emit(buildJsonObject {
                put("t", "attached")
                put("files", JsonArray(listOf(buildJsonObject {
                    put("path", "remote:$attachmentId")
                    put("attachmentId", attachmentId.toString())
                    put("name", metadata.safeName)
                    put("size", actualSize)
                })))
                put("rejected", JsonArray(emptyList()))
            }.toString())
            return attachmentId.toString()
        } catch (error: Throwable) {
            runCatching { sendCommandAndAwait("attachment.cancel", buildJsonObject { put("attachmentId", attachmentId.toString()) }) }
            throw error
        } finally {
            synchronized(this) { chunkWaiters.remove(attachmentId.toString())?.cancel() }
        }
    }

    private suspend fun uploadAttachmentBytes(token: String, rawName: String, rawMediaType: String?, bytes: ByteArray): String {
        require(_state.value is ProtocolEngineState.Active)
        require(bytes.size.toLong() <= MAX_ATTACHMENT_BYTES)
        val safeName = safeFileName(rawName)
        val mediaType = rawMediaType?.takeIf {
            it.matches(Regex("[A-Za-z0-9!#\u0024&^_.+\\-]+/[A-Za-z0-9!#\u0024&^_.+\\-]+"))
        }
        val attachmentId = UUID.randomUUID()
        val sha256 = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        sendCommandAndAwait("attachment.start", buildJsonObject {
            put("attachmentId", attachmentId.toString()); put("fileName", safeName)
            mediaType?.let { put("mediaType", it) }
            put("totalBytes", bytes.size); put("sha256", sha256)
        })
        try {
            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(bytes.size, offset + MAX_ATTACHMENT_SEND_CHUNK_BYTES)
                val waiter = CompletableDeferred<String>()
                synchronized(this) { chunkWaiters[attachmentId.toString()] = waiter }
                val chunk = AttachmentChunkCodec.encode(
                    AttachmentChunk(attachmentId, offset.toULong(), bytes.copyOfRange(offset, end)),
                )
                synchronized(this) { check(sendTraffic(chunk)) { "Relay disconnected during attachment upload" } }
                val decision = withTimeout(30_000) { waiter.await() }
                require(decision == "chunk-accepted") { "Attachment chunk rejected: $decision" }
                offset = end
            }
            sendCommandAndAwait("attachment.commit", buildJsonObject { put("attachmentId", attachmentId.toString()) })
            emitHostMessage(buildJsonObject {
                put("t", "attached"); put("token", token)
                put("files", JsonArray(listOf(buildJsonObject {
                    put("path", "remote:$attachmentId"); put("attachmentId", attachmentId.toString())
                    put("name", safeName); put("size", bytes.size)
                })))
                put("rejected", JsonArray(emptyList()))
            }.toString())
            return attachmentId.toString()
        } catch (error: Throwable) {
            runCatching { sendCommandAndAwait("attachment.cancel", buildJsonObject { put("attachmentId", attachmentId.toString()) }) }
            throw error
        } finally {
            bytes.fill(0)
            synchronized(this) { chunkWaiters.remove(attachmentId.toString())?.cancel() }
        }
    }

    @Synchronized
    fun disconnect() {
        discardVolatileAccumulators()
        _board.value = RemoteSessionBoard()
        _capabilities.value = RemoteCapabilityUi()
        pending?.destroy()
        pending = null
        pendingFallback?.cancel(); pendingFallback = null
        phaseTimeout?.cancel(); phaseTimeout = null
        hello?.destroy()
        hello = null
        connection?.destroy()
        connection = null
        _state.value = ProtocolEngineState.Idle
    }

    @Synchronized
    fun revoke() {
        disconnect()
        credential = null
        pairingStore.revokeAndDestroyKey()
        counterStore.rotateEpoch()
        outbox.clearForRevocation()
        commandResultStore.clear()
    }

    suspend fun revokeRemote() {
        // Only destroy the local credential after the host durably ACKs revocation.
        // A network/error path remains enrolled so the user can retry honestly.
        sendCommandAndAwait("remote.stop", JsonObject(emptyMap()), sessionScoped = false)
        revoke()
    }

    @Synchronized
    private fun onRelayEvent(event: RelayEvent) {
        runCatching {
            when (event) {
                is RelayEvent.Text -> handleRelayControl(event.value)
                is RelayEvent.Binary -> handleEncrypted(event.value)
            }
        }.onFailure { error ->
            _state.value = ProtocolEngineState.Failed(error.message ?: "Remote protocol failure", true)
        }
    }

    private fun handleRelayControl(text: String) {
        require(text.toByteArray(Charsets.UTF_8).size <= 32 * 1024)
        val value = StrictProtocolJson.parseToJsonElement(text).jsonObject
        val type = (value["t"] as? JsonPrimitive)?.content ?: error("Relay control type is missing")
        require(type in setOf("peer-joined", "peer-left", "room-closed")) { "Unknown relay control" }
        if (type != "room-closed") {
            val peer = (value["peer"] as? JsonPrimitive)?.content?.toLongOrNull() ?: error("Relay peer is invalid")
            require(peer in 1..UInt.MAX_VALUE.toLong())
        } else {
            _state.value = ProtocolEngineState.Failed("Remote room was closed", false)
        }
    }

    private fun handleEncrypted(frame: ByteArray) {
        when {
            connection != null && (_state.value is ProtocolEngineState.Active || _state.value is ProtocolEngineState.Recovering) -> handleTraffic(frame)
            pending != null && (hello != null || connection != null) && tryHandleDuplicateEnrolled(frame) -> Unit
            hello != null && connection == null -> handleChallenge(frame)
            connection != null -> {
                val current = connection ?: return
                if (current.challengeEnvelope.contentEquals(frame)) {
                    check(relay.sendBinary(current.sealedProof)) { "Unable to resend handshake proof" }
                    schedulePhaseTimeout(HANDSHAKE_TIMEOUT_MILLIS) { reconnectCurrent() }
                } else {
                    runCatching { handleWelcome(frame) }.onFailure { reconnectCurrent() }
                }
            }
            pending != null -> handleEnrolled(frame)
            else -> error("Encrypted frame arrived outside a handshake")
        }
    }

    private fun tryHandleDuplicateEnrolled(frame: ByteArray): Boolean =
        runCatching { handleEnrolled(frame); true }.getOrDefault(false)

    private fun sendPair() {
        val value = pending ?: return
        if (value.sealedPair == null) {
            val key = HkdfSha256.protocolKey(value.uri.pairingKey, value.uri.roomId, value.uri.keyEpoch, KeyPurpose.PAIR, TrafficDirection.DEVICE_TO_HOST)
            value.sealedPair = try {
                seal(
                    key,
                    value.uri.roomId,
                    value.uri.keyEpoch,
                    TrafficDirection.DEVICE_TO_HOST,
                    0,
                    HandshakeCounters.pairCounter(value.nonce),
                    RemoteHandshakeCodec.encode(value.frame),
                )
            } finally { key.fill(0) }
        }
        check(relay.sendBinary(value.sealedPair!!)) { "Unable to send pair frame" }
        schedulePhaseTimeout(PAIR_RESPONSE_TIMEOUT_MILLIS) {
            if (pending != null && hello == null && connection == null) sendPair()
        }
    }

    private fun handleEnrolled(frame: ByteArray) {
        val value = pending ?: error("Pairing state is missing")
        val (outerPeer, sealed) = RelayEnvelope.decode(frame)
        require(outerPeer > 0)
        val counter = CryptoCodec.readCounter(sealed, TrafficDirection.HOST_TO_DEVICE)
        require(counter == HandshakeCounters.enrolCounter(outerPeer)) { "Enrolled counter must bind its assigned relay peer" }
        val pairKey = HkdfSha256.protocolKey(value.uri.pairingKey, value.uri.roomId, value.uri.keyEpoch, KeyPurpose.PAIR, TrafficDirection.HOST_TO_DEVICE)
        val plaintext = try {
            CryptoCodec.decrypt(pairKey, AuthenticatedHeader(value.uri.roomId, value.uri.keyEpoch, TrafficDirection.HOST_TO_DEVICE, outerPeer, counter), sealed)
        } finally { pairKey.fill(0) }
        val enrolled = RemoteHandshakeCodec.parse(plaintext) as? EnrolledFrame ?: error("Expected enrolled frame")
        plaintext.fill(0)
        phaseTimeout?.cancel(); phaseTimeout = null
        require(enrolled.deviceId == value.frame.deviceId && enrolled.assignedPeerId == outerPeer && enrolled.keyEpoch == value.uri.keyEpoch)
        require(enrolled.capability.deviceId == enrolled.deviceId && enrolled.capability.keyEpoch == enrolled.keyEpoch)
        val roomKey = ProtocolSecurity.decodeCanonical(enrolled.roomMasterKey, 32) ?: error("Room key is invalid")
        val token = ProtocolSecurity.decodeCanonical(enrolled.deviceToken, 32) ?: error("Device token is invalid")
        val signatureKey = HkdfSha256.protocolKey(token, value.uri.roomId, enrolled.keyEpoch, KeyPurpose.AUTH, TrafficDirection.HOST_TO_DEVICE)
        try {
            require(ProtocolSecurity.verifyCapabilitySignature(signatureKey, enrolled.capability, enrolled.capabilitySignature)) {
                "Capability signature is invalid"
            }
        } finally { signatureKey.fill(0) }
        validateCapabilityWindow(enrolled.capability)

        val prior = pairingStore.load()
        val stored = DeviceCredential(
            deviceId = enrolled.deviceId,
            enrolmentId = enrolled.enrolmentId,
            relayOrigin = value.uri.relayOrigin.toASCIIString(),
            roomId = value.uri.roomId,
            roomMasterKeyBase64Url = enrolled.roomMasterKey,
            deviceTokenBase64Url = enrolled.deviceToken,
            keyEpoch = enrolled.keyEpoch,
            assignedPeerId = enrolled.assignedPeerId.toString(),
            hostGeneration = enrolled.hostGeneration,
            capabilityManifest = StrictProtocolJson.encodeToString(CapabilityManifest.serializer(), enrolled.capability),
            capabilitySignature = enrolled.capabilitySignature,
            lastSequence = prior?.takeIf { it.enrolmentId == enrolled.enrolmentId }?.lastSequence ?: "0",
        ).validate()
        if (prior == null || prior.enrolmentId != enrolled.enrolmentId || prior.keyEpoch != enrolled.keyEpoch) {
            counterStore.rotateEpoch()
            outbox.clearForRevocation()
        }
        pairingStore.saveAfterEnrolled(stored) // Atomic Keystore persistence before enrolled-ack.

        val digest = ProtocolSecurity.credentialDigest(value.uri.roomId, enrolled.keyEpoch, enrolled.deviceId, roomKey, token)
        val ack = RemoteHandshakeCodec.enrolledAck(enrolled.enrolmentId, enrolled.deviceId, digest)
        val ackKey = HkdfSha256.protocolKey(value.uri.pairingKey, value.uri.roomId, value.uri.keyEpoch, KeyPurpose.PAIR, TrafficDirection.DEVICE_TO_HOST)
        val sealedAck = try {
            seal(
                ackKey,
                value.uri.roomId,
                value.uri.keyEpoch,
                TrafficDirection.DEVICE_TO_HOST,
                enrolled.assignedPeerId,
                HandshakeCounters.enrolCounter(enrolled.assignedPeerId),
                RemoteHandshakeCodec.encode(ack),
            )
        } finally { ackKey.fill(0) }
        check(relay.sendBinary(sealedAck)) { "Unable to send enrolled acknowledgement" }

        roomKey.fill(0); token.fill(0)
        // Keep the Keystore-sealed pending pairing transaction until authenticated welcome.
        // A reconnect resends the byte-identical pair and receives the idempotent enrolled frame.
        credential = stored
        _state.value = ProtocolEngineState.Authenticating
        sendHello()
    }

    private fun sendHello() {
        val stored = credential ?: return
        hello?.destroy()
        connection?.destroy()
        connection = null
        val nonce = ByteArray(16).also(random::nextBytes)
        val frame = RemoteHandshakeCodec.hello(
            stored.deviceId,
            stored.deviceTokenBase64Url,
            ProtocolSecurity.encodeBase64Url(nonce),
            stored.hostGeneration.takeIf { it.isNotBlank() },
            stored.lastSequence,
        )
        val token = stored.deviceToken()
        val key = HkdfSha256.protocolKey(token, stored.roomId, stored.keyEpoch, KeyPurpose.AUTH, TrafficDirection.DEVICE_TO_HOST)
        token.fill(0)
        val counter = counterStore.reserveOutbound("auth_d2h_epoch_${stored.keyEpoch}")
        val sealed = try {
            seal(key, stored.roomId, stored.keyEpoch, TrafficDirection.DEVICE_TO_HOST, 0, counter, RemoteHandshakeCodec.encode(frame))
        } finally { key.fill(0) }
        hello = HelloContext(frame, nonce)
        _state.value = ProtocolEngineState.Authenticating
        check(relay.sendBinary(sealed)) { "Unable to send authenticated hello" }
        schedulePhaseTimeout(HANDSHAKE_TIMEOUT_MILLIS) { reconnectCurrent() }
    }

    private fun handleChallenge(frame: ByteArray) {
        phaseTimeout?.cancel(); phaseTimeout = null
        val stored = credential ?: error("Credential is missing")
        val sentHello = hello ?: error("Hello state is missing")
        val (outerPeer, sealed) = RelayEnvelope.decode(frame)
        require(outerPeer > 0)
        val counter = CryptoCodec.readCounter(sealed, TrafficDirection.HOST_TO_DEVICE)
        val counterName = "auth_h2d_epoch_${stored.keyEpoch}"
        require(counterStore.highestInbound(counterName)?.let { counter > it } != false) { "Replayed auth frame" }
        val token = stored.deviceToken()
        val authKey = HkdfSha256.protocolKey(token, stored.roomId, stored.keyEpoch, KeyPurpose.AUTH, TrafficDirection.HOST_TO_DEVICE)
        token.fill(0)
        val plaintext = try {
            CryptoCodec.decrypt(authKey, AuthenticatedHeader(stored.roomId, stored.keyEpoch, TrafficDirection.HOST_TO_DEVICE, outerPeer, counter), sealed)
        } finally { authKey.fill(0) }
        counterStore.commitInbound(counterName, counter)
        val challenge = RemoteHandshakeCodec.parse(plaintext) as? ChallengeFrame ?: error("Expected challenge frame")
        plaintext.fill(0)
        require(challenge.deviceId == stored.deviceId && challenge.assignedPeerId == outerPeer && challenge.keyEpoch == stored.keyEpoch)
        require(challenge.deviceNonce == sentHello.frame.deviceNonce) { "Challenge does not bind the device nonce" }
        val rebound = stored.copy(assignedPeerId = outerPeer.toString(), hostGeneration = challenge.hostGeneration).validate()
        credential = rebound
        pairingStore.saveAfterEnrolled(rebound)

        val hostNonce = ProtocolSecurity.decodeCanonical(challenge.hostNonce, 16) ?: error("Host nonce is invalid")
        val roomKey = stored.roomMasterKey()
        val d2h = HkdfSha256.connectionTrafficKey(roomKey, stored.roomId, stored.keyEpoch, hostNonce, sentHello.nonce, TrafficDirection.DEVICE_TO_HOST)
        val h2d = HkdfSha256.connectionTrafficKey(roomKey, stored.roomId, stored.keyEpoch, hostNonce, sentHello.nonce, TrafficDirection.HOST_TO_DEVICE)
        roomKey.fill(0); hostNonce.fill(0)
        val transcript = JsonArray(listOf(sentHello.frame.raw, challenge.raw))
        val deviceToken = stored.deviceToken()
        val proofAuth = HkdfSha256.protocolKey(deviceToken, stored.roomId, stored.keyEpoch, KeyPurpose.AUTH, TrafficDirection.DEVICE_TO_HOST)
        deviceToken.fill(0)
        val proofBytes = try { ProtocolSecurity.handshakeProof(proofAuth, transcript) } finally { proofAuth.fill(0) }
        val proof = RemoteHandshakeCodec.proof(challenge.connectionId, ProtocolSecurity.encodeBase64Url(proofBytes))
        proofBytes.fill(0)
        val sealedProof = seal(d2h, stored.roomId, stored.keyEpoch, TrafficDirection.DEVICE_TO_HOST, outerPeer, 0u, RemoteHandshakeCodec.encode(proof))
        connection = ConnectionContext(
            challenge.connectionId,
            outerPeer,
            d2h,
            h2d,
            challengeEnvelope = frame.copyOf(),
            sealedProof = sealedProof.copyOf(),
        )
        check(relay.sendBinary(sealedProof)) { "Unable to send handshake proof" }
        schedulePhaseTimeout(HANDSHAKE_TIMEOUT_MILLIS) { reconnectCurrent() }
    }

    private fun handleWelcome(frame: ByteArray) {
        phaseTimeout?.cancel(); phaseTimeout = null
        val stored = credential ?: error("Credential is missing")
        val current = connection ?: error("Connection keys are missing")
        val (outerPeer, sealed) = RelayEnvelope.decode(frame)
        require(outerPeer == current.assignedPeerId)
        val counter = CryptoCodec.readCounter(sealed, TrafficDirection.HOST_TO_DEVICE)
        require(counter == 0uL)
        val plaintext = CryptoCodec.decrypt(
            current.h2d,
            AuthenticatedHeader(stored.roomId, stored.keyEpoch, TrafficDirection.HOST_TO_DEVICE, outerPeer, counter),
            sealed,
        )
        val welcome = RemoteHandshakeCodec.parse(plaintext) as? WelcomeFrame ?: error("Expected welcome frame")
        plaintext.fill(0)
        require(welcome.connectionId == current.connectionId)
        val token = stored.deviceToken()
        val signatureKey = HkdfSha256.protocolKey(token, stored.roomId, stored.keyEpoch, KeyPurpose.AUTH, TrafficDirection.HOST_TO_DEVICE)
        token.fill(0)
        try { require(ProtocolSecurity.verifyCapabilitySignature(signatureKey, welcome.capability, welcome.capabilitySignature)) } finally { signatureKey.fill(0) }
        require(welcome.capability.deviceId == stored.deviceId && welcome.capability.keyEpoch == stored.keyEpoch) {
            "Welcome capability does not bind this enrolled device"
        }
        validateCapabilityWindow(welcome.capability)
        current.inboundHighest = 0u
        current.outboundNext = 1u
        val updated = stored.copy(
            hostGeneration = welcome.hostGeneration,
            lastSequence = welcome.sequence,
            capabilityManifest = StrictProtocolJson.encodeToString(CapabilityManifest.serializer(), welcome.capability),
            capabilitySignature = welcome.capabilitySignature,
        ).validate()
        credential = updated
        pairingStore.saveAfterEnrolled(updated)
        hello?.destroy(); hello = null
        _state.value = ProtocolEngineState.Active(welcome.hostGeneration, welcome.sequence)
        pendingFallback?.cancel(); pendingFallback = null
        pending?.destroy(); pending = null
        pairingStore.clearPending()
        emitRemoteCapabilities(updated)
        flushOutbox()
    }

    private fun handleTraffic(frame: ByteArray) {
        val stored = credential ?: error("Credential is missing")
        val current = connection ?: error("Connection state is missing")
        val (outerPeer, sealed) = RelayEnvelope.decode(frame)
        require(outerPeer == current.assignedPeerId)
        val counter = CryptoCodec.readCounter(sealed, TrafficDirection.HOST_TO_DEVICE)
        require(counter > current.inboundHighest) { "Replayed traffic frame" }
        val plaintext = CryptoCodec.decrypt(
            current.h2d,
            AuthenticatedHeader(stored.roomId, stored.keyEpoch, TrafficDirection.HOST_TO_DEVICE, outerPeer, counter),
            sealed,
        )
        current.inboundHighest = counter // Commit only after successful GCM.
        val raw = plaintext.toString(Charsets.UTF_8)
        plaintext.fill(0)
        require(raw.toByteArray(Charsets.UTF_8).size <= MAX_JSON_FRAME_BYTES)
        val value = StrictProtocolJson.parseToJsonElement(raw).jsonObject
        when ((value["type"] as? JsonPrimitive)?.content) {
            "command-ack" -> handleCommandAck(value)
            "event" -> handleHostEvent(value, raw)
            "ping" -> {
                val nonce = (value["nonce"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("Ping nonce is missing")
                require(nonce.length in 1..128)
                sendTraffic(buildJsonObject { put("protocolVersion", 1); put("type", "pong"); put("nonce", nonce) }.toString().toByteArray())
            }
            "error" -> {
                val code = (value["code"] as? JsonPrimitive)?.content ?: "remote-error"
                _state.value = ProtocolEngineState.Failed(code.take(64), false)
            }
            else -> error("Unknown authenticated data frame")
        }
    }

    private fun handleCommandAck(value: JsonObject) {
        val stored = credential ?: return
        require((value["protocolVersion"] as? JsonPrimitive)?.content == "1")
        require((value["hostGeneration"] as? JsonPrimitive)?.content == stored.hostGeneration)
        val commandId = (value["commandId"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("ACK command id is missing")
        val status = (value["status"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("ACK status is missing")
        if (status == "accepted") {
            outbox.markAccepted(commandId)
            return
        }
        require(status in setOf("completed", "rejected", "indeterminate")) { "Unknown command ACK status" }

        // Capture sealed metadata before removal so a terminal ACK after process death
        // still routes history/files/export/etc. to the correct renderer contract.
        val item = outbox.items().firstOrNull { it.command.commandId.equals(commandId, true) }
        val message = (value["message"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val errorCode = (value["errorCode"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val wireResult = value["result"]
        val declaresStream = (wireResult as? JsonObject)?.containsKey("streamed") == true
        val marker = if (status == "completed" && declaresStream) {
            runCatching { streamedResultMarker(wireResult) }.getOrNull()
        } else null
        val streamed = marker?.let { expected ->
            commandResultStore.load(commandId)?.let { restoreCompletedCommandResult(it, expected) }
        }
        // Never expose a marker as an application result. Missing/corrupt sealed bytes
        // are a bounded retry warning, not a traffic-parser failure or replay loop.
        val resolvedResult = if (declaresStream) streamed?.value else wireResult
        val waiter = commandWaiters.remove(commandId)
        waiter?.complete(AckOutcome(status, resolvedResult, message, streamed))
        val correlatedContext = pendingUiCommands[commandId] ?: item?.pendingUiCommand()
        // A live diff waiter performs validation and rendering itself. The sealed
        // outbox correlation is for process-death recovery and must not double-render.
        val context = correlatedContext.takeUnless { waiter != null && it is PendingUiCommand.Diff }
        try {
            if (context != null) {
                if (status == "completed" && streamed != null) {
                    emitStreamedUiResult(context, streamed)
                } else {
                    emitUiCommandResult(context, status, resolvedResult, message)
                }
                if (context is PendingUiCommand.Approval && !shouldRetainApprovalAfter(status, errorCode)) {
                    approvals.remove(context.requestId)
                }
            } else if (status != "completed") {
                val command = item?.command?.command ?: "remote command"
                emitHostMessage(buildJsonObject {
                    put("t", "frame")
                    put("frame", buildJsonObject {
                        put("type", "notice"); put("level", "error")
                        put("message", message ?: "$command was $status")
                    })
                }.toString())
            }
        } finally {
            // A terminal ACK cannot be made more complete by replay. In particular,
            // desktop intentionally strips sensitive result bodies after restart.
            pendingUiCommands.remove(commandId)
            outbox.removeTerminal(commandId)
            commandResultStore.remove(commandId)
        }
    }

    @Synchronized
    fun switchSession(targetSessionId: String) {
        val stored = credential ?: error("Remote credential is unavailable")
        require(_board.value.sessions.any { it.id == targetSessionId }) { "Session is not in the authenticated board" }
        if (!shouldSendSessionSwitch(selectedSessionId, targetSessionId)) return
        requireCommandCapability(stored, "session.switch", null)
        val command = androidHostPort.createCommand(
            hostGeneration = stored.hostGeneration,
            sessionId = null,
            command = "session.switch",
            payload = buildJsonObject { put("targetSessionId", targetSessionId) },
        )
        scope.launch {
            val result = androidHostPort.post(command)
            if (result is HostPostResult.Rejected) {
                emitHostMessage(buildJsonObject {
                    put("t", "frame")
                    put("frame", buildJsonObject { put("type", "notice"); put("level", "error"); put("message", result.reason) })
                }.toString())
            }
        }
    }

    @Synchronized
    fun createSession() = enqueueSessionManagement("session.create", null, JsonObject(emptyMap()))

    @Synchronized
    fun renameSession(sessionId: String, title: String) {
        require(title.length in 1..256 && title.none { it.code < 0x20 || it.code == 0x7f })
        enqueueSessionManagement("session.rename", sessionId, buildJsonObject { put("title", title) })
    }

    @Synchronized
    fun closeSession(sessionId: String) {
        require(_board.value.sessions.firstOrNull { it.id == sessionId }?.closable == true) { "Desktop session cannot be closed remotely" }
        enqueueSessionManagement("session.close", sessionId, JsonObject(emptyMap()))
    }

    private fun enqueueSessionManagement(commandName: String, sessionId: String?, payload: JsonObject) {
        val stored = credential ?: error("Remote credential is unavailable")
        sessionId?.let { require(_board.value.sessions.any { row -> row.id == it }) { "Session is not in the authenticated board" } }
        requireCommandCapability(stored, commandName, sessionId)
        val command = androidHostPort.createCommand(stored.hostGeneration, sessionId, commandName, payload)
        scope.launch {
            val result = androidHostPort.post(command)
            if (result is HostPostResult.Rejected) {
                emitHostMessage(buildJsonObject {
                    put("t", "frame")
                    put("frame", buildJsonObject { put("type", "notice"); put("level", "error"); put("message", result.reason) })
                }.toString())
            }
        }
    }

    private suspend fun handleDiffAction(changeId: String, revert: Boolean) {
        runCatching {
            val outcome = sendCommandAndAwait(
                "diff.get",
                buildJsonObject { put("changeId", changeId) },
                durableUi = if (revert) null else PendingUiCommand.Diff(changeId),
            )
            val diff = outcome.result as? JsonObject
                ?: error("Desktop returned an invalid diff")
            val returnedId = (diff["changeId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val afterSha = (diff["afterSha256"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            require(returnedId == changeId && afterSha?.matches(Regex("[0-9a-f]{64}")) == true)
            if (revert) {
                sendCommandAndAwait("revert.apply", buildJsonObject {
                    put("changeId", changeId); put("expectedAfterSha256", afterSha)
                })
                emitHostMessage(buildJsonObject { put("t", "editRejected"); put("toolCallId", changeId) }.toString())
            } else {
                val direct = buildJsonObject {
                    put("t", "diffContent")
                    put("toolCallId", changeId)
                    put("path", diff["path"] ?: JsonNull)
                    put("before", diff["before"] ?: JsonNull)
                    put("current", diff["current"] ?: JsonNull)
                    put("afterSha256", afterSha)
                }.toString()
                if (direct.toByteArray(Charsets.UTF_8).size <= MAX_JSON_FRAME_BYTES) {
                    emitHostMessage(direct)
                } else {
                    val complete = outcome.streamed ?: error("Oversized diff was not delivered as a bounded stream")
                    emitCommandResultFragments("diff", null, complete)
                }
            }
        }.onFailure { error ->
            emitHostMessage(buildJsonObject {
                put("t", "frame")
                put("frame", buildJsonObject { put("type", "notice"); put("level", "error"); put("message", error.message ?: "Diff action failed") })
            }.toString())
        }
    }

    private suspend fun handleCredentialCommands(requests: List<Pair<String, JsonObject>>) {
        runCatching {
            requests.forEach { (command, payload) -> sendCommandAndAwait(command, payload, sessionScoped = false) }
        }.onFailure { error ->
            emitHostMessage(buildJsonObject {
                put("t", "frame")
                put("frame", buildJsonObject { put("type", "notice"); put("level", "error"); put("message", error.message ?: "Credential update failed") })
            }.toString())
        }
    }

    private fun emitUiCommandResult(context: PendingUiCommand, status: String, result: JsonElement?, message: String?) {
        if (status != "completed") {
            if (context is PendingUiCommand.Prompt) {
                emitHostMessage(buildJsonObject { put("t", "promptFailed") }.toString())
            }
            emitHostMessage(buildJsonObject {
                put("t", "frame")
                put("frame", buildJsonObject {
                    put("type", "notice"); put("level", "error")
                    put("message", message ?: "Remote command $status")
                })
            }.toString())
            return
        }
        val uiKind = context.durableCorrelation().first
        if (!hasDurableUiResult(uiKind, result)) {
            emitHostMessage(buildJsonObject {
                put("t", "frame")
                put("frame", buildJsonObject {
                    put("type", "notice"); put("level", "warning")
                    put("message", "The command completed after reconnect, but its private result is no longer available. Please retry the action.")
                })
            }.toString())
            return
        }
        uiCommandResultMessage(context, result)?.let(::emitHostMessage)
    }

    private fun uiCommandResultMessage(context: PendingUiCommand, result: JsonElement?): String? {
        val body = result as? JsonObject ?: JsonObject(emptyMap())
        return when (context) {
            PendingUiCommand.Prompt, is PendingUiCommand.Approval -> null
            PendingUiCommand.History -> {
                val sessions = body["sessions"] as? JsonArray ?: error("History result is invalid")
                buildJsonObject { put("t", "history"); put("sessions", sessions) }.toString()
            }
            is PendingUiCommand.Files -> {
                val files = body["files"] as? JsonArray ?: error("File search result is invalid")
                buildJsonObject { put("t", "fileCandidates"); put("token", context.token); put("files", files) }.toString()
            }
            PendingUiCommand.ExportTranscript -> {
                val format = (body["format"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                val content = (body["content"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                require(format == "markdown" && content != null)
                buildJsonObject { put("t", "exportReady"); put("format", format); put("content", content) }.toString()
            }
            PendingUiCommand.Diagnostics -> {
                val markdown = (body["markdown"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    ?: error("Diagnostics result is invalid")
                buildJsonObject { put("t", "diagnosticsResult"); put("markdown", markdown) }.toString()
            }
            PendingUiCommand.ModelsProbe -> {
                val results = body["results"] as? JsonObject ?: error("Model probe result is invalid")
                buildJsonObject { put("t", "probe"); put("results", results); put("running", false); put("enabled", true) }.toString()
            }
            is PendingUiCommand.Diff -> {
                val returnedId = (body["changeId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                val afterSha = (body["afterSha256"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                require(returnedId == context.changeId && afterSha?.matches(Regex("[0-9a-f]{64}")) == true)
                buildJsonObject {
                    put("t", "diffContent"); put("toolCallId", context.changeId)
                    put("path", body["path"] ?: JsonNull); put("before", body["before"] ?: JsonNull)
                    put("current", body["current"] ?: JsonNull); put("afterSha256", afterSha)
                }.toString()
            }
        }
    }

    private fun emitStreamedUiResult(context: PendingUiCommand, complete: CompletedCommandResult) {
        val uiKind = context.durableCorrelation().first
        if (!hasDurableUiResult(uiKind, complete.value)) {
            emitUiCommandResult(context, "completed", null, null)
            return
        }
        if (context is PendingUiCommand.ExportTranscript) {
            val body = complete.value as JsonObject
            val content = (body["content"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: error("Export result is invalid")
            // The service writes the private FileProvider cache synchronously. Only
            // after that durable handoff may the sealed stream result be removed.
            runCatching { nativeResultSink(RemoteNativeResultEvent.ExportMarkdown(content)) }
                .onFailure { error ->
                    emitHostMessage(buildJsonObject {
                        put("t", "frame")
                        put("frame", buildJsonObject {
                            put("type", "notice"); put("level", "error")
                            put("message", error.message ?: "Unable to prepare the private transcript export")
                        })
                    }.toString())
                }
            return
        }
        val direct = uiCommandResultMessage(context, complete.value)
        if (direct == null || direct.toByteArray(Charsets.UTF_8).size <= MAX_JSON_FRAME_BYTES) {
            direct?.let(::emitHostMessage)
            return
        }
        require(uiKind in setOf("history", "files", "diagnostics", "models-probe", "diff"))
        val token = (context as? PendingUiCommand.Files)?.token
        emitCommandResultFragments(uiKind, token, complete)
    }

    private fun emitCommandResultFragments(uiKind: String, uiToken: String?, complete: CompletedCommandResult) {
        require(uiKind in setOf("history", "files", "diagnostics", "models-probe", "diff"))
        require((uiKind == "files") == (uiToken != null))
        emitHostMessage(buildJsonObject {
            put("t", "commandResultBegin")
            put("streamId", complete.streamId); put("commandId", complete.commandId); put("uiKind", uiKind)
            uiToken?.let { put("uiToken", it) }
            put("fragmentCount", complete.chunks.size); put("totalBytes", complete.totalBytes); put("sha256", complete.sha256)
        }.toString())
        complete.chunks.forEachIndexed { index, data ->
            emitHostMessage(buildJsonObject {
                put("t", "commandResultChunk")
                put("streamId", complete.streamId); put("commandId", complete.commandId)
                put("fragmentIndex", index); put("data", data)
            }.toString())
        }
        emitHostMessage(buildJsonObject {
            put("t", "commandResultCommit"); put("streamId", complete.streamId); put("commandId", complete.commandId)
        }.toString())
    }

    private fun handleHostEvent(value: JsonObject, raw: String) {
        val stored = credential ?: return
        require((value["protocolVersion"] as? JsonPrimitive)?.content == "1")
        require((value["type"] as? JsonPrimitive)?.content == "event")
        val generation = (value["hostGeneration"] as? JsonPrimitive)?.content ?: error("Event generation is missing")
        val sequenceText = (value["sequence"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("Event sequence is missing")
        val sequence = parseUint64Decimal(sequenceText)
        val event = (value["event"] as? JsonPrimitive)?.content ?: error("Event name is missing")
        require(event in setOf("full-sync", "session-message", "session-board", "remote-status", "capability-update", "command-result"))
        val durablePrevious = parseUint64Decimal(stored.lastSequence)
        if (generation != stored.hostGeneration) {
            recoverFromEventGap("host generation changed")
            return
        }
        if (sequence <= durablePrevious) {
            // Relay/host retries are cumulative. A duplicate is already durable,
            // so it is safe to ACK again without applying it twice.
            sendEventAck(generation, sequenceText)
            return
        }
        val volatilePrevious = commandResultVolatileSequence
        if (volatilePrevious != null && event != "command-result") {
            recoverFromEventGap("event interleaved with atomic command result")
            return
        }
        if (volatilePrevious != null && sequence <= volatilePrevious) {
            // ACK loss inside the same live process: the bounded partial bytes still
            // exist, but the durable hello sequence intentionally remains pre-begin.
            sendEventAck(generation, sequenceText)
            return
        }
        val expectedPrevious = volatilePrevious ?: durablePrevious
        if (sequence != expectedPrevious + java.math.BigInteger.ONE) {
            recoverFromEventGap("event sequence gap")
            return
        }

        val payload = value["payload"] as? JsonObject ?: error("Event payload must be an object")
        val syncActions = if (event == "full-sync") syncAccumulator.accept(payload) else emptyList()
        val streamedResult = if (event == "command-result") commandResultAccumulator.accept(payload) else null
        val boardUpdate = if (event == "session-board") RemoteSyncAccumulator.parseBoardPayload(payload) else null
        val sessionMessage = if (event == "session-message") payload else null
        val refreshedCredential = if (event == "capability-update") validateCapabilityUpdate(stored, payload) else stored

        // Apply to the native reducer/renderer queue first. Persisting a sequence
        // before this boundary would turn a queue failure into a permanently
        // skipped duplicate after reconnect.
        try {
            when (event) {
                "session-message" -> sessionMessage?.let { message ->
                    if ((message["t"] as? JsonPrimitive)?.content == "attachmentAck") {
                        val id = (message["attachmentId"] as? JsonPrimitive)?.content
                        val decision = (message["decision"] as? JsonObject)?.get("kind")?.let { (it as? JsonPrimitive)?.content }
                        if (id != null && decision != null) chunkWaiters.remove(id)?.complete(decision)
                    }
                    approvalResolutionRequestId(message)?.let { approvals.remove(it) }
                    recordApprovalRequests(message)
                    val eventSessionId = (value["sessionId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    if (eventSessionId != null && (message["t"] as? JsonPrimitive)?.content == "frame") {
                        val inner = message["frame"] as? JsonObject
                        when ((inner?.get("type") as? JsonPrimitive)?.content) {
                            "extension_ui_request" -> actionableApprovalRequestId(inner)?.let { requestId ->
                                if (approvals.containsKey(requestId)) {
                                    _notifications.tryEmit(
                                        RemoteNotificationEvent.Approval(
                                            eventSessionId,
                                            (inner["message"] as? JsonPrimitive)?.content ?: "Desktop session needs approval",
                                        ),
                                    )
                                }
                            }
                            "agent_end" -> _notifications.tryEmit(RemoteNotificationEvent.TurnCompleted(eventSessionId))
                        }
                    }
                    if (eventSessionId == null || eventSessionId == selectedSessionId) emitHostMessage(message.toString())
                }
                "full-sync" -> syncActions.forEach(::applySyncAction)
                "session-board" -> boardUpdate?.let(::applyBoard)
                "remote-status" -> emitHostMessage(buildJsonObject { put("t", "remoteStatus"); put("status", payload) }.toString())
                "capability-update" -> emitRemoteCapabilities(refreshedCredential)
                "command-result" -> streamedResult?.let { complete ->
                    // Seal the complete validated JSON before committing the event
                    // sequence. Process death can then recover the terminal marker.
                    commandResultStore.save(
                        StoredCommandResult(
                            complete.streamId,
                            complete.commandId,
                            complete.totalBytes,
                            complete.sha256,
                            complete.json,
                        ),
                    )
                }
            }
        } catch (error: Throwable) {
            discardVolatileAccumulators()
            throw error
        }

        if (event == "command-result" && streamedResult == null) {
            // Flow-control ACKs advance only volatile ordering. A reconnect advertises
            // the pre-begin durable sequence so the live host re-streams from begin.
            commandResultVolatileSequence = sequence
            sendEventAck(generation, sequenceText)
            return
        }
        commandResultVolatileSequence = null
        val updated = refreshedCredential.copy(hostGeneration = generation, lastSequence = sequenceText)
        pairingStore.saveAfterEnrolled(updated)
        credential = updated
        _state.value = ProtocolEngineState.Active(generation, sequenceText)
        sendEventAck(generation, sequenceText)
    }

    private fun validateCapabilityUpdate(stored: DeviceCredential, payload: JsonObject): DeviceCredential {
        require(payload.keys == setOf("capability", "capabilitySignature"))
        val manifest = RemoteHandshakeCodec.parseCapabilityManifest(
            payload["capability"] as? JsonObject ?: error("Capability update manifest is invalid"),
        )
        val signature = (payload["capabilitySignature"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: error("Capability update signature is missing")
        require(ProtocolSecurity.decodeCanonical(signature, 32) != null) { "Capability update signature is invalid" }
        require(manifest.deviceId == stored.deviceId && manifest.keyEpoch == stored.keyEpoch) {
            "Capability update does not bind this enrolled device"
        }
        validateCapabilityWindow(manifest)
        val token = stored.deviceToken()
        val signatureKey = HkdfSha256.protocolKey(
            token,
            stored.roomId,
            stored.keyEpoch,
            KeyPurpose.AUTH,
            TrafficDirection.HOST_TO_DEVICE,
        )
        token.fill(0)
        try {
            require(ProtocolSecurity.verifyCapabilitySignature(signatureKey, manifest, signature)) {
                "Capability update signature is invalid"
            }
        } finally {
            signatureKey.fill(0)
        }
        return stored.copy(
            capabilityManifest = StrictProtocolJson.encodeToString(CapabilityManifest.serializer(), manifest),
            capabilitySignature = signature,
        ).validate()
    }

    private fun recoverFromEventGap(reason: String) {
        discardVolatileAccumulators()
        _state.value = ProtocolEngineState.Recovering(reason)
        val reconnect = credential?.let { URI(it.relayOrigin).resolve("/r/${it.roomId}?role=guest") }
        if (reconnect != null) relay.connect(reconnect)
    }

    private fun discardVolatileAccumulators() {
        syncAccumulator.discard()
        commandResultAccumulator.discard()
        commandResultVolatileSequence = null
    }

    private fun sendEventAck(generation: String, sequence: String) {
        check(sendTraffic(buildJsonObject {
            put("protocolVersion", 1)
            put("type", "event-ack")
            put("hostGeneration", generation)
            put("sequence", sequence)
        }.toString().toByteArray(Charsets.UTF_8))) { "Unable to send cumulative event ACK" }
    }

    private fun applyBoard(value: RemoteSessionBoard) {
        selectedSessionId = value.selectedSessionId
        _board.value = value
    }

    private fun applySyncAction(action: RemoteSyncAction) {
        when (action) {
            is RemoteSyncAction.Begin -> applyBoard(action.board)
            is RemoteSyncAction.Notice -> emitHostMessage(buildJsonObject {
                put("t", "frame")
                put("frame", buildJsonObject {
                    put("type", "notice"); put("level", "warning")
                    put("message", "${action.omittedSessions} desktop sessions were omitted from the live phone board limit.")
                })
            }.toString())
            is RemoteSyncAction.Reset -> if (action.sessionId == selectedSessionId) {
                emitHostMessage(buildJsonObject {
                    put("t", "transcriptReset"); put("syncId", action.syncId); put("sessionId", action.sessionId)
                }.toString())
            }
            is RemoteSyncAction.Section -> if (action.sessionId == selectedSessionId) {
                if (action.section == "approvals") replaceApprovalRequests(action.value)
                emitHostMessage(buildJsonObject {
                    put("t", "syncSection"); put("syncId", action.syncId); put("sessionId", action.sessionId)
                    put("section", action.section); put("value", action.value)
                }.toString())
            }
            is RemoteSyncAction.Transcript -> if (action.sessionId == selectedSessionId) {
                emitHostMessage(buildJsonObject {
                    put("t", "transcriptAppend"); put("syncId", action.syncId); put("sessionId", action.sessionId)
                    put("messages", action.messages)
                }.toString())
            }
            is RemoteSyncAction.TranscriptFragments -> if (action.sessionId == selectedSessionId) {
                emitFragmentedSync(action.syncId, action.sessionId, null, action.messageIndex, action.fragments, action.totalBytes, action.sha256)
            }
            is RemoteSyncAction.SectionFragments -> if (action.sessionId == selectedSessionId) {
                if (action.section == "approvals") replaceApprovalRequests(action.validatedValue)
                emitFragmentedSync(action.syncId, action.sessionId, action.section, null, action.fragments, action.totalBytes, action.sha256)
            }
            is RemoteSyncAction.SessionComplete, is RemoteSyncAction.Complete -> Unit
        }
    }

    private fun emitFragmentedSync(
        syncId: String,
        sessionId: String,
        section: String?,
        messageIndex: Int?,
        fragments: List<String>,
        totalBytes: Int,
        sha256: String,
    ) {
        val prefix = if (section == null) "transcriptMessage" else "syncSection"
        emitHostMessage(buildJsonObject {
            put("t", "${prefix}Begin")
            put("syncId", syncId); put("sessionId", sessionId)
            section?.let { put("section", it) }; messageIndex?.let { put("messageIndex", it) }
            put("fragmentCount", fragments.size); put("totalBytes", totalBytes); put("sha256", sha256)
        }.toString())
        fragments.forEachIndexed { index, data ->
            emitHostMessage(buildJsonObject {
                put("t", "${prefix}Chunk")
                put("syncId", syncId); put("sessionId", sessionId)
                section?.let { put("section", it) }; messageIndex?.let { put("messageIndex", it) }
                put("fragmentIndex", index); put("data", data)
            }.toString())
        }
        emitHostMessage(buildJsonObject {
            put("t", "${prefix}Commit")
            put("syncId", syncId); put("sessionId", sessionId)
            section?.let { put("section", it) }; messageIndex?.let { put("messageIndex", it) }
        }.toString())
    }

    private fun emitHostMessage(message: String) {
        require(message.toByteArray(Charsets.UTF_8).size <= MAX_JSON_FRAME_BYTES) { "Renderer message exceeds 256 KiB" }
        check(_hostMessages.tryEmit(message)) { "Renderer message queue is full" }
    }

    private fun sendTraffic(plaintext: ByteArray): Boolean {
        val stored = credential ?: return false
        val current = connection ?: return false
        if (_state.value !is ProtocolEngineState.Active) return false
        val counter = current.outboundNext
        require(counter != ULong.MAX_VALUE) { "Traffic counter exhausted" }
        current.outboundNext = counter + 1u
        val frame = seal(current.d2h, stored.roomId, stored.keyEpoch, TrafficDirection.DEVICE_TO_HOST, current.assignedPeerId, counter, plaintext)
        return relay.sendBinary(frame)
    }

    private suspend fun sendCommandAndAwait(
        commandName: String,
        payload: JsonObject,
        sessionScoped: Boolean = true,
        durableUi: PendingUiCommand? = null,
    ): AckOutcome {
        val stored = credential ?: error("Remote credential is unavailable")
        val selected = if (sessionScoped) {
            selectedSessionId ?: capability(stored).sessionIds.firstOrNull() ?: error("No selected desktop session")
        } else null
        requireCommandCapability(stored, commandName, selected)
        val command = androidHostPort.createCommand(stored.hostGeneration, selected, commandName, payload)
        val waiter = CompletableDeferred<AckOutcome>()
        synchronized(this) { commandWaiters[command.commandId] = waiter }
        val correlation = durableUi?.durableCorrelation()
        val post = androidHostPort.post(command, correlation?.first, correlation?.second)
        if (post is HostPostResult.Rejected) {
            synchronized(this) { commandWaiters.remove(command.commandId) }
            error(post.reason)
        }
        flushOutbox()
        val outcome = try { withTimeout(30_000) { waiter.await() } } finally {
            synchronized(this) { commandWaiters.remove(command.commandId) }
        }
        require(outcome.status == "completed") { outcome.message ?: "Remote command ${outcome.status}" }
        return outcome
    }

    private fun queryAttachment(uri: Uri): AttachmentMetadata {
        var name: String? = null
        var size: Long? = null
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                name = cursor.getString(0)
                if (!cursor.isNull(1)) size = cursor.getLong(1)
            }
        }
        size?.let { require(it in 0..MAX_ATTACHMENT_BYTES) { "Attachment exceeds 20 MiB" } }
        val safeName = safeFileName(name ?: "android-attachment")
        val mediaType = contentResolver.getType(uri)?.takeIf { it.matches(Regex("[A-Za-z0-9!#\u0024&^_.+\\-]+/[A-Za-z0-9!#\u0024&^_.+\\-]+")) }
        return AttachmentMetadata(safeName, size, mediaType)
    }

    private fun safeFileName(raw: String): String {
        var value = Normalizer.normalize(raw, Normalizer.Form.NFC)
            .replace(Regex("[<>:\"/\\\\|?*\\x00-\\x1f\\x7f]"), "_")
            .trim().trimEnd('.', ' ')
        if (value.isBlank() || value == "." || value == "..") value = "android-attachment"
        val stem = value.substringBefore('.').uppercase()
        if (stem in WINDOWS_RESERVED) value = "_$value"
        while (value.toByteArray(Charsets.UTF_8).size > 255) value = value.dropLast(1)
        return value
    }

    private fun schedulePhaseTimeout(delayMillis: Long, action: () -> Unit) {
        phaseTimeout?.cancel()
        phaseTimeout = scope.launch {
            delay(delayMillis)
            synchronized(this@RemoteProtocolEngine) {
                phaseTimeout = null
                action()
            }
        }
    }

    private fun reconnectCurrent() {
        discardVolatileAccumulators()
        val uri = pending?.uri?.guestWebSocketUri()
            ?: credential?.let { URI(it.relayOrigin).resolve("/r/${it.roomId}?role=guest") }
            ?: return
        _state.value = ProtocolEngineState.Recovering("handshake timeout")
        relay.connect(uri)
    }

    private fun emitSnapshot(snapshot: JsonObject) {
        val configuration = snapshot["configuration"] as? JsonObject ?: JsonObject(emptyMap())
        val approvalMode = (snapshot["approvalMode"] as? JsonPrimitive)?.content
        _hostMessages.tryEmit(buildJsonObject {
            put("t", "boot")
            put("cfg", JsonObject(configuration.toMutableMap().apply { approvalMode?.let { this["approvalMode"] = JsonPrimitive(it) } }))
        }.toString())
        snapshot["state"]?.let { _hostMessages.tryEmit(buildJsonObject { put("t", "state"); put("state", it) }.toString()) }
        snapshot["models"]?.let { _hostMessages.tryEmit(buildJsonObject { put("t", "models"); put("models", it) }.toString()) }
        snapshot["commands"]?.let { _hostMessages.tryEmit(buildJsonObject { put("t", "commands"); put("commands", it) }.toString()) }
        snapshot["transcript"]?.let { _hostMessages.tryEmit(buildJsonObject { put("t", "transcript"); put("messages", it) }.toString()) }
        snapshot["stats"]?.takeUnless { it is JsonNull }?.let { _hostMessages.tryEmit(buildJsonObject { put("t", "sessionStats"); put("stats", it) }.toString()) }
        snapshot["profile"]?.takeUnless { it is JsonNull }?.let { _hostMessages.tryEmit(buildJsonObject { put("t", "profile"); put("profile", it) }.toString()) }
        approvalMode?.let { _hostMessages.tryEmit(buildJsonObject { put("t", "approval"); put("mode", it) }.toString()) }
        (snapshot["approvals"] as? JsonArray)?.forEach { frame ->
            if (frame is JsonObject) {
                recordApprovalRequests(frame)
                _hostMessages.tryEmit(buildJsonObject { put("t", "frame"); put("frame", frame) }.toString())
            }
        }
    }

    private fun approvalPayload(body: JsonObject): JsonObject {
        val frame = body["frame"] as? JsonObject ?: error("UI response frame is missing")
        val requestId = approvalResponseRequestId(body)
        // Retain the request until a terminal completed ACK. Rejected,
        // indeterminate, or timed-out delivery must remain retryable.
        val request = approvals[requestId] ?: error("Approval request is no longer pending")
        val response = when {
            (frame["cancelled"] as? JsonPrimitive)?.content == "true" -> buildJsonObject { put("kind", "cancel") }
            request.method == "confirm" -> buildJsonObject {
                put("kind", "confirm")
                put("value", (frame["confirmed"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false)
            }
            request.method == "select" -> {
                val selected = frame["value"] ?: error("Selection is missing")
                val index = request.options.indexOfFirst { ProtocolSecurity.canonicalJsonBytes(it).contentEquals(ProtocolSecurity.canonicalJsonBytes(selected)) }
                require(index >= 0) { "Selection is not one of the offered options" }
                buildJsonObject { put("kind", "select"); put("index", index) }
            }
            request.method == "editor" -> buildJsonObject { put("kind", "editor"); put("value", string(frame, "value", 1024 * 1024, allowEmpty = true)) }
            else -> buildJsonObject { put("kind", "input"); put("value", string(frame, "value", 64 * 1024, allowEmpty = true)) }
        }
        return buildJsonObject { put("requestId", requestId); put("response", response) }
    }

    private fun recordApprovalRequests(value: JsonElement) {
        when (value) {
            is JsonArray -> value.forEach(::recordApprovalRequests)
            is JsonObject -> {
                if ((value["type"] as? JsonPrimitive)?.content == "extension_ui_request") {
                    val id = (value["id"] as? JsonPrimitive)?.content
                    val method = (value["method"] as? JsonPrimitive)?.content
                    if (id != null && method in setOf("confirm", "select", "input", "editor")) {
                        val options = ((value["options"] ?: value["items"]) as? JsonArray)
                            ?.map(::normalizeApprovalOption)
                            .orEmpty()
                        approvals[id] = ApprovalRequest(method!!, options)
                    }
                }
                value.values.forEach(::recordApprovalRequests)
            }
            else -> Unit
        }
    }

    /** Full-sync approvals are authoritative and remove desktop/agent-won stale requests. */
    private fun replaceApprovalRequests(value: JsonElement) {
        approvals.clear()
        recordApprovalRequests(value)
    }

    private fun capability(value: DeviceCredential): CapabilityManifest =
        StrictProtocolJson.decodeFromString(CapabilityManifest.serializer(), value.capabilityManifest)

    private fun requireFilesCapability() {
        val stored = credential ?: error("Remote credential is unavailable")
        val selected = selectedSessionId ?: capability(stored).sessionIds.firstOrNull()
            ?: error("No selected desktop session")
        requireCommandCapability(stored, "attachment.start", selected)
    }

    private fun requireCommandCapability(stored: DeviceCredential, command: String, sessionId: String?) {
        val manifest = capability(stored)
        validateCapabilityWindow(manifest)
        val requiredVerb = COMMAND_CAPABILITY[command] ?: error("Command capability mapping is missing")
        require(requiredVerb in manifest.verbs) { "This phone was not granted $requiredVerb" }
        if (command in ALL_SESSION_COMMANDS) require(manifest.allSessions) { "This command requires an all-sessions grant" }
        if (command in SESSION_SCOPED_COMMANDS) {
            // allSessions permits global lifecycle verbs, but a concrete command may
            // target only an ID present in the host-signed canonical session set.
            require(isSessionInsideSignedGrant(manifest, sessionId)) {
                "Session is outside this phone's grant"
            }
        }
    }

    private fun emitRemoteCapabilities(stored: DeviceCredential) {
        val manifest = capability(stored)
        _capabilities.value = RemoteCapabilityUi(manifest.verbs.toSet(), manifest.allSessions)
        emitHostMessage(buildJsonObject {
            put("t", "remoteCapabilities")
            put("verbs", JsonArray(manifest.verbs.map(::JsonPrimitive)))
            put("allSessions", manifest.allSessions)
            put("sessionIds", JsonArray(manifest.sessionIds.map(::JsonPrimitive)))
            put("expiresAt", manifest.expiresAt)
        }.toString())
    }

    private fun string(value: JsonObject, key: String, max: Int, allowEmpty: Boolean = false): String {
        val found = (value[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("$key must be a string")
        require(found.length <= max && (allowEmpty || found.isNotEmpty()))
        return found
    }

    private fun seal(
        key: ByteArray,
        roomId: String,
        keyEpoch: Long,
        direction: TrafficDirection,
        logicalPeer: Long,
        counter: ULong,
        plaintext: ByteArray,
    ): ByteArray {
        val encrypted = CryptoCodec.encrypt(key, AuthenticatedHeader(roomId, keyEpoch, direction, logicalPeer, counter), plaintext)
        return RelayEnvelope.encode(0, encrypted) // Guest routing header is always zero; relay rewrites sender id.
    }

    private data class PendingPairing(
        val uri: PairingUri,
        val nonce: ByteArray,
        val frame: PairFrame,
        var sealedPair: ByteArray? = null,
    ) {
        fun destroy() { uri.pairingKey.fill(0); nonce.fill(0); sealedPair?.fill(0) }
    }

    private data class HelloContext(val frame: HelloFrame, val nonce: ByteArray) {
        fun destroy() = nonce.fill(0)
    }

    private data class ConnectionContext(
        val connectionId: String,
        val assignedPeerId: Long,
        val d2h: ByteArray,
        val h2d: ByteArray,
        val challengeEnvelope: ByteArray,
        val sealedProof: ByteArray,
        var outboundNext: ULong = 0u,
        var inboundHighest: ULong = ULong.MAX_VALUE,
    ) {
        fun destroy() { d2h.fill(0); h2d.fill(0); challengeEnvelope.fill(0); sealedProof.fill(0) }
    }

    private data class ApprovalRequest(val method: String, val options: List<JsonElement>)
    private data class AckOutcome(
        val status: String,
        val result: JsonElement?,
        val message: String?,
        val streamed: CompletedCommandResult? = null,
    )
    private data class AttachmentMetadata(val safeName: String, val size: Long?, val mediaType: String?)

    private fun PendingUiCommand.durableCorrelation(): Pair<String, String?> = when (this) {
        PendingUiCommand.Prompt -> "prompt" to null
        PendingUiCommand.History -> "history" to null
        is PendingUiCommand.Files -> "files" to token
        PendingUiCommand.ExportTranscript -> "export" to null
        PendingUiCommand.Diagnostics -> "diagnostics" to null
        PendingUiCommand.ModelsProbe -> "models-probe" to null
        is PendingUiCommand.Approval -> "approval" to requestId
        is PendingUiCommand.Diff -> "diff" to changeId
    }

    private fun OutboxItem.pendingUiCommand(): PendingUiCommand? = when (uiKind) {
        "prompt" -> PendingUiCommand.Prompt
        "history" -> PendingUiCommand.History
        "files" -> uiToken?.let(PendingUiCommand::Files)
        "export" -> PendingUiCommand.ExportTranscript
        "diagnostics" -> PendingUiCommand.Diagnostics
        "models-probe" -> PendingUiCommand.ModelsProbe
        "approval" -> uiToken?.let(PendingUiCommand::Approval)
        "diff" -> uiToken?.let(PendingUiCommand::Diff)
        else -> null
    }

    private sealed interface PendingUiCommand {
        data object Prompt : PendingUiCommand
        data object History : PendingUiCommand
        data class Files(val token: String) : PendingUiCommand
        data object ExportTranscript : PendingUiCommand
        data object Diagnostics : PendingUiCommand
        data object ModelsProbe : PendingUiCommand
        data class Approval(val requestId: String) : PendingUiCommand
        data class Diff(val changeId: String) : PendingUiCommand
    }

    companion object {
        private const val PENDING_HELLO_FALLBACK_MILLIS = 3_000L
        private const val PAIR_RESPONSE_TIMEOUT_MILLIS = 5_000L
        private const val HANDSHAKE_TIMEOUT_MILLIS = 10_000L
        private val COMMAND_CAPABILITY = mapOf(
            "session.sync" to "view", "transcript.get" to "view", "prompt.send" to "prompt", "turn.abort" to "prompt",
            "approval.respond" to "approve", "model.set" to "prompt", "models.probe" to "prompt", "thinking.set" to "prompt",
            "approval-mode.set" to "settings.manage", "attachment.start" to "files", "attachment.commit" to "files",
            "attachment.cancel" to "files", "files.search" to "files", "diff.get" to "files", "revert.apply" to "files",
            "editor.insert" to "files", "transcript.export" to "view", "sessions.list" to "session.manage",
            "session.create" to "session.manage", "session.switch" to "session.manage", "session.rename" to "session.manage",
            "session.reset" to "session.manage", "session.compact" to "session.manage", "session.restart" to "session.manage",
            "session.close" to "session.manage", "history.list" to "session.manage", "history.open" to "session.manage",
            "settings.update" to "settings.manage", "profile.update" to "settings.manage", "auth.login" to "credentials.manage",
            "credentials.set" to "credentials.manage", "credentials.clear" to "credentials.manage",
            "diagnostics.get" to "view", "remote.stop" to "view",
        )
        private val SESSION_SCOPED_COMMANDS = setOf(
            "session.sync", "transcript.get", "prompt.send", "turn.abort", "approval.respond", "model.set", "models.probe",
            "thinking.set", "attachment.start", "attachment.commit", "attachment.cancel", "files.search", "diff.get",
            "revert.apply", "editor.insert", "transcript.export", "session.rename", "session.reset", "session.compact",
            "session.restart", "session.close", "history.open", "profile.update", "auth.login",
        )
        private val ALL_SESSION_COMMANDS = setOf("sessions.list", "session.create", "session.switch", "history.list", "approval-mode.set")
        private val WINDOWS_RESERVED = setOf("CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9")
    }
}
