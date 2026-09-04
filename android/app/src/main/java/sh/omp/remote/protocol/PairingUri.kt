package sh.omp.remote.protocol

import java.net.IDN
import java.net.URI
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.util.Base64

data class PairingUri(
    val relayOrigin: URI,
    val roomId: String,
    val pairingKey: ByteArray,
    val expiresAtEpochMillis: Long,
    val keyEpoch: Long,
) {
    fun guestWebSocketUri(): URI = URI(
        relayOrigin.scheme,
        null,
        relayOrigin.host,
        relayOrigin.port,
        "/r/$roomId",
        "role=guest",
        null,
    )

    /** Safe metadata for UI. Pairing keys are intentionally never printable. */
    fun redactedDescription(): String = "${relayOrigin.host} • ${roomId.take(8)}…"

    override fun toString(): String = "PairingUri(${redactedDescription()}, key=<redacted>)"

    override fun equals(other: Any?): Boolean =
        other is PairingUri &&
            relayOrigin == other.relayOrigin &&
            roomId == other.roomId &&
            pairingKey.contentEquals(other.pairingKey) &&
            expiresAtEpochMillis == other.expiresAtEpochMillis &&
            keyEpoch == other.keyEpoch

    override fun hashCode(): Int {
        var result = relayOrigin.hashCode()
        result = 31 * result + roomId.hashCode()
        result = 31 * result + pairingKey.contentHashCode()
        result = 31 * result + expiresAtEpochMillis.hashCode()
        return 31 * result + keyEpoch.hashCode()
    }

    companion object {
        const val MAX_URI_LENGTH = 2048
        const val MAX_PAIRING_TTL_MILLIS = 10 * 60 * 1000L
        private val roomPattern = Regex("[0-9a-f]{32}")
        private val keyPattern = Regex("[A-Za-z0-9_-]{43}")
        private val expectedFields = setOf("v", "relay", "room", "key", "expires", "epoch")

        fun parse(
            raw: String,
            clock: Clock = Clock.systemUTC(),
            maximumTtlMillis: Long = MAX_PAIRING_TTL_MILLIS,
        ): PairingUri {
            val input = raw.trim()
            require(input.length in 1..MAX_URI_LENGTH) { "Pairing link has an invalid length" }
            val uri = runCatching { URI(input) }.getOrElse { throw IllegalArgumentException("Malformed pairing link") }
            require(uri.scheme.equals("omp-code", ignoreCase = true)) { "Unsupported pairing scheme" }
            require(uri.host.equals("pair", ignoreCase = true)) { "Unsupported pairing host" }
            require(uri.userInfo == null && uri.port == -1 && uri.fragment == null) { "Pairing link contains forbidden authority data" }
            require(uri.path.isNullOrEmpty() || uri.path == "/") { "Pairing link contains an unexpected path" }

            val fields = parseQuery(uri.rawQuery ?: throw IllegalArgumentException("Pairing parameters are missing"))
            require(fields.keys == expectedFields) { "Pairing parameters are incomplete or unsupported" }
            require(fields.getValue("v") == "1") { "Unsupported remote protocol version" }

            val room = fields.getValue("room")
            require(roomPattern.matches(room)) { "Room id must be 128-bit lowercase hex" }

            val encodedKey = fields.getValue("key")
            require(keyPattern.matches(encodedKey)) { "Pairing key must be unpadded base64url" }
            val pairingKey = runCatching { Base64.getUrlDecoder().decode(encodedKey) }
                .getOrElse { throw IllegalArgumentException("Pairing key is not valid base64url") }
            require(pairingKey.size == 32) { "Pairing key must contain 256 bits" }
            require(Base64.getUrlEncoder().withoutPadding().encodeToString(pairingKey) == encodedKey) {
                "Pairing key must use canonical base64url"
            }

            val expiryText = fields.getValue("expires")
            require(Regex("[1-9][0-9]{9,15}").matches(expiryText)) { "Pairing expiry is invalid" }
            val expiry = expiryText.toLongOrNull()
                ?: throw IllegalArgumentException("Pairing expiry is invalid")
            val now = clock.millis()
            require(expiry > now) { "Pairing link has expired" }
            require(expiry - now <= maximumTtlMillis) { "Pairing link expiry exceeds the allowed lifetime" }

            val epochText = fields.getValue("epoch")
            require(Regex("[1-9][0-9]{0,9}").matches(epochText)) { "Key epoch is invalid" }
            val epoch = epochText.toLongOrNull()
                ?: throw IllegalArgumentException("Key epoch is invalid")
            require(epoch in 1..UInt.MAX_VALUE.toLong()) { "Key epoch is outside positive uint32" }

            return PairingUri(
                relayOrigin = normalizeRelay(fields.getValue("relay")),
                roomId = room,
                pairingKey = pairingKey,
                expiresAtEpochMillis = expiry,
                keyEpoch = epoch,
            )
        }

        private fun normalizeRelay(raw: String): URI {
            val source = runCatching { URI(raw) }.getOrElse { throw IllegalArgumentException("Relay origin is malformed") }
            require(source.isAbsolute && source.host != null) { "Relay origin must be absolute" }
            require(source.userInfo == null && source.query == null && source.fragment == null) { "Relay origin contains forbidden data" }
            require(source.path.isNullOrEmpty() || source.path == "/") { "Relay must be an origin without a path" }
            val rawHost = source.host.lowercase()
            val asciiHost = if (':' in rawHost) rawHost else runCatching { IDN.toASCII(rawHost) }
                .getOrElse { throw IllegalArgumentException("Relay host is malformed") }
            val loopback = asciiHost == "localhost" || asciiHost == "127.0.0.1" || asciiHost == "::1" || asciiHost == "[::1]"
            val scheme = when (source.scheme.lowercase()) {
                "wss", "https" -> "wss"
                "ws" -> {
                    require(loopback) { "Plaintext relay is allowed only on localhost" }
                    "ws"
                }
                else -> throw IllegalArgumentException("Relay must use wss or https")
            }
            require(source.port == -1 || source.port in 1..65535) { "Relay port is invalid" }
            val port = if ((scheme == "wss" && source.port == 443) || (scheme == "ws" && source.port == 80)) -1 else source.port
            return URI(scheme, null, asciiHost, port, null, null, null)
        }

        private fun parseQuery(query: String): Map<String, String> {
            require(query.isNotBlank()) { "Pairing parameters are missing" }
            val result = linkedMapOf<String, String>()
            for (part in query.split('&')) {
                require(part.isNotEmpty()) { "Empty pairing parameter" }
                val delimiter = part.indexOf('=')
                require(delimiter > 0) { "Malformed pairing parameter" }
                val name = percentDecode(part.substring(0, delimiter))
                val value = percentDecode(part.substring(delimiter + 1))
                require(name !in result) { "Duplicate pairing parameter: $name" }
                result[name] = value
            }
            return result
        }

        private fun percentDecode(value: String): String {
            require('+' !in value) { "Plus encoding is not accepted in pairing links" }
            val output = java.io.ByteArrayOutputStream(value.length)
            var index = 0
            while (index < value.length) {
                val char = value[index]
                if (char == '%') {
                    require(index + 2 < value.length) { "Truncated percent encoding" }
                    val byte = value.substring(index + 1, index + 3).toIntOrNull(16)
                        ?: throw IllegalArgumentException("Invalid percent encoding")
                    output.write(byte)
                    index += 3
                } else {
                    require(char.code in 0x21..0x7e) { "Pairing link contains invalid characters" }
                    output.write(char.toString().toByteArray(StandardCharsets.UTF_8))
                    index++
                }
            }
            return output.toByteArray().toString(StandardCharsets.UTF_8)
        }
    }
}
