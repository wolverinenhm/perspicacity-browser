'use strict';
// Native network filter engine (PSC-UTL-005 §2). Host-anchored rules only: it is small,
// predictable and fast (a hash lookup per label of the request host), and it never runs
// page-supplied code. Cosmetic filtering is deliberately out of scope.

const { registrableDomain } = require('./site');

const SUPPORTED_OPTIONS = new Set(['third-party', '3p', 'important', 'all', 'document', 'doc', 'script', 'image', 'stylesheet', 'xmlhttprequest', 'xhr', 'subdocument', 'frame', 'ping', 'media', 'font', 'other', 'websocket']);
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

class FilterEngine {
  constructor() {
    this.block = new Map(); // host -> [{ path, thirdParty }]
    this.allow = new Map();
    this.ruleCount = 0;
  }

  addList(text) {
    let added = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
      if (this.addRule(raw)) added++;
    }
    return added;
  }

  /** Returns true when the line was understood and added. */
  addRule(raw) {
    let line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('[') || line.startsWith('#')) return false;
    if (/#[@?$%]?#/.test(line)) return false; // cosmetic / scriptlet rules

    const hosts = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+(\S+)/.exec(line);
    if (hosts) line = hosts[1];

    let exception = false;
    if (line.startsWith('@@')) { exception = true; line = line.slice(2); }

    let thirdParty = false;
    const dollar = line.lastIndexOf('$');
    if (dollar > 0) {
      const opts = line.slice(dollar + 1).split(',').map((o) => o.trim().toLowerCase()).filter(Boolean);
      line = line.slice(0, dollar);
      for (const o of opts) {
        if (o.startsWith('~') || o.startsWith('domain=') || !SUPPORTED_OPTIONS.has(o)) return false;
        if (o === 'third-party' || o === '3p') thirdParty = true;
      }
    }

    let host;
    let path = '';
    if (line.startsWith('||')) {
      let body = line.slice(2).replace(/\^\|?$/, '').replace(/\^$/, '');
      const slash = body.indexOf('/');
      if (slash >= 0) {
        path = body.slice(slash).replace(/\^.*$/, '');
        body = body.slice(0, slash);
      }
      host = body.toLowerCase();
    } else if (HOST_RE.test(line.toLowerCase())) {
      host = line.toLowerCase();
    } else {
      return false;
    }
    if (!HOST_RE.test(host) || path.includes('*')) return false;

    const map = exception ? this.allow : this.block;
    if (!map.has(host)) map.set(host, []);
    map.get(host).push({ path, thirdParty });
    this.ruleCount++;
    return true;
  }

  static lookup(map, host, pathname, isThirdParty) {
    let h = host;
    for (;;) {
      const rules = map.get(h);
      if (rules) {
        for (const r of rules) {
          if (r.thirdParty && !isThirdParty) continue;
          if (r.path && !pathname.startsWith(r.path)) continue;
          return { host: h, path: r.path };
        }
      }
      const dot = h.indexOf('.');
      if (dot < 0) return null;
      h = h.slice(dot + 1);
    }
  }

  /**
   * @param {string} url request URL
   * @param {string|null} topUrl URL of the top-level document (null for a main-frame load)
   * @returns {{blocked: boolean, rule?: string}}
   */
  match(url, topUrl) {
    let u;
    try { u = new URL(url); } catch (_) { return { blocked: false }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return { blocked: false };
    const host = u.hostname.toLowerCase();
    let topSite = '';
    try { topSite = topUrl ? registrableDomain(new URL(topUrl).hostname) : ''; } catch (_) { topSite = ''; }
    const thirdParty = Boolean(topSite) && registrableDomain(host) !== topSite;
    if (FilterEngine.lookup(this.allow, host, u.pathname, thirdParty)) return { blocked: false };
    const hit = FilterEngine.lookup(this.block, host, u.pathname, thirdParty);
    return hit ? { blocked: true, rule: `||${hit.host}${hit.path}^` } : { blocked: false };
  }
}

module.exports = { FilterEngine };
