'use strict';
// Browser-chrome preload: a narrow, typed bridge. The UI can send commands from a fixed
// list and receive state; it has no Node access and cannot reach tabs directly.
const { contextBridge, ipcRenderer } = require('electron');

const COMMANDS = new Set([
  'state', 'newTab', 'closeTab', 'activate', 'navigate', 'back', 'forward', 'reload', 'stop', 'allowHttp',
  'newIdentity', 'retryTor', 'overlay', 'zoom', 'getSettings', 'setSettings', 'toggleAgent', 'agentStart',
  'agentStop', 'agentApprove', 'ledger', 'openInShadow',
]);

contextBridge.exposeInMainWorld('psp', {
  cmd: (name, args) => (COMMANDS.has(name) ? ipcRenderer.invoke('ui:cmd', name, args || {}) : Promise.reject(new Error('unknown command'))),
  onState: (fn) => ipcRenderer.on('ui:state', (_e, s) => fn(s)),
  onToast: (fn) => ipcRenderer.on('ui:toast', (_e, t) => fn(t)),
  onFocusUrl: (fn) => ipcRenderer.on('ui:focus-url', () => fn()),
  platform: process.platform,
});
