'use strict';
// VEIL frame preload (sandboxed). Fetches the canonical fingerprint shim from the browser
// process and runs it in the page's main world before any page script.
const { ipcRenderer, contextBridge, webFrame } = require('electron');

let source = '';
try { source = ipcRenderer.sendSync('veil:shim'); } catch (_) { source = ''; }

if (source) {
  let done = false;
  if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(source);
      contextBridge.executeInMainWorld({ func: fn, args: [] });
      done = true;
    } catch (_) { done = false; }
  }
  if (!done) {
    try { webFrame.executeJavaScript(`(function(){${source}\n})();`); } catch (_) { /* nothing else to try */ }
  }
}
