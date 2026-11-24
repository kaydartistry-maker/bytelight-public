import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { getBytelightConfig } from '../config.js';

export type ThemeAssetKind = 'image' | 'font';
export interface ThemeAsset {
  id: string; name: string; kind: ThemeAssetKind; mime: string; bytes: number;
  url: string; createdAt: string; fontFamily?: string;
}
export interface ThemeAssetLimits { maxBytes: number; maxFontBytes: number; maxPixels: number; maxAssets: number; quotaBytes: number }
export const DEFAULT_THEME_ASSET_LIMITS: ThemeAssetLimits = {
  maxBytes: 10 * 1024 * 1024, maxFontBytes: 5 * 1024 * 1024,
  maxPixels: 16_000_000, maxAssets: 200, quotaBytes: 250 * 1024 * 1024,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORMATS: Record<string, { mime: string; ext: string; kind: ThemeAssetKind }> = {
  png: { mime: 'image/png', ext: '.png', kind: 'image' },
  jpeg: { mime: 'image/jpeg', ext: '.jpg', kind: 'image' },
  webp: { mime: 'image/webp', ext: '.webp', kind: 'image' },
  gif: { mime: 'image/gif', ext: '.gif', kind: 'image' },
  woff2: { mime: 'font/woff2', ext: '.woff2', kind: 'font' },
  woff: { mime: 'font/woff', ext: '.woff', kind: 'font' },
  ttf: { mime: 'font/ttf', ext: '.ttf', kind: 'font' },
  otf: { mime: 'font/otf', ext: '.otf', kind: 'font' },
};
export class ThemeAssetError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function defaultThemeAssetsDir(): string {
  return join(process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : dirname(getBytelightConfig().server.db_path), 'theme-assets');
}
function safeName(value: string): string {
  value = value.trim();
  if (!value || value.length > 160 || /[\x00-\x1f\x7f/\\]/.test(value) || value.startsWith('.')) {
    throw new ThemeAssetError('Use a plain filename without paths or control characters');
  }
  return value;
}
function fontFormat(data: Buffer): string {
  if (data.length < 12) throw new ThemeAssetError('Font header is incomplete');
  const tag = data.toString('ascii', 0, 4);
  if (tag === 'wOFF' || tag === 'wOF2') {
    const header = tag === 'wOFF' ? 44 : 48;
    if (data.length < header || data.readUInt32BE(8) !== data.length || data.readUInt16BE(14) !== 0) {
      throw new ThemeAssetError('Invalid compressed font header');
    }
    const tables = data.readUInt16BE(12), expanded = data.readUInt32BE(16);
    if (!tables || tables > 256 || expanded < 12 || expanded > 20 * 1024 * 1024) throw new ThemeAssetError('Font exceeds decoded limits');
    const flavor = data.readUInt32BE(4);
    if (flavor !== 0x00010000 && flavor !== 0x4f54544f) throw new ThemeAssetError('Unsupported font collection or flavor');
    if (tag === 'wOFF') {
      if (data.length < header + tables * 20) throw new ThemeAssetError('Incomplete font directory');
      for (let i = 0; i < tables; i++) {
        const at = header + i * 20, offset = data.readUInt32BE(at + 4), length = data.readUInt32BE(at + 8), original = data.readUInt32BE(at + 12);
        if (offset < header + tables * 20 || !length || length > original || offset + length > data.length || original > expanded) throw new ThemeAssetError('Invalid font table bounds');
      }
    } else if (!data.readUInt32BE(20) || data.readUInt32BE(20) > data.length - header || data.length < header + tables) {
      throw new ThemeAssetError('Incomplete compressed font data');
    }
    return tag === 'wOFF' ? 'woff' : 'woff2';
  }
  if (data.readUInt32BE(0) !== 0x00010000 && tag !== 'OTTO') throw new ThemeAssetError('Unsupported font header');
  const tables = data.readUInt16BE(4), directoryEnd = 12 + tables * 16;
  if (!tables || tables > 256 || directoryEnd > data.length) throw new ThemeAssetError('Incomplete font directory');
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16, offset = data.readUInt32BE(at + 8), length = data.readUInt32BE(at + 12);
    if (!length || offset < directoryEnd || offset + length > data.length) throw new ThemeAssetError('Invalid font table bounds');
  }
  return tag === 'OTTO' ? 'otf' : 'ttf';
}

/** Scan ONLY theme and preset containers, never stringify/log the setup blob.
 * Budget exhaustion fails closed so a complex setup cannot cause unsafe deletion. */
export function themeAssetIsReferenced(setup: unknown, id: string): boolean {
  if (!UUID.test(id)) return false;
  if (setup == null) return false; // Confirmed empty settings store.
  if (typeof setup !== 'object' || Array.isArray(setup)) return true;
  const root = setup as Record<string, unknown>;
  const app = root.appSettings && typeof root.appSettings === 'object' ? root.appSettings as Record<string, unknown> : {};
  if (root.theme != null && (typeof root.theme !== 'object' || Array.isArray(root.theme))) return true;
  if (root.appSettings != null && (typeof root.appSettings !== 'object' || Array.isArray(root.appSettings))) return true;
  const pending: Array<{ value: unknown; key: string; depth: number }> = [
    { value: root.theme, key: 'theme', depth: 0 }, { value: root.presets, key: 'presets', depth: 0 },
    { value: root.themePresets, key: 'themePresets', depth: 0 }, { value: app.themePresets, key: 'themePresets', depth: 0 },
    { value: root.appearancePresets, key: 'appearancePresets', depth: 0 }, { value: app.appearancePresets, key: 'appearancePresets', depth: 0 },
    { value: app.theme, key: 'theme', depth: 0 },
  ];
  let budget = 20_000;
  while (pending.length) {
    if (--budget < 0) return true;
    const { value, key, depth } = pending.pop()!;
    if (typeof value === 'string') {
      if ((/assetid$/i.test(key) && value === id) || value.includes(`/api/theme-assets/${id}/file`)) return true;
    } else if (value && typeof value === 'object') {
      if (depth >= 24) return true;
      for (const [childKey, child] of Object.entries(value)) {
        if (pending.length > 20_000) return true;
        pending.push({ value: child, key: childKey, depth: depth + 1 });
      }
    }
  }
  return false;
}

