'use strict';
// Window, tabs and the two planes (PSC-ARCH-001 §3, D1).
//
//  VEIL   – every tab is its own in-memory session (nothing is written to disk), its own
//           SOCKS gateway (per-tab + per-site Tor circuits), the canonical fingerprint and
//           a letterboxed viewport. Closing the tab, or New Identity, destroys it all.
//  SHADOW – one persistent session for agent work, on its own circuits (or direct, if the
//           user chooses). The agent can only drive SHADOW tabs.

const crypto = require('crypto');
const path = require('path');
const { BaseWindow, WebContentsView, session, ipcMain, Menu, clipboard, dialog, app } = require('electron');

const { IsolatingSocksGateway } = require('./gateway');
const { siteOfUrl, httpsUpgrade, isNavigableUrl, omniboxToUrl, isOnion, isLoopback } = require('./site');
const { sanitizeFilename } = require('./sanitize');
const { canonicalProfile, shimSource, HIGH_ENTROPY_HINT_HEADERS } = require('./fingerprint');
const { ISOLATED_WORLD_ID, SNAPSHOT_SCRIPT, locateScript, focusScript } = require('./snapshot');
const { AgentRun } = require('./agent');
const providers = require('./providers');
const { SEARCH_ENGINES } = require('./settings');

const CHROME_HEIGHT = 84;
const AGENT_PANEL_WIDTH = 380;
const PROFILE = canonicalProfile();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForLoad(wc, timeoutMs = 15000) {
  if (wc.isDestroyed() || !wc.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, timeoutMs);
    function done() { clearTimeout(t); wc.off('did-stop-loading', done); resolve(); }
    wc.on('did-stop-loading', done);
  });
}

class Browser {
  constructor({ paths, settings, tor, filter, ledger, selftest = false }) {
    this.paths = paths; // { ui, preloads, shim }
    this.settings = settings;
    this.tor = tor;
    this.filter = filter;
    this.ledger = ledger;
    this.selftest = selftest;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.nextId = 1;
    this.overlay = false;
    this.agent = { open: false, run: null, log: [], pending: null, autoClicks: false };
    this.approvalSeq = 0;
    this.downloads = [];
    this.sessionInfo = new WeakMap(); // session -> { plane, httpAllowed:Set }
    this.shadowNonce = crypto.randomBytes(16).toString('hex');
    this.statePending = false;
  }

