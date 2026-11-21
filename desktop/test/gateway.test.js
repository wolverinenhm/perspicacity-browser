'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { IsolatingSocksGateway, probeSocks } = require('../src/main/gateway');

/** A fake Tor SocksPort: requires username auth, records usernames, echoes data back. */
function fakeTor() {
  const seen = [];
  const server = net.createServer((s) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
          const methods = buf.subarray(2, 2 + buf[1]);
          buf = buf.subarray(2 + buf[1]);
          if (methods.includes(0x02)) { s.write(Buffer.from([5, 2])); stage = 1; } else if (methods.includes(0)) { s.write(Buffer.from([5, 0])); stage = 2; } else { s.end(Buffer.from([5, 0xff])); return; }
        } else if (stage === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
          const ul = buf[1];
          const user = buf.subarray(2, 2 + ul).toString();
          const pl = buf[2 + ul];
          buf = buf.subarray(3 + ul + pl);
          seen.push({ user });
          s.write(Buffer.from([1, 0]));
          stage = 2;
        } else if (stage === 2 && buf.length >= 5) {
          const atyp = buf[3];
          const need = atyp === 3 ? 5 + buf[4] + 2 : atyp === 1 ? 10 : 22;
          if (buf.length < need) return;
          const host = atyp === 3 ? buf.subarray(5, 5 + buf[4]).toString() : 'ip';
          if (seen.length) seen[seen.length - 1].host = host;
          buf = buf.subarray(need);
          s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          stage = 3;
        } else if (stage === 3 && buf.length) {
          s.write(buf); buf = Buffer.alloc(0);
        } else return;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

function socksConnect(port, host, payload, cmd = 1) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let stage = 0;
    let buf = Buffer.alloc(0);
    s.on('error', reject);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('close', () => resolve({ stage, reply: buf }));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        buf = buf.subarray(2);
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, cmd, 0, 3, h.length]), h, Buffer.from([0, 80])]));
        stage = 1;
      } else if (stage === 1 && buf.length >= 10) {
        const rep = buf[1];
        buf = buf.subarray(10);
        if (rep !== 0) { stage = `rep${rep}`; s.destroy(); return; }
        stage = 2;
        s.write(payload);
      } else if (stage === 2 && buf.length >= payload.length) {
        resolve({ stage, echo: buf.toString() });
        s.destroy();
      }
    });
  });
}

test('relays CONNECT through upstream with the isolation key as SOCKS username', async () => {
  const tor = await fakeTor();
  let key = 'tabA|example.com';
  const gw = new IsolatingSocksGateway({ upstream: () => ({ host: '127.0.0.1', port: tor.port }), keyFor: () => key });
  const port = await gw.listen();
  const r1 = await socksConnect(port, 'example.com', Buffer.from('hello'));
  assert.strictEqual(r1.echo, 'hello');
  key = 'tabA|other.org';
  await socksConnect(port, 'other.org', Buffer.from('x'));
  assert.deepStrictEqual(tor.seen.map((s) => [s.user, s.host]), [['tabA|example.com', 'example.com'], ['tabA|other.org', 'other.org']]);
  await gw.close();
  tor.server.close();
});

test('fails closed when Tor is not ready, and refuses UDP ASSOCIATE', async () => {
  const gw = new IsolatingSocksGateway({ upstream: () => null, keyFor: () => 'k' });
  const port = await gw.listen();
  const r = await socksConnect(port, 'example.com', Buffer.from('x'));
  assert.strictEqual(r.stage, 'rep3');
  const tor = await fakeTor();
  const gw2 = new IsolatingSocksGateway({ upstream: () => ({ host: '127.0.0.1', port: tor.port }), keyFor: () => 'k' });
  const port2 = await gw2.listen();
  const u = await socksConnect(port2, 'example.com', Buffer.from('x'), 3);
  assert.strictEqual(u.stage, 'rep7');
  assert.strictEqual(tor.seen.length, 0);
  await gw.close(); await gw2.close(); tor.server.close();
});

test('probeSocks recognises a SOCKS5 server and rejects silence', async () => {
  const tor = await fakeTor();
  assert.strictEqual(await probeSocks('127.0.0.1', tor.port), true);
  const dead = net.createServer((s) => s.end());
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  assert.strictEqual(await probeSocks('127.0.0.1', dead.address().port, 500), false);
  tor.server.close(); dead.close();
});
