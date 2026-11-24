import { beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWebPushEnabled, readWebPushDeviceState, subscribeWebPush, unsubscribeWebPush,
  sendTestPush, setupWebPush, setWebPushDevicePreferences, subscriptionKeyMatches, type WebPushDeviceState,
} from './push';

const names = ['window', 'navigator', 'Notification', 'document', 'fetch'] as const;
const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const publicKey = Buffer.alloc(65, 1).toString('base64url');
let requests: Array<{ url: string; body: any }>;
let permissionCalls: number;
let subscription: any;
let readiness: any;
let registered: boolean;
let rejectUnsubscribe: boolean;
let rejectRegistration: boolean;
let result: any;
let notification: any;
let notifyWhileConnected: boolean;
const install = (name: string, value: any) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  requests = [];
  permissionCalls = 0;
  subscription = null;
  registered = false;
  notifyWhileConnected = false;
  rejectUnsubscribe = false;
  rejectRegistration = false;
  readiness = { webPush: { configured: true, publicKey, setupState: 'ready' }, fcmConfigured: false };
  result = { delivery: { attempted: 1, accepted: 1, failed: 0 }, message: 'Accepted by provider; receipt not confirmed.' };
  const manager = {
    getSubscription: async () => subscription,
    subscribe: async () => {
      subscription = {
        endpoint: 'https://push.example/this-device',
        options: { applicationServerKey: Uint8Array.from(Buffer.alloc(65, 1)).buffer },
        toJSON: () => ({ endpoint: 'https://push.example/this-device', keys: { p256dh: 'mock', auth: 'mock' } }),
        unsubscribe: async () => { subscription = null; return true; },
      };
      return subscription;
    },
  };
  install('window', { PushManager: {}, Notification: {}, matchMedia: () => ({ matches: true }) });
  install('navigator', { userAgent: 'iPhone test', platform: 'iPhone', maxTouchPoints: 1, serviceWorker: { register: async () => ({ pushManager: manager }) } });
  notification = { permission: 'default', requestPermission: async () => { permissionCalls++; notification.permission = 'granted'; return 'granted'; } };
  install('Notification', notification);
  install('document', { cookie: 'bytelight_csrf=mock-csrf' });
  install('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/status')) return response(readiness);
    if (String(url).endsWith('/check-device')) return response({ registered, preferences: registered ? { notifyWhileConnected } : null });
    if (String(url).endsWith('/device-preferences')) {
      if (!registered) return response({ error: 'Device is not registered' }, 404);
      notifyWhileConnected = body.notifyWhileConnected;
      return response({ preferences: { notifyWhileConnected } });
    }
    if (String(url).endsWith('/setup-web')) return response({ success: true });
    if (String(url).endsWith('/unsubscribe')) {
      if (rejectUnsubscribe) return response({ error: 'Server refused removal' }, 503);
      registered = false;
      return response({ success: true });
    }
    if (String(url).endsWith('/subscribe')) {
      if (rejectRegistration) return response({ error: 'Server refused registration' }, 503);
      registered = true;
      return response({ success: true });
    }
    if (String(url).endsWith('/test')) return response(result);
    throw new Error(`Unexpected mock request ${url}`);
  });
});

after(() => {
  for (const name of names) {
    const descriptor = descriptors.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as any)[name];
  }
});

test('server readiness is checked before asking permission and empty setup never prompts', async () => {
  readiness.webPush = { configured: false, publicKey: null, setupState: 'empty' };
  await assert.rejects(subscribeWebPush(), /Set up web push/);
  assert.equal(permissionCalls, 0);
  assert.deepEqual(requests.map(r => r.url), ['/api/push/status']);
});

test('prepared readiness preserves the synchronous permission gesture, then registers this browser', async () => {
  const work = subscribeWebPush(publicKey);
  assert.equal(permissionCalls, 1, 'permission requested before any await/network');
  await work;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/push/subscribe');
  const state = await readWebPushDeviceState();
  assert.equal(isWebPushEnabled(state), true);
  assert.equal(state.ios, true);
  assert.equal(state.installed, true);
});

