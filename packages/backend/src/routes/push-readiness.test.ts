import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import webpush from 'web-push';

// All keys, vault writes and delivery attempts belong to this ephemeral DB.
const root = mkdtempSync(join(homedir(), '.virelle-push-readiness-test-'));
chmodSync(root, 0o700);
process.env.RESONANT_HOME = root;
process.env.VIRELLE_VAULT_KEY_FILE = join(root, 'vault.key');
for (const name of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_CONTACT']) delete process.env[name];
writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\nauth:\n  password: isolated-test-password\n');
const { initDb, createWebSession } = await import('../services/db.js');
const { getDb } = await import('../services/db/init.js');
const { loadConfig, getBytelightConfig } = await import('../config.js');
const { provisionVaultKey } = await import('../services/credential-vault.js');
const { getSecret, setSecret, setSecretsAtomically } = await import('../services/secrets.js');
const { PushService, validateVapidPair, validVapidContact } = await import('../services/push.js');
const { createPushRoutes } = await import('./push-routes.js');
const { readWebPushPreferences, webPushPreferenceKey } = await import('../services/push-preferences.js');
const { setConfig } = await import('../services/db/config.js');
const { registry } = await import('../services/registry.js');
let server: Server;
let app: express.Express;
let base = '';
const originalSend = webpush.sendNotification;
const originalGenerate = webpush.generateVAPIDKeys;
let sends: string[] = [];
let generated = 0;
let connected = false;
const originalConnected = registry.isUserConnected;
const ownerToken = 'isolated-push-owner-session';
const ownerHeaders = () => ({ cookie: `bytelight_session=${ownerToken}`, origin: base.replace('http:', 'https:'), 'x-forwarded-proto': 'https' });

before(async () => {
  provisionVaultKey(process.env.VIRELLE_VAULT_KEY_FILE!);
  loadConfig(join(root, 'config.yaml'));
  initDb(':memory:');
  createWebSession({ id: 'push-owner-test', token: ownerToken, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  app = express();
  app.use(express.json());
  app.use(createPushRoutes());
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No test port');
  base = `http://127.0.0.1:${addr.port}`;
  webpush.generateVAPIDKeys = () => { generated++; return originalGenerate(); };
  registry.isUserConnected = () => connected;
  webpush.sendNotification = (async (sub) => {
    sends.push(sub.endpoint);
    if (sub.endpoint.endsWith('/fail')) throw Object.assign(new Error('mock provider rejected'), { statusCode: 503 });
    return { statusCode: 201, body: '', headers: {} };
  }) as typeof webpush.sendNotification;
});
beforeEach(() => {
  getDb().exec("DELETE FROM config WHERE key LIKE 'secret:%' OR key LIKE 'push.web.preferences.%'; DELETE FROM push_subscriptions;");
  getBytelightConfig().auth.password = 'isolated-test-password';
  generated = 0;
  connected = false;
  sends = [];
  app.locals.pushService = new PushService();
});
after(() => {
  server?.close();
  webpush.sendNotification = originalSend;
  webpush.generateVAPIDKeys = originalGenerate;
  registry.isUserConnected = originalConnected;
  delete process.env.VIRELLE_VAULT_KEY_FILE;
  rmSync(root, { recursive: true, force: true });
});
async function post(path: string, body: unknown = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { ...ownerHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
async function preference(endpoint: string, notifyWhileConnected: unknown) {
  const res = await fetch(base + '/push/device-preferences', { method: 'PUT', headers: { ...ownerHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, notifyWhileConnected }) });
  return { status: res.status, body: await res.json() as any };
}
const contact = 'https://app.example/contact';
const setup = () => post('/push/setup-web', { contact });
const subscribe = (endpoint: string) => post('/push/subscribe', { endpoint, keys: { p256dh: 'mock-key', auth: 'mock-auth' } });

describe('safe web-push setup', () => {
  it('denies every sensitive push path without a real owner session, including passwordless configuration', async () => {
    getBytelightConfig().auth.password = '';
    for (const [method, path] of [
      ['GET', '/push/status'], ['GET', '/push/subscriptions'], ['POST', '/push/setup-web'],
      ['POST', '/push/check-device'], ['PUT', '/push/device-preferences'], ['POST', '/push/test'],
      ['POST', '/push/subscribe'], ['POST', '/push/unsubscribe'],
    ]) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: 'owner_session_required' });
    }
    assert.equal(generated, 0); assert.deepEqual(sends, []);
    assert.equal((getDb().prepare('SELECT COUNT(*) n FROM push_subscriptions').get() as { n: number }).n, 0);
  });
  it('rejects missing, cross-site and insecure Origin before any push mutation or delivery', async () => {
    for (const headers of [
      { cookie: `bytelight_session=${ownerToken}` },
      { ...ownerHeaders(), origin: 'https://attacker.invalid' },
      { ...ownerHeaders(), 'x-forwarded-proto': 'http' },
      { ...ownerHeaders(), cookie: 'bytelight_session=unknown' },
    ]) {
      for (const [method, path] of [['POST', '/push/setup-web'], ['POST', '/push/check-device'], ['PUT', '/push/device-preferences'], ['POST', '/push/test'], ['POST', '/push/subscribe'], ['POST', '/push/unsubscribe']]) {
        const response = await fetch(base + path, { method, headers });
        assert.equal(response.status, 403, `${method} ${path}`);
      }
    }
    assert.equal(generated, 0); assert.deepEqual(sends, []);
    assert.equal(getSecret('vapid_public_key'), undefined);
  });
  it('preserves same-origin HTTPS thin-shell FCM token registration without sending notifications', async () => {
    const result = await post('/push/subscribe', { deviceToken: 'isolated-native-token', deviceLabel: 'Mock HTTPS shell' });
    assert.equal(result.status, 200); assert.equal(result.body.transport, 'fcm');
    assert.equal((getDb().prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE type='fcm'").get() as { n: number }).n, 1);
    assert.deepEqual(sends, []);
  });
  it('reports empty readiness without generating keys or exposing private values', async () => {
    const res = await fetch(base + '/push/status', { headers: ownerHeaders() });
    const data = await res.json() as any;
    assert.deepEqual(data.webPush, { configured: false, publicKey: null, setupState: 'empty' });
    assert.equal(generated, 0);
  });
  it('requires configured owner authentication and validates contact before any writes', async () => {
    getBytelightConfig().auth.password = '';
    assert.equal((await setup()).status, 403);
    getBytelightConfig().auth.password = 'isolated-test-password';
    for (const value of ['person@example.com', 'http://app.example', 'https://u:p@app.example', 'mailto:bad', 'https://app.example/\nsecret']) {
      assert.equal((await post('/push/setup-web', { contact: value })).status, 400);
    }
    assert.equal(generated, 0);
    assert.equal(getSecret('vapid_public_key'), undefined);
  });
  it('atomically encrypts a new pair only when all slots are absent and hot-activates it', async () => {
    const result = await setup();
    assert.equal(result.status, 200);
    assert.equal(result.body.generated, true);
    assert.equal(generated, 1);
    const pub = getSecret('vapid_public_key')!;
    const priv = getSecret('vapid_private_key')!;
    validateVapidPair(pub, priv, contact);
    assert.equal(app.locals.pushService.getVapidPublicKey(), pub);
    const rows = getDb().prepare("SELECT value FROM config WHERE key LIKE 'secret:vapid_%'").all() as { value: string }[];
    assert.equal(rows.length, 3);
    for (const row of rows) { assert.match(row.value, /^virelle-vault:1:/); assert.notEqual(row.value, priv); }
    assert.ok(!JSON.stringify(result.body).includes(priv));
    assert.equal(sends.length, 0);
  });
  it('preserves a saved valid pair and can complete a missing contact without rotating', async () => {
    const pair = originalGenerate();
    setSecretsAtomically({ vapid_public_key: pair.publicKey, vapid_private_key: pair.privateKey });
    const result = await setup();
    assert.equal(result.status, 200);
    assert.equal(result.body.generated, false);
    assert.equal(getSecret('vapid_private_key'), pair.privateKey);
    assert.equal(getSecret('vapid_public_key'), pair.publicKey);
    assert.equal(generated, 0);
  });
  it('rejects partial saved key material and mismatched pairs without replacement', async () => {
    const first = originalGenerate();
    const second = originalGenerate();
    setSecret('vapid_public_key', first.publicKey);
    assert.equal((await setup()).status, 409);
    assert.equal(getSecret('vapid_private_key'), undefined);
    setSecret('vapid_private_key', second.privateKey);
    assert.equal((await setup()).status, 409);
    assert.equal(getSecret('vapid_public_key'), first.publicKey);
    assert.equal(getSecret('vapid_private_key'), second.privateKey);
    assert.equal(generated, 0);
  });
  it('does not generate a pair for a contact-only partial setup', async () => {
    setSecret('vapid_contact', contact);
    assert.equal((await setup()).status, 409);
    assert.equal(generated, 0);
    assert.equal(getSecret('vapid_public_key'), undefined);
    assert.equal(getSecret('vapid_contact'), contact);
  });
  it('does not rotate or regenerate an already active complete setup', async () => {
    await setup();
    const first = getSecret('vapid_private_key');
    const again = await setup();
    assert.equal(again.status, 200);
    assert.equal(again.body.generated, false);
    assert.equal(generated, 1);
    assert.equal(getSecret('vapid_private_key'), first);
  });
  it('does not substitute a newly saved key for the active sender public key', async () => {
    await setup();
    const active = app.locals.pushService.getVapidPublicKey();
    setSecret('vapid_public_key', originalGenerate().publicKey);
    assert.equal(app.locals.pushService.getVapidPublicKey(), active);
  });
  it('accepts only valid contact URI forms', () => {
    assert.equal(validVapidContact('mailto:owner@example.com'), true);
    assert.equal(validVapidContact(contact), true);
    assert.equal(validVapidContact('https://user:secret@app.example'), false);
  });
});

describe('atomic encrypted secret writes', () => {
  it('rejects invalid entries before modifying any row', () => {
    setSecret('vapid_contact', contact);
    assert.throws(() => setSecretsAtomically({ vapid_contact: 'https://replacement.example', unknown_slot: 'invalid' }), /Invalid secret/);
    assert.equal(getSecret('vapid_contact'), contact);
    assert.throws(() => setSecretsAtomically({ vapid_contact: '' }), /Invalid secret/);
    assert.throws(() => setSecretsAtomically({}), /non-empty/);
  });
  it('rolls back the whole set and restores synchronous mode on a mid-write failure', () => {
    setSecret('vapid_contact', contact);
    const db = getDb();
    const prior = db.pragma('synchronous', { simple: true });
    db.exec("CREATE TEMP TRIGGER fail_private BEFORE INSERT ON config WHEN NEW.key = 'secret:vapid_private_key' BEGIN SELECT RAISE(ABORT, 'mock disk failure'); END;");
    try {
      const pair = originalGenerate();
      assert.throws(() => setSecretsAtomically({ vapid_public_key: pair.publicKey, vapid_private_key: pair.privateKey, vapid_contact: 'https://replacement.example' }), /mock disk failure/);
      assert.equal(getSecret('vapid_public_key'), undefined);
      assert.equal(getSecret('vapid_private_key'), undefined);
      assert.equal(getSecret('vapid_contact'), contact);
      assert.equal(db.pragma('synchronous', { simple: true }), prior);
    } finally { db.exec('DROP TRIGGER fail_private'); }
  });
});

describe('honest test delivery and per-device registration', () => {
  it('rejects a test when no device is registered instead of claiming sent', async () => {
    await setup();
    const result = await post('/push/test');
    assert.equal(result.status, 409);
    assert.deepEqual(result.body.delivery, { attempted: 0, accepted: 0, failed: 0 });
  });
  it('tests only the requested registered browser and reports provider acceptance', async () => {
    await setup();
    await subscribe('https://push.example/this');
    await subscribe('https://push.example/other');
    assert.equal((await post('/push/check-device', { endpoint: 'https://push.example/this' })).body.registered, true);
    assert.equal((await post('/push/check-device', { endpoint: 'https://push.example/absent' })).body.registered, false);
    const result = await post('/push/test', { endpoint: 'https://push.example/this' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.delivery, { attempted: 1, accepted: 1, failed: 0 });
    assert.match(result.body.message, /receipt is not confirmed/);
    assert.deepEqual(sends, ['https://push.example/this']);
  });
  it('reports provider rejection as failure, never fulfilled-promise success', async () => {
    await setup();
    await subscribe('https://push.example/fail');
    const result = await post('/push/test', { endpoint: 'https://push.example/fail' });
    assert.equal(result.status, 502);
    assert.deepEqual(result.body.delivery, { attempted: 1, accepted: 0, failed: 1 });
  });
});

describe('explicit per-device connected-window delivery opt-in', () => {
  const first = 'https://push.example/first-device';
  const second = 'https://push.example/second-device';
  const payload = { title: 'Mock reply', body: 'Existing reply only', threadId: 'mock-thread' };

  it('keeps the existing connected-window suppression by default, without migrating a legacy flag', async () => {
    await setup();
    await subscribe(first);
    setConfig('phone.app-settings', JSON.stringify({ appSettings: { pushNotificationsEnabled: true } }));
    connected = true;
    await app.locals.pushService.sendIfOffline(payload);
    assert.deepEqual(sends, []);
    assert.deepEqual(readWebPushPreferences(first), { notifyWhileConnected: false });
    const rows = getDb().prepare("SELECT key FROM config WHERE key LIKE 'push.web.preferences.%'").all();
    assert.equal(rows.length, 0, 'reading absent preferences never creates an opt-in');
  });

  it('sends only to the explicitly opted-in web device while connected, including its own foreground window', async () => {
    await setup();
    await subscribe(first);
    await subscribe(second);
    assert.equal((await preference(first, true)).status, 200);
    assert.deepEqual((await post('/push/check-device', { endpoint: first })).body.preferences, { notifyWhileConnected: true });
    connected = true;
    let fcmCalls = 0;
    app.locals.pushService.sendFcm = async () => { fcmCalls++; return { attempted: 1, accepted: 1, failed: 0 }; };
    await app.locals.pushService.sendIfOffline(payload);
    assert.deepEqual(sends, [first]);
    assert.equal(fcmCalls, 0, 'web opt-in never broadens FCM connected delivery');
    assert.equal((await preference(first, false)).status, 200);
    sends = [];
    await app.locals.pushService.sendIfOffline(payload);
    assert.deepEqual(sends, []);
  });

  it('preserves all existing web and FCM delivery when no user window is connected', async () => {
    await setup();
    await subscribe(first);
    await subscribe(second);
    await preference(first, true);
    let fcmCalls = 0;
    app.locals.pushService.sendFcm = async () => { fcmCalls++; return { attempted: 1, accepted: 1, failed: 0 }; };
    connected = false;
    await app.locals.pushService.sendIfOffline(payload);
    assert.deepEqual(sends.sort(), [first, second].sort());
    assert.equal(fcmCalls, 1);
  });

  it('rejects updates for unknown devices and non-boolean preferences before writing', async () => {
    assert.equal((await preference(first, true)).status, 404);
    assert.deepEqual((await post('/push/check-device', { endpoint: first })).body, { registered: false, preferences: null });
    await subscribe(first);
    assert.equal((await preference(first, 'true')).status, 400);
    assert.equal(readWebPushPreferences(first).notifyWhileConnected, false);
  });

  it('fails closed on malformed stored values and never stores an endpoint in its config key', async () => {
    await setup();
    await subscribe(first);
    connected = true;
    const key = webPushPreferenceKey(first);
    assert.match(key, /^push\.web\.preferences\.[a-f0-9]{64}$/);
    assert.ok(!key.includes(first));
    for (const raw of ['not-json', 'true', '[]', '{"notifyWhileConnected":"true"}', '{"notifyWhileConnected":true,"unexpected":1}', '{}']) {
      setConfig(key, raw);
      assert.equal(readWebPushPreferences(first).notifyWhileConnected, false);
      await app.locals.pushService.sendIfOffline(payload);
    }
    assert.deepEqual(sends, []);
  });
});
