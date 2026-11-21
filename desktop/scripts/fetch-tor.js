#!/usr/bin/env node
'use strict';
// Downloads the official Tor Expert Bundle for the target platform into vendor/tor, after
// checking its SHA-256 against the checksum list Tor publishes next to it.
//   node scripts/fetch-tor.js [windows-x86_64|linux-x86_64] [version]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE = 'https://dist.torproject.org/torbrowser/';
const target = process.argv[2] || (process.platform === 'win32' ? 'windows-x86_64' : 'linux-x86_64');
const wanted = process.argv[3] || process.env.TOR_VERSION || '';
const outDir = path.join(__dirname, '..', 'vendor', 'tor');

async function get(url, binary = false) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
    } catch (e) {
      if (attempt === 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  return null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function main() {
  let versions = [];
  if (wanted) versions = [wanted];
  else {
    const index = await get(BASE);
    versions = [...new Set([...index.matchAll(/href="(\d+(?:\.\d+)+)\/"/g)].map((m) => m[1]))].sort(compareVersions);
  }
  for (const v of versions.slice(0, 6)) {
    const name = `tor-expert-bundle-${target}-${v}.tar.gz`;
    let sums;
    try { sums = await get(`${BASE}${v}/sha256sums-signed-build.txt`); } catch (_) { continue; }
    const line = sums.split('\n').find((l) => l.trim().endsWith(` ${name}`) || l.trim().endsWith(`*${name}`));
    if (!line) continue;
    const expected = line.trim().split(/\s+/)[0].toLowerCase();
    console.log(`Downloading ${name}`);
    const data = await get(`${BASE}${v}/${name}`, true);
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== expected) throw new Error(`checksum mismatch for ${name}: ${actual} != ${expected}`);
    fs.mkdirSync(outDir, { recursive: true });
    const archive = path.join(outDir, name);
    fs.writeFileSync(archive, data);
    execFileSync('tar', ['-xzf', name], { cwd: outDir, stdio: 'inherit' });
    fs.unlinkSync(archive);
    fs.writeFileSync(path.join(outDir, 'VERSION'), `${v}\n${name}\nsha256 ${actual}\n`);
    console.log(`Tor ${v} unpacked into ${outDir} (sha256 ${actual})`);
    return;
  }
  throw new Error(`no Tor Expert Bundle found for ${target}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
