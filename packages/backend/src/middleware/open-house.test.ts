import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedHostsFrom, isLoopbackBind, openHouseGuard, openHouseHostAllowed } from './open-house.js';

test('only a loopback bind counts as this machine alone', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', ' LOCALHOST ']) assert.equal(isLoopbackBind(h), true, h);
  for (const h of ['0.0.0.0', '100.64.0.1', '192.168.1.5', '', undefined]) assert.equal(isLoopbackBind(h), false, String(h));
});

test('a house with no password answers its own address and its configured origins', () => {
  const allowed = allowedHostsFrom(['https://house.lan', 'http://192.168.1.20:3002', 'not a url']);
  assert.equal(openHouseHostAllowed('127.0.0.1:3002', allowed), true);
  assert.equal(openHouseHostAllowed('localhost', allowed), true);
  assert.equal(openHouseHostAllowed('house.lan', allowed), true);
  assert.equal(openHouseHostAllowed('192.168.1.20:3002', allowed), true);
  assert.equal(openHouseHostAllowed('rebind.example:3002', allowed), false, 'a rebound hostname is refused');
});

test('the guard steps aside once a password is set', () => {
  const allowed = allowedHostsFrom([]);
  const run = (hasPassword: boolean, host: string) => {
    let passed = false;
    let status = 0;
    const res = { status(code: number) { status = code; return { json() { /* refused */ } }; } };
    openHouseGuard(() => hasPassword, allowed)(
      { headers: { host }, method: 'GET', originalUrl: '/api/threads' } as never,
      res as never,
      () => { passed = true; },
    );
    return { passed, status };
  };
  assert.deepEqual(run(false, 'rebind.example:3002'), { passed: false, status: 421 });
  assert.deepEqual(run(false, '127.0.0.1:3002'), { passed: true, status: 0 });
  assert.deepEqual(run(true, 'rebind.example:3002'), { passed: true, status: 0 });
});

test('with no password, a request through a tunnel is refused even for a listed host (fourth outside audit, Nov 20 2026)', () => {
  const allowed = allowedHostsFrom(['https://my-house.lan']);
  assert.equal(openHouseHostAllowed('my-house.lan', allowed, {}), true, 'a listed name for this machine, directly');
  assert.equal(openHouseHostAllowed('my-house.lan', allowed, { 'cf-connecting-ip': '203.0.113.9' }), false);
  assert.equal(openHouseHostAllowed('my-house.lan', allowed, { 'x-forwarded-for': '203.0.113.9' }), false);
  assert.equal(openHouseHostAllowed('127.0.0.1:3002', allowed, { forwarded: 'for=203.0.113.9' }), false, 'even claiming loopback');
  let passed = false;
  openHouseGuard(() => true, allowed)({ headers: { host: 'x', 'x-forwarded-for': '1.2.3.4' }, method: 'GET', originalUrl: '/' } as never, {} as never, () => { passed = true; });
  assert.equal(passed, true, 'a password lifts it');
});

test('with no password, a public name in cors.origins is never answered, since a raw tunnel adds no header (outside re-check, Nov 24 2026)', () => {
  const allowed = allowedHostsFrom(['https://my-house.example.com', 'https://203.0.113.9', 'https://box.example.ts.net', 'http://100.101.102.103:3002', 'http://10.0.0.4']);
  assert.equal(openHouseHostAllowed('my-house.example.com', allowed, {}), false, 'ssh -R with a public name, no forwarding header');
  assert.equal(openHouseHostAllowed('203.0.113.9', allowed, {}), false, 'a public address');
  assert.equal(openHouseHostAllowed('box.example.ts.net', allowed, {}), true, 'a tailnet name');
  assert.equal(openHouseHostAllowed('100.101.102.103:3002', allowed, {}), true, 'a tailnet address');
  assert.equal(openHouseHostAllowed('10.0.0.4', allowed, {}), true, 'a home network address');
});
