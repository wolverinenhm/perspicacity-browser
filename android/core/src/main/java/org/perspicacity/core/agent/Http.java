package org.perspicacity.core.agent;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** Minimal HTTP client used by the model providers (replaceable in tests). */
public interface Http {
    final class Response {
        public final int status;
        public final String body;
        public Response(int status, String body) { this.status = status; this.body = body == null ? "" : body; }
        public boolean ok() { return status >= 200 && status < 300; }
    }

    /** body == null means GET. Throws IOException when the server cannot be reached. */
    Response send(String method, String url, Map<String, String> headers, String body, int timeoutMs) throws IOException;

    /** java.net implementation, available on both Android and the JVM. */
    final class UrlConnection implements Http {
        private static final int MAX_BODY = 4 * 1024 * 1024;

        @Override
        public Response send(String method, String url, Map<String, String> headers, String body, int timeoutMs) throws IOException {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            try {
                c.setRequestMethod(method);
                c.setConnectTimeout(Math.min(timeoutMs, 20_000));
                c.setReadTimeout(timeoutMs);
                c.setUseCaches(false);
                c.setInstanceFollowRedirects(false);
                for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
                if (body != null) {
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
                }
                int status = c.getResponseCode();
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                return new Response(status, in == null ? "" : read(in));
            } finally {
                c.disconnect();
            }
        }

        private static String read(InputStream in) throws IOException {
            try (InputStream s = in) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = s.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > MAX_BODY) break;
                }
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
        }
    }
}
