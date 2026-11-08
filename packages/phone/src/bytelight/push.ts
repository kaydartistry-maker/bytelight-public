// Web push for the phone app on main's /api/push (vapid-public, subscribe,
// unsubscribe, subscriptions, test) — the flow main's Svelte
// NotificationsPanel uses, through this app's own worker (public/sw.js,
// scoped to the app's base, the front door).

import { apiFetch } from './api';

const SW_URL = `${import.meta.env.BASE_URL}sw.js`;
const SW_SCOPE = import.meta.env.BASE_URL;

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
export async function subscribeWebPush(): Promise<void> {
  if (!webPushSupported()) throw new Error('This browser has no web push.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site — allow them in the browser settings.');
  const reg = await registerPhoneWorker();
  if (!reg) throw new Error('Could not start the notification worker.');
  const vapid = await apiFetch('/api/push/vapid-public').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!vapid?.publicKey) throw new Error('Push is not configured on the server (no VAPID key).');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapid.publicKey) as BufferSource,
  });
  const json = sub.toJSON();
  const res = await apiFetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, deviceLabel: deviceLabel() }),
  });
  if (!res.ok) {
    await sub.unsubscribe().catch(() => {});
    throw new Error('The server rejected the subscription.');
  }
}

export async function unsubscribeWebPush(): Promise<void> {
  const reg = await registerPhoneWorker();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await apiFetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
}

export async function sendTestPush(): Promise<void> {
  const res = await apiFetch('/api/push/test', { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Test failed');
  }
}
