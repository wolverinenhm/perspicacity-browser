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

import androidx.localbroadcastmanager.content.LocalBroadcastManager;

import org.torproject.jni.TorService;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Runs the Tor daemon bundled in the APK (tor-android) and reports its state.
 * Tor keeps its state in the app's private storage; it is never shared with other apps.
 */
final class TorController {
    interface Listener {
        void onTorState(String status, int progress, int socksPort, int httpTunnelPort);
    }

    private static final Pattern PROGRESS = Pattern.compile("PROGRESS=(\\d+)");

    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private TorService service;
    private boolean bound;
    private volatile String status = TorService.STATUS_OFF;
    private volatile int progress;

    TorController(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent intent) {
            String s = intent.getStringExtra(TorService.EXTRA_STATUS);
            if (s == null) return;
            if (TorService.STATUS_CLIENT_CIRCUIT_ESTABLISHED.equals(s)) s = TorService.STATUS_ON;
            status = s;
            if (TorService.STATUS_ON.equals(s)) progress = 100;
            publish();
        }
    };

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((TorService.LocalBinder) binder).getService();
            publish();
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            service = null;
            status = TorService.STATUS_OFF;
            publish();
        }
    };

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            final TorService s = service;
            if (s != null && !TorService.STATUS_ON.equals(status)) {
                io.execute(() -> {
                    try {
                        String phase = s.getInfo("status/bootstrap-phase");
                        if (phase != null) {
                            Matcher m = PROGRESS.matcher(phase);
                            if (m.find()) {
                                progress = Integer.parseInt(m.group(1));
                                main.post(TorController.this::publish);
                            }
                        }
                    } catch (Throwable ignored) {
                        // control port not up yet
                    }
                });
            }
            if (bound) main.postDelayed(this, 1000);
        }
    };

    void start() {
        if (bound) return;
        LocalBroadcastManager.getInstance(context).registerReceiver(receiver, new IntentFilter(TorService.ACTION_STATUS));
        status = TorService.STATUS_STARTING;
        progress = 0;
        bound = context.bindService(new Intent(context, TorService.class), connection, Context.BIND_AUTO_CREATE);
        publish();
        main.postDelayed(poll, 1000);
    }

    void stop() {
        if (!bound) return;
        bound = false;
        main.removeCallbacks(poll);
        try { LocalBroadcastManager.getInstance(context).unregisterReceiver(receiver); } catch (Exception ignored) { }
        try { context.unbindService(connection); } catch (Exception ignored) { }
        service = null;
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
        TorService s = service;
        int socks = -1;
        int http = -1;
        if (s != null && TorService.STATUS_ON.equals(status)) {
            try { socks = s.getSocksPort(); } catch (Throwable ignored) { }
            try { http = s.getHttpTunnelPort(); } catch (Throwable ignored) { }
        }
        listener.onTorState(status, progress, socks, http);
    }
}
