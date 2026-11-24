// The sync engine (Slice 8): send this device's setup to the house, and take
// the house's newest setup. Format and rules live in sync-format.ts; the
// server half is backend/src/routes/app-settings-routes.ts.
//
// When: Apply sends (only if something changed, or the Fonts/Closet library
// changed). Opening the app, and coming back to it, takes the house copy if it
// is newer than what this device last sent or took. The latest send wins.
// Before sending, the house's fonts and looks are merged in first, so a look
// saved on another device is never wiped by this one.

import { apiFetch } from '../bytelight/api';
import type { AppSettings, AppTheme, ContactProfile } from '../types';
import type { UserFont } from './fonts';
import type { SavedLook } from './closet';
import type { StoredMoving } from './moving-wallpaper';
import { readMovingFile, restoreMovingFile } from './moving-wallpaper';
import { getUserFonts, setUserFontsFromSync } from './font-store';
import { getLooks, readMovingCopy, setLooksFromSync } from './closet-store';
import { clearLibraryDirty, lastSyncAt, readDeleted, setLastSyncAt, writeDeleted } from './sync-local';
import {
  ASSET_PREFIX, SYNC_VERSION, findAssetRefs, findDataUrls, isSyncBlob, lookOf, mergeById, pickHouse,
  settingsFromSync, swapStrings, themeFromSync, type SyncBlob, type SyncFile,
} from './sync-format';

export interface DeviceState {
  theme: AppTheme;
  appSettings: AppSettings;
  contacts: Record<string, ContactProfile>;
}

export interface Pulled {
  themePatch: Partial<AppTheme>;
  settingsPatch: Partial<AppSettings>;
  contacts?: Record<string, ContactProfile>;
  extras?: Record<string, string>;
}

export type SyncResult = { ok: true; detail?: string } | { ok: false; reason: string };

// ── bytes ─────────────────────────────────────────────────────────────────

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(5, comma);
  const type = head.split(';')[0] || 'application/octet-stream';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

const blobToDataUrl = (b: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(b);
});

async function sha256(b: Blob): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const d = await crypto.subtle.digest('SHA-256', await b.arrayBuffer());
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

// What this device already holds, by content (so a pull never re-downloads
// a picture or font that's already here).
const known = new Map<string, string>(); // sha -> data URL
const shaOf = new Map<string, string>(); // data URL -> sha

async function hashDataUrl(u: string): Promise<string | null> {
  const hit = shaOf.get(u);
  if (hit) return hit;
  const sha = await sha256(dataUrlToBlob(u));
  if (sha) { shaOf.set(u, sha); known.set(sha, u); }
  return sha;
}

// ── house assets ──────────────────────────────────────────────────────────

async function uploadBlob(b: Blob, sha: string | null): Promise<string> {
  if (sha) {
    const head = await apiFetch(`/api/app-assets/${sha}`, { method: 'HEAD' });
    if (head.ok) return sha;
  }
  const res = await apiFetch('/api/app-assets', { method: 'PUT', headers: { 'Content-Type': b.type || 'application/octet-stream' }, body: b });
  if (!res.ok) throw new Error(res.status === 413 ? 'a file is over the 25 MB limit' : `upload failed (HTTP ${res.status})`);
  const { id } = await res.json();
  if (typeof id !== 'string') throw new Error('upload gave no id');
  return id;
}

async function downloadBlob(sha: string): Promise<Blob> {
  const res = await apiFetch(`/api/app-assets/${sha}`);
  if (!res.ok) throw new Error(`a file is missing from the house (HTTP ${res.status})`);
  return res.blob();
}

async function toSyncFile(f: StoredMoving | null): Promise<SyncFile | undefined> {
  if (!f?.blob) return undefined;
  const id = await uploadBlob(f.blob, await sha256(f.blob));
  return { ref: ASSET_PREFIX + id, kind: f.kind, name: f.name, type: f.type || f.blob.type };
}

async function fromSyncFile(f: SyncFile | null | undefined): Promise<StoredMoving | null> {
  if (!f?.ref) return null;
  const blob = await downloadBlob(f.ref.slice(ASSET_PREFIX.length));
  return { blob, kind: f.kind === 'image' ? 'image' : 'video', name: f.name || 'moving', type: f.type || blob.type };
}

// ── the server copy ───────────────────────────────────────────────────────

async function fetchHouse(): Promise<{ blob: SyncBlob | null; updatedAt: number; empty: boolean }> {
  const res = await apiFetch('/api/app-settings');
  if (res.status === 404) throw new Error('the house needs its backend restart first');
  if (!res.ok) throw new Error(`couldn't reach the house (HTTP ${res.status})`);
  let data: { settings?: unknown; updatedAt?: number };
  try { data = await res.json(); } catch { throw new Error('the house gave a non-JSON answer; the backend may need a restart'); }
  const blob = isSyncBlob(data?.settings) ? data.settings : null;
  return { blob, updatedAt: Number(data?.updatedAt) || 0, empty: !data?.settings };
}

/** Swap every asset ref in a blob for local data URLs (downloading what's missing). */
async function resolveRefs<T>(value: T): Promise<T> {
  // Index what's already here first, so nothing is downloaded twice.
  const refs = [...findAssetRefs(value)];
  const map = new Map<string, string>();
  for (const ref of refs) {
    const sha = ref.slice(ASSET_PREFIX.length);
    let url = known.get(sha);
    if (!url) {
      url = await blobToDataUrl(await downloadBlob(sha));
      known.set(sha, url);
      shaOf.set(url, sha);
    }
    map.set(ref, url);
  }
  return swapStrings(value, map);
}

