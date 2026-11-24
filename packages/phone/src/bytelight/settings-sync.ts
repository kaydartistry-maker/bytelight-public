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

export const MAX_SETTINGS_PAYLOAD_BYTES = 10 * 1024 * 1024;
export type SettingsWriteResult = { ok: true } | { ok: false; error: string };

/** Match the server's bounded general JSON parser, including the envelope.
 * Never log the serialized setup: legacy settings may contain service keys. */
export function serializeSettingsSnapshot(blob: ServerSettingsBlob): string {
  let body: string;
  try { body = JSON.stringify({ settings: blob }); }
  catch { throw new Error('Settings could not be serialized. Your saved setup is unchanged.'); }
  if (new TextEncoder().encode(body).byteLength > MAX_SETTINGS_PAYLOAD_BYTES) {
    throw new Error('This setup exceeds the 10 MB sync limit. Use library image assets or reduce inline wallpaper/preset data before saving.');
  }
  return body;
}

// Old in-flight snapshots finish before a newer explicit Apply. This avoids a
// slow older PUT arriving last and overwriting an acknowledged new look.
let settingsWrites: Promise<unknown> = Promise.resolve();
export async function pushServerSettingsDetailed(blob: ServerSettingsBlob): Promise<SettingsWriteResult> {
  let body: string;
  try { body = serializeSettingsSnapshot(blob); }
  catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : 'Settings are too large to sync.' }; }
  const write = async (): Promise<SettingsWriteResult> => {
  try {
    const res = await apiFetch('/api/app-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.status === 413 ? 'The server refused this setup because it exceeds its size limit.'
      : res.status === 401 || res.status === 403 ? 'Sign in again before syncing your settings.' : `Settings sync failed (HTTP ${res.status}).` };
  } catch {
    return { ok: false, error: 'Could not reach the server. Your locally saved settings are waiting to sync.' };
  }
  };
  const pending = settingsWrites.then(write, write);
  settingsWrites = pending.then(() => undefined, () => undefined);
  return pending;
}

export async function pushServerSettings(blob: ServerSettingsBlob): Promise<boolean> {
  return (await pushServerSettingsDetailed(blob)).ok;
}
