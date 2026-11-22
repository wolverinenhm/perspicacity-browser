package org.perspicacity.browser;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;
import org.perspicacity.core.agent.AgentRun;
import org.perspicacity.core.agent.Http;
import org.perspicacity.core.agent.Ledger;
import org.perspicacity.core.agent.Providers;

import java.io.File;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.CountDownLatch;

/**
 * Owns the agent on Android: the model settings, API keys (via SecretStore), the audit
 * ledger, and the one task that may run at a time. UI-facing state changes are reported to a
 * Listener on the main thread.
 */
final class AgentController {
    interface Listener {
        void onAgentChanged();
    }

    static final class Approval {
        final int id;
        final String description;
        final String action;
        final String site;
        boolean answer;
        final CountDownLatch done = new CountDownLatch(1);
        Approval(int id, String description, String action, String site) { this.id = id; this.description = description; this.action = action; this.site = site; }
    }

    private static final String PREFS = "agent";
    private final SharedPreferences prefs;
    private final SecretStore secrets;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final File ledgerFile;
    private Ledger ledger;
    private Listener listener;
    private final List<String> log = new ArrayList<>();
    private volatile AgentRun run;
    private volatile Approval pending;
    private int approvalSeq;
    Http http = new Http.UrlConnection();

    AgentController(Context context, SecretStore secrets) {
        Context app = context.getApplicationContext();
        this.prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.secrets = secrets;
        this.ledgerFile = new File(app.getFilesDir(), "audit-ledger.jsonl");
        try {
            ledger = new Ledger(ledgerFile, secrets.randomKey("ledgerKey"));
        } catch (Exception e) {
            Log.w("Perspicacity", "audit ledger unavailable: " + e.getMessage());
        }
    }

    void setListener(Listener l) { listener = l; }

    private void changed() { main.post(() -> { if (listener != null) listener.onAgentChanged(); }); }

    // ---- settings -----------------------------------------------------------------------------
    Providers.Config config() {
        Providers.Config c = new Providers.Config();
        String p = prefs.getString("provider", "ollama");
        c.provider = Providers.exists(p) ? p : "ollama";
        try {
            JSONObject models = new JSONObject(prefs.getString("models", "{}"));
            JSONObject endpoints = new JSONObject(prefs.getString("endpoints", "{}"));
            for (Iterator<String> it = models.keys(); it.hasNext(); ) { String k = it.next(); if (Providers.exists(k)) c.models.put(k, models.optString(k)); }
            for (Iterator<String> it = endpoints.keys(); it.hasNext(); ) { String k = it.next(); if (Providers.exists(k)) c.endpoints.put(k, Providers.cleanEndpoint(endpoints.optString(k))); }
        } catch (Exception ignored) { }
        return c;
    }

    void saveConfig(Providers.Config c) {
        try {
            JSONObject models = new JSONObject();
            JSONObject endpoints = new JSONObject();
            for (Providers.Provider p : Providers.all()) {
                String m = c.models.get(p.id);
                String e = Providers.cleanEndpoint(c.endpoints.get(p.id));
                if (m != null && !m.trim().isEmpty()) models.put(p.id, m.trim());
                if (!e.isEmpty()) endpoints.put(p.id, e);
            }
            prefs.edit()
                    .putString("provider", Providers.exists(c.provider) ? c.provider : "ollama")
                    .putString("models", models.toString())
                    .putString("endpoints", endpoints.toString())
                    .apply();
        } catch (Exception ignored) { }
        changed();
    }

    int maxSteps() { return Math.max(1, Math.min(40, prefs.getInt("maxSteps", 15))); }
    void setMaxSteps(int n) { prefs.edit().putInt("maxSteps", Math.max(1, Math.min(40, n))).apply(); }

    String apiKey(String provider) { return secrets.apiKey(provider); }
    boolean hasApiKey(String provider) { return secrets.hasApiKey(provider); }
    void setApiKey(String provider, String value) { secrets.setApiKey(provider, value == null ? null : value.trim()); }

    String label() {
        Providers.Config c = config();
        Providers.Provider p = Providers.get(c.provider);
        String model = c.model(c.provider);
        return p.shortName() + " · " + (model.isEmpty() ? "no model" : model) + (p.local ? " (local)" : " (remote)");
    }

