'use strict';
// Semantic Snapshot Service (PSC-ARCH-001 §4.4, PSC-AGT-004 §3), L1 fidelity.
//
// These scripts run in an ISOLATED world of the SHADOW tab, never in the page's own world,
// so the page can neither read the handle table nor spoof it. The agent never sees the DOM:
// it sees a lossy outline of headings and interactive elements, each with an opaque handle
// ("e12") that is valid only for one snapshot generation (the anti-TOCTOU rule, §4.4.1).

const ISOLATED_WORLD_ID = 1789;

const SNAPSHOT_SCRIPT = `(() => {
  const st = (globalThis.__pspSnap = globalThis.__pspSnap || { gen: 0, els: new Map() });
  st.gen += 1;
  st.els = new Map();
  const clean = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      return ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', search: 'searchbox', range: 'slider', file: 'file' })[ty] || 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  const nameOf = (el) => {
    const lab = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
      (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '') ||
      el.innerText || el.getAttribute('name') || '';
    return clean(lab, 80);
  };
  const sel = 'h1,h2,h3,a[href],button,input:not([type=hidden]),select,textarea,summary,' +
    '[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=""],[contenteditable=true]';
  const lines = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (n >= 250) break;
    if (!visible(el)) continue;
    if (/^H[1-3]$/.test(el.tagName)) { const t = clean(el.innerText, 100); if (t) lines.push('#'.repeat(Number(el.tagName[1])) + ' ' + t); continue; }
    const id = 'e' + (++n);
    st.els.set(id, el);
    const role = roleOf(el);
    let line = '[' + id + '] ' + role + ' "' + nameOf(el) + '"';
    if (el.disabled) line += ' (disabled)';
    if (role === 'checkbox' || role === 'radio') line += el.checked ? ' (checked)' : ' (unchecked)';
    if (el.tagName === 'INPUT' && el.type === 'password') line += ' (password)';
    else if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) line += ' value="' + clean(el.value, 40) + '"';
    if (el.tagName === 'SELECT') line += ' options=[' + Array.from(el.options).slice(0, 8).map((o) => clean(o.text, 20)).join(' | ') + ']';
    if (el.tagName === 'A') { try { const u = new URL(el.href); line += ' -> ' + u.host + clean(u.pathname, 40); } catch (_) {} }
    lines.push(line);
  }
  const text = clean(document.body ? document.body.innerText : '', 3000);
  return { gen: st.gen, url: location.href, title: clean(document.title, 120), outline: lines.join('\\n'), text, count: n };
})()`;

/** Returns a script that scrolls the handle into view and reports its centre in CSS px. */
function locateScript(gen, handle) {
  return `(() => {
    const st = globalThis.__pspSnap;
    if (!st || st.gen !== ${Number(gen)}) return { error: 'stale' };
    const el = st.els.get(${JSON.stringify(handle)});
    if (!el || !el.isConnected) return { error: 'gone' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const tag = el.tagName;
    const editable = tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, editable, tag,
      type: (el.type || '').toLowerCase(), isPassword: tag === 'INPUT' && el.type === 'password' };
  })()`;
}

/** Focuses an editable element and selects its contents, so typed text replaces it. */
function focusScript(gen, handle) {
  return `(() => {
    const st = globalThis.__pspSnap;
    if (!st || st.gen !== ${Number(gen)}) return { error: 'stale' };
    const el = st.els.get(${JSON.stringify(handle)});
    if (!el || !el.isConnected) return { error: 'gone' };
    el.focus();
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    return { ok: document.activeElement === el };
  })()`;
}

module.exports = { ISOLATED_WORLD_ID, SNAPSHOT_SCRIPT, locateScript, focusScript };
