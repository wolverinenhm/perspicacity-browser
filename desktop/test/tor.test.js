'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { bridgeLines, transportLines, parseBootstrap } = require('../src/main/tor');

const pt = {
  pluggableTransports: { lyrebird: 'ClientTransportPlugin meek_lite,obfs4,webtunnel exec ${pt_path}lyrebird' },
  bridges: { obfs4: ['obfs4 1.2.3.4:443 AAAA cert=x iat-mode=0'], snowflake: ['snowflake 192.0.2.3:80 BBBB'] },
};

test('bridgeLines picks built-in or custom bridges', () => {
  assert.deepStrictEqual(bridgeLines({ bridges: 'none' }, pt), []);
  assert.deepStrictEqual(bridgeLines({ bridges: 'obfs4' }, pt), pt.bridges.obfs4);
  assert.deepStrictEqual(bridgeLines({ bridges: 'custom', customBridges: 'Bridge obfs4 5.6.7.8:1 C\n\n  snowflake 1.1.1.1:1 D ' }, pt), ['obfs4 5.6.7.8:1 C', 'snowflake 1.1.1.1:1 D']);
  assert.deepStrictEqual(bridgeLines({ bridges: 'meek-azure' }, pt), []);
});

test('transport paths are relative to the tor folder (no spaces from install paths)', () => {
  const layout = { binDir: path.join('C:', 'Program Files', 'Perspicacity', 'resources', 'tor', 'tor'), ptDir: path.join('C:', 'Program Files', 'Perspicacity', 'resources', 'tor', 'tor', 'pluggable_transports') };
  const [line] = transportLines(layout, pt);
  assert.ok(line.includes(`exec pluggable_transports${path.sep}lyrebird`), line);
  assert.ok(!line.includes('Program Files'));
});

test('bootstrap lines parse with LF and CRLF endings', () => {
  const line = 'Nov 21 09:48:01.000 [notice] Bootstrapped 45% (requesting_descriptors): Asking for relay descriptors';
  assert.deepStrictEqual(parseBootstrap(line), { progress: 45, message: 'Asking for relay descriptors' });
  assert.deepStrictEqual(parseBootstrap(`${line}\r`), { progress: 45, message: 'Asking for relay descriptors' });
  assert.strictEqual(parseBootstrap('Nov 21 [notice] Opening Socks listener'), null);
});
