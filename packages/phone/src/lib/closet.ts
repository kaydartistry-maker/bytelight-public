// The Closet (Slice 6): her looks, saved and swapped like outfits.
//
// The operator's rule: how it LOOKS goes in the closet; where things ARE and
// what they DO stays put. So a look carries colours, glass, texture, type,
// wallpaper (still / slideshow / moving), the lock screen's own wallpaper,
// clock face and card style, and sticky-note colours. It never carries clock
// positions or sizes, lock shortcuts, what the lock screen shows, the
// Spotify card, home widgets or the dock. Pure: tested in closet.test.ts.

import type { AppTheme } from '../types';
import { BUILTIN_FONTS, type TypeSettings } from './fonts';

export const LOOK_KEYS = [
  'mode',
  'id',
  'customColors',
  'accentOverride',
  'accentPalette',
  'skin',
  'fx',
  'glass',
  'typography',
  'type',
  'textOverride',
  'shapeRadius',
  'wallpaper',
  'wallpapers',
  'slideshowEnabled',
  'movingWallpaper',
  'movingPoster',
  'lockScreenWallpaper',
  'lockFace',
  'lockCards',
  'stickyNoteColors',
] as const satisfies readonly (keyof AppTheme)[];

export type LookKey = (typeof LOOK_KEYS)[number];
export type Look = Partial<Pick<AppTheme, LookKey>>;

export interface SavedLook {
  id: string;
  name: string;
  look: Look;
  thumb: string | null;    // small preview of its wallpaper, or null
  hasMoving: boolean;      // its own copy of the moving wallpaper is stored
  bytes: number;           // roughly how much space it takes on the device
  createdAt: number;
  updatedAt: number;
}

/** Just the look out of her whole theme (furniture left behind). */
export function pickLook(theme: AppTheme): Look {
  const out: Look = {};
  for (const k of LOOK_KEYS) {
    if (theme[k] !== undefined) (out as Record<string, unknown>)[k] = theme[k];
  }
  return out;
}

/**
 * The theme patch that puts a look on. Every look key is set, even ones the
 * look doesn't have (to undefined), so nothing from the previous look lingers.
 * Furniture keys are untouched because they aren't in the patch.
 */
export function wearPatch(look: Look): Partial<AppTheme> {
  const patch: Partial<AppTheme> = {};
  for (const k of LOOK_KEYS) (patch as Record<string, unknown>)[k] = look[k];
  return patch;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined && (v as Record<string, unknown>)[k] !== null)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Is she wearing exactly this look right now? */
export function sameLook(a: Look, b: Look): boolean {
  return stable(a) === stable(b);
}

/** The saved look she's wearing, if any. */
export function wornLook(theme: AppTheme, saved: SavedLook[]): SavedLook | null {
  const now = pickLook(theme);
  return saved.find((s) => sameLook(now, s.look)) ?? null;
}

/** Font families a look uses that aren't on this device (they fall back to Geist). */
export function missingFonts(look: Look, userFamilies: string[]): string[] {
  const have = new Set([...BUILTIN_FONTS.map((f) => f.family), ...userFamilies].map((f) => f.toLowerCase()));
  const t: TypeSettings = look.type || {};
  const used = [t.title, t.text, t.userMsg, t.compMsg, t.code].filter((f): f is string => !!f);
  return [...new Set(used.filter((f) => !have.has(f.toLowerCase())))];
}

/** The picture a look's thumbnail is made from. */
export function thumbSource(look: Look): string | null {
  if (look.movingWallpaper && look.movingPoster) return look.movingPoster;
  if (look.slideshowEnabled && look.wallpapers?.length) return look.wallpapers[0];
  return look.wallpaper || look.glass?.texture || null;
}

/** A name nobody else in the closet has. */
export function uniqueLookName(name: string, saved: SavedLook[]): string {
  const base = name.trim() || 'My look';
  const taken = new Set(saved.map((s) => s.name.toLowerCase()));
  let out = base;
  let n = 2;
  while (taken.has(out.toLowerCase())) out = `${base} ${n++}`;
  return out;
}