test('a persisted install-wide enabled flag cannot enable an unsubscribed browser', async () => {
  const state = await readWebPushDeviceState();
  assert.equal(isWebPushEnabled({ ...state, pushNotificationsEnabled: true } as WebPushDeviceState), false);
  assert.equal(state.subscribed, false);
  assert.equal(permissionCalls, 0);
});

test('a local browser subscription missing on the server is shown as needing registration', async () => {
  await subscribeWebPush(publicKey);
  registered = false;
  const state = await readWebPushDeviceState();
  assert.equal(state.subscribed, true);
  assert.equal(state.registered, false);
  assert.equal(isWebPushEnabled(state), false);
  await subscribeWebPush(publicKey);
  assert.equal(isWebPushEnabled(await readWebPushDeviceState()), true);
});

test('permission denied never prompts again or claims enabled', async () => {
  notification.permission = 'denied';
  await assert.rejects(subscribeWebPush(publicKey), /blocked/);
  assert.equal(permissionCalls, 0);
});

test('failed server registration removes only a newly created local subscription', async () => {
  rejectRegistration = true;
  await assert.rejects(subscribeWebPush(publicKey), /Server refused registration/);
  assert.equal(subscription, null);
  assert.equal(registered, false);
});

test('failed server unsubscribe preserves the local subscription and surfaces failure', async () => {
  await subscribeWebPush(publicKey);
  rejectUnsubscribe = true;
  await assert.rejects(unsubscribeWebPush(), /Server refused removal/);
  assert.ok(subscription);
  assert.equal(registered, true);
  rejectUnsubscribe = false;
  await unsubscribeWebPush();
  assert.equal(subscription, null);
  assert.equal(registered, false);
});

test('old-key subscriptions need explicit removal; the helper never silently rotates them', async () => {
  await subscribeWebPush(publicKey);
  const old = subscription;
  const differentKey = Buffer.alloc(65, 2).toString('base64url');
  assert.equal(subscriptionKeyMatches(old, differentKey), false);
  await assert.rejects(subscribeWebPush(differentKey), /older push key/);
  assert.equal(subscription, old);
});

test('the test is scoped to this endpoint and does not equate API success with delivery', async () => {
  const data = await sendTestPush('https://push.example/this-device');
  assert.deepEqual(requests.at(-1), { url: '/api/push/test', body: { endpoint: 'https://push.example/this-device' } });
  assert.equal(data.delivery.accepted, 1);
  result = { success: true };
  await assert.rejects(sendTestPush(), /did not confirm acceptance/);
  result = { delivery: { attempted: 1, accepted: '1', failed: 0 } };
  await assert.rejects(sendTestPush(), /did not confirm acceptance/);
});

test('worker registration failure leaves status unknown and disable unconfirmed', async () => {
  (navigator.serviceWorker as any).register = async () => { throw new Error('mock worker unavailable'); };
  await assert.rejects(readWebPushDeviceState(), /status is unknown/);
  await assert.rejects(unsubscribeWebPush(), /Disable was not confirmed/);
});

test('server setup is an explicit action, separate from subscription and test delivery', async () => {
  await setupWebPush('https://app.example');
  assert.deepEqual(requests, [{ url: '/api/push/setup-web', body: { contact: 'https://app.example' } }]);
  assert.equal(permissionCalls, 0);
  assert.equal(subscription, null);
});

test('connected-window delivery is off by default and changes only through an explicit device preference action', async () => {
  await subscribeWebPush(publicKey);
  assert.equal((await readWebPushDeviceState()).notifyWhileConnected, false);
  await setWebPushDevicePreferences('https://push.example/this-device', true);
  assert.deepEqual(requests.at(-1), { url: '/api/push/device-preferences', body: { endpoint: 'https://push.example/this-device', notifyWhileConnected: true } });
  assert.equal((await readWebPushDeviceState()).notifyWhileConnected, true);
  await setWebPushDevicePreferences('https://push.example/this-device', false);
  assert.equal((await readWebPushDeviceState()).notifyWhileConnected, false);
  assert.equal(requests.some(r => r.url.endsWith('/test')), false, 'changing a preference sends no test or message');
});
