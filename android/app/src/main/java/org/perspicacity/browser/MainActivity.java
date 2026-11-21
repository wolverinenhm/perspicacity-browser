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
 * Perspicacity for Android: the VEIL plane of the specification on Android WebView.
 * Every tab has its own WebView profile (cookies, storage, cache) when the device's WebView
 * supports it; all traffic goes through the Tor daemon inside the app, fail-closed; the
 * canonical fingerprint shim runs at document start; trackers are blocked; nothing is kept
 * when the app closes or the user asks for a new identity.
 */
public class MainActivity extends Activity implements TorController.Listener {
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

    static final class Tab {
        WebView web;
        String profile;
        volatile String url = "";
        String title = "";
        int progress;
        final AtomicInteger blocked = new AtomicInteger();
        final Set<String> httpAllowed = Collections.synchronizedSet(new HashSet<>());
        String pendingUrl;
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

        docStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        profilesSupported = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE);
        proxySupported = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE);

        String major = chromeMajor();
        userAgent = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major + ".0.0.0 Mobile Safari/537.36";
        shimScript = buildShim(major);
        filter.addList(readAsset("filters/trackers.txt"));

        wipeLeftovers();
        wireUi();
        tor = new TorController(this, this);
        applyNetworkPolicy();
        if (routeTor()) tor.start();

        Tab first = newTab();
        Intent intent = getIntent();
        if (intent != null && intent.getData() != null) navigate(first, intent.getData().toString());
        updateUi();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && intent.getData() != null) navigate(newTab(), intent.getData().toString());
    }

    @Override
    protected void onDestroy() {
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
    private Tab newTab() {
        final Tab tab = new Tab();
        WebView w = new WebView(this);
        tab.web = w;
        CookieManager cookies = CookieManager.getInstance();
        if (profilesSupported) {
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
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setTextZoom(100);
        s.setSafeBrowsingEnabled(false); // ADR-007: no remote Safe Browsing lookups
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(w, false);

        if (docStartSupported && !shimScript.isEmpty()) {
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
        if (tabs.isEmpty()) { active = null; newTab(); return; }
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
        if (tab.profile != null) {
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
        for (Tab t : new ArrayList<>(tabs)) destroyTab(t);
        tabs.clear();
        active = null;
        wipeLeftovers();
        if (tor != null) tor.newIdentity();
        newTab();
        toast("New identity: tabs, cookies and storage discarded; Tor will use new circuits.");
    }

    // ---- navigation ------------------------------------------------------------
    private void navigate(Tab tab, String input) {
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
        findViewById(R.id.btn_new).setOnClickListener(v -> { newTab(); urlBar.requestFocus(); showKeyboard(); });
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
            items[i] = (t == active ? "● " : "   ") + label;
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
        m.getMenu().add(0, 6, 5, "About");
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
        String msg = "Perspicacity 0.1 for Android.\n\n"
                + "• Tor runs inside the app; nothing loads until it is connected.\n"
                + "• " + (profilesSupported ? "Each tab has its own cookie and storage profile." : "This WebView cannot separate tabs; storage is wiped on exit and New Identity.") + "\n"
                + "• Fingerprint shield: " + (docStartSupported ? "active at document start." : "best effort (older WebView).") + "\n"
                + "• " + filter.ruleCount() + " tracker rules.\n\n"
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
