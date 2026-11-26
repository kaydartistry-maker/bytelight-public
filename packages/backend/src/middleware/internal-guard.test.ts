import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directLocalCheck } from './internal-guard.js';

const local = (headers: Record<string, unknown>) => directLocalCheck({ socket: { remoteAddress: '127.0.0.1' }, headers });

test('our own loopback calls still pass, by any loopback name', () => {
  for (const host of ['127.0.0.1:3013', 'localhost:3003', '[::1]:3013', '127.0.0.1', 'LOCALHOST']) {
    assert.deepEqual(local({ host }), { ok: true }, host);
  }
  assert.deepEqual(local({}), { ok: true });
});

test('a rebound hostname on a loopback socket is refused', () => {
  // DNS rebinding: the socket is loopback and no proxy header is set, but the
  // browser still sends the page's own hostname.
  const verdict = local({ host: 'evil.example:3013' });
  assert.equal(verdict.ok, false);
  assert.equal(local({ host: '127.0.0.1.evil.example' }).ok, false);
});

test('proxy headers and remote sockets are still refused', () => {
  assert.equal(local({ host: '127.0.0.1:3013', 'x-forwarded-for': '1.2.3.4' }).ok, false);
  assert.equal(directLocalCheck({ socket: { remoteAddress: '10.0.0.5' }, headers: { host: '127.0.0.1' } }).ok, false);
});

test('a request a browser stamped as coming from a page is refused', () => {
  // A form POST from a page on this box arrives on a loopback socket with a
  // loopback Host; only Origin and Sec-Fetch-Site give it away.
  assert.equal(local({ host: '127.0.0.1:3013', origin: 'https://evil.test' }).ok, false);
  assert.equal(local({ host: '127.0.0.1:3013', 'sec-fetch-site': 'cross-site' }).ok, false);
  assert.equal(local({ host: '127.0.0.1:3013', 'sec-fetch-site': 'same-site' }).ok, false);
  // Our own callers send neither; node's fetch adds only sec-fetch-mode.
  assert.deepEqual(local({ host: '127.0.0.1:3013', 'sec-fetch-mode': 'cors' }), { ok: true });
  assert.deepEqual(local({ host: '127.0.0.1:3013', 'sec-fetch-site': 'none' }), { ok: true });
});
