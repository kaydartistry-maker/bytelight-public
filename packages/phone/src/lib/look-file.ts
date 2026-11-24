// .bllook files (Slice 6b): one look, shareable with friends.
//
// The format is plain JSON so other ByteLight forks can read it too:
//   {
//     "format": "bytelight-look", "version": 1,
//     "name": "Moon Glow",
//     "look": { ...only the Closet's look settings (lib/closet.ts LOOK_KEYS)... },
//     "fonts": ["Magic Retro", ...],          // names only, never font files
//     "moving": { "kind": "video"|"image", "name": "...", "data": "data:video/mp4;base64,..." }  // optional
//   }
// Pictures (wallpaper, slideshow, texture, lock wallpaper, poster) ride
// inside "look" as base64 data URLs.
//
// IMPORTING IS UNTRUSTED. A file from someone else is checked field by field:
// anything that isn't a known look setting of the right shape is dropped.
// Colours must be real colours and font names plain words, because both get
// written into the page's CSS (customColors goes into a <style> block in
// App.tsx); pictures must be raster images (no SVG, which can carry script);
// the moving file must be a real video / GIF / WebP under the size limit.

import { ACCENT_PALETTES, THEMES, TYPOGRAPHY_PRESETS } from './theme';
import type { Look } from './closet';
import type { TypeSettings } from './fonts';
import type { GlassSettings } from './glass';

export const LOOK_FILE_FORMAT = 'bytelight-look';
export const LOOK_FILE_VERSION = 1;
export const LOOK_FILE_EXT = '.bllook';
const MAX_FILE_CHARS = 45 * 1024 * 1024;       // whole file, as text
const MAX_MOVING_CHARS = Math.ceil((20 * 1024 * 1024) * 4 / 3) + 64; // 20 MB as base64

export interface LookFile {
  format: typeof LOOK_FILE_FORMAT;
  version: number;
  name: string;
  look: Look;
  fonts: string[];
  moving?: { kind: 'video' | 'image'; name: string; data: string };
}

export function fontNamesOf(look: Look): string[] {
  const t = look.type || {};
  return [...new Set([t.title, t.text, t.userMsg, t.compMsg, t.code].filter((f): f is string => !!f))];
}

export function buildLookFile(name: string, look: Look, moving?: LookFile['moving']): LookFile {
  return { format: LOOK_FILE_FORMAT, version: LOOK_FILE_VERSION, name, look, fonts: fontNamesOf(look), ...(moving ? { moving } : {}) };
}

/** A safe file name for sharing: "Moon Glow.bllook". */
export function lookFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').trim().slice(0, 60) || 'My look';
  return `${clean}${LOOK_FILE_EXT}`;
}

// ── validators ────────────────────────────────────────────────────────────

const COLOUR = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)|hsla?\(\s*\d{1,3}(\.\d+)?\s*,\s*\d{1,3}(\.\d+)?%\s*,\s*\d{1,3}(\.\d+)?%\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;
const IMAGE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const MOVING_DATA = /^data:(video\/(mp4|webm|quicktime)|image\/(gif|webp)|application\/octet-stream);base64,[A-Za-z0-9+/]+=*$/;
const FONT_NAME = /^[\p{L}\p{N} ._&()-]{1,60}$/u;
const CUSTOM_COLOUR_KEYS = ['pageBg', 'panelBg', 'panelBorder', 'textMain', 'textMuted', 'userBubbleBg', 'userBubbleText', 'compBubbleBg', 'compBubbleText', 'accent', 'accentText', 'noteText'];

const isColour = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && COLOUR.test(v.trim());
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const isImage = (v: unknown): v is string => typeof v === 'string' && v.length < MAX_FILE_CHARS && IMAGE.test(v);
const isFontName = (v: unknown): v is string => typeof v === 'string' && FONT_NAME.test(v);
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
const oneOf = <T extends string>(v: unknown, opts: readonly T[]): T | undefined =>
  typeof v === 'string' && (opts as readonly string[]).includes(v) ? (v as T) : undefined;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanGlass(g: unknown): GlassSettings | undefined {
  if (!isObj(g)) return undefined;
  const out: GlassSettings = {};
  if (isHex(g.tint)) out.tint = g.tint;
  if (num(g.opacity, 0, 100) !== undefined) out.opacity = num(g.opacity, 0, 100);
  if (num(g.blur, 0, 24) !== undefined) out.blur = num(g.blur, 0, 24);
  if (isHex(g.borderColor)) out.borderColor = g.borderColor;
  if (num(g.borderWidth, 0, 3) !== undefined) out.borderWidth = num(g.borderWidth, 0, 3);
  if (num(g.glow, 0, 100) !== undefined) out.glow = num(g.glow, 0, 100);
  if (g.ink === 'auto' || g.ink === 'theme' || isHex(g.ink)) out.ink = g.ink as string;
  const frost = oneOf(g.bubbleFrost, ['plain', 'painted'] as const);
  if (frost) out.bubbleFrost = frost;
  const mode = oneOf(g.mode, ['colour', 'texture'] as const);
  if (mode) out.mode = mode;
  if (isImage(g.texture)) out.texture = g.texture;
  if (num(g.textureStrength, 0, 100) !== undefined) out.textureStrength = num(g.textureStrength, 0, 100);
  const fit = oneOf(g.textureFit, ['sheet', 'fill', 'tile'] as const);
  if (fit) out.textureFit = fit;
  return Object.keys(out).length ? out : undefined;
}

function cleanType(t: unknown): TypeSettings | undefined {
  if (!isObj(t)) return undefined;
  const out: TypeSettings = {};
  for (const k of ['title', 'text', 'userMsg', 'compMsg', 'code'] as const) {
    if (isFontName(t[k])) out[k] = t[k] as string;
  }
  return out;
}

function cleanCustomColours(c: unknown): Look['customColors'] | undefined {
  if (!isObj(c)) return undefined;
  const side = (s: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!isObj(s)) return out;
    for (const k of CUSTOM_COLOUR_KEYS) if (isColour(s[k])) out[k] = (s[k] as string).trim();
    return out;
  };
  return { light: side(c.light), dark: side(c.dark) };
}

