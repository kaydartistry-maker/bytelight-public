import { collectThemeAssetIds, normalizeThemeAppearance } from '@bytelight/shared';
import type { AppTheme, AppThemePreset } from '../types';
import type { ThemeAsset } from '../bytelight/theme-assets';
import { THEMES, ACCENT_PALETTES, TYPOGRAPHY_PRESETS } from './theme';

export const MAX_THEME_BUNDLE_BYTES = 20 * 1024 * 1024;
export const MAX_THEME_PRESETS = 50;
export const THEME_ASSET_IMPORT_LIMITS = { maxAssets: 200, quotaBytes: 250 * 1024 * 1024 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWN_URL = /^\/api\/theme-assets\/([0-9a-f-]{36})\/file$/;
const COLORS = ['pageBg', 'panelBg', 'panelBorder', 'textMain', 'textMuted', 'userBubbleBg', 'userBubbleText', 'compBubbleBg', 'compBubbleText', 'accent', 'accentText', 'noteText'];
const WIDGETS = ['companions', 'note', 'weather', 'letter', 'day', 'status', 'soundtrack'];
const KEYS = ['mode', 'id', 'appearance', 'skin', 'fx', 'accentOverride', 'accentPalette', 'typography', 'wallpaper', 'lockScreenWallpaper', 'wallpapers', 'slideshowEnabled', 'customColors', 'stickyNoteColors', 'shapeRadius', 'lockFace', 'lockClockPosition', 'lockClockSize', 'lockClockAt', 'lockWeatherAt', 'lockHidden', 'lockShortcuts', 'lockShow', 'lockCards', 'homeWidgets', 'homeWidgetSpots', 'homeQuietLine'];
const dangerous = new Set(['__proto__', 'constructor', 'prototype']);
type RecordValue = Record<string, any>;
export interface EmbeddedThemeAsset { id: string; name: string; kind: 'image' | 'font'; mime: string; data: string }
export interface ThemeBundle { format: 'virelle-theme'; version: 1; name: string; theme: AppTheme; assets: EmbeddedThemeAsset[] }
function fail(message: string): never { throw new Error(message); }
const size = (value: string): number => new TextEncoder().encode(value).byteLength;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Expected a plain theme object');
  return value as RecordValue;
}
function checkKeys(value: RecordValue, allowed: string[]): void {
  for (const key of Object.keys(value)) if (dangerous.has(key) || !allowed.includes(key)) fail(`Unsupported theme field: ${key}`);
}
function bounded(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail('Theme number is outside supported bounds');
  return value as number;
}
function choice(value: unknown, allowed: readonly string[]): any {
  if (typeof value !== 'string' || !allowed.includes(value)) fail('Unsupported theme option');
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail('Expected a theme switch'); return value as boolean; }
function color(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !(/^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|[a-z]{1,32}|(?:rgba?|hsla?)\([\d.,%+\-/\sdegturnrad]+\))$/i.test(value))) fail('Unsupported theme color');
  return value;
}
function safeTree(value: unknown): void {
  const pending = [{ value, depth: 0 }]; let budget = 30_000;
  while (pending.length) {
    if (--budget < 0) fail('Theme file is too complex');
    const entry = pending.pop()!;
    if (!entry.value || typeof entry.value !== 'object') continue;
    if (entry.depth > 24) fail('Theme file is nested too deeply');
    const source = Array.isArray(entry.value) ? entry.value : record(entry.value);
    for (const key of Object.keys(source)) {
      if (pending.length >= 30_000) fail('Theme file is too complex');
      if (dangerous.has(key)) fail('Unsafe theme object key');
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor || !('value' in descriptor)) fail('Theme accessors are not supported');
      pending.push({ value: descriptor.value, depth: entry.depth + 1 });
    }
  }
}
function assertNormalized(input: unknown, normalized: unknown): void {
  const source = record(input), target = record(normalized);
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (!(key in target)) {
      fail('Unknown or invalid appearance field');
    }
    if (value && typeof value === 'object') assertNormalized(value, target[key]);
    else if (value !== target[key]) fail('Appearance value is outside supported bounds');
  }
}
const MIME: Record<string, { kind: 'image' | 'font'; max: number; extensions: string[] }> = {
  'image/png': { kind: 'image', max: 10 * 1024 * 1024, extensions: ['png'] },
  'image/jpeg': { kind: 'image', max: 10 * 1024 * 1024, extensions: ['jpg', 'jpeg'] },
  'image/webp': { kind: 'image', max: 10 * 1024 * 1024, extensions: ['webp'] },
  'image/gif': { kind: 'image', max: 10 * 1024 * 1024, extensions: ['gif'] },
  'font/woff2': { kind: 'font', max: 5 * 1024 * 1024, extensions: ['woff2'] },
  'font/woff': { kind: 'font', max: 5 * 1024 * 1024, extensions: ['woff'] },
  'font/ttf': { kind: 'font', max: 5 * 1024 * 1024, extensions: ['ttf'] },
  'font/otf': { kind: 'font', max: 5 * 1024 * 1024, extensions: ['otf'] },
};
export function decodeThemeAsset(data: string): Uint8Array {
  if (typeof data !== 'string' || !data.length || data.length % 4 || /[^A-Za-z0-9+/=]/.test(data) || !/^={0,2}$/.test(data.slice(data.indexOf('=') < 0 ? data.length : data.indexOf('=')))) fail('Invalid base64 theme asset');
  if (data.length > Math.ceil(10 * 1024 * 1024 / 3) * 4) fail('Embedded theme asset is too large');
  try { const binary = atob(data); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
  catch { return fail('Invalid encoded theme asset'); }
}
function encode(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let at = 0; at < bytes.length; at += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(at, at + 0x8000)));
  return btoa(parts.join(''));
}
function validateMagic(bytes: Uint8Array, mime: string): void {
  const ascii = (at: number, count: number) => String.fromCharCode(...bytes.subarray(at, at + count));
  const valid = mime === 'image/png' ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    : mime === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === 'image/webp' ? bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP'
    : mime === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
    : mime === 'font/woff2' ? bytes.length >= 48 && ascii(0, 4) === 'wOF2'
    : mime === 'font/woff' ? bytes.length >= 44 && ascii(0, 4) === 'wOFF'
    : mime === 'font/otf' ? bytes.length >= 12 && ascii(0, 4) === 'OTTO'
    : mime === 'font/ttf' ? bytes.length >= 12 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0 : false;
  if (!valid) fail('Embedded asset content does not match its type');
}
function wallpaper(value: unknown, portable: boolean): string {
  if (typeof value !== 'string' || !value.length) fail('Invalid wallpaper reference');
  if (value.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (!match) fail('Only raster image data is allowed in wallpapers');
    const bytes = decodeThemeAsset(match[2]); validateMagic(bytes, match[1]); return value;
  }
  if (value.length > 2048 || /[\x00-\x20\\]/.test(value)) fail('Invalid wallpaper URL');
  if (/^https:\/\//i.test(value)) {
    if (portable) fail('Remote wallpaper cannot be packaged safely. Upload or embed the image first.');
    const url = new URL(value); if (url.username || url.password) fail('Wallpaper URLs cannot contain credentials');
    return value;
  }
  if (value.startsWith('/api/theme-assets/')) {
    const match = OWN_URL.exec(value);
    if (!match || !UUID.test(match[1])) fail('Invalid private theme asset URL');
    return value;
  }
  if (/^\/(?:assets\/|phone\/assets\/|api\/files\/|api\/theme-assets\/)/.test(value) && !value.includes('..') && !/%(?:2e|2f|5c)/i.test(value) && !value.startsWith('//')) return value;
  return fail('Unsupported wallpaper URL; upload the image first');
}
function xy(value: unknown): { x: number; y: number } {
  const input = record(value); checkKeys(input, ['x', 'y']); return { x: bounded(input.x, 0, 1), y: bounded(input.y, 0, 1) };
}

