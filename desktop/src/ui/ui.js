'use strict';
/* global psp */
// Browser chrome. Renders state pushed by the main process; every action is a command
// over the narrow bridge in ui-preload.js. No page content ever runs in this document.

(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let editingUrl = false;
  let lastLogLen = -1;

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) n.append(kid);
    return n;
  };

  const cmd = (name, args) => psp.cmd(name, args).catch((e) => toast(e.message));
  const active = () => (state ? state.tabs.find((t) => t.id === state.activeId) : null);

  // ---- overlays (menu / modal) hide the page view so they are visible ------
  let overlayDepth = 0;
  function overlay(on) {
    overlayDepth = Math.max(0, overlayDepth + (on ? 1 : -1));
    cmd('overlay', { on: overlayDepth > 0 });
  }

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 5000);
  }

  // ---- render --------------------------------------------------------------
  function render() {
    if (!state) return;
    const tab = active();
    renderTabs();
    const plane = tab ? tab.plane : 'veil';

    const badge = $('plane-badge');
    badge.className = 'badge';
    if (plane === 'shadow') { badge.classList.add('shadow'); badge.textContent = state.shadowRouting === 'direct' ? 'SHADOW · direct' : 'SHADOW'; }
    else if (state.clearnet) { badge.classList.add('clearnet'); badge.textContent = 'VEIL · NO TOR'; }
    else badge.textContent = 'VEIL';

    if (!editingUrl) $('omnibox').value = tab ? tab.url : '';
    $('back').disabled = !tab || !tab.canBack;
    $('forward').disabled = !tab || !tab.canFwd;
    $('reload').innerHTML = tab && tab.loading ? '&#215;' : '&#8635;';
    $('reload').title = tab && tab.loading ? 'Stop' : 'Reload (Ctrl+R)';
    $('shield').textContent = `${tab ? tab.blockedCount : 0} blocked`;

    const tor = state.tor;
    const pill = $('tor-pill');
    pill.className = 'pill';
    let tt = 'Tor';
    if (tor.phase === 'ready') { pill.classList.add('ready'); tt = tor.mode === 'external' ? 'Tor (external)' : 'Tor connected'; }
    else if (tor.phase === 'bootstrapping') { pill.classList.add('starting'); tt = `Tor ${tor.progress}%`; }
    else { pill.classList.add('down'); tt = tor.phase === 'unavailable' ? 'Tor not found' : tor.phase === 'failed' ? 'Tor failed' : 'Tor off'; }
    $('tor-text').textContent = tt;
    pill.title = tor.message;

    // stage pages
    const showNew = tab && !tab.url && !tab.blocked && !tab.error;
    const showTor = tab && tab.blocked === 'tor';
    const showErr = tab && tab.error && !showTor;
    $('page-newtab').classList.toggle('hidden', !showNew);
    $('page-tor').classList.toggle('hidden', !showTor);
    $('page-error').classList.toggle('hidden', !showErr);
    $('letterbox-note').classList.toggle('hidden', !(tab && tab.plane === 'veil' && tab.url && !showTor && !showErr));
    if (showNew) renderNewTab(tab);
    if (showTor) {
      $('tor-msg').textContent = tor.message;
      $('tor-bar').style.width = `${tor.progress}%`;
    }
    if (showErr) {
      $('err-desc').textContent = tab.error.desc || `Error ${tab.error.code}`;
      $('err-url').textContent = tab.error.url || '';
      $('err-http').classList.toggle('hidden', !tab.error.canHttp);
    }
    renderAgent(tab);
  }

  function renderTabs() {
    const box = $('tabs');
    box.textContent = '';
    for (const t of state.tabs) {
      const node = el('div', {
        class: `tab ${t.plane}${t.id === state.activeId ? ' active' : ''}`,
        role: 'tab', title: `${t.plane === 'veil' ? 'VEIL' : 'Shadow'} · ${t.title}\n${t.url}`,
        onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); cmd('closeTab', { id: t.id }); } else if (e.button === 0) cmd('activate', { id: t.id }); },
      },
      t.loading ? el('span', { class: 'spin' }) : null,
      el('span', { class: 't', text: t.title || t.url || 'New tab' }),
      el('button', { class: 'x', title: 'Close tab (Ctrl+W)', 'aria-label': 'Close tab', text: '×', onmousedown: (e) => e.stopPropagation(), onclick: () => cmd('closeTab', { id: t.id }) }));
      box.append(node);
    }
  }

  function renderNewTab(tab) {
    const veil = tab.plane === 'veil';
    $('newtab-sub').textContent = veil
      ? (state.clearnet ? 'VEIL without Tor: private storage, but your IP address is visible.' : 'A VEIL tab: Tor-routed, nothing saved, one fingerprint shared by every user.')
      : 'A Shadow tab: persistent session for agent work. Not anonymous by design.';
    $('hero-input').placeholder = veil ? 'Search privately' : 'Search or open a page for the agent';
    const facts = veil ? [
      ['Own circuit', 'Each site in each tab gets its own Tor circuit.'],
      ['RAM only', 'Cookies, cache and storage vanish when the tab closes.'],
      ['Uniform fingerprint', 'Timezone, screen size, canvas and user agent are the same for everyone.'],
      [`${state.filterRules} tracker rules`, 'Ads, analytics and fingerprinting scripts are blocked.'],
    ] : [
      ['Agent workspace', 'Open the Agent panel and describe a task.'],
      ['You approve effects', 'Typing, navigating and clicking need your OK.'],
      ['Audit ledger', 'Every approval is written to a tamper-evident log.'],
      ['Separate identity', 'No cookies, circuits or memory are shared with VEIL.'],
    ];
    const ul = $('newtab-facts');
    ul.textContent = '';
    for (const [b, t] of facts) ul.append(el('li', {}, el('b', { text: b }), document.createTextNode(t)));
  }

  function renderAgent(tab) {
    document.body.classList.toggle('panel-open', state.agent.open);
    $('agent-panel').classList.toggle('hidden', !state.agent.open);
    if (!state.agent.open) return;
    const a = state.agent;
    $('agent-provider').textContent = a.provider === 'anthropic' ? 'Claude (remote)' : 'Ollama (local)';
    const usable = tab && tab.plane === 'shadow' && tab.url;
    $('agent-hint').textContent = !tab || tab.plane !== 'shadow'
      ? 'The agent works only in Shadow tabs, never in VEIL. Open a Shadow tab (Ctrl+Shift+S) and load a page.'
      : !tab.url ? 'Load a page in this Shadow tab first.' : 'The agent sees an outline of this page and asks before typing, navigating or clicking.';
    $('agent-run').disabled = !usable || a.running;
    $('agent-stop').classList.toggle('hidden', !a.running);
    $('agent-task').disabled = a.running;
    const ap = $('approval');
    ap.classList.toggle('hidden', !a.pending);
    if (a.pending) { $('approval-text').textContent = a.pending.description; ap.dataset.id = a.pending.id; }
    if (a.log.length !== lastLogLen || a.log.length === 0) {
      lastLogLen = a.log.length;
      const ol = $('agent-log');
      ol.textContent = '';
      for (const e of a.log) ol.append(el('li', { class: e.kind, text: e.text }));
      ol.scrollTop = ol.scrollHeight;
    }
  }

  // ---- settings ------------------------------------------------------------
  async function openSettings() {
    const s = await cmd('getSettings');
    if (!s) return;
    const body = $('modal-body');
    body.textContent = '';
    const field = (label, input, hint) => el('div', { class: 'field' }, el('label', { text: label }), input, hint ? el('div', { class: 'hint', text: hint }) : null);
    const select = (id, options, value) => {
      const sel = el('select', { id });
      for (const [v, t] of options) { const o = el('option', { value: v, text: t }); if (v === value) o.selected = true; sel.append(o); }
      return sel;
    };

    body.append(
      field('Search engine', select('s-engine', Object.entries(s.engines).map(([k, v]) => [k, v.name]), s.searchEngine)),
      field('Security level', select('s-level', [['standard', 'Standard'], ['safest', 'Safest: JavaScript off in VEIL']], s.securityLevel), 'Applies to tabs opened after the change.'),
      field('Tor bridges', select('s-bridges', [['none', 'None (connect directly to Tor)'], ['obfs4', 'obfs4 (built-in)'], ['snowflake', 'Snowflake (built-in)'], ['meek-azure', 'meek-azure (built-in)'], ['custom', 'Custom bridge lines']], s.bridges), 'Use a bridge if Tor is blocked where you are. Built-in bridges need the bundled Tor.'),
      field('Custom bridges', el('textarea', { id: 's-custom-bridges', rows: '3', placeholder: 'obfs4 1.2.3.4:443 FINGERPRINT cert=... iat-mode=0' }), 'One bridge per line. Get bridges from bridges.torproject.org.'),
      field('Shadow tabs connect', select('s-shadow', [['tor', 'Through Tor (separate circuits from VEIL)'], ['direct', 'Directly (faster, shows your IP address)']], s.shadowRouting)),
      el('div', { class: 'field check' }, el('label', {}, Object.assign(el('input', { type: 'checkbox', id: 's-clearnet' }), { checked: s.veilAllowClearnet }),
        el('span', {}, el('b', { text: 'Let VEIL tabs load without Tor ' }), el('span', { class: 'warn', text: 'Not anonymous: sites see your IP address. VEIL stays RAM-only with a uniform fingerprint.' })))),
      field('Extra filter rules', el('textarea', { id: 's-filters', rows: '4', placeholder: '||example-tracker.com^\n@@||site-that-broke.com^' }), 'Adblock-style host rules, one per line.'),
      el('h3', { text: 'Agent model' }),
      field('Provider', select('s-provider', [['ollama', 'Ollama on this computer (private, default)'], ['anthropic', 'Claude via the Anthropic API (remote)']], s.agent.provider), 'A remote model is a network party: page outlines from Shadow tabs are sent to it. VEIL content never is.'),
      field('Ollama address', Object.assign(el('input', { type: 'text', id: 's-ollama-url' }), { value: s.agent.ollamaUrl })),
      field('Ollama model', Object.assign(el('input', { type: 'text', id: 's-ollama-model' }), { value: s.agent.ollamaModel }), 'Any model that supports structured output, e.g. llama3.1, qwen2.5.'),
      field('Claude model', Object.assign(el('input', { type: 'text', id: 's-anthropic-model' }), { value: s.agent.anthropicModel })),
      field('Anthropic API key', el('input', { type: 'password', id: 's-key', placeholder: s.hasAnthropicKey ? 'Saved (leave empty to keep, type a space to remove)' : 'sk-ant-...' }), 'Stored encrypted with your operating system keystore.'),
      field('Max agent steps', Object.assign(el('input', { type: 'text', id: 's-steps' }), { value: String(s.agent.maxSteps) })),
      el('div', { class: 'row' }, el('button', { class: 'primary', text: 'Save', onclick: saveSettings })),
    );
    $('s-custom-bridges').value = s.customBridges;
    $('s-filters').value = s.customFilters;
    showModal('Settings');
  }

  async function saveSettings() {
    const v = (id) => $(id).value;
    const patch = {
      searchEngine: v('s-engine'), securityLevel: v('s-level'), bridges: v('s-bridges'), customBridges: v('s-custom-bridges'),
      shadowRouting: v('s-shadow'), veilAllowClearnet: $('s-clearnet').checked, customFilters: v('s-filters'),
      agent: { provider: v('s-provider'), ollamaUrl: v('s-ollama-url').trim(), ollamaModel: v('s-ollama-model').trim(), anthropicModel: v('s-anthropic-model').trim(), maxSteps: Number(v('s-steps')) },
    };
    const args = { patch };
    const key = v('s-key');
    if (key) args.anthropicApiKey = key;
    await cmd('setSettings', args);
    hideModal();
    toast('Settings saved.');
  }

  async function openLedger() {
    const r = await cmd('ledger');
    if (!r) return;
    const body = $('modal-body');
    body.textContent = '';
    body.append(el('p', { class: r.verify.ok ? '' : 'warn', text: r.verify.ok ? `Chain verified: ${r.verify.count} entries, no gaps or edits.` : `Verification FAILED at entry ${r.verify.at}: ${r.verify.reason}.` }));
    body.append(el('p', { class: 'muted small', text: 'Agent approvals, refusals and actions in Shadow tabs, plus New Identity events (without any VEIL addresses). Each entry is HMAC-chained to the one before it.' }));
    for (const e of r.entries.slice().reverse()) body.append(el('div', { class: 'ledger-entry', text: `#${e.seq} ${e.ts} ${e.kind} ${JSON.stringify(e.data)}` }));
    showModal('Audit ledger');
  }

  function openAbout() {
    const body = $('modal-body');
    body.textContent = '';
    body.append(
      el('p', { text: 'Perspicacity 0.1: a privacy browser built from the Perspicacity specification (VEIL / SHADOW planes).' }),
      el('p', { class: 'muted', text: 'This desktop build uses Chromium through Electron, not the Tor-Browser-derived Gecko engine the specification chooses. It protects against trackers, cross-site correlation and casual fingerprinting, but it is not a substitute for Tor Browser when your safety depends on anonymity.' }),
      el('p', { class: 'muted small', text: `Tor: ${state.tor.mode} · ${state.tor.message}` }),
    );
    showModal('About Perspicacity');
  }

  function showModal(title) { $('modal-title').textContent = title; $('modal').classList.remove('hidden'); overlay(true); }
  function hideModal() { if ($('modal').classList.contains('hidden')) return; $('modal').classList.add('hidden'); overlay(false); }
  function toggleMenu(show) {
    const m = $('menu');
    const open = show === undefined ? m.classList.contains('hidden') : show;
    if (open === !m.classList.contains('hidden')) return;
    m.classList.toggle('hidden', !open);
    overlay(open);
  }

  // ---- events --------------------------------------------------------------
  $('new-veil').onclick = () => cmd('newTab', { plane: 'veil' });
  $('new-shadow').onclick = () => cmd('newTab', { plane: 'shadow' });
  $('back').onclick = () => cmd('back');
  $('forward').onclick = () => cmd('forward');
  $('reload').onclick = () => { const t = active(); cmd(t && t.loading ? 'stop' : 'reload'); };
  $('identity').onclick = () => cmd('newIdentity');
  $('tor-pill').onclick = () => { if (state && state.tor.phase !== 'ready') cmd('retryTor'); else toast(state ? state.tor.message : ''); };
  $('agent-toggle').onclick = () => cmd('toggleAgent', { open: !(state && state.agent.open) });
  $('agent-close').onclick = () => cmd('toggleAgent', { open: false });
  $('menu-btn').onclick = () => toggleMenu();
  $('modal-close').onclick = hideModal;
  $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) hideModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { toggleMenu(false); hideModal(); if (document.activeElement === $('omnibox')) $('omnibox').blur(); }
  });
  document.addEventListener('mousedown', (e) => { if (!$('menu').contains(e.target) && e.target !== $('menu-btn')) toggleMenu(false); });
  $('menu').addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    toggleMenu(false);
    if (act === 'new-shadow') cmd('newTab', { plane: 'shadow' });
    else if (act === 'open-in-shadow') cmd('openInShadow');
    else if (act === 'settings') openSettings();
    else if (act === 'ledger') openLedger();
    else if (act === 'about') openAbout();
  });

  const omni = $('omnibox');
  omni.addEventListener('focus', () => { editingUrl = true; omni.select(); });
  omni.addEventListener('blur', () => { editingUrl = false; render(); });
  $('omnibox-form').addEventListener('submit', (e) => { e.preventDefault(); const v = omni.value; omni.blur(); if (v.trim()) cmd('navigate', { input: v }); });
  $('hero-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('hero-input').value; $('hero-input').value = ''; if (v.trim()) cmd('navigate', { input: v }); });
  $('tor-retry').onclick = () => cmd('retryTor');
  $('tor-settings').onclick = openSettings;
  $('err-retry').onclick = () => cmd('reload');
  $('err-http').onclick = () => cmd('allowHttp');

  $('agent-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const task = $('agent-task').value.trim();
    if (!task) return;
    cmd('agentStart', { task, autoClicks: $('agent-autoclick').checked });
  });
  $('agent-stop').onclick = () => cmd('agentStop');
  $('approve-yes').onclick = () => cmd('agentApprove', { reqId: Number($('approval').dataset.id), ok: true });
  $('approve-no').onclick = () => cmd('agentApprove', { reqId: Number($('approval').dataset.id), ok: false });

  psp.onState((s) => { state = s; render(); });
  psp.onToast(toast);
  psp.onFocusUrl(() => { omni.focus(); omni.select(); });
  cmd('state').then((s) => { if (s) { state = s; render(); } });
})();
