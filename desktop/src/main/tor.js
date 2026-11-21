'use strict';
// Tor lifecycle (PSC-NET-002 §4). Order of preference:
//   1. the tor binary bundled with the installer (resources/tor), or PERSPICACITY_TOR;
//   2. a tor already running on this machine (Tor Browser on 9150, system tor on 9050);
//   3. nothing: VEIL fails closed and says so.
// A bundled tor runs with a throwaway DataDirectory in the temp folder that is deleted on
// exit, and exits by itself if this process dies (__OwningControllerProcess).

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { probeSocks } = require('./gateway');

const BOOTSTRAP_RE = /Bootstrapped (\d+)%[^:]*:\s*(.*?)\s*$/;

/** Parses a Tor "Bootstrapped N%" notice line; null for any other line. */
function parseBootstrap(line) {
  const m = BOOTSTRAP_RE.exec(line);
  if (!m) return null;
  const progress = Number(m[1]);
  return { progress, message: m[2] || `Bootstrapped ${progress}%` };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

function findOnPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, name + e);
    if (d && exists(p)) return p;
  }
  return null;
}

/** Locate the Tor Expert Bundle layout: <root>/tor/tor(.exe), <root>/data/geoip, PT folder. */
function findBundledTor(resourcesDir) {
  const exe = process.platform === 'win32' ? 'tor.exe' : 'tor';
  const candidates = [];
  if (process.env.PERSPICACITY_TOR) candidates.push(process.env.PERSPICACITY_TOR);
  if (resourcesDir) {
    candidates.push(path.join(resourcesDir, 'tor', 'tor', exe), path.join(resourcesDir, 'tor', exe));
  }
  for (const c of candidates) {
    if (c && exists(c)) {
      const binDir = path.dirname(c);
      const root = path.basename(binDir) === 'tor' ? path.dirname(binDir) : binDir;
      return {
        bin: c,
        binDir,
        geoip: [path.join(root, 'data', 'geoip'), path.join(binDir, 'geoip')].find(exists) || null,
        geoip6: [path.join(root, 'data', 'geoip6'), path.join(binDir, 'geoip6')].find(exists) || null,
        ptDir: [path.join(binDir, 'pluggable_transports'), path.join(root, 'pluggable_transports')].find(exists) || null,
      };
    }
  }
  const sys = findOnPath('tor');
  return sys ? { bin: sys, binDir: path.dirname(sys), geoip: null, geoip6: null, ptDir: null, system: true } : null;
}

/** Reads pt_config.json from the expert bundle (transport plugin lines and built-in bridges). */
function loadPtConfig(layout) {
  if (!layout || !layout.ptDir) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(layout.ptDir, 'pt_config.json'), 'utf8'));
    return cfg;
  } catch (_) {
    return null;
  }
}

/**
 * Builds the transport-plugin lines. Paths are written relative to the tor binary's folder
 * (tor is started with that folder as its working directory), so an install path with
 * spaces in it ("C:\Program Files\...") never reaches torrc.
 */
function transportLines(layout, ptCfg) {
  if (!ptCfg || !ptCfg.pluggableTransports) return [];
  const rel = path.relative(layout.binDir, layout.ptDir) || '.';
  const lines = [];
  for (const line of Object.values(ptCfg.pluggableTransports)) {
    let l = String(line).replace(/\$\{pt_path\}/g, `${rel}${path.sep}`);
    const m = /exec\s+(\S+)/.exec(l);
    if (m && process.platform === 'win32' && !/\.exe$/i.test(m[1]) && exists(path.join(layout.binDir, `${m[1]}.exe`))) {
      l = l.replace(m[1], `${m[1]}.exe`);
    }
    lines.push(l);
  }
  return lines;
}

function bridgeLines(settings, ptCfg) {
  const mode = settings.bridges || 'none';
  if (mode === 'none') return [];
  if (mode === 'custom') {
    return String(settings.customBridges || '').split(/\r?\n/).map((l) => l.trim().replace(/^Bridge\s+/i, '')).filter(Boolean);
  }
  const builtIn = ptCfg && ptCfg.bridges && ptCfg.bridges[mode];
  return Array.isArray(builtIn) ? builtIn : [];
}