/** Export/save allowlists appearance ONLY. Strict import rejects unknown keys
 * rather than quietly treating credentials or future executable fields as themes. */
export function sanitizePresetTheme(input: unknown, strict = false, portable = false): AppTheme {
  const source = record(input);
  if (strict) { safeTree(source); checkKeys(source, KEYS); }
  const result: RecordValue = { mode: choice(source.mode, ['light', 'dark']), id: choice(source.id, Object.keys(THEMES)) };
  const set = (key: string, read: (value: any) => unknown) => {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) result[key] = read(source[key]);
  };
  set('appearance', value => { safeTree(value); const normalized = normalizeThemeAppearance(value); if (strict) assertNormalized(value, normalized); return normalized; });
  set('skin', value => choice(value, ['none', 'cosmos']));
  set('fx', value => { const v = record(value); checkKeys(v, ['aura', 'glow', 'motion']); const out: RecordValue = {}; for (const key of Object.keys(v)) out[key] = bounded(v[key], 0, 200); return out; });
  set('accentOverride', value => value === null ? null : color(value));
  set('accentPalette', value => value === null ? null : choice(value, ACCENT_PALETTES.map(p => p.name)));
  set('typography', value => value === null ? null : choice(value, TYPOGRAPHY_PRESETS.map(p => p.name)));
  let wallpaperBytes = 0;
  const readWallpaper = (value: unknown) => {
    if (typeof value === 'string') wallpaperBytes += size(value);
    if (wallpaperBytes > MAX_THEME_BUNDLE_BYTES) fail('Wallpapers exceed the 20 MB theme limit');
    return wallpaper(value, portable);
  };
  for (const key of ['wallpaper', 'lockScreenWallpaper']) set(key, readWallpaper);
  set('wallpapers', value => { if (!Array.isArray(value) || value.length > 20) fail('Too many slideshow wallpapers'); return value.map(readWallpaper); });
  for (const key of ['slideshowEnabled', 'homeQuietLine']) set(key, bool);
  set('customColors', value => {
    const v = record(value); checkKeys(v, ['light', 'dark']); const out: RecordValue = {};
    for (const mode of ['light', 'dark']) if (v[mode] !== undefined) {
      const colors = record(v[mode]); checkKeys(colors, COLORS); out[mode] = Object.fromEntries(Object.entries(colors).map(([key, val]) => [key, color(val)]));
    }
    return out;
  });
  set('stickyNoteColors', value => { if (!Array.isArray(value) || value.length > 20) fail('Invalid sticky-note colors'); return value.map(color); });
  set('shapeRadius', value => bounded(value, 0, 24));
  set('lockFace', value => choice(value, ['stacked', 'dateline', 'classic']));
  set('lockClockPosition', value => choice(value, ['top', 'middle', 'low']));
  set('lockClockSize', value => choice(value, ['s', 'm', 'l']));
  set('lockClockAt', value => { const v = record(value); checkKeys(v, ['stacked', 'dateline', 'classic']); return Object.fromEntries(Object.entries(v).map(([key, val]) => [key, xy(val)])); });
  set('lockWeatherAt', xy);
  set('lockHidden', value => { if (!Array.isArray(value) || value.length > 2) fail('Invalid lock visibility'); return value.map(v => choice(v, ['clock', 'weather'])); });
  set('lockShortcuts', value => {
    if (!Array.isArray(value) || value.length !== 2) fail('Expected two lock shortcuts');
    return value.map(v => v === null ? null : typeof v === 'string' && /^[a-z0-9_-]{1,80}$/i.test(v) && !dangerous.has(v) ? v : fail('Invalid shortcut ID'));
  });
  set('lockShow', value => choice(value, ['names', 'first-line', 'nothing']));
  set('lockCards', value => choice(value, ['dark', 'light', 'auto']));
  set('homeWidgets', value => { if (!Array.isArray(value) || value.length > WIDGETS.length) fail('Invalid home widgets'); return value.map(v => choice(v, WIDGETS)); });
  set('homeWidgetSpots', value => {
    const v = record(value); checkKeys(v, WIDGETS);
    return Object.fromEntries(Object.entries(v).map(([key, val]) => { const spot = record(val); checkKeys(spot, ['col', 'row']); return [key, { col: bounded(spot.col, 0, 3, true), row: bounded(spot.row, 0, 1000, true) }]; }));
  });
  const serialized = JSON.stringify(result);
  if (size(serialized) > MAX_THEME_BUNDLE_BYTES) fail('Theme exceeds the 20 MB limit');
  return result as AppTheme;
}
export function presetName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) fail('Use a preset name between 1 and 80 characters');
  return value.trim();
}
export function createThemePreset(theme: AppTheme, name: string): AppThemePreset {
  const now = new Date().toISOString(); return { id: crypto.randomUUID(), name: presetName(name), createdAt: now, updatedAt: now, theme: sanitizePresetTheme(theme) };
}
export function validateThemePresetList(presets: AppThemePreset[]): void {
  if (presets.length > MAX_THEME_PRESETS) fail(`Keep up to ${MAX_THEME_PRESETS} named presets. Remove an unused preset first.`);
  if (size(JSON.stringify(presets)) > MAX_THEME_BUNDLE_BYTES) fail('Preset library exceeds 20 MB. Remove unused presets or use uploaded wallpaper assets instead of duplicated inline images.');
}
/** Parent validation checks the actual complete settings snapshot/body budget.
 * A mutation is acknowledged ONLY after the parent's durable write succeeds. */
