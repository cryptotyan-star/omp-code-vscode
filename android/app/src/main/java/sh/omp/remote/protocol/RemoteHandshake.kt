package sh.omp.remote.protocol

import java.security.MessageDigest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import sh.omp.remote.crypto.ProtocolSecurity

object HandshakeCounters {
    private val PAIR_COUNTER_DOMAIN = "omp-code-remote/v1\u0000pair-counter\u0000".toByteArray(Charsets.UTF_8)

    fun pairCounter(deviceNonce: ByteArray): ULong {
        require(deviceNonce.size == 16) { "Device nonce must be 16 bytes" }
        val digest = MessageDigest.getInstance("SHA-256").apply {
            update(PAIR_COUNTER_DOMAIN)
            update(deviceNonce)
        }.digest()
        var value = 0uL
        repeat(8) { index -> value = (value shl 8) or digest[index].toUByte().toULong() }
        digest.fill(0)
        return value and 0x7fff_ffff_ffff_ffffuL
    }

    fun enrolCounter(assignedPeerId: Long): ULong {
        require(assignedPeerId in 1..UInt.MAX_VALUE.toLong()) { "Assigned peer must be a positive uint32" }
        return 0x8000_0000_0000_0000uL or assignedPeerId.toULong()
    }
}

sealed interface HandshakeFrame { val type: String; val raw: JsonObject }

data class PairFrame(val deviceId: String, val deviceName: String, val deviceNonce: String, override val raw: JsonObject) : HandshakeFrame { override val type = "pair" }
data class EnrolledFrame(
    val enrolmentId: String,
    val deviceId: String,
    val assignedPeerId: Long,
    val roomMasterKey: String,
    val deviceToken: String,
    val keyEpoch: Long,
    val hostGeneration: String,
    val capability: CapabilityManifest,
    val capabilitySignature: String,
    override val raw: JsonObject,
) : HandshakeFrame { override val type = "enrolled" }
data class EnrolledAckFrame(val enrolmentId: String, val deviceId: String, val credentialDigest: String, override val raw: JsonObject) : HandshakeFrame { override val type = "enrolled-ack" }
data class HelloFrame(
    val deviceId: String,
    val deviceToken: String,
    val deviceNonce: String,
    val hostGeneration: String?,
    val lastSequence: String,
    val clientVersion: String,
    override val raw: JsonObject,
) : HandshakeFrame { override val type = "hello" }
data class ChallengeFrame(
    val connectionId: String,
    val deviceId: String,
    val assignedPeerId: Long,
    val deviceNonce: String,
    val hostNonce: String,
    val hostGeneration: String,
    val keyEpoch: Long,
    override val raw: JsonObject,
) : HandshakeFrame { override val type = "challenge" }
data class ProofFrame(val connectionId: String, val proof: String, override val raw: JsonObject) : HandshakeFrame { override val type = "proof" }
data class WelcomeFrame(
    val connectionId: String,
    val hostGeneration: String,
    val sequence: String,
    val capability: CapabilityManifest,
    val capabilitySignature: String,
    override val raw: JsonObject,
) : HandshakeFrame { override val type = "welcome" }
data class ErrorFrame(val code: String, val message: String, val retryable: Boolean, override val raw: JsonObject) : HandshakeFrame { override val type = "error" }

object RemoteHandshakeCodec {
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")
    private val identifier = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")

