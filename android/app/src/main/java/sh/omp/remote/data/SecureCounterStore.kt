package sh.omp.remote.data

import android.content.Context
import java.math.BigInteger
import sh.omp.remote.protocol.parseUint64Decimal

class SecureCounterStore(context: Context) {
    private val storage = EncryptedBlobStore(
        context.applicationContext,
        alias = "omp.remote.counters.v1",
        preferencesName = "omp_remote_counters_sealed",
    )

    /** Reserves and persists the next outbound counter before the caller writes to the network. */
    @Synchronized
    fun reserveOutbound(name: String): ULong {
        validateName(name)
        val currentText = storage.get("out_$name")?.toString(Charsets.UTF_8) ?: "0"
        val current = parseUint64Decimal(currentText)
        require(current <= UINT64_MAX)
        val next = current + BigInteger.ONE
        require(next <= UINT64_MAX) { "Counter exhausted" }
        storage.put("out_$name", next.toString().toByteArray(Charsets.UTF_8))
        return current.toString().toULong()
    }

    fun highestInbound(name: String): ULong? {
        validateName(name)
        return storage.get("in_$name")?.toString(Charsets.UTF_8)?.also { parseUint64Decimal(it) }?.toULong()
    }

    /** Commits only after AEAD authentication has succeeded. */
    @Synchronized
    fun commitInbound(name: String, counter: ULong) {
        validateName(name)
        val previous = highestInbound(name)
        require(previous == null || counter > previous) { "Replay counter is not fresh" }
        storage.put("in_$name", counter.toString().toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun rotateEpoch() = storage.destroy()

    private fun validateName(name: String) = require(name.matches(Regex("[a-z0-9_-]{1,32}")))

    companion object {
        private val UINT64_MAX = BigInteger("18446744073709551615")
    }
}
