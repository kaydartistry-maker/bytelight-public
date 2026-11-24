import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { initDb, getDb } from '../services/db/init.js';
import { issuePairingToken, consumePairingToken, pairingHash } from '../services/db/owner-pairing.js';
import { getWebSession } from '../services/db/web-sessions.js';
import { createPairingRoutes } from './pairing.js';
import { createWebRestOwner } from '../middleware/owner.js';
import { authMiddleware, logoutHandler } from '../middleware/auth.js';
import { loadConfig } from '../config.js';
import { builderRestOwner } from './builder-routes.js';
import { isHttps } from '../middleware/pairing-security.js';
initDb(':memory:');
after(() => getDb().close());
test('only hash and TTL metadata persist; atomic single use, boundary expiry, competing consumes', async () => {
  const token = issuePairingToken(1000);
  const row = getDb().prepare('SELECT * FROM owner_pairing_tokens WHERE token_hash = ?').get(pairingHash(token)) as Record<string, unknown>;
  assert.equal(row.expires_at, 601000); assert.equal(row.created_at, 1000); assert.equal(row.used_at, null);
  assert.ok(!JSON.stringify(row).includes(token));
  assert.equal(consumePairingToken(token, 601000), null);
  const fresh = issuePairingToken();
  const results = await Promise.all(Array.from({ length: 12 }, () => Promise.resolve().then(() => consumePairingToken(fresh))));
  assert.equal(results.filter(Boolean).length, 1);
  assert.ok(getWebSession(results.find(Boolean)!));
  assert.equal(consumePairingToken(fresh), null);
  assert.equal(consumePairingToken('bad'), null);
});
test('HTTPS forwarded proto must come from exact local trusted proxy', () => {
  const req = (peer: string, proto: string) => ({ secure: true, socket: { remoteAddress: peer }, headers: { 'x-forwarded-proto': proto } }) as never;
  assert.equal(isHttps(req('8.8.8.8', 'https')), false);
  assert.equal(isHttps(req('127.0.0.1', 'https,http')), false);
  assert.equal(isHttps(req('127.0.0.1', 'https')), true);
});
test('public exchange checks origin/HTTPS/payload, sets strict cookie, rate limits and revokes logout', async () => {
  const app = express(); app.set('trust proxy', 'loopback'); app.use(createPairingRoutes()); app.post('/logout', logoutHandler);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const host = new URL(base).host;
  const token = issuePairingToken();
  const post = (extra: Record<string,string> = {}, body: unknown = { token }) => fetch(base + '/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: `https://${host}`, 'x-forwarded-proto': 'https', ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ origin: 'https://evil.test' })).status, 400);
    assert.equal((await post({ 'x-forwarded-proto': 'http' })).status, 400);
    assert.equal((await post({}, { token: 'x'.repeat(65) })).status, 400);
    const response = await post(); assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
    const bearer = cookie.split(';')[0].split('=')[1]; assert.ok(getWebSession(bearer));
    const owner = createWebRestOwner(); assert.ok(owner({ method: 'GET', headers: { cookie: cookie.split(';')[0] } } as never));
    assert.equal((await post()).status, 400);
    assert.equal((await post()).status, 429);
    await fetch(base + '/logout', { method: 'POST', headers: { cookie: cookie.split(';')[0] } }); assert.equal(getWebSession(bearer), null);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('normal app stays passwordless and pairing does not unlock Builder REST', () => {
  const config = loadConfig(new URL('./nonexistent-test-config.yml', import.meta.url).pathname);
  const previous = config.auth.password; config.auth.password = '';
  try {
    let passed = false;
    authMiddleware({ headers: {} } as never, {} as never, () => { passed = true; });
    assert.ok(passed);
    const session = consumePairingToken(issuePairingToken())!;
    const request = { method: 'GET', headers: { cookie: `bytelight_session=${session}` } } as never;
    assert.ok(createWebRestOwner()(request));
    assert.throws(() => builderRestOwner(request), /configured owner authentication/);
  } finally { config.auth.password = previous; }
});

test('failed session insertion rolls back token consumption', () => {
  const token = issuePairingToken();
  getDb().exec("CREATE TRIGGER pairing_test_fail BEFORE INSERT ON web_sessions BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  try { assert.throws(() => consumePairingToken(token)); }
  finally { getDb().exec('DROP TRIGGER pairing_test_fail'); }
  assert.ok(consumePairingToken(token));
});

test('malformed private JSON never reaches error logger or reflects its body', async () => {
  const app = express(); app.use(createPairingRoutes());
  let forwarded = false;
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { forwarded = true; res.sendStatus(500); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"private-fixture' });
    assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('private-fixture')); assert.equal(forwarded, false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