    fun parse(bytes: ByteArray): HandshakeFrame {
        require(bytes.size in 1..MAX_JSON_FRAME_BYTES) { "Handshake frame size is invalid" }
        val value = runCatching { StrictProtocolJson.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject }
            .getOrElse { throw IllegalArgumentException("Handshake frame is malformed JSON") }
        require(number(value, "protocolVersion", 1, 1) == 1L)
        return when (val type = string(value, "type", 32)) {
            "pair" -> {
                exact(value, "protocolVersion", "type", "deviceId", "deviceName", "deviceNonce")
                PairFrame(identifier(value, "deviceId"), printable(value, "deviceName", 128), b64(value, "deviceNonce", 16), value)
            }
            "enrolled" -> {
                exact(value, "protocolVersion", "type", "enrolmentId", "deviceId", "assignedPeerId", "roomMasterKey", "deviceToken", "keyEpoch", "hostGeneration", "capability", "capabilitySignature")
                EnrolledFrame(
                    uuid(value, "enrolmentId"), identifier(value, "deviceId"), number(value, "assignedPeerId", 1, UINT32_MAX),
                    b64(value, "roomMasterKey", 32), b64(value, "deviceToken", 32), number(value, "keyEpoch", 1, UINT32_MAX),
                    identifier(value, "hostGeneration"), parseCapability(value["capability"] as? JsonObject ?: error("capability must be an object")),
                    b64(value, "capabilitySignature", 32), value,
                )
            }
            "enrolled-ack" -> {
                exact(value, "protocolVersion", "type", "enrolmentId", "deviceId", "credentialDigest")
                EnrolledAckFrame(uuid(value, "enrolmentId"), identifier(value, "deviceId"), hex(value, "credentialDigest", 64), value)
            }
            "hello" -> {
                exactOptional(value, setOf("hostGeneration"), "protocolVersion", "type", "deviceId", "deviceToken", "deviceNonce", "lastSequence", "clientVersion")
                HelloFrame(
                    identifier(value, "deviceId"), b64(value, "deviceToken", 32), b64(value, "deviceNonce", 16),
                    value["hostGeneration"]?.let { identifier(value, "hostGeneration") },
                    string(value, "lastSequence", 20).also(::parseUint64Decimal),
                    string(value, "clientVersion", 64).also { require(Regex("[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}").matches(it)) }, value,
                )
            }
            "challenge" -> {
                exact(value, "protocolVersion", "type", "connectionId", "deviceId", "assignedPeerId", "deviceNonce", "hostNonce", "hostGeneration", "keyEpoch")
                ChallengeFrame(
                    uuid(value, "connectionId"), identifier(value, "deviceId"), number(value, "assignedPeerId", 1, UINT32_MAX),
                    b64(value, "deviceNonce", 16), b64(value, "hostNonce", 16), identifier(value, "hostGeneration"),
                    number(value, "keyEpoch", 1, UINT32_MAX), value,
                )
            }
            "proof" -> {
                exact(value, "protocolVersion", "type", "connectionId", "proof")
                ProofFrame(uuid(value, "connectionId"), b64(value, "proof", 32), value)
            }
            "welcome" -> {
                exact(value, "protocolVersion", "type", "connectionId", "hostGeneration", "sequence", "capability", "capabilitySignature")
                WelcomeFrame(
                    uuid(value, "connectionId"), identifier(value, "hostGeneration"), string(value, "sequence", 20).also(::parseUint64Decimal),
                    parseCapability(value["capability"] as? JsonObject ?: error("capability must be an object")),
                    b64(value, "capabilitySignature", 32), value,
                )
            }
            "error" -> {
                exact(value, "protocolVersion", "type", "code", "message", "retryable")
                ErrorFrame(
                    string(value, "code", 64).also { require(Regex("[a-z][a-z0-9-]{0,63}").matches(it)) },
                    string(value, "message", 1024), boolean(value, "retryable"), value,
                )
            }
            else -> throw IllegalArgumentException("Unknown handshake frame: $type")
        }
    }

    fun pair(deviceId: String, deviceName: String, deviceNonce: String): PairFrame = parseObject(
        buildJsonObject {
            put("protocolVersion", 1); put("type", "pair"); put("deviceId", deviceId); put("deviceName", deviceName); put("deviceNonce", deviceNonce)
        },
    ) as PairFrame

    fun enrolledAck(enrolmentId: String, deviceId: String, digest: String): EnrolledAckFrame = parseObject(
        buildJsonObject {
            put("protocolVersion", 1); put("type", "enrolled-ack"); put("enrolmentId", enrolmentId); put("deviceId", deviceId); put("credentialDigest", digest)
        },
    ) as EnrolledAckFrame

    fun hello(deviceId: String, token: String, nonce: String, generation: String?, lastSequence: String): HelloFrame = parseObject(
        buildJsonObject {
            put("protocolVersion", 1); put("type", "hello"); put("deviceId", deviceId); put("deviceToken", token); put("deviceNonce", nonce)
            generation?.let { put("hostGeneration", it) }
            put("lastSequence", lastSequence); put("clientVersion", "android-0.1.0")
        },
    ) as HelloFrame

