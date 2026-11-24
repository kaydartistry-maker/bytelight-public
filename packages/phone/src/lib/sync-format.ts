// What syncs, and how (Slice 8). Pure: tested in sync-format.test.ts.
//
// The operator's rules: her LOOK and her HOUSE settings travel; furniture
// (dock, widgets and their spots, lock-screen layout) and connection
// settings (server address, keys, push relay) stay on each device. Fonts,
// Closet looks and moving videos travel too.
//
// Big things never ride inside the JSON: every data: URL over a small size is
// swapped for "bl-asset:<sha256>" and sent once to /api/app-assets.

import type { AppSettings, AppTheme } from '../types';
import { pickLook, wearPatch, type Look } from './closet';

export const SYNC_VERSION = 2;
export const ASSET_PREFIX = 'bl-asset:';
const INLINE_MAX = 1024; // tiny data URLs (dots, swatches) can ride inline

/** House settings that travel. Everything else in appSettings stays put. */
export const HOUSE_KEYS = [
  'osName', 'groupChatName', 'appLogo', 'nameplateLogo', 'nameplateName', 'allowLookImport',
  'fontFamily', 'fontSize', 'sendIconId', 'userAvatar', 'userAvatarColor',
] as const satisfies readonly (keyof AppSettings)[];
export type House = Partial<Pick<AppSettings, (typeof HOUSE_KEYS)[number]>>;

export interface SyncFile { ref: string; kind: 'video' | 'image'; name: string; type: string }

export interface SyncBlob {
  v: number;
  look: Look;
  house: House;
  contacts?: unknown;
  fonts: { id: string; family: string; role: 'title' | 'text'; data: string; fileName?: string }[];
  closet: { id: string; name: string; look: Look; thumb: string | null; hasMoving: boolean; bytes: number; createdAt: number; updatedAt: number; moving?: SyncFile }[];
  moving: SyncFile | null;
  deleted: { fonts: string[]; looks: string[] };
  extras?: Record<string, string>;
}

export function pickHouse(s: Partial<AppSettings>): House {
  const out: House = {};
  for (const k of HOUSE_KEYS) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

/** Theme patch for a pulled look: every look key set, furniture untouched. */
export function themeFromSync(look: Look): Partial<AppTheme> {
  return wearPatch(look);
}

/** Settings patch for a pulled house: every house key set (absent = cleared). */
export function settingsFromSync(house: House): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {};
  for (const k of HOUSE_KEYS) (patch as Record<string, unknown>)[k] = house[k];
  return patch;
}

export const lookOf = (theme: AppTheme): Look => pickLook(theme);

export const isAssetRef = (v: unknown): v is string => typeof v === 'string' && /^bl-asset:[a-f0-9]{64}$/.test(v);
const isBigDataUrl = (v: unknown): v is string => typeof v === 'string' && v.startsWith('data:') && v.length > INLINE_MAX;

/** Every big data: URL, wherever it sits, in order (deduped). */
export function findDataUrls(v: unknown, out = new Set<string>()): Set<string> {
  if (isBigDataUrl(v)) out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => findDataUrls(x, out));
  else if (v && typeof v === 'object') Object.values(v as object).forEach((x) => findDataUrls(x, out));
  return out;
}

export function findAssetRefs(v: unknown, out = new Set<string>()): Set<string> {
  if (isAssetRef(v)) out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => findAssetRefs(x, out));
  else if (v && typeof v === 'object') Object.values(v as object).forEach((x) => findAssetRefs(x, out));
  return out;
}

/** Copy of v with strings swapped through map (data URL -> ref, or ref -> data URL). */
export function swapStrings<T>(v: T, map: Map<string, string>): T {
  if (typeof v === 'string') return (map.get(v) ?? v) as T;
  if (Array.isArray(v)) return v.map((x) => swapStrings(x, map)) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) out[k] = swapStrings(x, map);
    return out as T;
  }
  return v;
}

/**
 * Merge two libraries by id (fonts, looks). Deleted ids (from either side)
 * are dropped; for the same id the newer updatedAt wins (server on a tie).
 */
export function mergeById<T extends { id: string; updatedAt?: number }>(local: T[], server: T[], deleted: Set<string>): T[] {
  const out = new Map<string, T>();
  for (const x of server) if (!deleted.has(x.id)) out.set(x.id, x);
  for (const x of local) {
    if (deleted.has(x.id)) continue;
    const s = out.get(x.id);
    if (!s || (x.updatedAt ?? 0) > (s.updatedAt ?? 0)) out.set(x.id, x);
  }
  return [...out.values()];
}

/** Is what came back from the server a setup this version understands? */
export function isSyncBlob(v: unknown): v is SyncBlob {
  if (!v || typeof v !== 'object') return false;
  const b = v as Partial<SyncBlob>;
  return b.v === SYNC_VERSION && !!b.look && typeof b.look === 'object' && !!b.house && typeof b.house === 'object'
    && Array.isArray(b.fonts) && Array.isArray(b.closet) && !!b.deleted;
}
