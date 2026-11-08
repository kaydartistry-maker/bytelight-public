import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { initDb } from './db.js';
import { getDb } from './db/init.js';
import { addFcmSubscription, listFcmSubscriptions } from './db/push.js';
import { setSecret, deleteSecret } from './secrets.js';
import { PushService } from './push.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  type: 'service_account',
  project_id: 'house-test',
  client_email: 'push@house-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; body: string; auth?: string }> = [];

before(() => {
  initDb(':memory:');
  globalThis.fetch = (async (url: string, init: { body?: unknown; headers?: Record<string, string> }) => {
    const body = String(init.body ?? '');
    calls.push({ url: String(url), body, auth: init.headers?.Authorization });
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
    }
    if (body.includes('dead-token')) {
      return new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 });
    }
    return new Response('{"name":"projects/house-test/messages/1"}', { status: 200 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

describe('Android app push (FCM)', () => {
  it('the table takes an FCM device token, and re-registering keeps one row', () => {
    const sql = (getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'push_subscriptions'").get() as { sql: string }).sql;
    assert.match(sql, /'fcm'/);
    addFcmSubscription({ id: 'a', deviceToken: 'live-token', deviceName: 'android' });
    addFcmSubscription({ id: 'b', deviceToken: 'live-token', deviceName: 'android' });
    assert.equal(listFcmSubscriptions().length, 1);
  });

  it('stays off without a service account, and turns on when the secret is saved', () => {
    deleteSecret('fcm_service_account');
    const push = new PushService();
    assert.equal(push.isFcmConfigured(), false);
    setSecret('fcm_service_account', JSON.stringify(account));
    push.refreshFcm();
    assert.equal(push.isFcmConfigured(), true);
  });

  it('signs a service-account JWT, sends to each device, and drops a dead token', async () => {
    setSecret('fcm_service_account', JSON.stringify(account));
    addFcmSubscription({ id: 'c', deviceToken: 'dead-token' });
    const push = new PushService();
    calls = [];
    await push.sendPush({ title: 'Companion A', body: 'hey you', threadId: 't1', tag: 'reply' });

    const exchange = calls.find((c) => c.url.includes('oauth2'))!;
    const assertion = new URLSearchParams(exchange.body).get('assertion')!;
    const [h, c, sig] = assertion.split('.');
    const verify = createVerify('RSA-SHA256');
    verify.update(`${h}.${c}`);
    assert.ok(verify.verify(publicKey, Buffer.from(sig, 'base64url')), 'the JWT is signed with the account key');
    assert.equal(JSON.parse(Buffer.from(c, 'base64url').toString()).iss, account.client_email);

    const sends = calls.filter((x) => x.url.endsWith('/projects/house-test/messages:send'));
    assert.equal(sends.length, 2);
    assert.ok(sends.every((x) => x.auth === 'Bearer tok-1'));
    const live = JSON.parse(sends.find((x) => x.body.includes('live-token'))!.body).message;
    assert.deepEqual(live.notification, { title: 'Companion A', body: 'hey you' });
    assert.deepEqual(live.data, { threadId: 't1' });
    assert.equal(live.android.notification.tag, 'reply');

    assert.deepEqual(listFcmSubscriptions().map((s) => s.device_token), ['live-token'], 'the dead token is dropped');
  });

  it('a data-only message (the Needle) has no notification block, high priority and a short ttl', async () => {
    setSecret('fcm_service_account', JSON.stringify(account));
    const push = new PushService();
    calls = [];
    const result = await push.sendFcmData({ kind: 'needle', uri: 'spotify:track:5googFqOqpopYdcvV22T3t', by: 'companion-a', dropId: 'd1' });
    assert.deepEqual(result, { devices: 1, sent: 1 });
    const sends = calls.filter((x) => x.url.endsWith('/projects/house-test/messages:send'));
    assert.equal(sends.length, 1);
    const message = JSON.parse(sends[0].body).message;
    assert.equal(message.token, 'live-token');
    assert.equal(message.notification, undefined, 'nothing for the system to draw');
    assert.deepEqual(message.data, { kind: 'needle', uri: 'spotify:track:5googFqOqpopYdcvV22T3t', by: 'companion-a', dropId: 'd1' });
    assert.deepEqual(message.android, { priority: 'HIGH', ttl: '120s' });
  });

  it('a data-only message with no service account reaches nobody and says so', async () => {
    deleteSecret('fcm_service_account');
    const push = new PushService();
    assert.deepEqual(await push.sendFcmData({ kind: 'needle' }), { devices: 0, sent: 0 });
  });
});