async function indexLocal(value: unknown) {
  for (const u of findDataUrls(value)) await hashDataUrl(u);
}

/** Take the house's fonts and looks into this device's libraries (merge, never wipe). */
async function mergeLibraries(blob: SyncBlob) {
  const deleted = readDeleted();
  const allDeleted = {
    fonts: [...new Set([...deleted.fonts, ...blob.deleted.fonts])],
    looks: [...new Set([...deleted.looks, ...blob.deleted.looks])],
  };
  writeDeleted(allDeleted);

  const localFonts = await getUserFonts();
  const localLooks = await getLooks();
  await indexLocal({ localFonts, localLooks });

  const serverFonts = await resolveRefs(blob.fonts) as UserFont[];
  const mergedFonts = mergeById(localFonts, serverFonts, new Set(allDeleted.fonts));
  await setUserFontsFromSync(mergedFonts);

  const serverLooks = await resolveRefs(blob.closet.map(({ moving: _m, ...l }) => l)) as SavedLook[];
  const mergedLooks = mergeById(localLooks, serverLooks, new Set(allDeleted.looks));
  // Download a look's video only when the house's version of that look won.
  const copies = new Map<string, StoredMoving>();
  for (const l of blob.closet) {
    const chosen = mergedLooks.find((m) => m.id === l.id);
    const serverVersion = serverLooks.find((x) => x.id === l.id);
    if (l.moving && chosen && chosen === serverVersion) {
      const f = await fromSyncFile(l.moving).catch(() => null);
      if (f) copies.set(l.id, f);
    }
  }
  await setLooksFromSync(mergedLooks, copies);
}

// ── public ────────────────────────────────────────────────────────────────

/** Send this device's setup to the house (after taking in its fonts/looks). */
export async function pushSetup(state: DeviceState, extras?: Record<string, string>): Promise<SyncResult> {
  try {
    const house = await fetchHouse();
    if (house.blob) await mergeLibraries(house.blob);

    const fonts = await getUserFonts();
    const looks = await getLooks();
    const closet: SyncBlob['closet'] = [];
    for (const l of looks) {
      const moving = l.hasMoving ? await toSyncFile(await readMovingCopy(l.id)) : undefined;
      closet.push({ ...l, ...(moving ? { moving } : {}) });
    }
    const raw: SyncBlob = {
      v: SYNC_VERSION,
      look: lookOf(state.theme),
      house: pickHouse(state.appSettings),
      contacts: state.contacts,
      fonts: fonts.map(({ id, family, role, data, fileName }) => ({ id, family, role, data, ...(fileName ? { fileName } : {}) })),
      closet,
      moving: state.theme.movingWallpaper ? (await toSyncFile(await readMovingFile())) ?? null : null,
      deleted: readDeleted(),
      ...(extras ? { extras } : {}),
    };

    // Every picture and font out of the JSON, into the house's file store.
    const map = new Map<string, string>();
    for (const u of findDataUrls(raw)) {
      const b = dataUrlToBlob(u);
      const id = await uploadBlob(b, await hashDataUrl(u));
      known.set(id, u);
      map.set(u, ASSET_PREFIX + id);
    }
    const blob = swapStrings(raw, map);

    const res = await apiFetch('/api/app-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: blob }) });
    if (res.status === 404) return { ok: false, reason: 'the house needs its backend restart first' };
    if (!res.ok) return { ok: false, reason: `the house refused it (HTTP ${res.status})` };
    const { updatedAt } = await res.json();
    setLastSyncAt(Number(updatedAt) || Date.now());
    clearLibraryDirty();
    return { ok: true, detail: `${fonts.length} fonts, ${looks.length} looks` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'send failed' };
  }
}

/**
 * Take the house's setup if it's newer than what this device has (or always,
 * with force). Returns the patches for App to apply, or null for nothing new.
 */
export async function pullSetup(force = false): Promise<Pulled | null> {
  const house = await fetchHouse();
  if (!house.blob) {
    if (force) throw new Error(house.empty ? 'the house has no saved setup yet; send one from the device where things look right' : "the house's setup is from an older version; send one from this version first");
    return null;
  }
  if (!force && house.updatedAt <= lastSyncAt()) return null;

  await mergeLibraries(house.blob);
  const look = await resolveRefs(house.blob.look);
  const houseSettings = await resolveRefs(house.blob.house);
  const contacts = house.blob.contacts ? await resolveRefs(house.blob.contacts) as Record<string, ContactProfile> : undefined;
  if (look.movingWallpaper && house.blob.moving) {
    const f = await fromSyncFile(house.blob.moving).catch(() => null);
    if (f) await restoreMovingFile(f);
    else look.movingWallpaper = false;
  }
  setLastSyncAt(house.updatedAt);
  return {
    themePatch: themeFromSync(look),
    settingsPatch: settingsFromSync(houseSettings),
    contacts,
    extras: house.blob.extras,
  };
}

// Setup Sync's buttons reach App's state through these, registered by App.
type Handlers = { send: () => Promise<SyncResult>; bring: () => Promise<SyncResult> };
let handlers: Handlers | null = null;
export function registerSyncHandlers(h: Handlers | null) { handlers = h; }
export function syncNow(kind: 'send' | 'bring'): Promise<SyncResult> {
  if (!handlers) return Promise.resolve({ ok: false, reason: 'the app is still starting; try again in a moment' });
  return kind === 'send' ? handlers.send() : handlers.bring();
}