/** One immutable directory per asset: bytes + metadata are published together
 * by rename. Quota recheck/publication are synchronous after async validation. */
export class ThemeAssetStore {
  readonly directory: string;
  readonly limits: ThemeAssetLimits;
  constructor(directory = defaultThemeAssetsDir(), limits: Partial<ThemeAssetLimits> = {}) {
    this.directory = resolve(directory);
    this.limits = { ...DEFAULT_THEME_ASSET_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid theme asset limits');
  }
  private ensure(): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid theme asset directory');
  }
  get(id: string): { asset: ThemeAsset; path: string } | null {
    if (!UUID.test(id)) return null;
    const dir = join(this.directory, id);
    if (!existsSync(dir)) return null;
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) return null;
    try {
      const metadata = join(dir, 'metadata.json');
      if (lstatSync(metadata).isSymbolicLink() || lstatSync(metadata).size > 4096) return null;
      const asset = JSON.parse(readFileSync(metadata, 'utf8')) as ThemeAsset;
      const format = Object.values(FORMATS).find(f => f.mime === asset.mime && f.kind === asset.kind);
      if (!format || asset.id !== id || asset.url !== `/api/theme-assets/${id}/file` || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) return null;
      safeName(asset.name);
      if (asset.kind === 'font' && asset.fontFamily !== `ThemeFont_${id.replaceAll('-', '_')}`) return null;
      const path = join(dir, `asset${format.ext}`), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes) return null;
      return { asset, path };
    } catch { return null; }
  }
  list(): ThemeAsset[] {
    this.ensure();
    return readdirSync(this.directory).filter(id => UUID.test(id)).map(id => this.get(id)?.asset).filter((a): a is ThemeAsset => !!a)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async save(data: Buffer, name: string, kind: ThemeAssetKind): Promise<ThemeAsset> {
    name = safeName(name);
    if (kind !== 'image' && kind !== 'font') throw new ThemeAssetError('Choose image or font');
    if (!data.length || data.length > Math.min(this.limits.maxBytes, kind === 'font' ? this.limits.maxFontBytes : this.limits.maxBytes)) throw new ThemeAssetError('Asset exceeds byte limit', 413);
    let formatName: string;
    if (kind === 'image') {
      try {
        const image = sharp(data, { animated: true, limitInputPixels: this.limits.maxPixels, failOn: 'warning' });
        const info = await image.metadata();
        if (!info.format || !['png', 'jpeg', 'webp', 'gif'].includes(info.format)) throw new Error('format');
        if (!info.width || !info.height || info.width * info.height > this.limits.maxPixels || (info.pages ?? 1) > 100) throw new Error('pixels');
        await image.raw().toBuffer(); // Force decode; metadata alone accepts truncated images.
        formatName = info.format;
      } catch { throw new ThemeAssetError('Use a valid PNG, JPEG, WebP or GIF within pixel limits'); }
    } else formatName = fontFormat(data);
    const format = FORMATS[formatName];
    const allowedExtensions = formatName === 'jpeg' ? ['.jpg', '.jpeg'] : [format.ext];
    if (!allowedExtensions.includes(extname(name).toLowerCase())) throw new ThemeAssetError('Filename extension does not match asset content');
    const existing = this.list();
    if (existing.length >= this.limits.maxAssets || existing.reduce((n, a) => n + a.bytes, 0) + data.length > this.limits.quotaBytes) throw new ThemeAssetError('Theme asset storage quota reached', 413);
    const id = randomUUID(), temporary = join(this.directory, `.upload-${id}`);
    const asset: ThemeAsset = { id, name, kind, mime: format.mime, bytes: data.length, url: `/api/theme-assets/${id}/file`, createdAt: new Date().toISOString(),
      ...(kind === 'font' ? { fontFamily: `ThemeFont_${id.replaceAll('-', '_')}` } : {}) };
    mkdirSync(temporary, { mode: 0o700 });
    try {
      writeFileSync(join(temporary, `asset${format.ext}`), data, { mode: 0o600, flag: 'wx' });
      writeFileSync(join(temporary, 'metadata.json'), JSON.stringify(asset), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, join(this.directory, id));
    } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
    return asset;
  }
  remove(id: string, setup: unknown): boolean {
    if (!this.get(id)) return false;
    if (themeAssetIsReferenced(setup, id)) throw new ThemeAssetError('Asset is still used by a theme or preset', 409);
    const temporary = join(this.directory, `.deleting-${id}-${randomUUID()}`);
    renameSync(join(this.directory, id), temporary);
    rmSync(temporary, { recursive: true });
    return true;
  }
}
