'use strict';
// Persistent preferences (SHADOW-side storage, PSC-ARCH-001 §5.4: "what is allowed to persist").
// Only non-identifying choices live here. Secrets (the agent API key, the ledger key) are
// encrypted with the OS keystore through Electron safeStorage (DPAPI on Windows).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  'duckduckgo-onion': { name: 'DuckDuckGo (onion)', template: 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/?q=%s' },
  startpage: { name: 'Startpage', template: 'https://www.startpage.com/do/search?q=%s' },
  brave: { name: 'Brave Search', template: 'https://search.brave.com/search?q=%s' },
  mojeek: { name: 'Mojeek', template: 'https://www.mojeek.com/search?q=%s' },
};

const DEFAULTS = Object.freeze({
  searchEngine: 'duckduckgo',
  securityLevel: 'standard', // standard | safest (JavaScript off in VEIL)
  bridges: 'none', // none | obfs4 | snowflake | meek-azure | custom
  customBridges: '',
  veilAllowClearnet: false, // fail closed unless the user explicitly opts out of Tor
  shadowRouting: 'tor', // tor | direct
  customFilters: '',
  agent: {
    provider: 'ollama', // ollama (local, default) | anthropic
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.1',
    anthropicModel: 'claude-opus-5-5',
    maxSteps: 15,
  },
});

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (!(k in base)) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

class Settings {
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.secretsFile = path.join(dir, 'secrets.json');
    this.safeStorage = safeStorage;
    this.values = deepMerge(DEFAULTS, this.readJson(this.file));
    this.validate();
  }

  readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
  }

  validate() {
    const v = this.values;
    if (!SEARCH_ENGINES[v.searchEngine]) v.searchEngine = DEFAULTS.searchEngine;
    if (!['standard', 'safest'].includes(v.securityLevel)) v.securityLevel = 'standard';
    if (!['none', 'obfs4', 'snowflake', 'meek-azure', 'custom'].includes(v.bridges)) v.bridges = 'none';
    if (!['tor', 'direct'].includes(v.shadowRouting)) v.shadowRouting = 'tor';
    v.veilAllowClearnet = v.veilAllowClearnet === true;
    if (!['ollama', 'anthropic'].includes(v.agent.provider)) v.agent.provider = 'ollama';
    v.agent.maxSteps = Math.min(40, Math.max(1, Number(v.agent.maxSteps) || 15));
    try {
      const u = new URL(v.agent.ollamaUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    } catch (_) { v.agent.ollamaUrl = DEFAULTS.agent.ollamaUrl; }
  }

  get() { return JSON.parse(JSON.stringify(this.values)); }

  update(patch) {
    this.values = deepMerge(this.values, patch);
    this.validate();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), { mode: 0o600 });
    return this.get();
  }

  searchTemplate() { return SEARCH_ENGINES[this.values.searchEngine].template; }

  // ---- secrets -------------------------------------------------------------
  canEncrypt() {
    try { return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable()); } catch (_) { return false; }
  }

  readSecret(name) {
    const all = this.readJson(this.secretsFile);
    const rec = all[name];
    if (!rec) return null;
    try {
      if (rec.enc && this.canEncrypt()) return this.safeStorage.decryptString(Buffer.from(rec.enc, 'base64'));
      if (rec.plain) return Buffer.from(rec.plain, 'base64').toString('utf8');
    } catch (_) { /* unreadable on this machine */ }
    return null;
  }

  writeSecret(name, value) {
    const all = this.readJson(this.secretsFile);
    if (value === null || value === '') delete all[name];
    else if (this.canEncrypt()) all[name] = { enc: this.safeStorage.encryptString(String(value)).toString('base64') };
    else all[name] = { plain: Buffer.from(String(value), 'utf8').toString('base64') };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.secretsFile, JSON.stringify(all), { mode: 0o600 });
  }

  hasSecret(name) { return Boolean(this.readJson(this.secretsFile)[name]); }

  /** 32-byte key, created on first use (the AUDIT ledger key). */
  key(name) {
    let hex = this.readSecret(name);
    if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
      hex = crypto.randomBytes(32).toString('hex');
      this.writeSecret(name, hex);
    }
    return Buffer.from(hex, 'hex');
  }
}

module.exports = { Settings, SEARCH_ENGINES, DEFAULTS };
