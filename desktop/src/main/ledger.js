'use strict';
// AUDIT: append-only, HMAC-chained action ledger (PSC-ARCH-001 §8.4, Appendix B).
// Each line is JSON: { seq, ts, kind, data, prev, mac } where
//   mac = HMAC-SHA256(key, prev || canonical(seq, ts, kind, data)).
// Truncating, reordering or editing any entry breaks verification from that point on.
// Only SHADOW-plane events are written here; VEIL never writes to disk.

const crypto = require('crypto');
const fs = require('fs');

const GENESIS = '0'.repeat(64);

function canonical(entry) {
  return JSON.stringify([entry.seq, entry.ts, entry.kind, entry.data]);
}

function macFor(key, prev, entry) {
  return crypto.createHmac('sha256', key).update(prev).update('\n').update(canonical(entry)).digest('hex');
}

class Ledger {
  /**
   * @param {string} file path of the ledger file
   * @param {Buffer} key 32-byte HMAC key (held by the key custodian, never logged)
   */
  constructor(file, key) {
    if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('ledger key must be at least 32 bytes');
    this.file = file;
    this.key = key;
    this.seq = 0;
    this.prev = GENESIS;
    const v = this.verify();
    if (v.ok) { this.seq = v.count; this.prev = v.last; } else { this.broken = v; }
  }

  append(kind, data) {
    if (this.broken) throw new Error(`ledger failed verification at entry ${this.broken.at}; refusing to append`);
    const entry = { seq: this.seq + 1, ts: new Date().toISOString(), kind: String(kind), data: data === undefined ? null : data };
    entry.prev = this.prev;
    entry.mac = macFor(this.key, this.prev, entry);
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.seq = entry.seq;
    this.prev = entry.mac;
    return entry;
  }

  /** @returns {{ok: true, count: number, last: string} | {ok: false, at: number, reason: string}} */
  verify() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return { ok: true, count: 0, last: GENESIS };
      throw e;
    }
    let prev = GENESIS;
    let n = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      n++;
      let e;
      try { e = JSON.parse(line); } catch (_) { return { ok: false, at: n, reason: 'unparseable entry' }; }
      if (e.seq !== n) return { ok: false, at: n, reason: 'sequence gap' };
      if (e.prev !== prev) return { ok: false, at: n, reason: 'chain break' };
      const expect = macFor(this.key, prev, e);
      if (typeof e.mac !== 'string' || e.mac.length !== expect.length ||
          !crypto.timingSafeEqual(Buffer.from(e.mac), Buffer.from(expect))) {
        return { ok: false, at: n, reason: 'bad MAC' };
      }
      prev = e.mac;
    }
    return { ok: true, count: n, last: prev };
  }

  tail(n = 50) {
    try {
      return fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l));
    } catch (_) {
      return [];
    }
  }
}

module.exports = { Ledger };
