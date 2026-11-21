'use strict';
// Download filename sanitiser (PSC-UTL-005 §4). A page controls the suggested filename,
// so treat it as hostile: strip path tricks, bidi overrides and reserved device names,
// and flag anything the OS would execute.

const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'msc', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'ps1', 'psm1', 'psd1', 'hta', 'jar', 'lnk', 'url', 'reg', 'dll', 'sys', 'inf',
  'appx', 'appxbundle', 'msix', 'msixbundle', 'application', 'gadget', 'iso', 'img', 'vhd', 'vhdx',
  'apk', 'xapk', 'app', 'dmg', 'pkg', 'command', 'sh', 'run', 'bin', 'deb', 'rpm', 'appimage',
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'xll', 'chm', 'settingcontent-ms',
]);

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// Bidi controls and zero-width characters used to disguise extensions ("evil‮fdp.exe").
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const MAX_LENGTH = 180;

function sanitizeFilename(input) {
  let name = String(input || '').normalize('NFC');
  name = name.split(/[\\/]/).pop();
  name = name.replace(INVISIBLE, '').replace(ILLEGAL, '_');
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  name = name.replace(/\s+/g, ' ');
  if (!name) name = 'download';
  if (RESERVED.test(name)) name = `_${name}`;

  if (name.length > MAX_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_LENGTH - ext.length) + ext;
  }

  const parts = name.toLowerCase().split('.');
  const ext = parts.length > 1 ? parts[parts.length - 1] : '';
  const dangerous = DANGEROUS_EXTENSIONS.has(ext);
  // "invoice.pdf.exe": a decoy extension in front of an executable one.
  const disguised = dangerous && parts.length > 2 && /^[a-z0-9]{2,4}$/.test(parts[parts.length - 2]);
  return { name, extension: ext, dangerous, disguised };
}

module.exports = { sanitizeFilename, DANGEROUS_EXTENSIONS };
