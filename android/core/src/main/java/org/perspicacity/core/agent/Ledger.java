package org.perspicacity.core.agent;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Append-only, HMAC-chained audit ledger (same scheme as desktop/src/main/ledger.js).
 * Each line: {seq, ts, kind, data, prev, mac}, mac = HMAC-SHA256(key, prev + "\n" + [seq, ts, kind, data]).
 * Editing, removing or reordering any entry breaks verification from that entry on.
 */
public final class Ledger {
    public static final String GENESIS = "0000000000000000000000000000000000000000000000000000000000000000";

    public static final class Verify {
        public final boolean ok;
        public final int count;
        public final int at;
        public final String reason;
        final String last;
        Verify(boolean ok, int count, int at, String reason, String last) { this.ok = ok; this.count = count; this.at = at; this.reason = reason; this.last = last; }
    }

    private final File file;
    private final byte[] key;
    private int seq;
    private String prev = GENESIS;
    private Verify broken;

    public Ledger(File file, byte[] key) throws IOException {
        if (key == null || key.length < 32) throw new IllegalArgumentException("ledger key must be at least 32 bytes");
        this.file = file;
        this.key = key.clone();
        Verify v = verify();
        if (v.ok) { seq = v.count; prev = v.last; } else broken = v;
    }

    private static String canonical(int seq, String ts, String kind, String data) {
        return new JSONArray().put(seq).put(ts).put(kind).put(data).toString();
    }

    private String mac(String prev, int seq, String ts, String kind, String data) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key, "HmacSHA256"));
            m.update(prev.getBytes(StandardCharsets.UTF_8));
            m.update((byte) '\n');
            byte[] out = m.doFinal(canonical(seq, ts, kind, data).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : out) hex.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            return hex.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String now() {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date());
    }

    public synchronized void append(String kind, String data) throws IOException {
        if (broken != null) throw new IOException("ledger failed verification at entry " + broken.at + "; refusing to append");
        int s = seq + 1;
        String ts = now();
        String d = data == null ? "" : data;
        String m = mac(prev, s, ts, kind, d);
        JSONObject e = new JSONObject();
        try {
            e.put("seq", s).put("ts", ts).put("kind", kind).put("data", d).put("prev", prev).put("mac", m);
        } catch (JSONException ex) {
            throw new IOException(ex);
        }
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write((e.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        }
        seq = s;
        prev = m;
    }

    public synchronized Verify verify() throws IOException {
        if (!file.exists()) return new Verify(true, 0, 0, null, GENESIS);
        String p = GENESIS;
        int n = 0;
        for (String line : new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).split("\n")) {
            if (line.trim().isEmpty()) continue;
            n++;
            JSONObject e;
            try { e = new JSONObject(line); } catch (JSONException ex) { return new Verify(false, n, n, "unparseable entry", null); }
            if (e.optInt("seq", -1) != n) return new Verify(false, n, n, "sequence gap", null);
            if (!p.equals(e.optString("prev"))) return new Verify(false, n, n, "chain break", null);
            String expect = mac(p, n, e.optString("ts"), e.optString("kind"), e.optString("data"));
            if (!MessageDigest.isEqual(expect.getBytes(StandardCharsets.UTF_8), e.optString("mac").getBytes(StandardCharsets.UTF_8))) {
                return new Verify(false, n, n, "bad MAC", null);
            }
            p = expect;
        }
        return new Verify(true, n, 0, null, p);
    }

    /** Last n entries as display lines, newest last. */
    public synchronized List<String> tail(int n) {
        List<String> out = new ArrayList<>();
        try {
            if (!file.exists()) return out;
            String[] lines = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).split("\n");
            for (int i = Math.max(0, lines.length - n); i < lines.length; i++) {
                if (lines[i].trim().isEmpty()) continue;
                JSONObject e = new JSONObject(lines[i]);
                out.add("#" + e.optInt("seq") + " " + e.optString("ts") + " " + e.optString("kind") + " " + e.optString("data"));
            }
        } catch (Exception ignored) { }
        return out;
    }
}
