'use strict';
const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/main/site');

test('registrableDomain groups subdomains and handles multi-label suffixes', () => {
  assert.strictEqual(s.registrableDomain('www.example.com'), 'example.com');
  assert.strictEqual(s.registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.strictEqual(s.registrableDomain('user.github.io'), 'user.github.io');
  assert.strictEqual(s.registrableDomain('EXAMPLE.com.'), 'example.com');
  assert.strictEqual(s.registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.strictEqual(s.registrableDomain('x.abcdefghijklmnop.onion'), 'abcdefghijklmnop.onion');
});

test('httpsUpgrade upgrades clearnet http only', () => {
  assert.strictEqual(s.httpsUpgrade('http://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.strictEqual(s.httpsUpgrade('http://example.com:80/'), 'https://example.com/');
  assert.strictEqual(s.httpsUpgrade('https://example.com/'), null);
  assert.strictEqual(s.httpsUpgrade('http://abc.onion/'), null);
  assert.strictEqual(s.httpsUpgrade('http://localhost:3000/'), null);
  assert.strictEqual(s.httpsUpgrade('http://127.0.0.1/'), null);
});

test('omniboxToUrl distinguishes addresses, searches and forbidden schemes', () => {
  const t = 'https://search.test/?q=%s';
  assert.strictEqual(s.omniboxToUrl('example.com', t), 'https://example.com/');
  assert.strictEqual(s.omniboxToUrl('example.com/path?x=1', t), 'https://example.com/path?x=1');
  assert.strictEqual(s.omniboxToUrl('abcdefghijklmnop.onion', t), 'http://abcdefghijklmnop.onion/');
  assert.strictEqual(s.omniboxToUrl('localhost:8080', t), 'http://localhost:8080/');
  assert.strictEqual(s.omniboxToUrl('what is tor', t), 'https://search.test/?q=what%20is%20tor');
  assert.strictEqual(s.omniboxToUrl('node.js', t), 'https://node.js/');
  assert.strictEqual(s.omniboxToUrl('javascript:alert(1)', t), null);
  assert.strictEqual(s.omniboxToUrl('file:///etc/passwd', t), null);
  assert.strictEqual(s.omniboxToUrl('https://example.com', t), 'https://example.com/');
  assert.strictEqual(s.omniboxToUrl('   ', t), null);
});

test('isNavigableUrl allows only http(s) and about:blank', () => {
  assert.ok(s.isNavigableUrl('https://a.com'));
  assert.ok(s.isNavigableUrl('about:blank'));
  assert.ok(!s.isNavigableUrl('file:///c:/'));
  assert.ok(!s.isNavigableUrl('chrome://settings'));
  assert.ok(!s.isNavigableUrl('not a url'));
});