    fun proof(connectionId: String, proof: String): ProofFrame = parseObject(
        buildJsonObject { put("protocolVersion", 1); put("type", "proof"); put("connectionId", connectionId); put("proof", proof) },
    ) as ProofFrame

    fun encode(frame: HandshakeFrame): ByteArray = frame.raw.toString().toByteArray(Charsets.UTF_8).also {
        require(it.size <= MAX_JSON_FRAME_BYTES)
    }

    fun parseCapabilityManifest(value: JsonObject): CapabilityManifest = parseCapability(value)

    private fun parseObject(value: JsonObject): HandshakeFrame = parse(value.toString().toByteArray(Charsets.UTF_8))

    private fun parseCapability(value: JsonObject): CapabilityManifest {
        exact(value, "protocolVersion", "manifestId", "deviceId", "keyEpoch", "issuedAt", "expiresAt", "verbs", "sessionIds", "workspaceRoots", "allSessions")
        val result = CapabilityManifest(
            protocolVersion = number(value, "protocolVersion", 1, 1).toInt(),
            manifestId = uuid(value, "manifestId"),
            deviceId = identifier(value, "deviceId"),
            keyEpoch = number(value, "keyEpoch", 1, UINT32_MAX),
            issuedAt = number(value, "issuedAt", 0, MAX_SAFE_INTEGER),
            expiresAt = number(value, "expiresAt", 1, MAX_SAFE_INTEGER),
            verbs = stringArray(value, "verbs", 7, 32).also { require(it.all { verb -> verb in CAPABILITY_VERBS }) },
            sessionIds = stringArray(value, "sessionIds", 256, 128).also { require(it.all(identifier::matches)) },
            workspaceRoots = stringArray(value, "workspaceRoots", 64, 4096),
            allSessions = boolean(value, "allSessions"),
        )
        require(result.expiresAt > result.issuedAt)
        return result
    }

    private fun exact(value: JsonObject, vararg keys: String) = exactOptional(value, emptySet(), *keys)
    private fun exactOptional(value: JsonObject, optional: Set<String>, vararg keys: String) {
        val required = keys.toSet()
        require(value.keys.containsAll(required) && value.keys.all { it in required || it in optional }) { "Handshake schema fields do not match" }
    }

    private fun string(value: JsonObject, key: String, max: Int): String {
        val found = (value[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("$key must be a string")
        require(found.isNotEmpty() && found.length <= max)
        return found
    }
    private fun identifier(value: JsonObject, key: String): String = string(value, key, 128).also { require(identifier.matches(it)) }
    private fun uuid(value: JsonObject, key: String): String = string(value, key, 36).also { require(uuid.matches(it)) }.lowercase()
    private fun printable(value: JsonObject, key: String, max: Int): String = string(value, key, max).also { require(it.none { c -> c.code < 0x20 || c.code == 0x7f }) }
    private fun b64(value: JsonObject, key: String, bytes: Int): String = string(value, key, if (bytes == 16) 22 else 43).also {
        require(ProtocolSecurity.decodeCanonical(it, bytes) != null)
    }
    private fun hex(value: JsonObject, key: String, length: Int): String = string(value, key, length).also { require(it.length == length && it.all { c -> c in '0'..'9' || c in 'a'..'f' }) }
    private fun number(value: JsonObject, key: String, min: Long, max: Long): Long {
        val primitive = (value[key] as? JsonPrimitive)?.takeUnless { it.isString } ?: error("$key must be a number")
        val found = primitive.content.toLongOrNull() ?: error("$key must be an integer")
        require(found in min..max)
        return found
    }
    private fun boolean(value: JsonObject, key: String): Boolean =
        (value[key] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: error("$key must be boolean")
    private fun stringArray(value: JsonObject, key: String, count: Int, itemMax: Int): List<String> {
        val array = value[key] as? JsonArray ?: error("$key must be an array")
        require(array.size <= count)
        return array.map { element ->
            (element as? JsonPrimitive)?.takeIf { it.isString }?.content?.also { require(it.isNotEmpty() && it.length <= itemMax) }
                ?: error("$key contains non-string")
        }.distinct()
    }

    private const val UINT32_MAX = 0xffff_ffffL
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private val CAPABILITY_VERBS = setOf("view", "prompt", "approve", "files", "session.manage", "settings.manage", "credentials.manage")
}
