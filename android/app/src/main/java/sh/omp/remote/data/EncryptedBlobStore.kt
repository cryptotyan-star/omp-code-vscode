package sh.omp.remote.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class EncryptedBlobStore(
    context: Context,
    private val alias: String,
    preferencesName: String,
) {
    private val preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
    @Synchronized
    fun put(name: String, plaintext: ByteArray) {
        require(name.matches(Regex("[a-z0-9._-]{1,64}"))) { "Invalid encrypted value name" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        // A randomized Android Keystore key rejects caller-provided encryption IVs.
        // Let the provider generate the IV and persist that non-secret value beside
        // the authenticated ciphertext for decryption.
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv.also { require(it.size == 12) { "Keystore returned an invalid GCM IV" } }
        cipher.updateAAD(aad(name))
        val ciphertext = cipher.doFinal(plaintext)
        val encoded = listOf(
            FORMAT_VERSION,
            encoder.encodeToString(iv),
            encoder.encodeToString(ciphertext),
        ).joinToString(".")
        check(preferences.edit().putString(name, encoded).commit()) { "Unable to persist encrypted data" }
    }

    @Synchronized
    fun get(name: String): ByteArray? {
        val encoded = preferences.getString(name, null) ?: return null
        return runCatching {
            val parts = encoded.split('.')
            require(parts.size == 3 && parts[0] == FORMAT_VERSION) { "Unsupported encrypted data version" }
            val iv = decoder.decode(parts[1])
            val ciphertext = decoder.decode(parts[2])
            require(iv.size == 12 && ciphertext.size >= 16) { "Encrypted data is truncated" }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            cipher.updateAAD(aad(name))
            cipher.doFinal(ciphertext)
        }.getOrElse {
            // Corrupt or invalidated blobs are unusable and must not be returned as plaintext.
            preferences.edit().remove(name).commit()
            null
        }
    }

    @Synchronized
    fun remove(name: String) {
        check(preferences.edit().remove(name).commit()) { "Unable to clear encrypted data" }
    }

    @Synchronized
    fun destroy() {
        check(preferences.edit().clear().commit()) { "Unable to clear encrypted storage" }
        val keyStore = keyStore()
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = keyStore()
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun aad(name: String): ByteArray = "$FORMAT_VERSION\u0000$alias\u0000$name".toByteArray(Charsets.UTF_8)

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val FORMAT_VERSION = "1"
        private val encoder = Base64.getUrlEncoder().withoutPadding()
        private val decoder = Base64.getUrlDecoder()
    }
}
