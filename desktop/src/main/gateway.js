'use strict';
// Isolating SOCKS5 gateway (PSC-NET-002 §6.2, adapted).
//
// Chromium cannot attach a per-request SOCKS username, so it cannot ask Tor for per-site
// circuits on its own. Each identity domain (one VEIL tab, or the SHADOW plane) gets its
// own gateway listening on 127.0.0.1:<random>. Chromium connects to it without auth; the
// gateway re-issues the CONNECT to Tor's SocksPort with a username derived from the
// isolation key at that moment (tab nonce + first-party site). Tor's IsolateSOCKSAuth then
// guarantees that different keys never share a circuit.
//
// Only CONNECT is supported. BIND and UDP ASSOCIATE are refused (no UDP leaves the browser).

const net = require('net');

const REP = { OK: 0x00, FAIL: 0x01, NOT_ALLOWED: 0x02, NET_UNREACHABLE: 0x03, CMD_UNSUPPORTED: 0x07, ATYP_UNSUPPORTED: 0x08 };
const HANDSHAKE_TIMEOUT_MS = 60_000;

/** Buffered exact-length reader over a socket, used only during the handshake. */
class Reader {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.ended = false;
    this.onData = (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); };
    this.onEnd = () => { this.ended = true; this.pump(); };
    sock.on('data', this.onData);
    sock.on('end', this.onEnd);
    sock.on('close', this.onEnd);
  }

  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.buf.length >= w.n) {
        this.waiters.shift();
        const out = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        w.resolve(out);
      } else if (this.ended) {
        this.waiters.shift();
        w.reject(new Error('socket closed during handshake'));
      } else {
        return;
      }
    }
  }

  read(n) {
    return new Promise((resolve, reject) => { this.waiters.push({ n, resolve, reject }); this.pump(); });
  }

  /** Stop buffering and hand back anything already received. */
  detach() {
    this.sock.off('data', this.onData);
    this.sock.off('end', this.onEnd);
    this.sock.off('close', this.onEnd);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

function reply(code) {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

/** Reads a SOCKS5 address (after ATYP) and returns the raw bytes, ATYP included. */
async function readAddress(reader, atyp) {
  if (atyp === 0x01) return Buffer.concat([Buffer.from([atyp]), await reader.read(4 + 2)]);
  if (atyp === 0x04) return Buffer.concat([Buffer.from([atyp]), await reader.read(16 + 2)]);
  if (atyp === 0x03) {
    const len = await reader.read(1);
    return Buffer.concat([Buffer.from([atyp]), len, await reader.read(len[0] + 2)]);
  }
  return null;
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const fail = (e) => { s.destroy(); reject(e); };
    s.once('error', fail);
    s.once('connect', () => { s.off('error', fail); resolve(s); });
  });
}

class IsolatingSocksGateway {
  /**
   * @param {object} o
   * @param {() => ({host: string, port: number} | null)} o.upstream  Tor SocksPort, or null if Tor is not ready
   * @param {() => string} o.keyFor  isolation key at connection time
   * @param {(info: object) => void} [o.onStream]  observer for tests and the circuit display
   */
  constructor({ upstream, keyFor, onStream }) {
    this.upstream = upstream;
    this.keyFor = keyFor;
    this.onStream = onStream || (() => {});
    this.sockets = new Set();
    this.server = net.createServer((sock) => this.handle(sock));
    this.server.on('error', () => {});
    this.port = 0;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  track(sock) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => sock.destroy());
  }

  async handle(client) {
    this.track(client);
    client.setTimeout(HANDSHAKE_TIMEOUT_MS, () => client.destroy());
    const reader = new Reader(client);
    let upstream = null;
    try {
      const [ver, nmethods] = await reader.read(2);
      if (ver !== 0x05) throw new Error('not SOCKS5');
      const methods = await reader.read(nmethods);
      if (!methods.includes(0x00)) { client.end(Buffer.from([0x05, 0xff])); return; }
      client.write(Buffer.from([0x05, 0x00]));

      const [v2, cmd, , atyp] = await reader.read(4);
      if (v2 !== 0x05) throw new Error('bad request');
      const addr = await readAddress(reader, atyp);
      if (!addr) { client.end(reply(REP.ATYP_UNSUPPORTED)); return; }
      if (cmd !== 0x01) { client.end(reply(REP.CMD_UNSUPPORTED)); return; }

      const up = this.upstream();
      if (!up) { client.end(reply(REP.NET_UNREACHABLE)); return; }

      const key = String(this.keyFor() || 'default').slice(0, 255);
      upstream = await connect(up.host, up.port);
      this.track(upstream);
      const ur = new Reader(upstream);
      upstream.write(Buffer.from([0x05, 0x01, 0x02]));
      const [uv, um] = await ur.read(2);
      if (uv !== 0x05 || um !== 0x02) throw new Error('upstream refused username auth');
      const user = Buffer.from(key, 'utf8');
      const pass = Buffer.from('perspicacity', 'utf8');
      upstream.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const [, status] = await ur.read(2);
      if (status !== 0x00) throw new Error('upstream auth failed');

      upstream.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr]));
      const head = await ur.read(4);
      const boundAddr = await readAddress(ur, head[3]);
      // readAddress() returns ATYP + address, and head[3] is that same ATYP byte.
      const replyBytes = boundAddr ? Buffer.concat([head.subarray(0, 3), boundAddr]) : head;
      client.write(replyBytes);
      if (head[1] !== REP.OK || !boundAddr) { client.end(); upstream.destroy(); return; }

      this.onStream({ key, target: describe(addr) });
      client.setTimeout(0);
      const restC = reader.detach();
      const restU = ur.detach();
      if (restC.length) upstream.write(restC);
      if (restU.length) client.write(restU);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    } catch (_) {
      if (!client.destroyed) client.end(reply(REP.FAIL));
      if (upstream) upstream.destroy();
    }
  }
}

function describe(addr) {
  const atyp = addr[0];
  const port = addr.readUInt16BE(addr.length - 2);
  if (atyp === 0x03) return `${addr.subarray(2, 2 + addr[1]).toString('utf8')}:${port}`;
  if (atyp === 0x01) return `${Array.from(addr.subarray(1, 5)).join('.')}:${port}`;
  return `[ipv6]:${port}`;
}

/** Quick check whether something speaking SOCKS5 listens on host:port. */
function probeSocks(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('error', () => done(false));
    s.once('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])));
    s.once('data', (d) => done(d.length >= 2 && d[0] === 0x05 && d[1] === 0x00));
    s.once('close', () => done(false));
  });
}

module.exports = { IsolatingSocksGateway, probeSocks };