class TorManager extends EventEmitter {
  constructor({ resourcesDir }) {
    super();
    this.resourcesDir = resourcesDir;
    this.child = null;
    this.dataDir = null;
    this.state = { mode: 'none', phase: 'idle', progress: 0, message: 'Not started', socksPort: 0 };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** {host, port} once Tor can carry streams, else null. */
  upstream() {
    return this.state.phase === 'ready' ? { host: '127.0.0.1', port: this.state.socksPort } : null;
  }

  async start(settings) {
    await this.stop();
    const layout = findBundledTor(this.resourcesDir);
    if (layout) {
      try {
        await this.launch(layout, settings || {});
        return;
      } catch (e) {
        this.set({ phase: 'failed', message: `Bundled Tor failed to start: ${e.message}` });
      }
    }
    for (const port of [9150, 9050]) {
      // eslint-disable-next-line no-await-in-loop
      if (await probeSocks('127.0.0.1', port)) {
        this.set({ mode: 'external', phase: 'ready', progress: 100, socksPort: port, message: `Using the Tor already running on port ${port}` });
        return;
      }
    }
    this.set({
      mode: 'none', phase: 'unavailable', progress: 0, socksPort: 0,
      message: 'Tor is not available. Install Perspicacity with the bundled Tor, or start Tor Browser / the tor service, then press Retry.',
    });
  }

  async launch(layout, settings) {
    const port = await freePort();
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perspicacity-tor-'));
    const ptCfg = loadPtConfig(layout);
    const bridges = bridgeLines(settings, ptCfg);
    const torrc = [
      `SocksPort 127.0.0.1:${port} IsolateSOCKSAuth KeepAliveIsolateSOCKSAuth`,
      'ClientOnly 1',
      'AvoidDiskWrites 1',
      'SafeLogging 1',
      'Log notice stdout',
      `__OwningControllerProcess ${process.pid}`,
    ];
    if (bridges.length) {
      torrc.push('UseBridges 1', ...transportLines(layout, ptCfg), ...bridges.map((b) => `Bridge ${b}`));
    }
    const torrcPath = path.join(this.dataDir, 'torrc');
    fs.writeFileSync(torrcPath, `${torrc.join('\n')}\n`, { mode: 0o600 });
    const defaultsPath = path.join(this.dataDir, 'torrc-defaults');
    fs.writeFileSync(defaultsPath, '', { mode: 0o600 });
    // Paths go on the command line, not in torrc, so spaces and backslashes need no quoting.
    const args = ['-f', torrcPath, '--defaults-torrc', defaultsPath, '--DataDirectory', this.dataDir];
    if (layout.geoip) args.push('--GeoIPFile', layout.geoip);
    if (layout.geoip6) args.push('--GeoIPv6File', layout.geoip6);

    this.set({ mode: layout.system ? 'system' : 'bundled', phase: 'bootstrapping', progress: 0, socksPort: port, message: 'Starting Tor' });
    const child = spawn(layout.bin, args, {
      cwd: layout.binDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let tail = '';
    const onLine = (line) => {
      const b = parseBootstrap(line);
      if (b) {
        this.set({ progress: b.progress, message: b.message, phase: b.progress >= 100 ? 'ready' : 'bootstrapping' });
      } else if (/\[(err|warn)\]/.test(line)) {
        tail = line.replace(/^.*\[(err|warn)\]\s*/, '');
      }
    };
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      // Tor on Windows ends lines with CRLF.
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { tail = d.toString('utf8').trim().split('\n').pop(); });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.once('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.set({ phase: 'failed', progress: 0, message: `Tor exited (code ${code}). ${tail}`.trim() });
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (child) {
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
        try { child.kill(); } catch (_) { clearTimeout(t); resolve(); }
      });
    }
    if (this.dataDir) {
      try { fs.rmSync(this.dataDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
      this.dataDir = null;
    }
    this.set({ phase: 'idle', progress: 0, socksPort: 0, message: 'Stopped' });
  }

  /** Synchronous best-effort cleanup for process exit. */
  stopSync() {
    if (this.child) { try { this.child.kill('SIGKILL'); } catch (_) { /* gone */ } }
    if (this.dataDir) { try { fs.rmSync(this.dataDir, { recursive: true, force: true }); } catch (_) { /* busy */ } }
  }
}

module.exports = { TorManager, findBundledTor, bridgeLines, transportLines, parseBootstrap };
