package org.perspicacity.browser;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * API keys and the audit-ledger key, encrypted with an AES-256-GCM key that lives in the
 * Android Keystore (hardware-backed where the phone has it) and never leaves it. The
 * ciphertext sits in app-private preferences; backups are disabled for the whole app.
 */
final class SecretStore {
    private static final String KEY_ALIAS = "perspicacity-secrets";
    private static final String PREFS = "secrets";

    private final SharedPreferences prefs;

    SecretStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return g.generateKey();
    }

    synchronized void put(String name, String value) {
        if (value == null || value.isEmpty()) { prefs.edit().remove(name).apply(); return; }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
            ByteBuffer b = ByteBuffer.allocate(1 + iv.length + ct.length);
            b.put((byte) iv.length).put(iv).put(ct);
            prefs.edit().putString(name, Base64.encodeToString(b.array(), Base64.NO_WRAP)).apply();
        } catch (Exception e) {
            throw new IllegalStateException("Could not encrypt the secret: " + e.getMessage(), e);
        }
    }

    synchronized String get(String name) {
        String stored = prefs.getString(name, null);
        if (stored == null) return null;
        try {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            int ivLen = all[0];
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 1, ivLen));
            byte[] pt = c.doFinal(all, 1 + ivLen, all.length - 1 - ivLen);
            return new String(pt, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null; // unreadable (key reset after a restore, for example)
        }
    }

    boolean has(String name) { return prefs.contains(name); }

    /** API key for a model provider. */
    String apiKey(String provider) { return get("apiKey." + provider); }
    void setApiKey(String provider, String value) { put("apiKey." + provider, value); }
    boolean hasApiKey(String provider) { return has("apiKey." + provider); }

    /** 32-byte random key, created on first use. */
    byte[] randomKey(String name) {
        String hex = get(name);
        if (hex == null || !hex.matches("[0-9a-f]{64}")) {
            byte[] k = new byte[32];
            new SecureRandom().nextBytes(k);
            StringBuilder b = new StringBuilder();
            for (byte x : k) b.append(String.format("%02x", x & 0xff));
            hex = b.toString();
            put(name, hex);
        }
        byte[] out = new byte[32];
        for (int i = 0; i < 32; i++) out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        return out;
    }
}
