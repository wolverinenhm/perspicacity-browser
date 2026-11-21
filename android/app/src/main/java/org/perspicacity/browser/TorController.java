package org.perspicacity.browser;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.localbroadcastmanager.content.LocalBroadcastManager;

import org.torproject.jni.TorService;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Runs the Tor daemon bundled in the APK (tor-android) and reports its state.
 * Tor keeps its state in the app's private storage; it is never shared with other apps.
 *
 * Readiness comes from Tor itself over the control connection (bootstrap progress and the
 * listener ports), not only from TorService's status broadcasts: those report ON only after a
 * CIRC BUILT event, and report STOPPING whenever TorService's control-port setup hits an
 * exception, even while the daemon keeps running. If the daemon really is gone, the service
 * is rebound with a growing back-off.
 */
final class TorController {
    interface Listener {
        void onTorState(String status, int progress, int socksPort, int httpTunnelPort);
    }

    private static final String TAG = "Perspicacity";
    private static final Pattern PROGRESS = Pattern.compile("PROGRESS=(\\d+)");
    private static final Pattern PORT = Pattern.compile(":(\\d+)\"?\\s*$");
    private static final long DEAD_AFTER_MS = 15_000;
    private static final int MAX_RESTARTS = 5;

    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile TorService service;
    private boolean bound;
    private boolean wanted;
    private int restarts;

    /** Last status TorService broadcast. */
    private volatile String serviceStatus = TorService.STATUS_OFF;
    /** What we report: ON only once Tor says it is bootstrapped and we know its SOCKS port. */
    private volatile String status = TorService.STATUS_OFF;
    private volatile int progress;
    private volatile int socksPort = -1;
    private volatile int httpPort = -1;
    private volatile long lastAliveAt;
    private String lastPublished = "";

    TorController(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent intent) {
            if (TorService.ACTION_ERROR.equals(intent.getAction())) {
                Log.w(TAG, "tor error: " + intent.getStringExtra(Intent.EXTRA_TEXT));
                return;
            }
            String s = intent.getStringExtra(TorService.EXTRA_STATUS);
            if (s == null) return;
            Log.i(TAG, "tor service status " + s);
            serviceStatus = s;
            recompute();
        }
    };

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((TorService.LocalBinder) binder).getService();
            lastAliveAt = System.currentTimeMillis();
            recompute();
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            service = null;
            serviceStatus = TorService.STATUS_OFF;
            recompute();
        }
    };

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            if (!bound) return;
            final TorService s = service;
            if (s != null) io.execute(() -> query(s));
            main.postDelayed(this, TorService.STATUS_ON.equals(status) ? 5000 : 1000);
        }
    };

    /** Runs on the io thread. */
    private void query(TorService s) {
        String phase = info(s, "status/bootstrap-phase");
        if (phase == null) {
            // Control connection not up yet, or the daemon is gone.
            if (System.currentTimeMillis() - lastAliveAt > DEAD_AFTER_MS
                    && (TorService.STATUS_STOPPING.equals(serviceStatus) || TorService.STATUS_OFF.equals(serviceStatus))) {
                main.post(this::restart);
            }
            return;
        }
        lastAliveAt = System.currentTimeMillis();
        Matcher m = PROGRESS.matcher(phase);
        if (m.find()) progress = Integer.parseInt(m.group(1));
        if (progress >= 100 && socksPort <= 0) {
            socksPort = port(info(s, "net/listeners/socks"));
            httpPort = port(info(s, "net/listeners/httptunnel"));
            if (socksPort <= 0) { try { socksPort = s.getSocksPort(); } catch (Throwable ignored) { } }
            if (httpPort <= 0) { try { httpPort = s.getHttpTunnelPort(); } catch (Throwable ignored) { } }
        }
        main.post(this::recompute);
    }

    private static String info(TorService s, String key) {
        try {
            if (s.getTorControlConnection() == null) return null;
            return s.getTorControlConnection().getInfo(key);
        } catch (Throwable e) {
            return null;
        }
    }

    /** First port in a GETINFO net/listeners/* answer such as "127.0.0.1:9050" (may be quoted). */
    static int port(String listeners) {
        if (listeners == null) return -1;
        for (String part : listeners.trim().split("\\s+")) {
            Matcher m = PORT.matcher(part);
            if (m.find()) return Integer.parseInt(m.group(1));
        }
        return -1;
    }

    private void recompute() {
        String next;
        boolean alive = System.currentTimeMillis() - lastAliveAt <= DEAD_AFTER_MS;
        if (progress >= 100 && socksPort > 0 && alive) next = TorService.STATUS_ON;
        else if (!bound) next = TorService.STATUS_OFF;
        else if (alive || TorService.STATUS_STARTING.equals(serviceStatus)) next = TorService.STATUS_STARTING;
        else next = serviceStatus;
        status = next;
        publish();
    }

    void start() {
        wanted = true;
        restarts = 0;
        bind();
    }

    private void bind() {
        if (bound) return;
        IntentFilter filter = new IntentFilter(TorService.ACTION_STATUS);
        filter.addAction(TorService.ACTION_ERROR);
        LocalBroadcastManager.getInstance(context).registerReceiver(receiver, filter);
        serviceStatus = TorService.STATUS_STARTING;
        progress = 0;
        socksPort = -1;
        httpPort = -1;
        lastAliveAt = System.currentTimeMillis();
        bound = context.bindService(new Intent(context, TorService.class), connection, Context.BIND_AUTO_CREATE);
        recompute();
        main.postDelayed(poll, 1000);
    }

    private void unbind() {
        if (!bound) return;
        bound = false;
        main.removeCallbacks(poll);
        try { LocalBroadcastManager.getInstance(context).unregisterReceiver(receiver); } catch (Exception ignored) { }
        try { context.unbindService(connection); } catch (Exception ignored) { }
        service = null;
        serviceStatus = TorService.STATUS_OFF;
        socksPort = -1;
        httpPort = -1;
    }

    private void restart() {
        if (!wanted || !bound) return;
        if (restarts >= MAX_RESTARTS) {
            Log.w(TAG, "tor stopped and did not come back after " + restarts + " restarts");
            unbind();
            serviceStatus = TorService.STATUS_OFF;
            recompute();
            return;
        }
        restarts++;
        long delay = 2000L * restarts;
        Log.w(TAG, "tor is not running; restarting in " + delay + " ms (attempt " + restarts + ")");
        unbind();
        recompute();
        main.postDelayed(() -> { if (wanted) bind(); }, delay);
    }

    void stop() {
        wanted = false;
        unbind();
        progress = 0;
        status = TorService.STATUS_OFF;
    }

    /** Ask Tor for fresh circuits for every new stream. */
    void newIdentity() {
        final TorService s = service;
        if (s == null) return;
        io.execute(() -> {
            try {
                if (s.getTorControlConnection() != null) s.getTorControlConnection().signal("NEWNYM");
            } catch (Throwable ignored) {
                // best effort
            }
        });
    }

    boolean isOn() { return TorService.STATUS_ON.equals(status); }

    private void publish() {
        boolean on = TorService.STATUS_ON.equals(status);
        int socks = on ? socksPort : -1;
        int http = on ? httpPort : -1;
        String key = status + "/" + progress + "/" + socks + "/" + http;
        if (key.equals(lastPublished)) return;
        lastPublished = key;
        listener.onTorState(status, progress, socks, http);
    }
}