  // ---------------------------------------------------------------------------
  async init() {
    this.win = new BaseWindow({
      width: 1280, height: 860, minWidth: 720, minHeight: 480, title: 'Perspicacity',
      backgroundColor: '#14121c', show: true,
      autoHideMenuBar: true,
    });
    this.chrome = new WebContentsView({
      webPreferences: {
        preload: path.join(this.paths.preloads, 'ui-preload.js'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, webgl: false,
      },
    });
    this.win.contentView.addChildView(this.chrome);
    const cwc = this.chrome.webContents;
    cwc.on('will-navigate', (e) => e.preventDefault());
    cwc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // The UI is local files only: refuse every network request from it.
    cwc.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|devtools|chrome-extension):/.test(d.url) }));

    this.win.on('resize', () => this.layout());
    this.win.on('closed', () => { this.closed = true; });

    await this.setupShadowSession();
    this.registerIpc();
    this.buildMenu();
    this.tor.on('state', () => this.onTorState());

    await cwc.loadFile(path.join(this.paths.ui, 'index.html'));
    this.layout();
    this.pushState();
  }

  // ---- sessions ----------------------------------------------------------------
  proxyConfigFor(plane, gatewayPort) {
    const s = this.settings.get();
    const direct = plane === 'veil' ? s.veilAllowClearnet : s.shadowRouting === 'direct';
    if (direct) return { mode: 'direct' };
    // '<-loopback>' removes Chromium's implicit loopback bypass: pages must not reach
    // services on this machine (PSC-NET-002 §7.4); Tor refuses such destinations.
    return { mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${gatewayPort}`, proxyBypassRules: '<-loopback>' };
  }

  async hardenSession(ses, plane) {
    const info = { plane, httpAllowed: new Set() };
    this.sessionInfo.set(ses, info);
    // Spellcheck dictionaries are fetched from a Google CDN: a network side channel. Off.
    ses.setSpellCheckerEnabled(false);
    try { ses.setSpellCheckerLanguages([]); } catch (_) { /* not on macOS */ }
    try { ses.setSpellCheckerDictionaryDownloadURL('https://dictionaries.invalid/'); } catch (_) { /* ignore */ }
    if (plane === 'veil') ses.setUserAgent(PROFILE.userAgent, PROFILE.acceptLanguage);
    ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'fullscreen'));
    ses.setPermissionCheckHandler((wc, permission) => permission === 'fullscreen');
    ses.setDevicePermissionHandler(() => false);
    if (ses.setDisplayMediaRequestHandler) ses.setDisplayMediaRequestHandler((req, cb) => cb({}));
    if (ses.setBluetoothPairingHandler) ses.setBluetoothPairingHandler((d, cb) => cb({ confirmed: false }));
    if (ses.setCertificateVerifyProc) {
      // Chromium's own verification stands; we only refuse to offer an override UI.
      ses.setCertificateVerifyProc((req, cb) => cb(-3));
    }

    ses.webRequest.onBeforeRequest((details, cb) => {
      const tab = details.webContents ? this.tabByWc(details.webContents) : null;
      if (details.resourceType !== 'mainFrame') {
        const top = tab ? (tab.url || tab.pendingUrl) : null;
        const verdict = this.filter.match(details.url, top);
        if (verdict.blocked) {
          if (tab) { tab.blockedCount++; this.pushState(); }
          cb({ cancel: true });
          return;
        }
      }
      if (details.url.startsWith('http:')) {
        let host = '';
        try { host = new URL(details.url).hostname; } catch (_) { /* ignore */ }
        if (!info.httpAllowed.has(host)) {
          const up = httpsUpgrade(details.url);
          if (up) { cb({ redirectURL: up }); return; }
        }
      }
      cb({});
    });

    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      if (plane === 'veil') {
        for (const k of Object.keys(h)) {
          if (HIGH_ENTROPY_HINT_HEADERS.includes(k.toLowerCase())) delete h[k];
        }
        h['Accept-Language'] = PROFILE.acceptLanguage;
      }
      delete h['X-Client-Data'];
      cb({ requestHeaders: h });
    });

    ses.on('will-download', (event, item, wc) => this.onDownload(item, wc, plane));
  }

  async setupShadowSession() {
    this.shadowSes = session.fromPartition('persist:shadow');
    await this.hardenSession(this.shadowSes, 'shadow');
    this.shadowGateway = new IsolatingSocksGateway({
      upstream: () => this.tor.upstream(),
      keyFor: () => `shadow-${this.shadowNonce}`,
    });
    await this.shadowGateway.listen();
    await this.shadowSes.setProxy(this.proxyConfigFor('shadow', this.shadowGateway.port));
  }

  async applyProxies() {
    await this.shadowSes.setProxy(this.proxyConfigFor('shadow', this.shadowGateway.port));
    for (const tab of this.tabs.values()) {
      if (tab.plane === 'veil') await tab.ses.setProxy(this.proxyConfigFor('veil', tab.gateway.port));
    }
  }

  // ---- tabs --------------------------------------------------------------------
  tabByWc(wc) {
    for (const t of this.tabs.values()) if (t.wc === wc || (!t.wc.isDestroyed() && t.wc.id === wc.id)) return t;
    return null;
  }

  veilNetworkReady() {
    return this.settings.get().veilAllowClearnet || this.tor.state.phase === 'ready';
  }

  shadowNetworkReady() {
    return this.settings.get().shadowRouting === 'direct' || this.tor.state.phase === 'ready';
  }

  async createTab({ plane = 'veil', url = null, activate = true } = {}) {
    const id = this.nextId++;
    const tab = {
      id, plane, url: '', pendingUrl: null, title: plane === 'veil' ? 'New VEIL tab' : 'New Shadow tab',
      loading: false, blocked: null, error: null, canBack: false, canFwd: false, blockedCount: 0,
      firstParty: '', nonce: crypto.randomBytes(16).toString('hex'), crashed: false,
    };
    const s = this.settings.get();
    if (plane === 'veil') {
      tab.ses = session.fromPartition(`veil-${crypto.randomUUID()}`); // no "persist:" => RAM only
      await this.hardenSession(tab.ses, 'veil');
      tab.gateway = new IsolatingSocksGateway({
        upstream: () => this.tor.upstream(),
        // Per-tab nonce + first-party site: no two sites, and no two tabs, share a circuit.
        keyFor: () => crypto.createHash('sha256').update(`${tab.nonce}|${tab.firstParty || 'blank'}`).digest('hex').slice(0, 32),
      });
      await tab.gateway.listen();
      await tab.ses.setProxy(this.proxyConfigFor('veil', tab.gateway.port));
    } else {
      tab.ses = this.shadowSes;
    }

    tab.view = new WebContentsView({
      webPreferences: {
        session: tab.ses,
        preload: plane === 'veil' ? path.join(this.paths.preloads, 'veil-preload.js') : undefined,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: plane === 'veil', // run the shim in every frame
        webgl: plane !== 'veil',
        javascript: !(plane === 'veil' && s.securityLevel === 'safest'),
        spellcheck: false,
        enableWebSQL: false,
        navigateOnDragDrop: false,
        autoplayPolicy: 'document-user-activation-required',
        safeDialogs: true,
        backgroundThrottling: true,
      },
    });
    tab.view.setBackgroundColor('#ffffff');
    tab.wc = tab.view.webContents;
    this.wireTab(tab);
    if (plane === 'veil') {
      // CDP commands need a live renderer: start one on about:blank (no network), then emulate.
      await tab.wc.loadURL('about:blank').catch(() => {});
      await this.applyCanonicalEmulation(tab.wc);
    }

    this.tabs.set(id, tab);
    this.order.push(id);
    this.win.contentView.addChildView(tab.view);
    if (activate || this.activeId === null) this.activate(id); else tab.view.setVisible(false);
    if (url) this.navigate(id, url);
    this.pushState();
    return tab;
  }

  async applyCanonicalEmulation(wc) {
    // Timezone, locale and UA client hints have no session-level API, so the browser applies
    // them to its own tab through the in-process debugger. Nothing is exposed to pages or
    // to the agent, and no remote-debugging port exists (ADR-003).
    try { wc.debugger.attach('1.3'); } catch (_) { return; }
    const send = async (m, p) => {
      try {
        await Promise.race([wc.debugger.sendCommand(m, p), sleep(3000).then(() => { throw new Error('timeout'); })]);
      } catch (e) { if (process.env.PERSPICACITY_DEBUG) console.log('cdp', m, e.message); }
    };
    await send('Emulation.setTimezoneOverride', { timezoneId: PROFILE.timezone });
    await send('Emulation.setLocaleOverride', { locale: PROFILE.locale });
    await send('Emulation.setUserAgentOverride', {
      userAgent: PROFILE.userAgent, acceptLanguage: PROFILE.acceptLanguage, platform: 'Win32',
      userAgentMetadata: PROFILE.cdpMetadata,
    });
  }

  wireTab(tab) {
    const wc = tab.wc;
    wc.setWindowOpenHandler(({ url }) => {
      if (isNavigableUrl(url) && url !== 'about:blank') this.createTab({ plane: tab.plane, url, activate: true });
      return { action: 'deny' };
    });
    const guard = (e, url) => { if (!isNavigableUrl(url)) e.preventDefault(); };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) {
        tab.firstParty = siteOfUrl(d.url);
        tab.pendingUrl = d.url;
        tab.error = null;
        tab.blockedCount = 0;
      }
    });
    const nav = () => {
      tab.url = wc.getURL();
      tab.canBack = wc.navigationHistory.canGoBack();
      tab.canFwd = wc.navigationHistory.canGoForward();
      tab.firstParty = siteOfUrl(tab.url) || tab.firstParty;
      this.pushState();
    };
    wc.on('did-navigate', nav);
    wc.on('did-navigate-in-page', nav);
    wc.on('page-title-updated', (e, title) => { tab.title = title || tab.url; this.pushState(); });
    wc.on('did-start-loading', () => { tab.loading = true; this.pushState(); });
    wc.on('did-stop-loading', () => { tab.loading = false; nav(); });
    wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: aborted (e.g. replaced by another load)
      let host = '';
      try { host = new URL(url).hostname; } catch (_) { /* ignore */ }
      tab.error = { code, desc, url, canHttp: url.startsWith('https:') && !isOnion(host) && !isLoopback(host) };
      tab.loading = false;
      this.pushState();
    });
    wc.on('render-process-gone', (e, d) => { tab.crashed = true; tab.error = { code: 0, desc: `Page crashed (${d.reason})`, url: tab.url }; this.pushState(); });
    wc.on('context-menu', (e, p) => this.contextMenu(tab, p));
    wc.on('before-input-event', (e, input) => this.handleShortcut(e, input));
  }

  contextMenu(tab, p) {
    const items = [];
    if (p.linkURL && isNavigableUrl(p.linkURL)) {
      items.push({ label: tab.plane === 'veil' ? 'Open link in new VEIL tab' : 'Open link in new Shadow tab', click: () => this.createTab({ plane: tab.plane, url: p.linkURL }) });
      items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    } else if (p.selectionText) {
      items.push({ role: 'copy' });
    }
    if (items.length) items.push({ type: 'separator' });
    items.push(
      { label: 'Back', enabled: tab.wc.navigationHistory.canGoBack(), click: () => tab.wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: tab.wc.navigationHistory.canGoForward(), click: () => tab.wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => tab.wc.reload() },
    );
    if (tab.plane === 'shadow') items.push({ type: 'separator' }, { label: 'Inspect element', click: () => tab.wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup();
  }

  handleShortcut(e, input) {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    let handled = true;
    if (mod && input.shift && key === 'u') this.newIdentity();
    else if (mod && input.shift && key === 's') this.createTab({ plane: 'shadow' });
    else if (mod && key === 't') this.createTab({ plane: 'veil' });
    else if (mod && key === 'w') { if (this.activeId) this.closeTab(this.activeId); }
    else if (mod && key === 'l') this.chrome.webContents.send('ui:focus-url');
    else if ((mod && key === 'r') || input.key === 'F5') { const t = this.active(); if (t) t.wc.reload(); }
    else if (input.alt && input.key === 'ArrowLeft') { const t = this.active(); if (t && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack(); }
    else if (input.alt && input.key === 'ArrowRight') { const t = this.active(); if (t && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward(); }
    else if (mod && input.key === 'Tab') this.cycle(input.shift ? -1 : 1);
    else handled = false;
    if (handled) e.preventDefault();
  }

  cycle(dir) {
    if (!this.order.length) return;
    const i = this.order.indexOf(this.activeId);
    this.activate(this.order[(i + dir + this.order.length) % this.order.length]);
  }

  active() { return this.tabs.get(this.activeId) || null; }

  activate(id) {
    if (!this.tabs.has(id)) return;
    this.activeId = id;
    this.layout();
    this.pushState();
  }

  navigate(id, input) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const url = omniboxToUrl(input, SEARCH_ENGINES[this.settings.get().searchEngine].template);
    if (!url) { tab.error = { code: 0, desc: 'Perspicacity only opens http and https addresses.', url: String(input).slice(0, 200) }; this.pushState(); return; }
    tab.error = null;
    const ready = tab.plane === 'veil' ? this.veilNetworkReady() : this.shadowNetworkReady();
    if (!ready) {
      // Fail closed: keep the request, load it once Tor is up.
      tab.pendingUrl = url;
      tab.blocked = 'tor';
      tab.title = 'Waiting for Tor';
      this.layout();
      this.pushState();
      return;
    }
    tab.blocked = null;
    tab.pendingUrl = url;
    tab.firstParty = siteOfUrl(url);
    tab.wc.loadURL(url).catch(() => { /* reported via did-fail-load */ });
    this.layout();
    this.pushState();
  }

  async closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.agent.run && this.agent.tabId === id) this.agent.run.stop();
    this.tabs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    try { this.win.contentView.removeChildView(tab.view); } catch (_) { /* window gone */ }
    if (!tab.wc.isDestroyed()) tab.wc.close();
    if (tab.plane === 'veil') await this.destroyVeilState(tab);
    if (this.activeId === id) this.activeId = this.order.length ? this.order[this.order.length - 1] : null;
    if (this.activeId === null && !this.closed && !this.quitting) await this.createTab({ plane: 'veil' });
    this.layout();
    this.pushState();
  }

  async destroyVeilState(tab) {
    try { await tab.gateway.close(); } catch (_) { /* ignore */ }
    try {
      await tab.ses.closeAllConnections();
      await tab.ses.clearStorageData();
      await tab.ses.clearCache();
      await tab.ses.clearAuthCache();
      await tab.ses.clearHostResolverCache();
    } catch (_) { /* ignore */ }
  }

  /** New Identity (PSC-UTL-005 §3): all VEIL tabs and their state are destroyed. */
  async newIdentity() {
    const veil = [...this.tabs.values()].filter((t) => t.plane === 'veil');
    for (const t of veil) {
      this.tabs.delete(t.id);
      this.order = this.order.filter((x) => x !== t.id);
      try { this.win.contentView.removeChildView(t.view); } catch (_) { /* ignore */ }
      if (!t.wc.isDestroyed()) t.wc.close();
      await this.destroyVeilState(t);
    }
    this.audit('veil.new-identity', { tabs: veil.length });
    this.activeId = this.order.length ? this.order[this.order.length - 1] : null;
    await this.createTab({ plane: 'veil' });
    this.chrome.webContents.send('ui:toast', 'New identity: all VEIL tabs, cookies and circuits were discarded.');
  }

  onTorState() {
    for (const t of this.tabs.values()) {
      const ready = t.plane === 'veil' ? this.veilNetworkReady() : this.shadowNetworkReady();
      if (t.blocked === 'tor' && ready && t.pendingUrl) this.navigate(t.id, t.pendingUrl);
    }
    this.pushState();
  }

  // ---- layout ------------------------------------------------------------------
  layout() {
    if (!this.win || this.closed) return;
    const { width, height } = this.win.getContentBounds();
    this.chrome.setBounds({ x: 0, y: 0, width, height });
    const panel = this.agent.open ? AGENT_PANEL_WIDTH : 0;
    const area = { x: 0, y: CHROME_HEIGHT, width: Math.max(0, width - panel), height: Math.max(0, height - CHROME_HEIGHT) };
    for (const tab of this.tabs.values()) {
      const showPage = tab.id === this.activeId && !this.overlay && tab.blocked === null && !tab.error && (tab.url || tab.pendingUrl);
      tab.view.setVisible(Boolean(showPage));
      if (tab.id !== this.activeId) continue;
      let b = area;
      if (tab.plane === 'veil') {
        // Letterboxing (PSC-FP-003 §5.3): the viewport is rounded down to a 200x100 grid so
        // window size stops being an identifier.
        const w = area.width >= 400 ? Math.floor(area.width / 200) * 200 : area.width;
        const h = area.height >= 300 ? Math.floor(area.height / 100) * 100 : area.height;
        b = { x: area.x + Math.floor((area.width - w) / 2), y: area.y + Math.floor((area.height - h) / 2), width: w, height: h };
      }
      tab.view.setBounds(b);
    }
  }

  // ---- downloads ---------------------------------------------------------------
  onDownload(item, wc, plane) {
    const s = sanitizeFilename(item.getFilename());
    const warn = s.disguised ? ' (WARNING: disguised executable)' : s.dangerous ? ' (warning: this file can run programs)' : '';
    item.setSaveDialogOptions({
      title: `Save download${warn}`,
      defaultPath: path.join(app.getPath('downloads'), s.name),
      buttonLabel: 'Save',
    });
    const rec = { id: this.downloads.length + 1, name: s.name, plane, state: 'progressing', received: 0, total: item.getTotalBytes(), dangerous: s.dangerous };
    this.downloads.push(rec);
    item.on('updated', (e, state) => { rec.state = state; rec.received = item.getReceivedBytes(); this.pushState(); });
    item.once('done', (e, state) => {
      rec.state = state;
      rec.received = item.getReceivedBytes();
      rec.path = state === 'completed' ? path.basename(item.getSavePath()) : null;
      this.chrome.webContents.send('ui:toast', state === 'completed' ? `Downloaded ${rec.path}. Perspicacity never opens downloads for you.` : `Download ${state}: ${s.name}`);
      this.pushState();
    });
  }

  // ---- agent -------------------------------------------------------------------
  audit(kind, data) {
    try { if (this.ledger) this.ledger.append(kind, data); } catch (e) { this.agentLog({ kind: 'error', text: `Audit ledger: ${e.message}`, ts: Date.now() }); }
  }

  agentLog(entry) {
    this.agent.log.push(entry);
    if (this.agent.log.length > 200) this.agent.log.shift();
    this.pushState();
  }

  driverFor(tab) {
    const wc = tab.wc;
    const iso = (code) => wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }]);
    const alive = () => { if (wc.isDestroyed() || !this.tabs.has(tab.id)) throw new Error('the Shadow tab was closed'); };
    return {
      currentUrl: () => (wc.isDestroyed() ? '' : wc.getURL()),
      snapshot: async () => {
        alive();
        await waitForLoad(wc);
        return iso(SNAPSHOT_SCRIPT);
      },
      perform: async (act, gen) => {
        alive();
        // Real input events only reach a visible view: bring the agent's tab to the front.
        if (['click', 'type', 'select'].includes(act.action) && this.activeId !== tab.id) {
          this.activate(tab.id);
          await sleep(150);
        }
        const zoom = wc.getZoomFactor();
        switch (act.action) {
          case 'click': {
            let loc = await iso(locateScript(gen, act.id));
            if (loc.error) return `could not click ${act.id}: element is ${loc.error}`;
            await sleep(120);
            loc = await iso(locateScript(gen, act.id));
            if (loc.error) return `could not click ${act.id}: element is ${loc.error}`;
            if (!wc.isFocused()) wc.focus();
            const x = Math.round(loc.x * zoom);
            const y = Math.round(loc.y * zoom);
            wc.sendInputEvent({ type: 'mouseMove', x, y });
            await sleep(60 + Math.random() * 90);
            wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            await sleep(50 + Math.random() * 60);
            wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
            await sleep(700);
            await waitForLoad(wc);
            return `clicked ${act.target}`;
          }
          case 'type': {
            const f = await iso(focusScript(gen, act.id));
            if (f.error) return `could not type into ${act.id}: element is ${f.error}`;
            for (const chunk of act.text.match(/.{1,6}/gs) || []) {
              wc.insertText(chunk);
              await sleep(40 + Math.random() * 80);
            }
            if (act.submit) {
              wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
              wc.sendInputEvent({ type: 'char', keyCode: '\r' });
              wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
              await sleep(700);
              await waitForLoad(wc);
            }
            return `typed into ${act.target}${act.submit ? ' and pressed Enter' : ''}`;
          }
          case 'select': {
            const r = await iso(`(() => {
              const st = globalThis.__pspSnap; if (!st || st.gen !== ${Number(gen)}) return 'stale';
              const el = st.els.get(${JSON.stringify(act.id)}); if (!el || el.tagName !== 'SELECT') return 'not a list';
              const want = ${JSON.stringify(act.text)}.trim().toLowerCase();
              const opt = Array.from(el.options).find((o) => o.text.trim().toLowerCase() === want) ||
                Array.from(el.options).find((o) => o.text.trim().toLowerCase().includes(want));
              if (!opt) return 'no such option';
              el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'ok';
            })()`);
            return r === 'ok' ? `selected "${act.text}"` : `could not select: ${r}`;
          }
          case 'navigate':
            await wc.loadURL(act.url).catch(() => {});
            await waitForLoad(wc);
            return `opened ${siteOfUrl(act.url)}`;
          case 'scroll':
            await iso(`window.scrollBy({ top: ${act.direction === 'up' ? -1 : 1} * Math.round(innerHeight * 0.8), behavior: 'instant' }); true`);
            return `scrolled ${act.direction}`;
          case 'wait':
            await sleep(1500);
            return 'waited';
          default:
            return 'nothing done';
        }
      },
    };
  }

  modelFor() {
    const cfg = this.settings.get().agent;
    const p = providers.PROVIDERS[cfg.provider];
    const key = this.settings.readApiKey(cfg.provider);
    if (p.needsKey && !key) throw new Error(`No ${p.name} API key saved. Add one in Settings, or use a local model.`);
    return providers.makeDecider(cfg, key);
  }

  requestApproval(req) {
    return new Promise((resolve) => {
      const id = ++this.approvalSeq;
      this.agent.pending = { id, ...req, resolve };
      if (!this.win.isFocused()) this.win.flashFrame(true);
      this.pushState();
    });
  }

  resolveApproval(id, ok) {
    const p = this.agent.pending;
    if (!p || p.id !== id) return;
    this.agent.pending = null;
    this.win.flashFrame(false);
    p.resolve(Boolean(ok));
    this.pushState();
  }

  async startAgent(task, opts = {}) {
    if (this.agent.run) throw new Error('An agent task is already running.');
    const tab = this.active();
    if (!tab || tab.plane !== 'shadow') throw new Error('The agent only works in Shadow tabs. Open one with Ctrl+Shift+S.');
    if (!tab.url) throw new Error('Open a page in this Shadow tab first.');
    const run = new AgentRun({
      task: String(task).slice(0, 2000),
      driver: opts.driver || this.driverFor(tab),
      decide: opts.decide || this.modelFor(),
      approve: opts.approve || ((req) => this.requestApproval(req)),
      audit: (kind, data) => this.audit(kind, data),
      maxSteps: this.settings.get().agent.maxSteps,
      autoApproveClicks: Boolean(opts.autoClicks),
      pacing: opts.pacing,
    });
    this.agent.run = run;
    this.agent.tabId = tab.id;
    this.agent.log = [];
    run.on('log', (e) => this.agentLog(e));
    this.pushState();
    try {
      return await run.run();
    } finally {
      this.agent.run = null;
      if (this.agent.pending) this.resolveApproval(this.agent.pending.id, false);
      this.pushState();
    }
  }

  // ---- UI bridge -----------------------------------------------------------------
  registerIpc() {
    const fromChrome = (e) => e.sender === this.chrome.webContents;
    ipcMain.on('veil:shim', (e) => {
      // Only VEIL tab renderers may ask; anything else gets an empty script.
      const tab = this.tabByWc(e.sender.hostWebContents || e.sender);
      e.returnValue = tab && tab.plane === 'veil' ? shimSource(this.paths.shim, PROFILE.shim) : '';
    });
    ipcMain.handle('ui:cmd', async (e, cmd, a = {}) => {
      if (!fromChrome(e)) throw new Error('forbidden');
      const tab = a.id ? this.tabs.get(a.id) : this.active();
      switch (cmd) {
        case 'state': return this.state();
        case 'newTab': await this.createTab({ plane: a.plane === 'shadow' ? 'shadow' : 'veil', url: a.url || null }); return true;
        case 'closeTab': await this.closeTab(a.id); return true;
        case 'activate': this.activate(a.id); return true;
        case 'navigate': if (tab) this.navigate(tab.id, a.input); return true;
        case 'back': if (tab && tab.wc.navigationHistory.canGoBack()) { tab.error = null; tab.wc.navigationHistory.goBack(); } return true;
        case 'forward': if (tab && tab.wc.navigationHistory.canGoForward()) { tab.error = null; tab.wc.navigationHistory.goForward(); } return true;
        case 'reload':
          if (tab) {
            if (tab.error || tab.blocked) { const u = tab.error ? tab.error.url : tab.pendingUrl; tab.error = null; if (u) this.navigate(tab.id, u); } else tab.wc.reload();
          }
          return true;
        case 'stop': if (tab) tab.wc.stop(); return true;
        case 'allowHttp':
          if (tab && tab.error && tab.error.canHttp) {
            const u = new URL(tab.error.url);
            this.sessionInfo.get(tab.ses).httpAllowed.add(u.hostname);
            u.protocol = 'http:';
            this.navigate(tab.id, u.toString());
          }
          return true;
        case 'newIdentity': await this.newIdentity(); return true;
        case 'retryTor': await this.tor.start(this.settings.get()); return true;
        case 'overlay': this.overlay = Boolean(a.on); this.layout(); return true;
        case 'zoom':
          if (tab) tab.wc.setZoomLevel(a.delta === 0 ? 0 : tab.wc.getZoomLevel() + (a.delta > 0 ? 0.5 : -0.5));
          return true;
        case 'getSettings': {
          const providerList = providers.catalog().map((p) => ({ ...p, hasKey: this.settings.hasApiKey(p.id) }));
          return { ...this.settings.get(), providers: providerList, engines: SEARCH_ENGINES };
        }
        case 'listModels': {
          const id = providers.PROVIDERS[a.provider] ? a.provider : null;
          if (!id) throw new Error('unknown provider');
          const cfg = { endpoints: { [id]: typeof a.endpoint === 'string' ? a.endpoint : '' }, models: {} };
          const key = typeof a.apiKey === 'string' && a.apiKey.trim() ? a.apiKey.trim() : this.settings.readApiKey(id);
          try {
            return { ok: true, models: (await providers.listModels(id, cfg, key)).slice(0, 500) };
          } catch (err) {
            return { ok: false, error: err.name === 'TimeoutError' ? 'No answer within 20 seconds.' : err.message };
          }
        }
        case 'setSettings': {
          const before = this.settings.get();
          const after = this.settings.update(a.patch || {});
          if (a.apiKeys && typeof a.apiKeys === 'object') {
            for (const [id, value] of Object.entries(a.apiKeys)) {
              if (providers.PROVIDERS[id] && typeof value === 'string') this.settings.writeApiKey(id, value.trim() || null);
            }
          }
          if (before.bridges !== after.bridges || before.customBridges !== after.customBridges) this.tor.start(after);
          if (before.veilAllowClearnet !== after.veilAllowClearnet || before.shadowRouting !== after.shadowRouting) await this.applyProxies();
          if (before.customFilters !== after.customFilters) this.emitFiltersChanged();
          this.onTorState();
          return true;
        }
        case 'toggleAgent': this.agent.open = Boolean(a.open); this.layout(); this.pushState(); return true;
        case 'agentStart':
          this.startAgent(a.task, { autoClicks: a.autoClicks }).catch((err) => this.agentLog({ kind: 'error', text: err.message, ts: Date.now() }));
          return true;
        case 'agentStop': if (this.agent.run) this.agent.run.stop(); return true;
        case 'agentApprove': this.resolveApproval(a.reqId, a.ok); return true;
        case 'ledger': {
          const v = this.ledger ? this.ledger.verify() : { ok: false, reason: 'no ledger' };
          return { verify: v, entries: this.ledger ? this.ledger.tail(40) : [] };
        }
        case 'openInShadow':
          // A deliberate, user-initiated cross-plane effect: only the URL crosses, never state.
          if (tab && tab.plane === 'veil' && tab.url) {
            this.audit('cross-plane.open-in-shadow', { site: siteOfUrl(tab.url) });
            await this.createTab({ plane: 'shadow', url: tab.url });
          }
          return true;
        default: throw new Error(`unknown command ${cmd}`);
      }
    });
  }

  emitFiltersChanged() { if (this.onFiltersChanged) this.onFiltersChanged(); }

  buildMenu() {
    const template = [
      {
        label: 'File',
        submenu: [
          { label: 'New VEIL tab', accelerator: 'CmdOrCtrl+T', click: () => this.createTab({ plane: 'veil' }) },
          { label: 'New Shadow tab', accelerator: 'CmdOrCtrl+Shift+S', click: () => this.createTab({ plane: 'shadow' }) },
          { label: 'New identity', accelerator: 'CmdOrCtrl+Shift+U', click: () => this.newIdentity() },
          { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: () => this.activeId && this.closeTab(this.activeId) },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => { const t = this.active(); if (t) t.wc.reload(); } },
          { label: 'Focus address bar', accelerator: 'CmdOrCtrl+L', click: () => this.chrome.webContents.send('ui:focus-url') },
          { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => { const t = this.active(); if (t) t.wc.setZoomLevel(t.wc.getZoomLevel() + 0.5); } },
          { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => { const t = this.active(); if (t) t.wc.setZoomLevel(t.wc.getZoomLevel() - 0.5); } },
          { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => { const t = this.active(); if (t) t.wc.setZoomLevel(0); } },
          { role: 'togglefullscreen' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  state() {
    const tabs = this.order.map((id) => {
      const t = this.tabs.get(id);
      return {
        id, plane: t.plane, title: t.title, url: t.url || t.pendingUrl || '', loading: t.loading, blocked: t.blocked,
        error: t.error, canBack: t.canBack, canFwd: t.canFwd, blockedCount: t.blockedCount, site: t.firstParty,
      };
    });
    const s = this.settings.get();
    const p = this.agent.pending;
    return {
      tabs, activeId: this.activeId, tor: this.tor.state,
      clearnet: s.veilAllowClearnet, shadowRouting: s.shadowRouting, securityLevel: s.securityLevel,
      agent: {
        open: this.agent.open, running: Boolean(this.agent.run), log: this.agent.log.slice(-80),
        pending: p ? { id: p.id, description: p.description, site: p.site, action: p.action } : null,
        provider: s.agent.provider,
        providerLabel: `${providers.PROVIDERS[s.agent.provider].name.replace(/ \(.*\)$/, '')} · ${providers.modelFor(s.agent.provider, s.agent) || 'no model'}${providers.PROVIDERS[s.agent.provider].local ? ' (local)' : ' (remote)'}`,
      },
      downloads: this.downloads.slice(-5).map(({ id, name, state, received, total, dangerous }) => ({ id, name, state, received, total, dangerous })),
      filterRules: this.filter.ruleCount,
    };
  }

  pushState() {
    if (this.statePending) return;
    this.statePending = true;
    setImmediate(() => {
      this.statePending = false;
      if (this.closed || !this.chrome || this.chrome.webContents.isDestroyed()) return;
      this.chrome.webContents.send('ui:state', this.state());
    });
  }

  async shutdown() {
    this.quitting = true;
    if (this.agent.run) this.agent.run.stop();
    for (const t of [...this.tabs.values()]) {
      if (t.plane === 'veil') await this.destroyVeilState(t);
    }
    try { await this.shadowGateway.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { Browser, CHROME_HEIGHT, PROFILE, waitForLoad };