    // ---- ledger -------------------------------------------------------------------------------
    void audit(String kind, String detail) {
        if (ledger == null) return;
        try { ledger.append(kind, detail); } catch (Exception e) { Log.w("Perspicacity", "audit: " + e.getMessage()); }
    }

    String ledgerReport() {
        if (ledger == null) return "The audit ledger could not be opened on this device.";
        StringBuilder b = new StringBuilder();
        try {
            Ledger.Verify v = ledger.verify();
            b.append(v.ok ? "Chain verified: " + v.count + " entries, no gaps or edits." : "Verification FAILED at entry " + v.at + ": " + v.reason + ".");
        } catch (Exception e) {
            b.append("Could not read the ledger: ").append(e.getMessage());
        }
        b.append("\n\nAgent approvals, refusals and actions in Shadow tabs. Each entry is HMAC-chained to the one before it.\n");
        List<String> tail = ledger.tail(30);
        for (int i = tail.size() - 1; i >= 0; i--) b.append('\n').append(tail.get(i));
        return b.toString();
    }

    // ---- runs ---------------------------------------------------------------------------------
    boolean running() { return run != null; }
    Approval pending() { return pending; }
    synchronized List<String> log() { return new ArrayList<>(log); }

    private synchronized void addLog(String kind, String text) {
        String prefix;
        switch (kind) {
            case "task": prefix = "▶ "; break;
            case "thought": prefix = "💭 "; break;
            case "approval": prefix = "? "; break;
            case "act": prefix = "✓ "; break;
            case "denied": case "reject": prefix = "✗ "; break;
            case "error": prefix = "⚠ "; break;
            case "done": prefix = "■ "; break;
            default: prefix = "· ";
        }
        log.add(prefix + text);
        while (log.size() > 120) log.remove(0);
        changed();
    }

    /** Starts a task; approver null means "ask in the panel". Returns an error message or null. */
    String start(WebViewDriver.TabAccess tab, String task, boolean autoClicks, AgentRun.Approver approver, long[] pacing) {
        if (run != null) return "An agent task is already running.";
        if (task == null || task.trim().isEmpty()) return "Describe a task first.";
        Providers.Config c = config();
        Providers.Provider p = Providers.get(c.provider);
        String key = secrets.apiKey(c.provider);
        if (p.needsKey && (key == null || key.isEmpty())) return "No " + p.name + " API key saved. Tap Model to add one.";
        Providers.Decider decider = Providers.decider(c, key, http);
        synchronized (this) { log.clear(); }
        AgentRun.Approver gate = approver != null ? approver : this::askUser;
        AgentRun r = new AgentRun(task.trim(), new WebViewDriver(tab), decider, gate, new AgentRun.Listener() {
            @Override public void log(String kind, String text) { addLog(kind, text); }
            @Override public void audit(String kind, String detail) { AgentController.this.audit(kind, detail); }
        }, maxSteps(), pacing, autoClicks);
        run = r;
        changed();
        Thread t = new Thread(() -> {
            try {
                AgentRun.Result res = r.run();
                Log.i("Perspicacity", "agent finished: " + res.status + " " + res.message);
            } finally {
                run = null;
                Approval a = pending;
                if (a != null) { a.answer = false; a.done.countDown(); pending = null; }
                changed();
            }
        }, "perspicacity-agent");
        t.start();
        return null;
    }

    void stop() {
        AgentRun r = run;
        if (r != null) r.stop();
        Approval a = pending;
        if (a != null) { a.answer = false; a.done.countDown(); }
    }

    private boolean askUser(String description, String action, String site) throws InterruptedException {
        Approval a;
        synchronized (this) { a = new Approval(++approvalSeq, description, action, site); }
        pending = a;
        changed();
        try {
            a.done.await();
            return a.answer;
        } finally {
            if (pending == a) pending = null;
            changed();
        }
    }

    void answer(int id, boolean ok) {
        Approval a = pending;
        if (a == null || a.id != id) return;
        a.answer = ok;
        a.done.countDown();
    }
}
