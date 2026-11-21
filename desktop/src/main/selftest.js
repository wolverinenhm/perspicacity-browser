'use strict';
// End-to-end self-test: `electron . --selftest` (CI runs this on Linux and Windows).
// It drives the real browser: a VEIL tab loads a local page that measures the fingerprint
// surfaces and reports back, a tracker request must be blocked, then the agent fills in and
// submits a form in a Shadow tab (with a scripted model), and the audit chain must verify.

const http = require('http');
const net = require('net');

/** Minimal SOCKS5 server standing in for Tor: requires username auth, then really connects. */
function startFakeTor() {
  const seen = [];
  const server = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    let stage = 0;
    let user = '';
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 + buf[1]) { buf = buf.subarray(2 + buf[1]); c.write(Buffer.from([5, 2])); stage = 1; }
      if (stage === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
        user = buf.subarray(2, 2 + buf[1]).toString(); buf = buf.subarray(3 + buf[1] + buf[2 + buf[1]]); c.write(Buffer.from([1, 0])); stage = 2;
      }
      if (stage === 2 && buf.length >= 5) {
        const atyp = buf[3];
        const need = atyp === 3 ? 7 + buf[4] : atyp === 1 ? 10 : 22;
        if (buf.length < need) return;
        const host = atyp === 3 ? buf.subarray(5, 5 + buf[4]).toString() : Array.from(buf.subarray(4, 8)).join('.');
        const port = buf.readUInt16BE(need - 2);
        buf = buf.subarray(need);
        stage = 3;
        c.off('data', onData);
        seen.push({ user, host });
        const up = net.connect(port, host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (buf.length) up.write(buf);
          c.pipe(up); up.pipe(c);
        });
        up.on('error', () => c.destroy());
        c.on('error', () => up.destroy());
      }
    };
    c.on('data', onData);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}
const { waitForLoad } = require('./browser');

const FP_PAGE = `<!doctype html><html><head><title>fp</title></head><body>
<img src="http://blocked.perspicacity.test/pixel.gif" alt="">
<iframe id="f" srcdoc="<p>child</p>"></iframe>
<script>
(async () => {
  const c = document.createElement('canvas'); c.width = 40; c.height = 20;
  const x = c.getContext('2d'); x.fillStyle = '#f00'; x.fillRect(0, 0, 40, 20);
  const canvasBlank = Array.from(x.getImageData(0, 0, 40, 20).data).every((v) => v === 0);
  let perfCoarse = true;
  for (let i = 0; i < 50; i++) if (performance.now() % 100 !== 0) perfCoarse = false;
  await new Promise((r) => setTimeout(r, 300));
  const fw = document.getElementById('f').contentWindow;
  const hcDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency');
  const r = {
    hardwareConcurrency: navigator.hardwareConcurrency,
    iframeHardwareConcurrency: fw.navigator.hardwareConcurrency,
    languages: navigator.languages.join(','),
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffset: new Date(2030, 6, 1).getTimezoneOffset(),
    rtc: typeof RTCPeerConnection,
    webgl: Boolean(document.createElement('canvas').getContext('webgl')),
    screenMatchesViewport: screen.width === innerWidth && screen.height === innerHeight,
    letterboxed: innerWidth % 200 === 0 && innerHeight % 100 === 0,
    canvasBlank,
    perfCoarse,
    getterLooksNative: Function.prototype.toString.call(hcDesc.get).includes('[native code]'),
    battery: 'getBattery' in navigator,
  };
  r.workerTimeZone = await new Promise((res) => {
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone)'], { type: 'text/javascript' })));
      w.onmessage = (e) => res(e.data); w.onerror = () => res('error');
    } catch (e) { res('error ' + e.message); }
  });
  await fetch('/report', { method: 'POST', body: JSON.stringify(r) });
})();
</script></body></html>`;

const FORM_PAGE = `<!doctype html><html><head><title>form</title></head><body>
<h1>Contact</h1>
<form id="f"><label>Name <input id="name" name="name"></label><button id="go" type="submit">Send</button></form>
<script>
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  document.title = 'submitted:' + document.getElementById('name').value;
});
</script></body></html>`;

