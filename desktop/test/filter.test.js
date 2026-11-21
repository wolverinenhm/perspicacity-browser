'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { FilterEngine } = require('../src/main/filter');

test('host rules block the host and its subdomains, not lookalikes', () => {
  const f = new FilterEngine();
  f.addList('||tracker.com^');
  assert.ok(f.match('https://tracker.com/x.js', 'https://site.com/').blocked);
  assert.ok(f.match('https://cdn.tracker.com/x.js', 'https://site.com/').blocked);
  assert.ok(!f.match('https://nottracker.com/x.js', 'https://site.com/').blocked);
  assert.ok(!f.match('https://tracker.com.evil.net/', 'https://site.com/').blocked);
});

test('third-party rules spare first-party requests', () => {
  const f = new FilterEngine();
  f.addList('||widgets.com^$third-party');
  assert.ok(f.match('https://widgets.com/w.js', 'https://news.com/').blocked);
  assert.ok(!f.match('https://static.widgets.com/w.js', 'https://www.widgets.com/').blocked);
});

test('exceptions win and path rules match by prefix', () => {
  const f = new FilterEngine();
  f.addList('||ads.com^\n@@||good.ads.com^\n||facebook.com/tr^');
  assert.ok(!f.match('https://good.ads.com/a', 'https://x.com/').blocked);
  assert.ok(f.match('https://bad.ads.com/a', 'https://x.com/').blocked);
  assert.ok(f.match('https://www.facebook.com/tr?id=1', 'https://x.com/').blocked);
  assert.ok(!f.match('https://www.facebook.com/profile', 'https://x.com/').blocked);
});

test('unsupported or cosmetic rules are skipped, hosts-file lines accepted', () => {
  const f = new FilterEngine();
  const n = f.addList('example.com##.ad\n||x.com^$domain=y.com\n/banner/*\n0.0.0.0 hosts.example\n! comment\n[Adblock Plus 2.0]');
  assert.strictEqual(n, 1);
  assert.ok(f.match('https://hosts.example/', 'https://a.com/').blocked);
});

test('the bundled list parses and blocks common trackers', () => {
  const f = new FilterEngine();
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'filters', 'trackers.txt'), 'utf8');
  const n = f.addList(text);
  assert.ok(n > 100, `only ${n} rules parsed`);
  assert.ok(f.match('https://www.google-analytics.com/analytics.js', 'https://news.com/').blocked);
  assert.ok(f.match('https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'https://news.com/').blocked);
  assert.ok(!f.match('https://www.wikipedia.org/', 'https://news.com/').blocked);
});
