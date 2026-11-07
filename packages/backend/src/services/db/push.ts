import { getDb } from './init.js';

// Push subscription operations
export interface PushSubscription {
  id: string;
  type: 'web_push' | 'apns';
  endpoint: string | null;
  keys_p256dh: string | null;
  keys_auth: string | null;
  device_token: string | null;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export function addPushSubscription(params: {
  id: string;
  endpoint: string;
  keysP256dh: string;
  keysAuth: string;
  deviceName?: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO push_subscriptions (id, type, endpoint, keys_p256dh, keys_auth, device_name, created_at, last_used_at)
    VALUES (?, 'web_push', ?, ?, ?, ?, ?, NULL)
  `);
  stmt.run(params.id, params.endpoint, params.keysP256dh, params.keysAuth, params.deviceName || null, new Date().toISOString());
}

export function removePushSubscription(endpoint: string): boolean {
  const stmt = getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const result = stmt.run(endpoint);
  return result.changes > 0;
}

export function listPushSubscriptions(): PushSubscription[] {
  const stmt = getDb().prepare("SELECT * FROM push_subscriptions WHERE type = 'web_push' ORDER BY created_at DESC");
  return stmt.all() as unknown as PushSubscription[];
}

export function touchPushSubscription(endpoint: string): void {
  const stmt = getDb().prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?');
  stmt.run(new Date().toISOString(), endpoint);
}
