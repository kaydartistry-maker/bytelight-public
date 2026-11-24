import { createHash } from 'node:crypto';
import { getConfig, setConfig } from './db/config.js';

export interface WebPushPreferences { notifyWhileConnected: boolean }

// Store no endpoint/token in config keys. No migration from install-wide flags.
export function webPushPreferenceKey(endpoint: string): string {
  return `push.web.preferences.${createHash('sha256').update(endpoint).digest('hex')}`;
}

export function readWebPushPreferences(endpoint: string): WebPushPreferences {
  try {
    const raw = getConfig(webPushPreferenceKey(endpoint));
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (data && typeof data === 'object' && !Array.isArray(data)
      && Object.keys(data).length === 1 && Object.keys(data)[0] === 'notifyWhileConnected'
      && typeof (data as WebPushPreferences).notifyWhileConnected === 'boolean') {
      return { notifyWhileConnected: (data as WebPushPreferences).notifyWhileConnected };
    }
  } catch { /* Missing/malformed/unreadable preference never grants delivery. */ }
  return { notifyWhileConnected: false };
}

export function saveWebPushPreferences(endpoint: string, preferences: WebPushPreferences): void {
  if (typeof preferences?.notifyWhileConnected !== 'boolean') throw new Error('A boolean device preference is required');
  setConfig(webPushPreferenceKey(endpoint), JSON.stringify({ notifyWhileConnected: preferences.notifyWhileConnected }));
}
