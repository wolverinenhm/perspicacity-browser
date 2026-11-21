'use strict';
// Perspicacity desktop entry point.

const path = require('path');
const fs = require('fs');
const { app, safeStorage, dialog, session } = require('electron');

const { Settings } = require('./settings');
const { TorManager } = require('./tor');
const { FilterEngine } = require('./filter');
const { Ledger } = require('./ledger');
const { Browser } = require('./browser');

const SELFTEST = process.argv.includes('--selftest');

// ADR-003: no remote debugging endpoint in release builds.
if (app.isPackaged && process.argv.some((a) => /^--(remote-debugging-(port|pipe)|inspect)/.test(a))) {
  process.exit(1);
}

// Chromium switches that close leaks Electron leaves open by default.
app.commandLine.appendSwitch('disable-quic'); // QUIC cannot ride SOCKS; never let it bypass the proxy
app.commandLine.appendSwitch('dns-prefetch-disable');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy');
app.commandLine.appendSwitch('disable-features', [
  'NetworkPrediction', 'InterestFeedContentSuggestions', 'MediaRouter', 'DialMediaRouteProvider',
  'OptimizationHints', 'AutofillServerCommunication', 'CertificateTransparencyComponentUpdater',
  'UseDnsHttpsSvcb', 'AsyncDns', 'SpareRendererForSitePerProcess',
].join(','));
app.commandLine.appendSwitch('enable-features', 'ReducedReferrerGranularity,PartitionedCookies,ThirdPartyStoragePartitioning');
if (SELFTEST && process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

// Keep this app's persistent data (SHADOW plane, settings, ledger) in its own folder.
if (SELFTEST) app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'perspicacity-selftest-')));

const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
const sharedDir = app.isPackaged ? path.join(process.resourcesPath, 'shared') : path.join(__dirname, '..', '..', '..', 'shared');
const vendorDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'vendor');

let browser = null;
let tor = null;

function loadFilters(filter, settings) {
  const engine = new FilterEngine();
  try { engine.addList(fs.readFileSync(path.join(sharedDir, 'filters', 'trackers.txt'), 'utf8')); } catch (_) { /* missing list */ }
  engine.addList(settings.get().customFilters);
  if (filter) { filter.block = engine.block; filter.allow = engine.allow; filter.ruleCount = engine.ruleCount; return filter; }
  return engine;
}

async function boot() {
  // The browser chrome uses the default session: no spellcheck dictionary downloads, no network.
  session.defaultSession.setSpellCheckerEnabled(false);
  try { session.defaultSession.setSpellCheckerLanguages([]); } catch (_) { /* not on macOS */ }
  const userDir = app.getPath('userData');
  const settings = new Settings(userDir, safeStorage);
  if (SELFTEST) settings.update({ veilAllowClearnet: true, shadowRouting: 'direct' });
  const filter = loadFilters(null, settings);

  let ledger = null;
  try {
    ledger = new Ledger(path.join(userDir, 'audit.log'), settings.key('ledgerKey'));
  } catch (e) {
    console.error('ledger unavailable:', e.message);
  }

  tor = new TorManager({ resourcesDir: vendorDir });
  browser = new Browser({
    paths: {
      ui: path.join(__dirname, '..', 'ui'),
      preloads: path.join(__dirname, '..', 'preload'),
      shim: path.join(sharedDir, 'veil-shim.js'),
    },
    settings, tor, filter, ledger, selftest: SELFTEST,
  });
  browser.onFiltersChanged = () => loadFilters(filter, settings);
  await browser.init();
  if (ledger && ledger.broken) {
    browser.chrome.webContents.send('ui:toast', `Audit ledger failed verification at entry ${ledger.broken.at} (${ledger.broken.reason}). Agent actions will not be recorded until it is reset.`);
  }

  if (SELFTEST) {
    const { runSelftest } = require('./selftest');
    const code = await runSelftest({ browser, filter, ledger });
    await shutdown();
    app.exit(code);
    return;
  }

  tor.start(settings.get());
  await browser.createTab({ plane: 'veil' });
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (browser) await browser.shutdown(); } catch (_) { /* ignore */ }
  try { if (tor) await tor.stop(); } catch (_) { /* ignore */ }
}

if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (browser && browser.win) { if (browser.win.isMinimized()) browser.win.restore(); browser.win.focus(); }
  });
  app.whenReady().then(boot).catch((e) => {
    console.error(e);
    if (!SELFTEST) dialog.showErrorBox('Perspicacity failed to start', String(e && e.stack ? e.stack : e));
    app.exit(1);
  });
  app.on('window-all-closed', async () => { await shutdown(); app.quit(); });
  app.on('before-quit', (e) => {
    if (shuttingDown) return;
    e.preventDefault();
    shutdown().finally(() => app.quit());
  });
  app.on('will-quit', () => { if (tor) tor.stopSync(); });
  // Refuse every certificate override, and never create extra windows from web content.
  app.on('certificate-error', (event, wc, url, error, cert, cb) => cb(false));
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
  });
}
