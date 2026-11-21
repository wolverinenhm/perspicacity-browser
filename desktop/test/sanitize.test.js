'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeFilename } = require('../src/main/sanitize');

test('strips paths, bidi tricks and illegal characters', () => {
  assert.strictEqual(sanitizeFilename('../../etc/passwd').name, 'passwd');
  assert.strictEqual(sanitizeFilename('C:\\Windows\\evil.txt').name, 'evil.txt');
  const r = sanitizeFilename('invoice\u202Efdp.exe');
  assert.strictEqual(r.name, 'invoicefdp.exe');
  assert.ok(r.dangerous);
  assert.strictEqual(sanitizeFilename('a<b>:c"d|e?f*.txt').name, 'a_b__c_d_e_f_.txt');
  assert.strictEqual(sanitizeFilename('   ...hidden ').name, 'hidden');
});

test('reserved device names and empty names are made safe', () => {
  assert.strictEqual(sanitizeFilename('CON.txt').name, '_CON.txt');
  assert.strictEqual(sanitizeFilename('nul').name, '_nul');
  assert.strictEqual(sanitizeFilename('').name, 'download');
});

test('flags executables and disguised double extensions', () => {
  assert.deepStrictEqual([sanitizeFilename('report.pdf').dangerous, sanitizeFilename('setup.msi').dangerous], [false, true]);
  const d = sanitizeFilename('invoice.pdf.exe');
  assert.ok(d.dangerous && d.disguised);
  assert.ok(!sanitizeFilename('archive.tar.gz').dangerous);
});

test('long names are cut but keep their extension', () => {
  const r = sanitizeFilename(`${'a'.repeat(400)}.pdf`);
  assert.ok(r.name.length <= 180);
  assert.ok(r.name.endsWith('.pdf'));
});
