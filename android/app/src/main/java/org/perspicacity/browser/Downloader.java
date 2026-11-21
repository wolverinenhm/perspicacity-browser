package org.perspicacity.browser;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Downloads files itself instead of using DownloadManager, because DownloadManager runs in
 * another process and would bypass Tor. Through Tor it uses the HTTP CONNECT tunnel port, so
 * DNS is resolved by the exit relay, and only HTTPS is accepted (plain HTTP would expose the
 * request to the exit relay and the tunnel does not carry it).
 */
final class Downloader {
    interface Callback { void done(boolean ok, String message); }

    private static final ExecutorService IO = Executors.newFixedThreadPool(2);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private Downloader() {}

    static void fetch(Context ctx, String url, String name, String mime, String userAgent, int torHttpPort, boolean viaTor, Callback cb) {
        final Context app = ctx.getApplicationContext();
        IO.execute(() -> {
            String msg;
            boolean ok = false;
            try {
                if (viaTor && !url.startsWith("https://")) throw new Exception("Only HTTPS downloads are possible through Tor.");
                if (viaTor && torHttpPort <= 0) throw new Exception("Tor is not connected yet.");
                Proxy proxy = viaTor ? new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", torHttpPort)) : Proxy.NO_PROXY;
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection(proxy);
                c.setConnectTimeout(60_000);
                c.setReadTimeout(120_000);
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("User-Agent", userAgent);
                c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
                int code = c.getResponseCode();
                if (code < 200 || code >= 300) throw new Exception("Server answered HTTP " + code);
                if (viaTor && !c.getURL().toString().startsWith("https://")) throw new Exception("Redirected to plain HTTP; refused.");
                String type = mime != null && !mime.isEmpty() ? mime : "application/octet-stream";
                try (InputStream in = c.getInputStream()) {
                    save(app, in, name, type);
                }
                ok = true;
                msg = "Downloaded " + name + " to Downloads.";
            } catch (Exception e) {
                msg = "Download failed: " + e.getMessage();
            }
            final boolean fOk = ok;
            final String fMsg = msg;
            MAIN.post(() -> cb.done(fOk, fMsg));
        });
    }

    private static void save(Context app, InputStream in, String name, String mime) throws Exception {
        byte[] buf = new byte[64 * 1024];
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver r = app.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("could not create the file");
            try (OutputStream out = r.openOutputStream(uri)) {
                if (out == null) throw new Exception("could not open the file");
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } catch (Exception e) {
                r.delete(uri, null, null);
                throw e;
            }
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            r.update(uri, v, null, null);
        } else {
            File dir = app.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) throw new Exception("no storage available");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("could not create the folder");
            try (OutputStream out = new FileOutputStream(new File(dir, name))) {
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
        }
    }
}
