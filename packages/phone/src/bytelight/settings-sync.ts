// Cross-browser app-settings sync against /api/app-settings (NOT
// /api/settings — that's the agent-config KV route, which shadowed this
// blob's original path for two months). The server stores a single JSON
// blob keyed per install; theme, contacts and the rest of appSettings
// all live inside it so phone and laptop see the same prefs without
// manual export/import.
//
// localStorage still acts as the fast-path cache for first paint; this
// just keeps the server copy fresh and seeds new browsers from it.

import { apiFetch } from './api';
import type { AppSettings, AppTheme, ContactProfile } from '../types';

export interface ServerSettingsBlob {
  theme?: AppTheme;
  contacts?: Record<string, ContactProfile>;
  appSettings?: Partial<AppSettings>;
  // Small localStorage strings that ride along so the server copy is a
  // complete setup: reactions/bookmarks, Studio picks, game bests, radar
  // notes (see EXTRA_KEYS in components/SetupSync.tsx). Applied only by
  // the explicit "bring my setup here" flow, never by passive reconcile.
  extras?: Record<string, string>;
}

// Why an error class instead of just returning null: the previous code
// returned null for both "server legitimately has no blob yet" and
// "fetch failed" (network blip, 401, parse error). The caller couldn't
// tell them apart, so it marked hydration complete on failure too —
// and the push-on-state-change effect then overwrote the server's real
// data with the local defaults. Throwing on failure lets the caller
// keep hydration blocked when the server's answer is unknown.
export class SettingsSyncError extends Error {
  constructor(public reason: 'network' | 'unauth' | 'server' | 'parse', message?: string) {
    super(message ?? reason);
    this.name = 'SettingsSyncError';
  }
}

// Returns the blob on success (null = server confirmed empty, please
// seed me); throws SettingsSyncError on any failure.
export async function fetchServerSettings(): Promise<ServerSettingsBlob | null> {
  let res: Response;
  try {
    res = await apiFetch('/api/app-settings');
  } catch (e) {
    throw new SettingsSyncError('network', e instanceof Error ? e.message : 'network error');
  }
  if (res.status === 401 || res.status === 403) {
    throw new SettingsSyncError('unauth', `auth (${res.status})`);
  }
  if (!res.ok) {
    throw new SettingsSyncError('server', `server (${res.status})`);
  }
  let data: { settings?: ServerSettingsBlob | null };
  try {
    data = await res.json();
  } catch {
    throw new SettingsSyncError('parse', 'invalid response');
  }
  return (data?.settings as ServerSettingsBlob | null) ?? null;
}

export async function pushServerSettings(blob: ServerSettingsBlob): Promise<boolean> {
  try {
    const res = await apiFetch('/api/app-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: blob }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
