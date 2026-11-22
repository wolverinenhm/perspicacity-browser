package org.perspicacity.browser;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebViewDatabase;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.ProfileStore;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;
import org.perspicacity.core.FilenameSanitizer;
import org.perspicacity.core.FilterEngine;
import org.perspicacity.core.Site;
import org.torproject.jni.TorService;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Perspicacity for Android.
 *
 * VEIL tabs (the default): every tab has its own WebView profile (cookies, storage, cache)
 * when the device's WebView supports it; all traffic goes through the Tor daemon inside the
 * app, fail-closed; the canonical fingerprint shim runs at document start; trackers are
 * blocked; nothing is kept when the app closes or the user asks for a new identity.
 *
 * SHADOW tabs: one persistent profile shared by Shadow tabs only, never by VEIL, and the only
 * place the approval-gated agent can work (AgentController / WebViewDriver).
 */
public class MainActivity extends Activity implements TorController.Listener, AgentController.Listener {
    static final String SHADOW_PROFILE = "shadow";
    private static final String PREFS = "settings";
    private static final String DEAD_PROXY = "socks5://127.0.0.1:9"; // nothing listens: every load fails
    private static final Map<String, String> ENGINES = new HashMap<>();
    static {
        ENGINES.put("DuckDuckGo", "https://duckduckgo.com/?q=%s");
        ENGINES.put("DuckDuckGo (onion)", "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/?q=%s");
        ENGINES.put("Startpage", "https://www.startpage.com/do/search?q=%s");
        ENGINES.put("Brave Search", "https://search.brave.com/search?q=%s");
        ENGINES.put("Mojeek", "https://www.mojeek.com/search?q=%s");
    }

    static final class Tab implements WebViewDriver.TabAccess {
        boolean shadow;
        WebView web;
        String profile;
        volatile String url = "";
        String title = "";
        int progress;
        final AtomicInteger blocked = new AtomicInteger();
        final Set<String> httpAllowed = Collections.synchronizedSet(new HashSet<>());
        String pendingUrl;

        @Override public WebView web() { return web; }
        @Override public String url() { return url; }
        @Override public int progress() { return progress; }
    }

    private final List<Tab> tabs = new ArrayList<>();
    private Tab active;
    private final FilterEngine filter = new FilterEngine();
    private TorController tor;
    private SharedPreferences prefs;
    private String userAgent;
    private String shimScript = "";
    private boolean docStartSupported;
    private boolean profilesSupported;
    private boolean proxySupported;
    private volatile boolean networkReady;
    private String torStatus = TorService.STATUS_OFF;
    private int torProgress;
    private int torHttpPort = -1;
    private String appliedProxy;

    private FrameLayout content;
    private View home;
    private TextView homeStatus;
    private TextView homeFacts;
    private EditText urlBar;
    private TextView torPill;
    private ProgressBar progress;
    private TextView tabsBtn;
    private TextView agentBtn;
    private View agentPanel;
    private TextView agentLog;
    private EditText agentTask;
    private android.widget.Button agentRun;
    private AgentController agent;
    private boolean agentOpen;
    private final Executor mainExecutor = r -> runOnUiThread(r);

    // ------------------------------------------------------------------------
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // No screenshots, no thumbnail in the recent-apps switcher.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        setContentView(R.layout.activity_main);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        content = findViewById(R.id.content);
        home = findViewById(R.id.home);
        homeStatus = findViewById(R.id.home_status);
        homeFacts = findViewById(R.id.home_facts);
        urlBar = findViewById(R.id.url);
        torPill = findViewById(R.id.tor_status);
        progress = findViewById(R.id.progress);
        tabsBtn = findViewById(R.id.btn_tabs);
        agentBtn = findViewById(R.id.btn_agent);
        agentPanel = findViewById(R.id.agent_panel);
        agentLog = findViewById(R.id.agent_log);
        agentTask = findViewById(R.id.agent_task);
        agentRun = findViewById(R.id.agent_run);
        agent = new AgentController(this, new SecretStore(this));
        agent.setListener(this);

        docStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        profilesSupported = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE);
        proxySupported = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE);
        Log.i("Perspicacity", "webview features: profiles=" + profilesSupported + " proxy=" + proxySupported + " docStart=" + docStartSupported);

        String major = chromeMajor();
        userAgent = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major + ".0.0.0 Mobile Safari/537.36";
        shimScript = buildShim(major);
        filter.addList(readAsset("filters/trackers.txt"));

        wipeLeftovers();
        wireUi();
        tor = new TorController(this, this);
        applyNetworkPolicy();
        if (routeTor()) tor.start();

        Tab first = newTab(false);
        Intent intent = getIntent();
        if (intent != null && intent.getData() != null) navigate(first, intent.getData().toString());
        updateUi();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && intent.getData() != null) navigate(newTab(false), intent.getData().toString());
    }

    @Override
    protected void onDestroy() {
        if (agent != null) agent.stop();
        for (Tab t : new ArrayList<>(tabs)) destroyTab(t);
        tabs.clear();
        wipeLeftovers();
        if (tor != null) tor.stop();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (active != null && active.web.canGoBack()) active.web.goBack();
        else super.onBackPressed();
    }

    // ---- settings -------------------------------------------------------------
    private boolean routeTor() { return prefs.getBoolean("routeTor", true); }
    private boolean safest() { return prefs.getBoolean("safest", false); }
    private String engineName() {
        String e = prefs.getString("engine", "DuckDuckGo");
        return ENGINES.containsKey(e) ? e : "DuckDuckGo";
    }

    // ---- network policy (fail closed) ----------------------------------------
    private void applyNetworkPolicy() {
        if (!routeTor()) {
            networkReady = false;
            if (proxySupported) {
                ProxyController.getInstance().clearProxyOverride(mainExecutor, () -> { appliedProxy = null; onNetworkReady(); });
            } else {
                onNetworkReady();
            }
            return;
        }
        if (!proxySupported) {
            networkReady = false;
            updateUi();
            return;
        }
        String rule = DEAD_PROXY;
        int socks = lastSocksPort;
        if (TorService.STATUS_ON.equals(torStatus) && socks > 0) rule = "socks5://127.0.0.1:" + socks;
        if (rule.equals(appliedProxy)) return;
        networkReady = false;
        final String target = rule;
        try {
            setProxy(target);
        } catch (IllegalArgumentException e) {
            // Older WebView builds only accept HTTP proxies: use Tor's HTTP CONNECT tunnel (HTTPS only).
            if (!target.equals(DEAD_PROXY) && torHttpPort > 0) setProxy("http://127.0.0.1:" + torHttpPort);
            else setProxy("http://127.0.0.1:9");
        }
    }

    private void setProxy(final String rule) {
        ProxyConfig config = new ProxyConfig.Builder().addProxyRule(rule).build();
        ProxyController.getInstance().setProxyOverride(config, mainExecutor, () -> {
            appliedProxy = rule;
            if (!rule.endsWith(":9")) onNetworkReady();
            else updateUi();
        });
    }

    private void onNetworkReady() {
        networkReady = true;
        Log.i("Perspicacity", "network ready via " + (appliedProxy == null ? "direct" : appliedProxy));
        for (Tab t : tabs) {
            if (t.pendingUrl != null) {
                String u = t.pendingUrl;
                t.pendingUrl = null;
                navigate(t, u);
            }
        }
        updateUi();
    }

    private int lastSocksPort = -1;

    @Override
    public void onTorState(String status, int prog, int socksPort, int httpTunnelPort) {
        Log.i("Perspicacity", "tor status=" + status + " progress=" + prog + " socks=" + socksPort);
        runOnUiThread(() -> {
            torStatus = status;
            torProgress = prog;
            if (socksPort > 0) lastSocksPort = socksPort;
            if (httpTunnelPort > 0) torHttpPort = httpTunnelPort;
            if (!TorService.STATUS_ON.equals(status)) lastSocksPort = -1;
            if (routeTor()) applyNetworkPolicy();
            updateUi();
        });
    }

    // ---- tabs -------------------------------------------------------------------
    @SuppressLint("SetJavaScriptEnabled")
    Tab newTab(boolean shadow) {
        boolean debuggable = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (shadow && !profilesSupported && !debuggable) { // debug builds allow it so emulator tests run on older WebViews
            toast("Shadow tabs need a newer Android System WebView (multi-profile support), so their storage can be kept apart from VEIL. Update it from the Play Store.");
            return active;
        }
        final Tab tab = new Tab();
        tab.shadow = shadow;
        WebView w = new WebView(this);
        tab.web = w;
        CookieManager cookies = CookieManager.getInstance();
        if (shadow) {
            if (profilesSupported) {
                try {
                    tab.profile = SHADOW_PROFILE;
                    ProfileStore.getInstance().getOrCreateProfile(SHADOW_PROFILE);
                    WebViewCompat.setProfile(w, SHADOW_PROFILE);
                    cookies = ProfileStore.getInstance().getProfile(SHADOW_PROFILE).getCookieManager();
                } catch (Throwable t) {
                    tab.profile = null;
                    if (!debuggable) {
                        w.destroy();
                        toast("Could not open the Shadow profile: " + t.getMessage());
                        return active;
                    }
                }
            }
        } else if (profilesSupported) {
            try {
                tab.profile = "veil-" + UUID.randomUUID();
                ProfileStore.getInstance().getOrCreateProfile(tab.profile);
                WebViewCompat.setProfile(w, tab.profile);
                cookies = ProfileStore.getInstance().getProfile(tab.profile).getCookieManager();
            } catch (Throwable t) {
                tab.profile = null;
            }
        }
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(!safest());
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportMultipleWindows(false); // window.open and target=_blank stay in this tab
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setUserAgentString(userAgent);
        s.setCacheMode(shadow ? WebSettings.LOAD_DEFAULT : WebSettings.LOAD_NO_CACHE);
        if (shadow) s.setJavaScriptEnabled(true); // the agent needs scripts to read the page
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setTextZoom(100);
        s.setSafeBrowsingEnabled(false); // ADR-007: no remote Safe Browsing lookups
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(w, false);

        if (!shadow && docStartSupported && !shimScript.isEmpty()) {
            try {
                WebViewCompat.addDocumentStartJavaScript(w, shimScript, Collections.singleton("*"));
            } catch (Throwable ignored) {
                docStartSupported = false;
            }
        }

        w.setWebViewClient(new TabClient(tab));
        w.setWebChromeClient(new TabChrome(tab));
        w.setDownloadListener((url, ua, disposition, mime, length) -> confirmDownload(url, disposition, mime));
        w.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        tabs.add(tab);
        switchTo(tab);
        return tab;
    }

    private void switchTo(Tab tab) {
        if (active != null && active != tab) {
            active.web.onPause();
            content.removeView(active.web);
        }
        active = tab;
        if (tab.web.getParent() == null) content.addView(tab.web);
        tab.web.onResume();
        updateUi();
    }

    private void closeTab(Tab tab) {
        int idx = tabs.indexOf(tab);
        tabs.remove(tab);
        destroyTab(tab);
        if (tabs.isEmpty()) { active = null; newTab(false); return; }
        if (active == tab) { active = null; switchTo(tabs.get(Math.max(0, idx - 1))); }
        updateUi();
    }

    private void destroyTab(Tab tab) {
        content.removeView(tab.web);
        try {
            tab.web.stopLoading();
            tab.web.clearHistory();
            tab.web.clearCache(true);
            tab.web.clearFormData();
            tab.web.destroy();
        } catch (Throwable ignored) { }
        if (tab.profile != null && !tab.profile.equals(SHADOW_PROFILE)) {
            try { ProfileStore.getInstance().deleteProfile(tab.profile); } catch (Throwable ignored) {
                // still referenced; wipeLeftovers() removes it at next start
            }
        }
    }

    /** Remove every trace a previous session might have left (crash, forced stop). */
    private void wipeLeftovers() {
        try {
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
            WebStorage.getInstance().deleteAllData();
            WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword();
        } catch (Throwable ignored) { }
        if (profilesSupported) {
            try {
                ProfileStore store = ProfileStore.getInstance();
                for (String name : new ArrayList<>(store.getAllProfileNames())) {
                    if (name.startsWith("veil-") && (tabs.isEmpty() || !profileInUse(name))) {
                        try { store.deleteProfile(name); } catch (Throwable ignored) { }
                    }
                }
            } catch (Throwable ignored) { }
        }
    }

    private boolean profileInUse(String name) {
        for (Tab t : tabs) if (name.equals(t.profile)) return true;
        return false;
    }

    private void newIdentity() {
        for (Tab t : new ArrayList<>(tabs)) {
            if (t.shadow) continue; // Shadow is a separate, persistent identity
            tabs.remove(t);
            if (active == t) { content.removeView(t.web); active = null; }
            destroyTab(t);
        }
        wipeLeftovers();
        if (tor != null) tor.newIdentity();
        newTab(false);
        toast("New identity: VEIL tabs, cookies and storage discarded; Tor will use new circuits. Shadow tabs are kept.");
    }

    // ---- navigation ------------------------------------------------------------
    void navigate(Tab tab, String input) {
        String url = Site.omniboxToUrl(input, ENGINES.get(engineName()));
        if (url == null) { toast("Perspicacity only opens http and https addresses."); return; }
        String up = Site.httpsUpgrade(url);
        if (up != null && !tab.httpAllowed.contains(Site.hostOf(url))) url = up;
        if (!networkReady) {
            tab.pendingUrl = url;
            tab.url = url;
            updateUi();
            return;
        }
        tab.url = url;
        tab.web.loadUrl(url);
        updateUi();
    }

    private final class TabClient extends WebViewClient {
        private final Tab tab;
        TabClient(Tab tab) { this.tab = tab; }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (!Site.isNavigable(url)) {
                toast("Blocked a link that would open another app.");
                return true;
            }
            String up = Site.httpsUpgrade(url);
            if (up != null && !tab.httpAllowed.contains(Site.hostOf(url))) {
                view.loadUrl(up);
                return true;
            }
            if (!networkReady) {
                tab.pendingUrl = url;
                updateUi();
                return true;
            }
            return false;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (request.isForMainFrame()) return null;
            String rule = filter.match(request.getUrl().toString(), tab.url);
            if (rule == null) return null;
            tab.blocked.incrementAndGet();
            runOnUiThread(MainActivity.this::updateUi);
            InputStream empty = new ByteArrayInputStream(new byte[0]);
            return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", new HashMap<>(), empty);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            tab.url = url;
            tab.blocked.set(0);
            if (!docStartSupported && !shimScript.isEmpty()) view.evaluateJavascript(shimScript, null);
            updateUi();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            tab.url = url;
            updateUi();
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel(); // never offer to ignore a certificate error
            toast("Certificate error: the connection was refused.");
        }
    }

    private final class TabChrome extends WebChromeClient {
        private final Tab tab;
        TabChrome(Tab tab) { this.tab = tab; }

        @Override public void onProgressChanged(WebView view, int newProgress) { tab.progress = newProgress; if (tab == active) updateProgress(); }
        @Override public void onReceivedTitle(WebView view, String title) { tab.title = title; updateUi(); }
        @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
    }

    // ---- downloads ---------------------------------------------------------------
    private void confirmDownload(String url, String disposition, String mime) {
        FilenameSanitizer.Result r = FilenameSanitizer.sanitize(URLUtil.guessFileName(url, disposition, mime));
        String msg = "Save \"" + r.name + "\" to Downloads?";
        if (r.disguised) msg += "\n\nWARNING: this is an app or program disguised as a document.";
        else if (r.dangerous) msg += "\n\nThis file can install or run software.";
        final boolean viaTor = routeTor();
        if (viaTor) msg += "\n\nThe download goes through Tor and does not carry this site's cookies.";
        new AlertDialog.Builder(this)
                .setTitle("Download")
                .setMessage(msg)
                .setPositiveButton("Save", (d, w) -> {
                    toast("Downloading " + r.name + "…");
                    Downloader.fetch(this, url, r.name, mime, userAgent, torHttpPort, viaTor, (ok, m) -> toast(m));
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    // ---- UI ------------------------------------------------------------------------
    private void wireUi() {
        urlBar.setOnEditorActionListener((v, actionId, event) -> {
            boolean go = actionId == EditorInfo.IME_ACTION_GO || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN);
            if (!go) return false;
            String text = urlBar.getText().toString();
            hideKeyboard();
            urlBar.clearFocus();
            if (active != null && !text.trim().isEmpty()) navigate(active, text);
            return true;
        });
        findViewById(R.id.btn_back).setOnClickListener(v -> { if (active != null && active.web.canGoBack()) active.web.goBack(); });
        findViewById(R.id.btn_forward).setOnClickListener(v -> { if (active != null && active.web.canGoForward()) active.web.goForward(); });
        findViewById(R.id.btn_reload).setOnClickListener(v -> {
            if (active == null) return;
            if (active.progress > 0 && active.progress < 100) active.web.stopLoading();
            else if (active.pendingUrl != null || active.web.getUrl() == null) { if (!active.url.isEmpty()) navigate(active, active.url); }
            else active.web.reload();
        });
        findViewById(R.id.btn_new).setOnClickListener(v -> { newTab(false); urlBar.requestFocus(); showKeyboard(); });
        findViewById(R.id.btn_new).setOnLongClickListener(v -> { if (newTab(true) != null && active != null && active.shadow) { urlBar.requestFocus(); showKeyboard(); } return true; });
        agentBtn.setOnClickListener(v -> { agentOpen = !agentOpen; updateAgentUi(); });
        findViewById(R.id.agent_close).setOnClickListener(v -> { agentOpen = false; updateAgentUi(); });
        findViewById(R.id.agent_settings).setOnClickListener(v -> showAgentSettings());
        agentRun.setOnClickListener(v -> {
            if (agent.running()) { agent.stop(); return; }
            if (active == null || !active.shadow) { toast("The agent works only in Shadow tabs."); return; }
            if (active.url.isEmpty() || active.pendingUrl != null) { toast("Load a page in this Shadow tab first."); return; }
            hideKeyboard();
            String err = agent.start(active, agentTask.getText().toString(), ((android.widget.CheckBox) findViewById(R.id.agent_auto_clicks)).isChecked(), null, null);
            if (err != null) toast(err);
        });
        findViewById(R.id.agent_allow).setOnClickListener(v -> { AgentController.Approval a = agent.pending(); if (a != null) agent.answer(a.id, true); });
        findViewById(R.id.agent_deny).setOnClickListener(v -> { AgentController.Approval a = agent.pending(); if (a != null) agent.answer(a.id, false); });
        tabsBtn.setOnClickListener(v -> showTabs());
        findViewById(R.id.btn_identity).setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle("New identity")
                .setMessage("Close all tabs and discard their cookies, storage and history, and switch Tor circuits?")
                .setPositiveButton("New identity", (d, w) -> newIdentity())
                .setNegativeButton("Cancel", null).show());
        findViewById(R.id.btn_menu).setOnClickListener(this::showMenu);
        torPill.setOnClickListener(v -> toast(torDescription()));
    }

    private void showTabs() {
        final String[] items = new String[tabs.size()];
        for (int i = 0; i < tabs.size(); i++) {
            Tab t = tabs.get(i);
            String label = t.title != null && !t.title.isEmpty() ? t.title : (t.url.isEmpty() ? "New tab" : t.url);
            items[i] = (t == active ? "● " : "   ") + (t.shadow ? "[Shadow] " : "") + label;
        }
        new AlertDialog.Builder(this)
                .setTitle("Tabs (" + tabs.size() + ")")
                .setItems(items, (d, which) -> switchTo(tabs.get(which)))
                .setPositiveButton("Close current tab", (d, w) -> { if (active != null) closeTab(active); })
                .setNegativeButton("Back", null)
                .show();
    }

    private void showMenu(View anchor) {
        PopupMenu m = new PopupMenu(this, anchor);
        m.getMenu().add(0, 1, 0, "Search engine: " + engineName());
        m.getMenu().add(0, 2, 1, "Security level: " + (safest() ? "Safest (no JavaScript)" : "Standard"));
        m.getMenu().add(0, 3, 2, routeTor() ? "Route through Tor: on" : "Route through Tor: OFF");
        m.getMenu().add(0, 4, 3, "Load this site over plain HTTP");
        m.getMenu().add(0, 5, 4, "Clear everything and exit");
        m.getMenu().add(0, 7, 5, "New Shadow tab (for the agent)");
        m.getMenu().add(0, 8, 6, "Agent model");
        m.getMenu().add(0, 9, 7, "Audit ledger");
        m.getMenu().add(0, 6, 8, "About");
        m.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1: chooseEngine(); return true;
                case 2:
                    prefs.edit().putBoolean("safest", !safest()).apply();
                    toast(safest() ? "Safest: JavaScript is off in new tabs." : "Standard: JavaScript is on in new tabs.");
                    return true;
                case 3: toggleTor(); return true;
                case 4:
                    if (active != null && active.url.startsWith("https://")) {
                        String host = Site.hostOf(active.url);
                        active.httpAllowed.add(host);
                        String http = "http://" + active.url.substring("https://".length());
                        active.url = http;
                        if (networkReady) active.web.loadUrl(http); else active.pendingUrl = http;
                    }
                    return true;
                case 5: finishAndRemoveTask(); return true;
                case 6: showAbout(); return true;
                case 7: newTab(true); return true;
                case 8: showAgentSettings(); return true;
                case 9: new AlertDialog.Builder(this).setTitle("Audit ledger").setMessage(agent.ledgerReport()).setPositiveButton("OK", null).show(); return true;
                default: return false;
            }
        });
        m.show();
    }

    private void chooseEngine() {
        final String[] names = ENGINES.keySet().toArray(new String[0]);
        java.util.Arrays.sort(names);
        int current = java.util.Arrays.asList(names).indexOf(engineName());
        new AlertDialog.Builder(this).setTitle("Search engine")
                .setSingleChoiceItems(names, current, (d, which) -> { prefs.edit().putString("engine", names[which]).apply(); d.dismiss(); })
                .show();
    }

    private void toggleTor() {
        if (routeTor()) {
            new AlertDialog.Builder(this).setTitle("Turn off Tor?")
                    .setMessage("Websites and your network will see your real IP address. Storage stays per-tab and is still wiped, and the fingerprint shield stays on, but you will not be anonymous.")
                    .setPositiveButton("Turn off", (d, w) -> {
                        prefs.edit().putBoolean("routeTor", false).apply();
                        tor.stop();
                        applyNetworkPolicy();
                        updateUi();
                    })
                    .setNegativeButton("Keep Tor", null).show();
        } else {
            prefs.edit().putBoolean("routeTor", true).apply();
            appliedProxy = null;
            applyNetworkPolicy();
            tor.start();
            updateUi();
        }
    }

    private void showAbout() {
        String msg = "Perspicacity " + versionName() + " for Android.\n\n"
                + "• Tor runs inside the app; nothing loads until it is connected.\n"
                + "• " + (profilesSupported ? "Each tab has its own cookie and storage profile." : "This WebView cannot separate tabs; storage is wiped on exit and New Identity.") + "\n"
                + "• Fingerprint shield: " + (docStartSupported ? "active at document start." : "best effort (older WebView).") + "\n"
                + "• " + filter.ruleCount() + " tracker rules.\n"
                + "• Shadow tabs keep their own storage and are the only place the agent can work. Every effect it wants needs your OK, and each decision is written to an HMAC-chained audit ledger.\n\n"
                + "Android WebView is not Tor Browser: it shares one Tor circuit set across sites and announces itself as WebView in some request headers. Use Tor Browser when your safety depends on anonymity.";
        new AlertDialog.Builder(this).setTitle("About").setMessage(msg).setPositiveButton("OK", null).show();
    }

    private String torDescription() {
        if (!routeTor()) return "Tor is off: sites see your IP address.";
        if (!proxySupported) return "This device's WebView cannot route through Tor. Update Android System WebView.";
        if (TorService.STATUS_ON.equals(torStatus) && networkReady) return "Connected through Tor.";
        return "Connecting to Tor… " + torProgress + "%";
    }

    private void updateUi() {
        if (isFinishing()) return;
        // Tor pill
        if (!routeTor()) {
            torPill.setText("No Tor");
            torPill.setTextColor(getColor(R.color.bad));
        } else if (TorService.STATUS_ON.equals(torStatus) && networkReady) {
            torPill.setText("Tor ✓");
            torPill.setTextColor(getColor(R.color.ok));
        } else {
            torPill.setText(proxySupported ? "Tor " + torProgress + "%" : "No WebView proxy");
            torPill.setTextColor(getColor(R.color.amber));
        }
        tabsBtn.setText(String.valueOf(tabs.size()));
        if (active == null) return;
        urlBar.setHint(active.shadow ? "Shadow tab: search or enter address" : getString(R.string.url_hint));
        urlBar.setTextColor(getColor(active.shadow ? R.color.amber : R.color.fg));
        agentBtn.setVisibility(active.shadow ? View.VISIBLE : View.GONE);
        if (!active.shadow && agentOpen && !agent.running()) agentOpen = false;
        updateAgentUi();
        if (!urlBar.hasFocus()) urlBar.setText(active.url);
        boolean blank = active.url.isEmpty();
        boolean waiting = active.pendingUrl != null && !networkReady;
        home.setVisibility(blank || waiting ? View.VISIBLE : View.GONE);
        active.web.setVisibility(blank || waiting ? View.INVISIBLE : View.VISIBLE);
        if (waiting) {
            homeStatus.setText("Waiting for Tor (" + torProgress + "%). Your page opens as soon as the connection is ready.");
        } else if (!routeTor()) {
            homeStatus.setText("Tor is off. Storage is still wiped and the fingerprint shield is on, but sites see your IP address.");
        } else {
            homeStatus.setText(networkReady ? "Connected through Tor. Type an address or a search above." : "Connecting to Tor… " + torProgress + "%");
        }
        homeFacts.setText("• Tor runs inside the app; nothing loads until it is connected.\n"
                + "• " + (profilesSupported ? "Every tab has its own cookies and storage." : "Storage is wiped on exit and New Identity.") + "\n"
                + "• One fingerprint for everyone: UTC timezone, blank canvas readback, no WebGL or WebRTC.\n"
                + "• " + filter.ruleCount() + " tracker rules · " + active.blocked.get() + " blocked on this page.\n"
                + "• No screenshots, no backups, no history kept.");
        updateProgress();
    }

    private void updateProgress() {
        if (active == null) return;
        int p = active.progress;
        progress.setVisibility(p > 0 && p < 100 ? View.VISIBLE : View.INVISIBLE);
        progress.setProgress(p);
    }

    private void toast(String s) { runOnUiThread(() -> Toast.makeText(this, s, Toast.LENGTH_LONG).show()); }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(urlBar.getWindowToken(), 0);
    }

    private void showKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.showSoftInput(urlBar, InputMethodManager.SHOW_IMPLICIT);
    }

    // ---- agent --------------------------------------------------------------------------
    AgentController agent() { return agent; }

    @Override
    public void onAgentChanged() { updateAgentUi(); }

    private void updateAgentUi() {
        if (isFinishing() || agentPanel == null) return;
        boolean show = agentOpen || agent.running() || agent.pending() != null;
        agentPanel.setVisibility(show ? View.VISIBLE : View.GONE);
        if (!show) return;
        ((TextView) findViewById(R.id.agent_provider)).setText(agent.label());
        TextView hint = findViewById(R.id.agent_hint);
        if (active == null || !active.shadow) hint.setText("The agent works only in Shadow tabs, never in VEIL tabs.");
        else if (active.url.isEmpty()) hint.setText("Load a page in this Shadow tab, then describe what to do.");
        else hint.setText("The agent sees an outline of this page and asks before typing, opening pages or clicking.");
        StringBuilder b = new StringBuilder();
        for (String line : agent.log()) b.append(line).append('\n');
        agentLog.setText(b.length() == 0 ? "No task yet." : b.toString().trim());
        View scroll = findViewById(R.id.agent_log_scroll);
        scroll.post(() -> ((android.widget.ScrollView) scroll).fullScroll(View.FOCUS_DOWN));
        AgentController.Approval a = agent.pending();
        findViewById(R.id.agent_approval).setVisibility(a != null ? View.VISIBLE : View.GONE);
        if (a != null) ((TextView) findViewById(R.id.agent_approval_text)).setText(a.description);
        agentRun.setText(agent.running() ? R.string.stop : R.string.run);
        agentTask.setEnabled(!agent.running());
    }

    private void showAgentSettings() {
        final org.perspicacity.core.agent.Providers.Config cfg = agent.config();
        final List<org.perspicacity.core.agent.Providers.Provider> list = org.perspicacity.core.agent.Providers.all();
        final Map<String, String> typedKeys = new HashMap<>();
        final int pad = (int) (16 * getResources().getDisplayMetrics().density);

        android.widget.LinearLayout box = new android.widget.LinearLayout(this);
        box.setOrientation(android.widget.LinearLayout.VERTICAL);
        box.setPadding(pad, pad / 2, pad, 0);
        android.widget.Spinner spinner = new android.widget.Spinner(this);
        String[] names = new String[list.size()];
        int selected = 0;
        for (int i = 0; i < list.size(); i++) {
            org.perspicacity.core.agent.Providers.Provider p = list.get(i);
            names[i] = p.name + (agent.hasApiKey(p.id) ? " ✓" : "");
            if (p.id.equals(cfg.provider)) selected = i;
        }
        android.widget.ArrayAdapter<String> adapter = new android.widget.ArrayAdapter<>(this, android.R.layout.simple_spinner_item, names);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinner.setAdapter(adapter);
        TextView hint = new TextView(this);
        hint.setTextColor(getColor(R.color.muted));
        hint.setTextSize(12);
        TextView privacy = new TextView(this);
        privacy.setTextColor(getColor(R.color.muted));
        privacy.setTextSize(12);
        privacy.setText("A hosted model is a network party: it receives the outline of the Shadow page the agent is working on. VEIL tabs are never sent. Model requests go directly to the provider, not through Tor.");
        android.widget.AutoCompleteTextView model = new android.widget.AutoCompleteTextView(this);
        model.setSingleLine(true);
        model.setThreshold(0);
        model.setOnClickListener(v -> model.showDropDown());
        android.widget.Button listBtn = new android.widget.Button(this);
        listBtn.setText("List models");
        TextView status = new TextView(this);
        status.setTextColor(getColor(R.color.muted));
        status.setTextSize(12);
        EditText endpoint = new EditText(this);
        endpoint.setSingleLine(true);
        endpoint.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        EditText key = new EditText(this);
        key.setSingleLine(true);
        key.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        EditText steps = new EditText(this);
        steps.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        steps.setText(String.valueOf(agent.maxSteps()));
        TextView keyLabel = label("API key (stored encrypted in the Android Keystore; leave empty to keep, type a space to remove)");

        box.addView(label("Provider"));
        box.addView(spinner);
        box.addView(hint);
        box.addView(label("Model"));
        box.addView(model);
        box.addView(listBtn);
        box.addView(status);
        box.addView(label("Endpoint (empty = default shown)"));
        box.addView(endpoint);
        box.addView(keyLabel);
        box.addView(key);
        box.addView(label("Max agent steps"));
        box.addView(steps);
        box.addView(privacy);
        android.widget.ScrollView sv = new android.widget.ScrollView(this);
        sv.addView(box);

        final String[] current = {cfg.provider};
        final Runnable stash = () -> {
            cfg.models.put(current[0], model.getText().toString().trim());
            cfg.endpoints.put(current[0], endpoint.getText().toString().trim());
            String k = key.getText().toString();
            if (!k.isEmpty()) typedKeys.put(current[0], k);
        };
        final java.util.function.Consumer<String> load = id -> {
            org.perspicacity.core.agent.Providers.Provider p = org.perspicacity.core.agent.Providers.get(id);
            current[0] = id;
            hint.setText(p.hint);
            String m = cfg.models.get(id);
            model.setText(m == null ? "" : m);
            model.setHint(p.model.isEmpty() ? "model name" : p.model);
            model.setAdapter(null);
            String e = cfg.endpoints.get(id);
            endpoint.setText(e == null ? "" : e);
            endpoint.setHint(p.endpoint.isEmpty() ? (p.local ? "http://192.168.1.10:" + (p.id.equals("ollama") ? "11434" : "1234/v1") : "https://your-server/v1") : p.endpoint);
            boolean keyed = !"ollama".equals(p.kind);
            keyLabel.setVisibility(keyed ? View.VISIBLE : View.GONE);
            key.setVisibility(keyed ? View.VISIBLE : View.GONE);
            String typed = typedKeys.get(id);
            key.setText(typed == null ? "" : typed);
            key.setHint(agent.hasApiKey(id) ? "Saved" : (p.needsKey ? (p.keyHint.isEmpty() ? "Paste your API key" : p.keyHint) : "Optional"));
            status.setText("");
        };
        spinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) {
                String next = list.get(position).id;
                if (next.equals(current[0])) return;
                stash.run();
                load.accept(next);
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) { }
        });
        spinner.setSelection(selected);
        load.accept(cfg.provider);
        listBtn.setOnClickListener(v -> {
            stash.run();
            final String id = current[0];
            final String typed = typedKeys.get(id);
            final String k = typed != null && !typed.trim().isEmpty() ? typed.trim() : agent.apiKey(id);
            status.setText("Asking the provider…");
            listBtn.setEnabled(false);
            new Thread(() -> {
                String msg;
                List<String> models = null;
                try {
                    models = org.perspicacity.core.agent.Providers.listModels(id, cfg, k, agent.http);
                    msg = models.isEmpty() ? "The provider returned no models." : models.size() + " models available. Tap the Model box to pick one.";
                } catch (Exception ex) {
                    msg = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
                }
                final String m = msg;
                final List<String> found = models;
                runOnUiThread(() -> {
                    listBtn.setEnabled(true);
                    if (!id.equals(current[0])) return;
                    status.setText(m);
                    if (found != null && !found.isEmpty()) {
                        model.setAdapter(new android.widget.ArrayAdapter<>(this, android.R.layout.simple_dropdown_item_1line, found));
                        model.requestFocus();
                        model.showDropDown();
                    }
                });
            }, "perspicacity-models").start();
        });

        new AlertDialog.Builder(this)
                .setTitle("Agent model")
                .setView(sv)
                .setPositiveButton("Save", (d, w) -> {
                    stash.run();
                    cfg.provider = current[0];
                    for (Map.Entry<String, String> e : typedKeys.entrySet()) agent.setApiKey(e.getKey(), e.getValue().trim().isEmpty() ? null : e.getValue());
                    try { agent.setMaxSteps(Integer.parseInt(steps.getText().toString().trim())); } catch (NumberFormatException ignored) { }
                    agent.saveConfig(cfg);
                    toast("Agent model: " + agent.label());
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private TextView label(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(getColor(R.color.fg));
        t.setTextSize(13);
        t.setPadding(0, (int) (12 * getResources().getDisplayMetrics().density), 0, 0);
        return t;
    }

    private String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
    }

    // ---- fingerprint shim ----------------------------------------------------------
    private String chromeMajor() {
        try {
            PackageInfo p = WebViewCompat.getCurrentWebViewPackage(this);
            if (p != null && p.versionName != null) return p.versionName.split("\\.")[0];
        } catch (Throwable ignored) { }
        return "130";
    }

    private String buildShim(String major) {
        String src = readAsset("veil-shim.js");
        if (src.isEmpty()) return "";
        try {
            JSONObject brand1 = new JSONObject().put("brand", "Chromium").put("version", major).put("fullVersion", major + ".0.0.0");
            JSONObject brand2 = new JSONObject().put("brand", "Not.A/Brand").put("version", "99").put("fullVersion", "99.0.0.0");
            JSONObject ua = new JSONObject()
                    .put("brands", new JSONArray().put(brand1).put(brand2))
                    .put("mobile", true).put("platform", "Android").put("platformVersion", "10.0.0")
                    .put("architecture", "").put("bitness", "").put("model", "K").put("fullVersion", major + ".0.0.0");
            JSONObject cfg = new JSONObject()
                    .put("platform", "Linux armv8l")
                    .put("hardwareConcurrency", 8)
                    .put("deviceMemory", 4)
                    .put("maxTouchPoints", 5)
                    .put("languages", new JSONArray().put("en-US").put("en"))
                    .put("timerPrecisionMs", 100)
                    .put("devicePixelRatio", JSONObject.NULL)
                    .put("disableWebGL", true)
                    .put("blockCanvasReadback", true)
                    .put("utcTimezone", true)
                    .put("uaData", ua);
            return "(function(){" + src + "\nperspicacityVeilShim(" + cfg + ");})();";
        } catch (Exception e) {
            return "";
        }
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return "";
        }
    }
}
