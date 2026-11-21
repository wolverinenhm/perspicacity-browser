'use strict';
// URL and site helpers shared by the filter engine, circuit isolation and the omnibox.

// Common multi-label public suffixes. Not the full Public Suffix List: it errs towards
// grouping two sites together (fewer circuits), never towards splitting one site apart.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz', 'govt.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'com.tw', 'org.tw', 'com.sg', 'edu.sg', 'gov.sg', 'com.my', 'gov.my',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'co.za', 'org.za', 'gov.za',
  'com.mx', 'gob.mx', 'com.ar', 'gob.ar', 'com.tr', 'gov.tr', 'co.il', 'org.il', 'gov.il',
  'com.ua', 'co.id', 'or.id', 'go.id', 'com.vn', 'gov.vn', 'com.ph', 'gov.ph', 'com.pk',
  'com.ng', 'gov.ng', 'com.eg', 'com.sa', 'gov.sa', 'com.co', 'com.pe', 'com.ve', 'com.ec',
  'github.io', 'gitlab.io', 'blogspot.com', 'herokuapp.com', 'vercel.app', 'netlify.app',
  'pages.dev', 'workers.dev', 'appspot.com', 'cloudfront.net', 'azurewebsites.net',
  'firebaseapp.com', 'web.app', 'onrender.com', 'fly.dev', 'glitch.me', 'neocities.org',
]);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpLiteral(host) {
  return IPV4.test(host) || host.includes(':') || (host.startsWith('[') && host.endsWith(']'));
}

function normaliseHost(host) {
  return String(host || '').toLowerCase().replace(/\.$/, '');
}

/** eTLD+1 approximation ("site" in the HTML sense). */
function registrableDomain(host) {
  host = normaliseHost(host);
  if (!host) return '';
  if (isIpLiteral(host)) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

function siteOfUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return registrableDomain(u.hostname);
  } catch (_) {
    return '';
  }
}

function isOnion(host) {
  return normaliseHost(host).endsWith('.onion');
}

function isLoopback(host) {
  host = normaliseHost(host).replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const m = IPV4.exec(host);
  return Boolean(m && m[1] === '127');
}

/** HTTPS-Only mode (PSC-UTL-005 §2.6): upgrade plain http except onion and loopback. */
function httpsUpgrade(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return null;
    if (isOnion(u.hostname) || isLoopback(u.hostname)) return null;
    u.protocol = 'https:';
    if (u.port === '80') u.port = '';
    return u.toString();
  } catch (_) {
    return null;
  }
}

/** Schemes a tab is allowed to navigate to. Everything else is refused. */
function isNavigableUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || url === 'about:blank';
  } catch (_) {
    return false;
  }
}

/**
 * Turn omnibox input into a URL. Returns null for a scheme we refuse (file:, javascript:, ...).
 * searchTemplate contains "%s".
 */
function omniboxToUrl(input, searchTemplate) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|javascript|data|file|blob|chrome|view-source):/i.test(text)) {
    return isNavigableUrl(text) ? new URL(text).toString() : (text === 'about:blank' ? text : null);
  }
  const looksLikeHost = !/\s/.test(text) && (
    /^[^/?#]+\.[a-z0-9-]{2,}(:\d+)?([/?#].*)?$/i.test(text) ||
    /^localhost(:\d+)?([/?#].*)?$/i.test(text) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(text)
  );
  if (looksLikeHost) {
    const host = text.split(/[/:?#]/)[0];
    const scheme = isOnion(host) || isLoopback(host) ? 'http://' : 'https://';
    try {
      return new URL(scheme + text).toString();
    } catch (_) { /* fall through to search */ }
  }
  return searchTemplate.replace('%s', encodeURIComponent(text));
}

module.exports = {
  registrableDomain, siteOfUrl, isOnion, isLoopback, isIpLiteral, httpsUpgrade, isNavigableUrl, omniboxToUrl,
};