function startServer() {
  let resolveReport;
  const report = new Promise((r) => { resolveReport = r; });
  const server = http.createServer((req, res) => {
    if (req.url === '/fp') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FP_PAGE); return; }
    if (req.url === '/form') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FORM_PAGE); return; }
    if (req.url === '/report' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { res.end('ok'); try { resolveReport(JSON.parse(body)); } catch (_) { resolveReport(null); } });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, report })));
}

const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);

async function runSelftest({ browser, filter, ledger }) {
  let fakeTor;
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail }); };
  const stage = (m) => console.log(`selftest: ${m}`);
  let srv;
  try {
    filter.addRule('||blocked.perspicacity.test^');
    srv = await startServer();
    const base = `http://127.0.0.1:${srv.port}`;

    // VEIL tab: fingerprint surfaces.
    stage('opening VEIL tab');
    const veil = await browser.createTab({ plane: 'veil', url: `${base}/fp` });
    const r = await timeout(srv.report, 30000, 'fingerprint report');
    check('report received', r, r);
    if (r) {
      check('hardwareConcurrency is canonical', r.hardwareConcurrency === 4, r.hardwareConcurrency);
      check('shim also runs in iframes', r.iframeHardwareConcurrency === 4, r.iframeHardwareConcurrency);
      check('languages are canonical', r.languages === 'en-US,en', r.languages);
      check('platform is canonical', r.platform === 'Win32', r.platform);
      check('user agent is canonical', /Windows NT 10\.0; Win64; x64/.test(r.userAgent) && /Chrome\/\d+\.0\.0\.0/.test(r.userAgent), r.userAgent);
      check('timezone is UTC', /^(UTC|Etc\/UTC|Etc\/GMT)$/.test(r.timeZone) && r.tzOffset === 0, `${r.timeZone} ${r.tzOffset}`);
      check('timezone is UTC in workers too (engine-level override)', /^(UTC|Etc\/UTC|Etc\/GMT|GMT)$/.test(r.workerTimeZone), r.workerTimeZone);
      check('WebRTC removed', r.rtc === 'undefined', r.rtc);
      check('WebGL disabled', r.webgl === false, r.webgl);
      check('screen reports the viewport', r.screenMatchesViewport, r.screenMatchesViewport);
      check('canvas readback is blank', r.canvasBlank, r.canvasBlank);
      check('timers are coarse (100 ms)', r.perfCoarse, r.perfCoarse);
      check('patched getters look native', r.getterLooksNative, r.getterLooksNative);
      check('battery API removed', r.battery === false, r.battery);
    }
    await waitForLoad(veil.wc);
    check('tracker request blocked', veil.blockedCount >= 1, veil.blockedCount);

    // Shadow tab: the agent fills in the form with a scripted model and auto-approval.
    stage('opening Shadow tab');
    const shadow = await browser.createTab({ plane: 'shadow', url: `${base}/form` });
    await timeout(new Promise((res) => { const t = setInterval(() => { if (shadow.url.endsWith('/form') && !shadow.wc.isLoading()) { clearInterval(t); res(); } }, 100); }), 15000, 'form load');
    const script = [
      (snap) => {
        const m = /\[(e\d+)\] textbox "Name/.exec(snap);
        return { thought: 'fill the name', action: 'type', id: m ? m[1] : 'e99', text: 'perspicacity', submit: false, url: '', direction: '', answer: '' };
      },
      (snap) => {
        const m = /\[(e\d+)\] button "Send"/.exec(snap);
        return { thought: 'send', action: 'click', id: m ? m[1] : 'e99', text: '', submit: false, url: '', direction: '', answer: '' };
      },
      () => ({ thought: 'finished', action: 'done', id: '', text: '', submit: false, url: '', direction: '', answer: 'Form sent.' }),
    ];
    stage('running agent');
    let step = 0;
    const approvals = [];
    const out = await timeout(browser.startAgent('Send the contact form with the name perspicacity', {
      decide: async (messages) => script[Math.min(step++, script.length - 1)](messages[0].content),
      approve: async (req) => { approvals.push(req.description); return true; },
      pacing: [10, 20],
    }), 60000, 'agent run');
    check('agent finished', out.status === 'done', out);
    check('typing and clicking asked for approval', approvals.length === 2, approvals);
    const title = shadow.wc.getTitle();
    check('form submitted with real input events', title === 'submitted:perspicacity', title);

    if (ledger) {
      const v = ledger.verify();
      check('audit ledger verifies', v.ok && v.count >= 4, v);
    }

    // VEIL through "Tor": the real proxy path, Chromium -> per-tab gateway -> SOCKS upstream.
    stage('VEIL through the isolating gateway');
    fakeTor = await startFakeTor();
    browser.tor.set({ mode: 'external', phase: 'ready', progress: 100, socksPort: fakeTor.port, message: 'selftest' });
    browser.settings.update({ veilAllowClearnet: false });
    await browser.applyProxies();
    const t1 = await browser.createTab({ plane: 'veil', url: `${base}/form` });
    const t2 = await browser.createTab({ plane: 'veil', url: `${base}/form` });
    await timeout(new Promise((res) => { const t = setInterval(() => { if (t1.url && t2.url && !t1.wc.isLoading() && !t2.wc.isLoading()) { clearInterval(t); res(); } }, 100); }), 20000, 'proxied loads');
    check('VEIL pages load through the gateway', t1.wc.getTitle() === 'form' && t2.wc.getTitle() === 'form', [t1.wc.getTitle(), t2.wc.getTitle(), t1.error, t2.error]);
    const users = [...new Set(fakeTor.seen.map((x) => x.user))];
    check('each tab gets its own SOCKS isolation key', users.length >= 2 && users.every((u) => /^[0-9a-f]{32}$/.test(u)), fakeTor.seen);
    console.log('selftest: proxied streams', JSON.stringify(fakeTor.seen.map((x) => x.host)));
    check('only page traffic uses the circuit, loopback included (no bypass, no background fetches)', fakeTor.seen.length > 0 && fakeTor.seen.every((x) => x.host === '127.0.0.1'), fakeTor.seen);
    browser.tor.set({ phase: 'unavailable', socksPort: 0 });
    const t3 = await browser.createTab({ plane: 'veil', url: `${base}/form` });
    check('VEIL fails closed when Tor is down', t3.blocked === 'tor' && !t3.wc.getURL().startsWith('http'), [t3.blocked, t3.wc.getURL()]);

    // Optional: the real bundled Tor, end to end (CI runs this on Windows with the Expert Bundle).
    if (process.argv.includes('--selftest-tor')) {
      stage('starting the real Tor');
      await browser.tor.start(browser.settings.get());
      check('a tor binary was found', ['bundled', 'system'].includes(browser.tor.state.mode), browser.tor.state);
      await timeout(new Promise((res) => {
        const t = setInterval(() => { if (['ready', 'failed', 'unavailable'].includes(browser.tor.state.phase)) { clearInterval(t); res(); } }, 500);
      }), 180000, 'Tor bootstrap').catch(() => {});
      check('Tor bootstrapped to 100%', browser.tor.state.phase === 'ready', browser.tor.state);
      if (browser.tor.state.phase === 'ready') {
        const tc = await browser.createTab({ plane: 'veil', url: 'https://check.torproject.org/api/ip' });
        await timeout(new Promise((res) => { const t = setInterval(() => { if (tc.url.includes('check.torproject.org') && !tc.wc.isLoading()) { clearInterval(t); res(); } }, 300); }), 90000, 'check.torproject.org').catch(() => {});
        let body = '';
        try { body = await tc.wc.executeJavaScript('document.body ? document.body.innerText : ""'); } catch (_) { body = ''; }
        let isTor = false;
        try { isTor = JSON.parse(body).IsTor === true; } catch (_) { isTor = false; }
        check('check.torproject.org confirms the VEIL tab exits through Tor', isTor, body.slice(0, 200) || tc.error);
      }
    }

    // New identity destroys every VEIL tab.
    const before = veil.id;
    await browser.newIdentity();
    check('new identity closed VEIL tabs', !browser.tabs.has(before), [...browser.tabs.keys()]);
  } catch (e) {
    check('selftest ran without exceptions', false, e.stack || String(e));
  } finally {
    if (srv) srv.server.close();
    if (fakeTor) fakeTor.server.close();
  }
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${JSON.stringify(r.detail)}`}`);
  }
  console.log(`selftest: ${results.length - failed}/${results.length} passed`);
  return failed ? 1 : 0;
}

module.exports = { runSelftest };