/** Keep only well-formed look settings; everything else is dropped. */
export function cleanLook(raw: unknown): Look {
  if (!isObj(raw)) return {};
  const out: Look = {};
  const mode = oneOf(raw.mode, ['light', 'dark'] as const);
  if (mode) out.mode = mode;
  if (typeof raw.id === 'string' && raw.id in THEMES) out.id = raw.id as Look['id'];
  const cc = cleanCustomColours(raw.customColors);
  if (cc) out.customColors = cc;
  if (raw.accentOverride === null || isColour(raw.accentOverride)) out.accentOverride = raw.accentOverride as string | null;
  if (raw.accentPalette === null || (typeof raw.accentPalette === 'string' && ACCENT_PALETTES.some((p) => p.name === raw.accentPalette))) out.accentPalette = raw.accentPalette as string | null;
  const skin = oneOf(raw.skin, ['none', 'cosmos'] as const);
  if (skin) out.skin = skin;
  if (isObj(raw.fx)) {
    const fx: Look['fx'] = {};
    for (const k of ['aura', 'glow', 'motion'] as const) { const v = num(raw.fx[k], 0, 200); if (v !== undefined) fx[k] = v; }
    out.fx = fx;
  }
  const glass = cleanGlass(raw.glass);
  if (glass) out.glass = glass;
  if (raw.typography === null || (typeof raw.typography === 'string' && TYPOGRAPHY_PRESETS.some((p) => p.name === raw.typography))) out.typography = raw.typography as string | null;
  const type = cleanType(raw.type);
  if (type) out.type = type;
  if (raw.textOverride === null || isColour(raw.textOverride)) out.textOverride = raw.textOverride as string | null;
  const r = num(raw.shapeRadius, 0, 24);
  if (r !== undefined) out.shapeRadius = r;
  if (isImage(raw.wallpaper)) out.wallpaper = raw.wallpaper;
  if (Array.isArray(raw.wallpapers)) {
    const ws = raw.wallpapers.filter(isImage).slice(0, 10);
    if (ws.length) out.wallpapers = ws;
  }
  if (typeof raw.slideshowEnabled === 'boolean') out.slideshowEnabled = raw.slideshowEnabled;
  if (typeof raw.movingWallpaper === 'boolean') out.movingWallpaper = raw.movingWallpaper;
  if (isImage(raw.movingPoster)) out.movingPoster = raw.movingPoster;
  if (isImage(raw.lockScreenWallpaper)) out.lockScreenWallpaper = raw.lockScreenWallpaper;
  const face = oneOf(raw.lockFace, ['stacked', 'dateline', 'classic'] as const);
  if (face) out.lockFace = face;
  const cards = oneOf(raw.lockCards, ['dark', 'light', 'auto'] as const);
  if (cards) out.lockCards = cards as Look['lockCards'];
  if (Array.isArray(raw.stickyNoteColors)) {
    const cs = raw.stickyNoteColors.filter(isColour).slice(0, 12);
    if (cs.length) out.stickyNoteColors = cs;
  }
  return out;
}

export type ParsedLookFile = { ok: true; file: LookFile } | { ok: false; reason: string };

/** Read a .bllook someone sent. Never throws. */
export function parseLookFile(text: string): ParsedLookFile {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: "That file is empty." };
  if (text.length > MAX_FILE_CHARS) return { ok: false, reason: 'That look file is too big (over 45 MB).' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: "That isn't a look file (it can't be read)." }; }
  if (!isObj(raw) || raw.format !== LOOK_FILE_FORMAT) return { ok: false, reason: "That isn't a ByteLight look file." };
  if (typeof raw.version !== 'number' || raw.version > LOOK_FILE_VERSION) {
    return { ok: false, reason: 'That look was made by a newer version of the app. Update yours, then try again.' };
  }
  const look = cleanLook(raw.look);
  if (!Object.keys(look).length) return { ok: false, reason: "That look file has nothing in it this app can use." };
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : 'Shared look';
  let moving: LookFile['moving'];
  if (isObj(raw.moving) && typeof raw.moving.data === 'string' && raw.moving.data.length <= MAX_MOVING_CHARS && MOVING_DATA.test(raw.moving.data)) {
    const kind = raw.moving.kind === 'image' ? 'image' : 'video';
    moving = { kind, name: typeof raw.moving.name === 'string' ? raw.moving.name.slice(0, 80) : 'moving', data: raw.moving.data };
  }
  if (look.movingWallpaper && !moving) look.movingWallpaper = false; // nothing to play
  return { ok: true, file: { format: LOOK_FILE_FORMAT, version: LOOK_FILE_VERSION, name, look, fonts: fontNamesOf(look), ...(moving ? { moving } : {}) } };
}