export async function persistThemePresetList(presets: AppThemePreset[], persist: (list: AppThemePreset[]) => Promise<void>, validate?: (list: AppThemePreset[]) => void): Promise<void> {
  validateThemePresetList(presets);
  validate?.(presets);
  await persist(presets);
}
/** Conservative preflight against the currently loaded library. The server
 * remains authoritative when another browser uploads or limits are tightened. */
export function preflightThemeAssetImport(bundle: ThemeBundle, library: ThemeAsset[]): void {
  if (library.length + bundle.assets.length > THEME_ASSET_IMPORT_LIMITS.maxAssets) fail('Import exceeds the 200-asset theme library limit. Remove unused uploads first.');
  let total = 0;
  for (const asset of library) {
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 1) fail('Reload the asset library before importing; its size could not be verified.');
    total += asset.bytes;
  }
  for (const asset of bundle.assets) {
    const bytes = asset.data.length / 4 * 3 - (asset.data.endsWith('==') ? 2 : asset.data.endsWith('=') ? 1 : 0);
    if (!Number.isSafeInteger(bytes) || bytes < 1) fail('Invalid embedded asset size');
    total += bytes;
  }
  if (total > THEME_ASSET_IMPORT_LIMITS.quotaBytes) fail('Import exceeds the 250 MB theme asset storage quota. Remove unused uploads first.');
}
function referencedIds(theme: AppTheme): string[] {
  const ids = new Set(collectThemeAssetIds(theme.appearance));
  for (const url of [theme.wallpaper, theme.lockScreenWallpaper, ...(theme.wallpapers ?? [])]) {
    const match = typeof url === 'string' ? OWN_URL.exec(url) : null;
    if (match) ids.add(match[1]);
  }
  for (const id of ids) if (!UUID.test(id)) fail('Portable themes require UUID asset references');
  return [...ids];
}
function requiredKinds(theme: AppTheme): Map<string, 'font' | 'image'> {
  const result = new Map<string, 'font' | 'image'>();
  const add = (id: string, kind: 'font' | 'image') => {
    if (result.has(id) && result.get(id) !== kind) fail('An asset cannot be used as both a font and image');
    result.set(id, kind);
  };
  function visit(value: unknown, parent = '', grandparent = ''): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'assetId' && typeof child === 'string') add(child, parent === 'text' || grandparent === 'typography' ? 'font' : 'image');
      else visit(child, key, parent);
    }
  }
  visit(theme.appearance);
  for (const value of [theme.wallpaper, theme.lockScreenWallpaper, ...(theme.wallpapers ?? [])]) {
    const match = typeof value === 'string' ? OWN_URL.exec(value) : null;
    if (match) add(match[1], 'image');
  }
  return result;
}
function validateEmbedded(input: unknown): EmbeddedThemeAsset {
  const source = record(input); checkKeys(source, ['id', 'name', 'kind', 'mime', 'data']);
  if (typeof source.id !== 'string' || !UUID.test(source.id)) fail('Invalid bundled asset ID');
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name || name.length > 160 || /[\x00-\x1f\x7f/\\]/.test(name) || name.startsWith('.')) fail('Invalid bundled asset filename');
  const format = Object.prototype.hasOwnProperty.call(MIME, source.mime) ? MIME[source.mime] : undefined;
  if (!format || source.kind !== format.kind || !format.extensions.includes(name.split('.').pop()!.toLowerCase())) fail('Unsupported bundled asset type');
  const bytes = decodeThemeAsset(source.data);
  if (bytes.length > format.max) fail('Bundled asset exceeds its upload limit');
  validateMagic(bytes, source.mime);
  return { id: source.id, name, kind: source.kind, mime: source.mime, data: source.data };
}
export function parseThemeBundle(text: string): ThemeBundle {
  if (typeof text !== 'string' || size(text) > MAX_THEME_BUNDLE_BYTES) fail('Theme file exceeds the 20 MB limit');
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { return fail('Theme file is not valid JSON'); }
  safeTree(parsed); const source = record(parsed); checkKeys(source, ['format', 'version', 'name', 'theme', 'assets']);
  if (source.format !== 'virelle-theme' || source.version !== 1) fail('Unsupported theme bundle format or version');
  const theme = sanitizePresetTheme(source.theme, true, true);
  if (!Array.isArray(source.assets) || source.assets.length > 200) fail('Invalid bundled asset list');
  const assets = source.assets.map(validateEmbedded), ids = new Set(assets.map(a => a.id));
  if (ids.size !== assets.length) fail('Duplicate bundled asset IDs');
  const referenced = referencedIds(theme);
  if (referenced.some(id => !ids.has(id)) || assets.some(a => !referenced.includes(a.id))) fail('Bundle assets must exactly match referenced assets');
  const kinds = requiredKinds(theme);
  if (assets.some(asset => kinds.get(asset.id) !== asset.kind)) fail('Asset kind does not match its appearance slot');
  return { format: 'virelle-theme', version: 1, name: presetName(source.name), theme, assets };
}
/** The reader is called ONLY for exact listed private theme-asset endpoints.
 * Never fetch legacy wallpapers, arbitrary URLs or unrelated library files. */
