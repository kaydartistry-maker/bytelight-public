// Web push for the phone app on main's /api/push (vapid-public, subscribe,
// unsubscribe, subscriptions, test) — the flow main's Svelte
// NotificationsPanel uses, through this app's own worker (public/sw.js,
// scoped to the app's base, the front door).

import { apiFetch } from './api';

const SW_SCOPE = import.meta.env?.BASE_URL || '/';
const SW_URL = `${SW_SCOPE}sw.js`;

export interface PushReadiness {
  webPush: { configured: boolean; publicKey: string | null; setupState: 'empty' | 'partial' | 'saved-not-active' | 'ready' };
  fcmConfigured: boolean;
}

export interface WebPushDeviceState {
  server: PushReadiness;
  supported: boolean;
  ios: boolean;
  installed: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  registered: boolean;
  keyMismatch: boolean;
  endpoint: string | null;
  notifyWhileConnected: boolean;
}

export interface PushTestResult {
  delivery: { attempted: number; accepted: number; failed: number };
  message: string;
}

async function responseJson(res: Response, fallback: string): Promise<any> {
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || fallback);
  if (!data || typeof data !== 'object') throw new Error(fallback);
  return data;
}

export async function readPushReadiness(): Promise<PushReadiness> {
  const data = await responseJson(await apiFetch('/api/push/status'), 'Could not check push readiness.');
  if (typeof data.webPush?.configured !== 'boolean') throw new Error('The server returned an invalid push status.');
  return data as PushReadiness;
}

export async function setupWebPush(contact: string): Promise<void> {
  await responseJson(await apiFetch('/api/push/setup-web', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact }),
  }), 'Could not set up web push.');
}

export function subscriptionKeyMatches(sub: PushSubscription, publicKey: string): boolean {
  const current = sub.options?.applicationServerKey;
  if (!current) return true; // Older browsers cannot expose this; server registration is checked too.
  const wanted = urlBase64ToUint8Array(publicKey);
  const actual = new Uint8Array(current);
  return actual.length === wanted.length && actual.every((v, i) => v === wanted[i]);
}

export function isWebPushEnabled(state: WebPushDeviceState): boolean {
  return state.supported && state.server.webPush.configured && !!state.server.webPush.publicKey && state.permission === 'granted'
    && state.subscribed && state.registered && !state.keyMismatch;
}

export async function readWebPushDeviceState(): Promise<WebPushDeviceState> {
  const server = await readPushReadiness();
  const supported = webPushSupported();
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = !!window.matchMedia?.('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
  const reg = supported ? await registerPhoneWorker() : null;
  if (supported && !reg) throw new Error('Could not start the notification worker. Device subscription status is unknown; try checking again.');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  let registered = false;
  let notifyWhileConnected = false;
  if (sub) {
    const data = await responseJson(await apiFetch('/api/push/check-device', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }),
    }), 'Could not verify this device registration.');
    registered = data.registered === true;
    notifyWhileConnected = registered && data.preferences?.notifyWhileConnected === true;
  }
  return { server, supported, ios, installed, permission: supported ? Notification.permission : 'unsupported',
    subscribed: !!sub, registered, notifyWhileConnected, endpoint: sub?.endpoint ?? null,
    keyMismatch: !!(sub && server.webPush.publicKey && !subscriptionKeyMatches(sub, server.webPush.publicKey)) };
}

export async function setWebPushDevicePreferences(endpoint: string, notifyWhileConnected: boolean): Promise<void> {
  await responseJson(await apiFetch('/api/push/device-preferences', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, notifyWhileConnected }),
  }), 'Could not save this device’s notification preference.');
}

export function webPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/** Register (or reuse) the phone's own worker. Safe to call on every load. */
export async function registerPhoneWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!webPushSupported()) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  } catch (err) {
    console.warn('[Bytelight] Service worker registration failed:', err);
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const kind = ua.includes('iPhone') ? 'iPhone' : ua.includes('Android') ? 'Android' : ua.includes('Mac') ? 'Mac' : 'Browser';
  return `${kind} (phone app)`;
}

export async function isWebPushSubscribed(): Promise<boolean> {
  const reg = await registerPhoneWorker();
  if (!reg) return false;
  return !!(await reg.pushManager.getSubscription());
}

/** Ask permission, subscribe this browser, and register it with main. */
export async function subscribeWebPush(preparedPublicKey?: string): Promise<void> {
  if (!webPushSupported()) throw new Error('This browser has no web push.');
  // The panel preflights on mount and passes the verified public key. That path
  // reaches requestPermission before the first await, preserving iOS's tap
  // gesture. Legacy callers still check readiness BEFORE asking permission.
  let publicKey = preparedPublicKey;
  if (!publicKey) {
    const readiness = await readPushReadiness();
    publicKey = readiness.webPush.configured ? readiness.webPush.publicKey || undefined : undefined;
  }
  if (!publicKey) throw new Error('Set up web push on the server before enabling this device.');
  if (Notification.permission === 'denied') throw new Error('Notifications are blocked for this app. Allow them in device or browser settings.');
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site — allow them in the browser settings.');
  const reg = await registerPhoneWorker();
  if (!reg) throw new Error('Could not start the notification worker.');
  const existing = await reg.pushManager.getSubscription();
  if (existing && !subscriptionKeyMatches(existing, publicKey)) throw new Error('This device uses an older push key. Remove its old registration before enabling it again.');
  const sub = existing || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const json = sub.toJSON();
  try {
    const res = await apiFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, deviceLabel: deviceLabel() }),
    });
    await responseJson(res, 'The server rejected this device registration.');
  } catch (err) {
    if (!existing) await sub.unsubscribe().catch(() => {});
    throw err;
  }
}

export async function unsubscribeWebPush(): Promise<void> {
  const reg = await registerPhoneWorker();
  if (!reg) throw new Error('Could not access this device’s notification worker. Disable was not confirmed; try again.');
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await responseJson(await apiFetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }), 'The server could not remove this device. Notifications may still be enabled; try again.');
  const removed = await sub.unsubscribe();
  if (!removed && await reg.pushManager.getSubscription()) throw new Error('The browser could not remove its push subscription. Try disabling again.');
}

export async function sendTestPush(endpoint?: string): Promise<PushTestResult> {
  const data = await responseJson(await apiFetch('/api/push/test', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(endpoint ? { endpoint } : {}),
  }), 'Test failed');
  const d = data.delivery;
  if (!d || ![d.attempted, d.accepted, d.failed].every(Number.isInteger) || d.accepted < 1 || d.failed < 0 || d.accepted + d.failed !== d.attempted) {
    throw new Error('The push service did not confirm acceptance. Check the device registration and try again.');
  }
  return data;
}
