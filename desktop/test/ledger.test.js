'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Ledger } = require('../src/main/ledger');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'audit.log');

test('appends a verifiable chain and resumes from disk', () => {
  const file = tmp();
  const key = crypto.randomBytes(32);
  const l = new Ledger(file, key);
  l.append('a', { x: 1 });
  l.append('b', null);
  const again = new Ledger(file, key);
  again.append('c', 'z');
  const v = again.verify();
  assert.deepStrictEqual([v.ok, v.count], [true, 3]);
});

test('detects edits, deletions and the wrong key', () => {
  const file = tmp();
  const key = crypto.randomBytes(32);
  const l = new Ledger(file, key);
  for (let i = 0; i < 4; i++) l.append('e', { i });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');

  fs.writeFileSync(file, `${lines.map((x, i) => (i === 1 ? x.replace('"i":1', '"i":9') : x)).join('\n')}\n`);
  assert.strictEqual(new Ledger(file, key).verify().at, 2);

  fs.writeFileSync(file, `${[lines[0], lines[2], lines[3]].join('\n')}\n`);
  assert.strictEqual(new Ledger(file, key).verify().ok, false);

  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  assert.strictEqual(new Ledger(file, crypto.randomBytes(32)).verify().ok, false);
  const broken = new Ledger(file, crypto.randomBytes(32));
  assert.throws(() => broken.append('x', 1), /refusing to append/);
});