export async function buildThemeBundle(name: string, source: AppTheme, library: ThemeAsset[], readAsset: (asset: ThemeAsset) => Promise<Uint8Array>): Promise<ThemeBundle> {
  const theme = sanitizePresetTheme(source, false, true), assets: EmbeddedThemeAsset[] = [];
  const references = referencedIds(theme);
  const kinds = requiredKinds(theme);
  if (references.length > 200) fail('Too many assets in one theme');
  for (const id of references) {
    const asset = library.find(item => item.id === id);
    if (!asset || asset.url !== `/api/theme-assets/${id}/file` || !MIME[asset.mime] || asset.kind !== MIME[asset.mime].kind || asset.kind !== kinds.get(id) || asset.bytes < 1 || asset.bytes > MIME[asset.mime].max) fail('Referenced private asset is unavailable or has the wrong kind');
    const bytes = await readAsset(asset);
    if (bytes.length !== asset.bytes || bytes.length > MIME[asset.mime].max) fail('Theme asset size does not match library metadata');
    assets.push(validateEmbedded({ id, name: asset.name, kind: asset.kind, mime: asset.mime, data: encode(bytes) }));
    if (size(JSON.stringify({ theme, assets })) > MAX_THEME_BUNDLE_BYTES) fail('Theme bundle exceeds 20 MB');
  }
  return parseThemeBundle(JSON.stringify({ format: 'virelle-theme', version: 1, name: presetName(name), theme, assets }));
}
/** Replace only opaque appearance assetId fields and exact own-asset wallpaper
 * URLs. Never global-string-replace names, colors, profiles or arbitrary data. */
export function remapThemeAssetReferences(source: AppTheme, mapping: Record<string, string>): AppTheme {
  const theme = sanitizePresetTheme(source, true, true);
  const lookup = (id: string): string => {
    const value = Object.prototype.hasOwnProperty.call(mapping, id) ? mapping[id] : undefined;
    if (!value || !UUID.test(value)) fail('Imported asset mapping is incomplete'); return value;
  };
  function walk(value: RecordValue): void {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'assetId' && typeof child === 'string') value[key] = lookup(child);
      else if (child && typeof child === 'object' && !Array.isArray(child)) walk(child);
    }
  }
  if (theme.appearance) walk(theme.appearance);
  const remapUrl = (url: string): string => { const match = OWN_URL.exec(url); return match ? `/api/theme-assets/${lookup(match[1])}/file` : url; };
  if (theme.wallpaper) theme.wallpaper = remapUrl(theme.wallpaper);
  if (theme.lockScreenWallpaper) theme.lockScreenWallpaper = remapUrl(theme.lockScreenWallpaper);
  if (theme.wallpapers) theme.wallpapers = theme.wallpapers.map(remapUrl);
  return theme;
}
