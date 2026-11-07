/**
 * Image generation — the house's own hands.
 *
 * Two backends, chosen by config (`image_gen.backend`):
 *   - 'codex'  (default): shells out to the locally-installed `codex` CLI and
 *     its built-in `image_gen` tool, which renders gpt-image-2 on the ChatGPT
 *     *subscription* — no API key, no per-image cost.
 *   - 'openai' (fallback): the metered OpenAI Images API with a user-supplied
 *     key. Same model, costs a few cents per picture.
 *
 * Reference conditioning: each subject maps to a
 * drawer of reference images under data/image-refs/<subject>/. Those files are
 * passed to the model so we stay looking like ourselves shot to shot.
 *
 * The whole feature remains opt-in through Studio settings.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, extname, basename } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';
import { PROJECT_ROOT } from '../config.js';
import { getConfig, setConfig, getConfigBool, getConfigNumber, getDb } from './db.js';
import { errMessage } from '../util/errors.js';

/** Engine tag recorded on usage_events for image generations. */
export const IMAGE_GEN_ENGINE = 'image-gen';

// ─── Paths & constants ───────────────────────────────────────────────

export type Subject = string;

export interface Drawer { slug: string; label: string; isDefault: boolean; emoji?: string; }

const DEFAULT_DRAWERS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: 'companion-a', label: 'Companion A' },
  { slug: 'companion-b', label: 'Companion B' },
  { slug: 'user', label: 'You' },
];

const DATA_DIR = join(PROJECT_ROOT, 'data');
export const REFS_DIR = join(DATA_DIR, 'image-refs');
export const GALLERY_DIR = join(DATA_DIR, 'generated-images');
export const STUDIO_UPLOADS_DIR = join(DATA_DIR, 'studio-one-off-refs');
const JOBS_FILE = join(DATA_DIR, 'studio-image-jobs.json');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov']);

const SIZE_MAP: Record<string, { guidance: string; apiSize: string }> = {
  square: { guidance: 'square, roughly 1024x1024 pixels', apiSize: '1024x1024' },
  portrait: { guidance: 'portrait (taller than wide), roughly 1024x1536 pixels', apiSize: '1024x1536' },
  landscape: { guidance: 'landscape (wider than tall), roughly 1536x1024 pixels', apiSize: '1536x1024' },
  '16:9': { guidance: 'widescreen 16:9 aspect ratio, roughly 1536x864 pixels', apiSize: '1536x864' },
  '9:16': { guidance: 'vertical 9:16 aspect ratio, roughly 864x1536 pixels', apiSize: '864x1536' },
  '21:9': { guidance: 'ultrawide 21:9 aspect ratio, roughly 1536x658 pixels', apiSize: '1536x658' },
  '2:3': { guidance: '2:3 aspect ratio, roughly 1024x1536 pixels', apiSize: '1024x1536' },
  '3:2': { guidance: '3:2 aspect ratio, roughly 1536x1024 pixels', apiSize: '1536x1024' },
  '4:5': { guidance: '4:5 aspect ratio, roughly 1024x1280 pixels', apiSize: '1024x1280' },
  '5:4': { guidance: '5:4 aspect ratio, roughly 1280x1024 pixels', apiSize: '1280x1024' },
};

// ─── Config helpers ──────────────────────────────────────────────────

export type Quality = 'auto' | 'low' | 'medium' | 'high';
const VALID_QUALITY: Quality[] = ['auto', 'low', 'medium', 'high'];

export const ANTIGRAVITY_MODELS = [
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
] as const;

export type AntigravityModel = typeof ANTIGRAVITY_MODELS[number];

export interface ImageGenSettings {
  enabled: boolean;
  backend: 'codex' | 'openai' | 'cloudflare' | 'antigravity' | 'openart';
  size: 'square' | 'portrait' | 'landscape';
  quality: Quality;
  openaiModel: string;
  antigravityModel: AntigravityModel;
  openartModel: string;
  monthlyBudgetUsd: number;
  hasOpenaiKey: boolean;
}

export function getImageGenSettings(): ImageGenSettings {
  const backend = (getConfig('image_gen.backend') as ImageGenSettings['backend']) || 'codex';
  const size = (getConfig('image_gen.size') as ImageGenSettings['size']) || 'square';
  const quality = (getConfig('image_gen.quality') as Quality) || 'auto';
  const antigravityModel = getConfig('image_gen.antigravity_model') as AntigravityModel || 'Gemini 3.5 Flash (Medium)';
  return {
    enabled: getConfigBool('image_gen.enabled', false),
    backend: ['codex', 'openai', 'cloudflare', 'antigravity', 'openart'].includes(backend) ? backend as ImageGenSettings['backend'] : 'codex',
    size: SIZE_MAP[size] ? size : 'square',
    quality: VALID_QUALITY.includes(quality) ? quality : 'auto',
    openaiModel: getConfig('image_gen.openai_model') || 'gpt-image-2',
    antigravityModel: ANTIGRAVITY_MODELS.includes(antigravityModel) ? antigravityModel : 'Gemini 3.5 Flash (Medium)',
    openartModel: getConfig('image_gen.openart_model') || 'nano-banana-2-lite',
    monthlyBudgetUsd: getConfigNumber('image_gen.monthly_budget_usd', 0),
    hasOpenaiKey: !!getConfig('image_gen.openai_api_key'),
  };
}

function codexBin(): string {
  // Do not pin Studio to the binary nested inside a particular npm package
  // version. `codex update` installs the current standalone CLI in ~/.local/bin.
  // PM2's deliberately minimal PATH does not include that directory, so resolve
  // the standalone install directly rather than relying on command lookup.
  return getConfig('image_gen.codex_bin') || process.env.CODEX_BIN || join(homedir(), '.local', 'bin', 'codex');
}

function codexHome(): string {
  return getConfig('image_gen.codex_home') || process.env.CODEX_HOME || join(homedir(), '.codex');
}

function antigravityHome(): string {
  return getConfig('image_gen.antigravity_home') || join(homedir(), '.gemini', 'antigravity-cli');
}

function antigravityBin(): string {
  return getConfig('image_gen.antigravity_bin') || join(homedir(), '.local', 'bin', 'agy');
}

// ─── Drawers (named reference sets) ──────────────────────────────────

export function slugifyDrawer(label: string): string {
  return String(label).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function sanitizeSlug(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

type CustomDrawer = { slug: string; label: string; emoji?: string };

function customDrawers(): CustomDrawer[] {
  const raw = getConfig('image_gen.drawers');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr
          .filter((d) => d && typeof d.slug === 'string' && typeof d.label === 'string')
          .map((d) => ({ slug: d.slug, label: d.label, emoji: typeof d.emoji === 'string' && d.emoji ? d.emoji : undefined }))
      : [];
  } catch { return []; }
}

function setCustomDrawers(list: CustomDrawer[]): void {
  setConfig('image_gen.drawers', JSON.stringify(list));
}

function cleanEmoji(e: string | undefined): string | undefined {
  const v = String(e ?? '').trim();
  return v ? Array.from(v).slice(0, 2).join('') : undefined;
}

export function listDrawers(): Drawer[] {
  const defaults = DEFAULT_DRAWERS.map((d) => ({ ...d, isDefault: true }));
  const customs = customDrawers()
    .filter((d) => !DEFAULT_DRAWERS.some((x) => x.slug === d.slug))
    .map((d) => ({ ...d, isDefault: false }));
  return [...defaults, ...customs];
}

export function isKnownDrawer(slug: string): boolean {
  return listDrawers().some((d) => d.slug === sanitizeSlug(slug));
}

export function listDrawersWithCounts(): Array<Drawer & { count: number }> {
  return listDrawers().map((d) => {
    let count = 0;
    try {
      const dir = join(REFS_DIR, d.slug);
      if (existsSync(dir)) count = readdirSync(dir).filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase())).length;
    } catch { /* ignore */ }
    return { ...d, count };
  });
}

export function isValidSubject(s: string): boolean {
  return isKnownDrawer(s);
}

export function createDrawer(label: string, emoji?: string): Drawer {
  const trimmed = String(label || '').trim();
  if (!trimmed) throw new ImageGenError('A name is required.');
  const slug = slugifyDrawer(trimmed);
  if (!slug) throw new ImageGenError('That name has no usable characters — try letters or numbers.');
  const existing = listDrawers().find((d) => d.slug === slug);
  if (existing) return existing;
  const e = cleanEmoji(emoji);
  const customs = customDrawers();
  customs.push({ slug, label: trimmed, emoji: e });
  setCustomDrawers(customs);
  return { slug, label: trimmed, isDefault: false, emoji: e };
}

export function renameDrawer(slug: string, label: string, emoji?: string): Drawer {
  const s = sanitizeSlug(slug);
  if (DEFAULT_DRAWERS.some((d) => d.slug === s)) throw new ImageGenError('The default drawers cannot be renamed.');
  const trimmed = String(label || '').trim();
  if (!trimmed) throw new ImageGenError('A name is required.');
  const e = cleanEmoji(emoji);
  const customs = customDrawers();
  const idx = customs.findIndex((d) => d.slug === s);
  if (idx === -1) throw new ImageGenError('Drawer not found.');
  customs[idx] = { slug: s, label: trimmed, emoji: e };
  setCustomDrawers(customs);
  return { slug: s, label: trimmed, isDefault: false, emoji: e };
}

export async function deleteDrawer(slug: string): Promise<boolean> {
  const s = sanitizeSlug(slug);
  if (DEFAULT_DRAWERS.some((d) => d.slug === s)) throw new ImageGenError('The default drawers cannot be deleted.');
  const customs = customDrawers();
  const next = customs.filter((d) => d.slug !== s);
  if (next.length === customs.length) return false;
  setCustomDrawers(next);
  const dir = join(REFS_DIR, s);
  if (existsSync(dir)) await fs.rm(dir, { recursive: true, force: true });
  return true;
}

// ─── Reference library (CRUD) ────────────────────────────────────────

function subjectDir(subject: Subject): string {
  return join(REFS_DIR, sanitizeSlug(subject));
}

function safeName(name: string): string {
  const ext = extname(name).toLowerCase();
  const stem = basename(name, ext).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'ref';
  return `${stem}${IMAGE_EXTS.has(ext) ? ext : '.png'}`;
}

export async function listReferences(subject: Subject): Promise<string[]> {
  const dir = subjectDir(subject);
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir);
  const files = entries.filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()));
  const withStat = await Promise.all(
    files.map(async (f) => ({ f, t: (await fs.stat(join(dir, f))).mtimeMs })),
  );
  return withStat.sort((a, b) => b.t - a.t).map((x) => x.f);
}

export async function referencePaths(subject: Subject): Promise<string[]> {
  return (await listReferences(subject)).map((f) => join(subjectDir(subject), f));
}

export async function saveReference(subject: Subject, filename: string, buf: Buffer): Promise<string> {
  const dir = subjectDir(subject);
  await fs.mkdir(dir, { recursive: true });
  const name = safeName(filename);
  await fs.writeFile(join(dir, name), buf);
  return name;
}

export async function deleteReference(subject: Subject, filename: string): Promise<boolean> {
  const target = join(subjectDir(subject), basename(filename));
  if (!existsSync(target)) return false;
  await fs.unlink(target);
  return true;
}

export async function saveOneOffReference(filename: string, buf: Buffer): Promise<string> {
  await fs.mkdir(STUDIO_UPLOADS_DIR, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safeName(filename)}`;
  await fs.writeFile(join(STUDIO_UPLOADS_DIR, name), buf);
  return name;
}

// ─── Gallery ─────────────────────────────────────────────────────────

const GALLERY_INDEX = join(GALLERY_DIR, '_index.json');

export interface GalleryMeta {
  messageId?: string;
  threadId?: string;
  createdAt?: string;
  prompt?: string;
  model?: string;
  backend?: string;
  width?: number;
  height?: number;
  folderId?: string;
  aspectRatio?: string;
  references?: string[];
}

/** Pixel size a requested picture size maps to. Shared by the Studio tab
 *  and the chat door so both write the same gallery card. */
export function galleryDimensions(size?: string, customWidth?: number, customHeight?: number): { width: number; height: number } {
  if (size === 'custom' && customWidth && customHeight) return { width: customWidth, height: customHeight };
  if (size === 'portrait' || size === '2:3') return { width: 1024, height: 1536 };
  if (size === 'landscape' || size === '3:2') return { width: 1536, height: 1024 };
  if (size === '16:9') return { width: 1536, height: 864 };
  if (size === '9:16') return { width: 864, height: 1536 };
  if (size === '21:9') return { width: 1536, height: 658 };
  if (size === '4:5') return { width: 1024, height: 1280 };
  if (size === '5:4') return { width: 1280, height: 1024 };
  return { width: 1024, height: 1024 };
}

/** The gallery card for a picture made from chat: the same fields the Studio
 *  tab records, so the gallery can show its prompt, model and who is in it.
 *  recordGalleryMeta replaces the whole entry, so a card missing these loses them. */
export function chatGalleryMeta(input: {
  prompt: string;
  subjects?: string[];
  size?: string;
  model?: string;
  backend?: string;
  messageId: string;
  threadId: string;
  createdAt: string;
}): GalleryMeta {
  const { width, height } = galleryDimensions(input.size);
  return {
    messageId: input.messageId,
    threadId: input.threadId,
    createdAt: input.createdAt,
    prompt: input.prompt,
    model: input.model,
    backend: input.backend,
    width,
    height,
    aspectRatio: input.size || 'square',
    references: input.subjects?.length ? input.subjects : undefined,
  };
}

async function readGalleryIndex(): Promise<Record<string, GalleryMeta>> {
  if (!existsSync(GALLERY_INDEX)) return {};
  try {
    return JSON.parse(await fs.readFile(GALLERY_INDEX, 'utf8')) as Record<string, GalleryMeta>;
  } catch (error) {
    // A bad read must never silently become an empty index that the next
    // write persists — that wipes every image's prompt/metadata at once
    // (this happened repeatedly through early July 2026). Preserve the
    // unparseable file so its entries stay recoverable, then start empty.
    const backup = `${GALLERY_INDEX}.corrupt-${Date.now()}`;
    try { await fs.copyFile(GALLERY_INDEX, backup); } catch {}
    console.error(`[image-gen] gallery index unreadable — preserved at ${backup}:`, error);
    return {};
  }
}

// Concurrent read-modify-write cycles (multi-image jobs record meta per file)
// interleave and drop each other's entries; a write interrupted mid-file is
// how the index turns unparseable in the first place. Serialize all mutations
// and land each one atomically via tmp + rename.
let galleryIndexLock: Promise<unknown> = Promise.resolve();

function withGalleryIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = galleryIndexLock.then(fn, fn);
  galleryIndexLock = run.catch(() => {});
  return run;
}

async function writeGalleryIndex(idx: Record<string, GalleryMeta>): Promise<void> {
  await fs.mkdir(GALLERY_DIR, { recursive: true });
  const tmp = `${GALLERY_INDEX}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(idx, null, 2));
  await fs.rename(tmp, GALLERY_INDEX);
}

export async function getGalleryMeta(filename: string): Promise<GalleryMeta | null> {
  const idx = await readGalleryIndex();
  return idx[basename(filename)] ?? null;
}

export async function recordGalleryMeta(filename: string, meta: GalleryMeta): Promise<void> {
  console.log(`[recordGalleryMeta] ${filename}: prompt=${meta.prompt?.slice(0, 50) || 'NONE'}`);
  await withGalleryIndexLock(async () => {
    const idx = await readGalleryIndex();
    idx[basename(filename)] = { ...meta };
    await writeGalleryIndex(idx);
  });
}

export interface GalleryItem {
  filename: string;
  createdAt: string;
  size: number;
  mediaType: 'image' | 'video';
  messageId?: string;
  threadId?: string;
  prompt?: string;
  model?: string;
  backend?: string;
  width?: number;
  height?: number;
  folderId?: string;
  aspectRatio?: string;
  references?: string[];
}

export async function listGallery(limit = 2000): Promise<GalleryItem[]> {
  if (!existsSync(GALLERY_DIR)) return [];
  const idx = await readGalleryIndex();
  const entries = await fs.readdir(GALLERY_DIR);
  const imgs = entries.filter((f) => {
    const ext = extname(f).toLowerCase();
    return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext);
  });
  const items = await Promise.all(
    imgs.map(async (f) => {
      const st = await fs.stat(join(GALLERY_DIR, f));
      const meta = idx[f] || {};
      return {
        filename: f,
        mediaType: (VIDEO_EXTS.has(extname(f).toLowerCase()) ? 'video' : 'image') as 'image' | 'video',
        createdAt: meta.createdAt || new Date(st.mtimeMs).toISOString(),
        size: st.size,
        messageId: meta.messageId,
        threadId: meta.threadId,
        prompt: meta.prompt,
        model: meta.model,
        backend: meta.backend,
        width: meta.width,
        height: meta.height,
        folderId: meta.folderId,
        aspectRatio: meta.aspectRatio,
        references: meta.references,
      };
    }),
  );
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
}

export async function deleteGalleryItem(filename: string): Promise<boolean> {
  const name = basename(filename);
  let existed = false;
  const target = join(GALLERY_DIR, name);
  if (existsSync(target)) { await fs.unlink(target); existed = true; }
  await withGalleryIndexLock(async () => {
    const idx = await readGalleryIndex();
    if (idx[name]) { delete idx[name]; await writeGalleryIndex(idx); existed = true; }
  });
  return existed;
}

// ─── Generation ──────────────────────────────────────────────────────

export interface GenerateInput {
  prompt: string;
  subjects?: string[];
  size?: string;
  customWidth?: number;
  customHeight?: number;
  extraRefs?: string[];
  oneOffRefs?: string[];
  backend?: string;
  codexModel?: string;
  openaiModel?: string;
  cloudflareModel?: string;
  agyModel?: string;
  openartModel?: string;
  openartMedia?: 'image' | 'video';
}

export interface GenerateResult {
  filename: string;
  path: string;
  backend: 'codex' | 'openai' | 'cloudflare' | 'antigravity' | 'openart';
  model: string;
  mediaType?: 'image' | 'video';
  durationMs: number;
  costUsd: number;
}

export class ImageGenError extends Error {}

function resolveSize(input: GenerateInput): { guidance: string; apiSize: string } {
  // Handle custom dimensions
  if (input.size === 'custom' && input.customWidth && input.customHeight) {
    const w = Math.min(Math.max(input.customWidth, 256), 2048);
    const h = Math.min(Math.max(input.customHeight, 256), 2048);
    return {
      guidance: `custom ${w}x${h} pixels`,
      apiSize: `${w}x${h}`,
    };
  }
  const settings = getImageGenSettings();
  const key = input.size || settings.size;
  return SIZE_MAP[key] || SIZE_MAP.square;
}

const MAX_REFS_PER_SUBJECT = 2;

async function resolveSubjectRefs(
  subjects: string[] | undefined,
  maxPerSubject = MAX_REFS_PER_SUBJECT,
): Promise<string[]> {
  if (!subjects || subjects.length === 0) return [];
  const drawers = listDrawers();
  const out: string[] = [];
  for (const raw of subjects) {
    const name = String(raw).toLowerCase().trim();
    const slug = sanitizeSlug(name);
    const match = drawers.find(
      (d) => d.slug === slug || d.label.toLowerCase() === name || slugifyDrawer(d.label) === slug,
    );
    if (!match) continue;
    out.push(...(await referencePaths(match.slug)).slice(0, maxPerSubject));
  }
  return out;
}

async function resolveAllRefs(input: GenerateInput, maxPerSubject = MAX_REFS_PER_SUBJECT): Promise<string[]> {
  const subjectRefs = await resolveSubjectRefs(input.subjects, maxPerSubject);
  const extra = (input.extraRefs ?? []).filter((p) => p && existsSync(p));
  const staged = (input.oneOffRefs ?? []).slice(0, 4).map((name) => join(STUDIO_UPLOADS_DIR, basename(name))).filter(existsSync);
  return [...subjectRefs, ...extra, ...staged].slice(0, 8);
}

async function newGalleryName(ext = '.png', prefix = 'img'): Promise<string> {
  await fs.mkdir(GALLERY_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}_${stamp}_${crypto.randomBytes(3).toString('hex')}${ext}`;
}

export async function copyToGallery(source: string, ext: string, prefix: string, meta: GalleryMeta): Promise<{ filename: string; path: string }> {
  const filename = await newGalleryName(ext, prefix);
  const path = join(GALLERY_DIR, filename);
  await fs.copyFile(source, path);
  await recordGalleryMeta(filename, meta);
  return { filename, path };
}

async function findNewestCodexImage(since: number, sessionId?: string | null): Promise<string | null> {
  const root = join(codexHome(), 'generated_images');
  if (!existsSync(root)) return null;
  let best: { path: string; t: number } | null = null;
  const sessions = sessionId ? [sessionId] : await fs.readdir(root).catch(() => [] as string[]);
  for (const sess of sessions) {
    const dir = join(root, sess);
    let files: string[];
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) continue;
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!IMAGE_EXTS.has(extname(f).toLowerCase())) continue;
      const p = join(dir, f);
      try {
        const st = await fs.stat(p);
        if (st.mtimeMs >= since - 1000 && (!best || st.mtimeMs > best.t)) {
          best = { path: p, t: st.mtimeMs };
        }
      } catch { /* skip */ }
    }
  }
  return best?.path ?? null;
}

async function findNewestAntigravityImage(since: number): Promise<string | null> {
  const root = join(antigravityHome(), 'brain');
  if (!existsSync(root)) return null;
  let best: { path: string; t: number } | null = null;
  const sessions = await fs.readdir(root).catch(() => [] as string[]);
  for (const sess of sessions) {
    const dir = join(root, sess);
    let files: string[];
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) continue;
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!IMAGE_EXTS.has(extname(f).toLowerCase())) continue;
      const p = join(dir, f);
      try {
        const st = await fs.stat(p);
        if (st.mtimeMs >= since - 1000 && (!best || st.mtimeMs > best.t)) {
          best = { path: p, t: st.mtimeMs };
        }
      } catch { /* skip */ }
    }
  }
  return best?.path ?? null;
}

async function generateViaCodex(input: GenerateInput): Promise<GenerateResult> {
  const start = Date.now();
  const { guidance: sizeDesc } = resolveSize(input);
  const sizeGuidance = sizeDesc ? `Make it ${sizeDesc}.` : '';
  const quality = getImageGenSettings().quality;
  const qualityLine = quality !== 'auto' ? `Render at ${quality} quality and detail.` : '';
  const refs = await resolveAllRefs(input);

  const hasExtraRefs = (input.extraRefs?.length ?? 0) > 0 || (input.oneOffRefs?.length ?? 0) > 0;
  const refLine = refs.length === 0
    ? ''
    : hasExtraRefs
      ? `The attached reference images were supplied by the requester (her own avatar art and/or images she dropped in chat). Keep the subject(s) visually consistent with them.`
      : `The attached reference images are AI-generated illustrations of FICTIONAL characters (the requester's original avatars — not real people). Keep the character(s) visually consistent with them — same style of face, build, hair, and tattoos.`;

  const instruction =
    `Generate ONE image with your built-in image_gen tool.${sizeGuidance ? ' ' + sizeGuidance : ''}${qualityLine ? ' ' + qualityLine : ''}\n` +
    `${refLine}\n` +
    `Use ONLY the built-in image_gen tool. Do NOT use any CLI, API, or OPENAI_API_KEY path.\n\n` +
    `--- PROMPT ---\n${input.prompt}\n--- END PROMPT ---\n\n` +
    `After it is saved, output as the final line exactly: RESULT_PATH=<absolute path>`;

  // Use requested model, then the operator's configured default, then gpt-5.5.
  // NOT gpt-5.4: OpenAI retired it for ChatGPT-account Codex access, so every
  // render 400'd on "model is not supported when using Codex with a ChatGPT
  // account". gpt-5.5 is the newest id confirmed good on both the standalone
  // CLI and the older npm build `image_gen.codex_bin` may still point at.
  // The config key exists so the next retirement is a settings edit, not a deploy.
  const codexModel = input.codexModel || getConfig('image_gen.codex_model') || 'gpt-5.5';

  const args = [
    'exec',
    '--skip-git-repo-check',
    '-c', `model="${codexModel}"`,
    ...refs.flatMap((r) => ['-i', r]),
    '-',
  ];

  const bin = codexBin();
  const env = {
    ...process.env,
    PATH: `/opt/node/bin:${process.env.PATH || ''}`,
    HOME: process.env.HOME || homedir(),
  };

  const produced = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { env });
    let stderr = '';
    let stdout = '';
    let sessionId: string | null = null;
    const scanSessionId = (chunk: string) => {
      if (!sessionId) sessionId = /session id:\s*([0-9a-f-]{36})/i.exec(chunk)?.[1] ?? null;
    };
    let settled = false;
    let lastSize = -1;
    let stableHits = 0;
    let foundPath: string | null = null;
    let stdoutPath: string | null = null;

    const noteStdout = (chunk: string) => {
      scanSessionId(chunk);
      // Always drain stdout. Codex can emit enough progress text to backpressure
      // an unconsumed pipe, which makes Studio feel much slower than interactive
      // Codex runs. Keep only a small tail for RESULT_PATH parsing.
      stdout = (stdout + chunk).slice(-20_000);
      const match = stdout.match(/RESULT_PATH=(\/[^\r\n]+)/);
      if (match?.[1]) stdoutPath = match[1].trim();
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      clearInterval(poll);
      fn();
    };

    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      settle(() => reject(new ImageGenError('Image generation timed out (10 min).')));
    }, 600_000);

    const checkForImage = () => {
      void (async () => {
        try {
          const p = foundPath ?? stdoutPath ?? (await findNewestCodexImage(start, sessionId));
          if (!p) return;
          foundPath = p;
          const sz = (await fs.stat(p)).size;
          if (sz > 0 && sz === lastSize) {
            if (++stableHits >= 2) {
              try { child.kill('SIGTERM'); } catch { /* ignore */ }
              settle(() => resolve(p));
            }
          } else {
            lastSize = sz;
            stableHits = 0;
          }
        } catch { /* keep polling */ }
      })();
    };

    const poll = setInterval(checkForImage, 500);

    child.stdin.write(instruction);
    child.stdin.end();
    child.stdout.on('data', (d) => { noteStdout(String(d)); });
    child.stderr.on('data', (d) => { const chunk = String(d); stderr += chunk; scanSessionId(chunk); });
    checkForImage();
    child.on('error', (err) => {
      settle(() => reject(new ImageGenError(`Could not run codex CLI (${bin}): ${err.message}`)));
    });
    child.on('close', async (code) => {
      const p = stdoutPath ?? (await findNewestCodexImage(start, sessionId).catch(() => null));
      if (p) settle(() => resolve(p));
      else if (/rejected by the safety system|can't (help with|generate) that image|unable to generate that image/i.test(stdout + stderr)) {
        settle(() => reject(new ImageGenError('SAFETY_REFUSED: The image request was rejected by the safety system.')));
      }
      else settle(() => reject(new ImageGenError(`codex exec exited ${code} with no image. ${stderr.slice(-400)}`)));
    });
  });

  const filename = await newGalleryName();
  const dest = join(GALLERY_DIR, filename);
  await fs.copyFile(produced, dest);

  return {
    filename,
    path: dest,
    backend: 'codex',
    model: codexModel,
    durationMs: Date.now() - start,
    costUsd: 0,
  };
}

async function generateViaAntigravity(input: GenerateInput): Promise<GenerateResult> {
  const start = Date.now();
  const { guidance: sizeDesc } = resolveSize(input);
  const sizeGuidance = sizeDesc ? ` Make it ${sizeDesc}.` : '';
  const refs = await resolveAllRefs(input);

  // Build reference instruction if refs exist
  const refLine = refs.length > 0
    ? `Use these reference images to maintain character/subject consistency: ${refs.join(', ')}. `
    : '';

  const instruction = `${refLine}generate an image of: ${input.prompt}${sizeGuidance}`;

  const bin = antigravityBin();
  if (!existsSync(bin)) {
    throw new ImageGenError(`Antigravity CLI not found at ${bin}. Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash`);
  }

  const env = {
    ...process.env,
    PATH: `${join(homedir(), '.local', 'bin')}:${process.env.PATH || ''}`,
    HOME: process.env.HOME || homedir(),
  };

  // Use request model if provided, otherwise fall back to configured default
  // Only Gemini models can generate images — Claude/GPT models can't
  const settings = getImageGenSettings();
  const model = (input.agyModel && ANTIGRAVITY_MODELS.includes(input.agyModel as AntigravityModel))
    ? input.agyModel
    : settings.antigravityModel;

  const produced = await new Promise<string>((resolve, reject) => {
    // Run from /tmp to avoid agy getting confused by workspace context
    // agy's print mode accepts its prompt as the final positional argument; it does
    // not read prompts from stdin. Keep every flag before --print, otherwise it
    // mistakes a later flag (such as --print-timeout) for the prompt.
    const child = spawn(bin, ['--model', model, '--print-timeout', '10m', '--print', instruction], { env, cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let settled = false;
    let lastSize = -1;
    let stableHits = 0;
    let foundPath: string | null = null;

    const noteStdout = (chunk: string) => {
      // Drain stdout so agy cannot block on a full pipe during long generations.
      stdout = (stdout + chunk).slice(-20_000);
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      clearInterval(poll);
      fn();
    };

    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      settle(() => reject(new ImageGenError('Image generation timed out (10 min).')));
    }, 600_000);

    const checkForImage = () => {
      void (async () => {
        try {
          const p = foundPath ?? (await findNewestAntigravityImage(start));
          if (!p) return;
          foundPath = p;
          const sz = (await fs.stat(p)).size;
          if (sz > 0 && sz === lastSize) {
            if (++stableHits >= 2) {
              try { child.kill('SIGTERM'); } catch { /* ignore */ }
              settle(() => resolve(p));
            }
          } else {
            lastSize = sz;
            stableHits = 0;
          }
        } catch { /* keep polling */ }
      })();
    };

    const poll = setInterval(checkForImage, 500);

    child.stdout.on('data', (d) => { noteStdout(String(d)); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    checkForImage();
    child.on('error', (err) => {
      settle(() => reject(new ImageGenError(`Could not run agy CLI (${bin}): ${err.message}`)));
    });
    child.on('close', async (code) => {
      const p = await findNewestAntigravityImage(start).catch(() => null);
      if (p) settle(() => resolve(p));
      else settle(() => reject(new ImageGenError(`agy exited ${code} with no image. ${stderr.slice(-400)}`)));
    });
  });

  const filename = await newGalleryName();
  const dest = join(GALLERY_DIR, filename);
  await fs.copyFile(produced, dest);

  return {
    filename,
    path: dest,
    backend: 'antigravity' as const,
    model,
    durationMs: Date.now() - start,
    costUsd: 0,
  };
}

// ─── OpenArt (direct MCP-over-HTTP) ──────────────────────────────────
// The `openart` MCP server is OAuth-logged-in at the Codex level
// (`codex mcp login openart`); the token lives in ~/.codex/.credentials.json.
// We speak JSON-RPC to mcp.openart.ai ourselves rather than through a codex
// exec agent — codex sessions silently omit openart_upload_sign from the
// callable schema, so an agent can never upload references. The backend
// refreshes the token in place when it expires; codex picks up the refresh
// from the same file.

/** OpenArt model ids that produce video. kling-3-omni does both; the
 *  request's openartMedia decides which mode family it runs in. */
const OPENART_VIDEO_ONLY = new Set([
  'grok-imagine-1-5', 'gemini-omni-flash', 'wan2-7', 'pixverseV6',
  'byte-plus-seedance-2', 'byte-plus-seedance-2-fast', 'byte-plus-seedance-2-mini',
]);

/** Models whose only video mode is image2video (no element/text modes). */
const OPENART_I2V_ONLY = new Set(['grok-imagine-1-5']);
/** Models without element2video — fall back to image2video when refs exist. */
const OPENART_NO_ELEMENT = new Set(['pixverseV6', 'grok-imagine-1-5']);

function openartMode(media: 'image' | 'video', model: string, hasRefs: boolean): string {
  if (media === 'image') return hasRefs ? 'image2image' : 'text2image';
  if (OPENART_I2V_ONLY.has(model)) return 'image2video';
  if (!hasRefs) return 'text2video';
  return OPENART_NO_ELEMENT.has(model) ? 'image2video' : 'element2video';
}

function contentTypeFor(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

interface OpenArtCredEntry {
  server_url: string;
  client_id: string;
  access_token: string;
  expires_at: number;
  refresh_token: string;
}

/** Load the OpenArt bearer token from codex's credential store, refreshing
 *  it in place when it is about to expire. */
async function openartAuth(): Promise<{ url: string; token: string }> {
  const credFile = join(codexHome(), '.credentials.json');
  let creds: Record<string, OpenArtCredEntry>;
  try {
    creds = JSON.parse(await fs.readFile(credFile, 'utf8'));
  } catch {
    throw new ImageGenError('OpenArt is not logged in — run `codex mcp login openart` first.');
  }
  const key = Object.keys(creds).find((k) => k.startsWith('openart|'));
  if (!key) throw new ImageGenError('OpenArt is not logged in — run `codex mcp login openart` first.');
  const entry = creds[key];
  if (Number(entry.expires_at) < Date.now() + 60_000) {
    const resp = await fetch('https://openart.ai/suite/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: entry.refresh_token,
        client_id: entry.client_id,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      throw new ImageGenError(`OpenArt token refresh failed (${resp.status}) — re-run \`codex mcp login openart\`.`);
    }
    const t = await resp.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    entry.access_token = t.access_token;
    if (t.refresh_token) entry.refresh_token = t.refresh_token;
    entry.expires_at = Date.now() + (t.expires_in ? t.expires_in * 1000 : 3600_000);
    creds[key] = entry;
    await fs.writeFile(credFile, JSON.stringify(creds, null, 2));
  }
  return { url: entry.server_url || 'https://mcp.openart.ai/mcp', token: entry.access_token };
}

/** One MCP tools/call round-trip; returns the joined text content. */
async function openartCall(name: string, args: Record<string, unknown>): Promise<string> {
  const { url, token } = await openartAuth();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) throw new ImageGenError(`OpenArt MCP ${name}: HTTP ${resp.status}.`);
  let raw = await resp.text();
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) { raw = line.slice(5); break; }
  }
  const parsed = JSON.parse(raw) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  };
  if (parsed.error) throw new ImageGenError(`OpenArt ${name}: ${parsed.error.message || 'MCP error'}`);
  const text = (parsed.result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
  if (parsed.result?.isError) throw new ImageGenError(`OpenArt ${name}: ${text.slice(0, 300)}`);
  return text;
}

/** Tool replies mix a JSON payload with prose instructions; dig the JSON out. */
function parseFirstJson(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text); } catch { /* fall through to per-line */ }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch { /* keep looking */ }
  }
  return null;
}

/** Flatten a model form's jsonSchema (allOf layers) into properties + required.
 *  Some forms route property schemas through $defs — resolve one $ref level. */
function collectFormProps(form: Record<string, unknown> | null, mode: string): {
  props: Record<string, Record<string, unknown>>;
  required: Set<string>;
} {
  const props: Record<string, Record<string, unknown>> = {};
  const required = new Set<string>();
  type SchemaNode = Record<string, unknown>;
  const schema = form?.jsonSchema as SchemaNode | undefined;
  const defs = (schema?.$defs ?? {}) as Record<string, unknown>;
  const resolve = (value: SchemaNode): SchemaNode => {
    let node = value;
    const seen = new Set<string>();
    while (typeof node?.$ref === 'string' && node.$ref.startsWith('#/$defs/')) {
      const key = node.$ref.slice('#/$defs/'.length);
      if (seen.has(key)) break;
      seen.add(key);
      const next = defs[key];
      if (!next || typeof next !== 'object') break;
      node = next as SchemaNode;
    }
    return node;
  };

  // OpenArt's element-video forms are frequently discriminated unions rather
  // than flat objects. Pick the element + single-shot branch instead of
  // merging mutually exclusive branches (which produces an impossible form).
  const desiredCreationMode = mode === 'element2video' ? 'element' : 'text';
  const branchScore = (value: SchemaNode): number => {
    const node = resolve(value);
    const p = (node.properties ?? {}) as Record<string, SchemaNode>;
    let score = 0;
    const creation = p.creationMode ? resolve(p.creationMode).const : undefined;
    if (creation === desiredCreationMode) score += 100;
    else if (creation !== undefined) score -= 100;
    const multiShot = p.multiShot ? resolve(p.multiShot).const : undefined;
    if (multiShot === false) score += 10;
    else if (multiShot === true) score -= 10;
    return score;
  };
  const visit = (value: SchemaNode): void => {
    const node = resolve(value);
    const nodeProps = (node.properties ?? {}) as Record<string, SchemaNode>;
    for (const [name, prop] of Object.entries(nodeProps)) props[name] = resolve(prop);
    for (const name of (node.required ?? []) as string[]) required.add(name);
    for (const child of (node.allOf ?? []) as SchemaNode[]) visit(child);
    const variants = ((node.oneOf ?? node.anyOf) ?? []) as SchemaNode[];
    if (variants.length) {
      const selected = variants.reduce((best, candidate) =>
        branchScore(candidate) > branchScore(best) ? candidate : best,
      );
      visit(selected);
    }
  };
  if (schema) visit(schema);
  return { props, required };
}

/** Pick the enum aspect ratio closest to the requested pixel size. */
function closestAspect(options: unknown, apiSize: string): string {
  const opts = Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string') : [];
  if (!opts.length) return '1:1';
  const [w, h] = apiSize.split('x').map(Number);
  const target = w && h ? w / h : 1;
  let best = opts[0];
  let bestDiff = Infinity;
  for (const opt of opts) {
    const [ow, oh] = opt.split(':').map(Number);
    if (!ow || !oh) continue;
    const diff = Math.abs(ow / oh - target);
    if (diff < bestDiff) { bestDiff = diff; best = opt; }
  }
  return best;
}

async function generateViaOpenArt(input: GenerateInput): Promise<GenerateResult> {
  const start = Date.now();
  const settings = getImageGenSettings();
  const model = input.openartModel || settings.openartModel;
  const media: 'image' | 'video' =
    input.openartMedia || (OPENART_VIDEO_ONLY.has(model) ? 'video' : 'image');
  // A video model needs one distinct element per selected subject, not two
  // alternate portraits of the same subject. Sending both drawer images made
  // Seedance treat one person as two visual elements (and sometimes reject
  // visualRef outright); it also let I2V models choose the weaker likeness as
  // their opening frame.
  const refs = await resolveAllRefs(input, media === 'video' ? 1 : MAX_REFS_PER_SUBJECT);
  if (OPENART_I2V_ONLY.has(model) && refs.length === 0) {
    throw new ImageGenError(`${model} is image-to-video only — select at least one reference subject.`);
  }
  const mode = openartMode(media, model, refs.length > 0);
  const { apiSize } = resolveSize(input);

  // Upload each reference ourselves: sign, PUT the bytes, keep the handle.
  const visualReferences: Array<Record<string, unknown>> = [];
  for (const ref of refs) {
    const bytes = await fs.readFile(ref);
    const ct = contentTypeFor(ref);
    const sign = parseFirstJson(await openartCall('openart_upload_sign', {
      mediaType: 'image', size: bytes.length, contentType: ct, purpose: `create-${media}`,
    })) as { uploadId?: string; signURL?: string; accessURL?: string } | null;
    if (!sign?.signURL || !sign.uploadId) throw new ImageGenError('OpenArt upload_sign returned no signed URL.');
    const put = await fetch(sign.signURL, {
      method: 'PUT',
      headers: { 'Content-Type': ct },
      body: bytes,
      signal: AbortSignal.timeout(300_000),
    });
    if (!put.ok) throw new ImageGenError(`OpenArt reference upload failed (${put.status}).`);
    let visualReference: Record<string, unknown> = {
      type: 'image', id: sign.uploadId, url: sign.accessURL,
      label: basename(ref),
    };
    // Element-video adapters (notably Seedance and Kling) validate the source
    // dimensions and file size even though some published schemas do not mark
    // metadata required. Ask OpenArt to probe the completed upload and use its
    // canonical reference object. I2V startFrame is narrowed back to four
    // fields below because Grok explicitly forbids metadata there.
    if (media === 'video') {
      let probed: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 5 && !probed; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 1_000));
        try {
          const metadata = parseFirstJson(await openartCall('openart_upload_metadata_get', {
            mediaType: 'image', mediaUrl: sign.accessURL,
            uploadId: sign.uploadId, label: basename(ref),
          }));
          const candidate = metadata?.visualReference;
          if (candidate && typeof candidate === 'object') probed = candidate as Record<string, unknown>;
        } catch { /* the freshly uploaded asset may still be processing */ }
      }
      if (!probed) throw new ImageGenError('OpenArt could not read the uploaded reference metadata.');
      visualReference = probed;
    }
    visualReferences.push(visualReference);
  }

  // Ask the form what this model/mode takes and fill it deterministically.
  const form = parseFirstJson(await openartCall('openart_model_form_get', { model, mode }));
  const { props, required } = collectFormProps(form, mode);
  const params: Record<string, unknown> = { prompt: input.prompt };
  if (props.imageCount) params.imageCount = 1;
  if (props.aspectRatio) params.aspectRatio = closestAspect(props.aspectRatio.enum, apiSize);
  if (props.visualReferences) {
    if (visualReferences.length) params.visualReferences = visualReferences;
    else if (required.has('visualReferences')) params.visualReferences = [];
  }
  // image2video forms take a single startFrame object with a strict shape
  // ({type,id,url,label} only — additionalProperties:false rejects extras).
  if (props.startFrame && visualReferences.length) {
    const first = visualReferences[0];
    params.startFrame = { type: 'image', id: first.id, url: first.url, label: 'start frame' };
  }
  const formDefaults = (form?.defaults ?? {}) as Record<string, unknown>;
  for (const [name, schema] of Object.entries(props)) {
    if (name in params || !required.has(name)) continue;
    if ('default' in schema) params[name] = schema.default;
    else if (name in formDefaults) params[name] = formDefaults[name];
    else if ('const' in schema) params[name] = schema.const;
    else if (Array.isArray(schema.enum) && schema.enum.length) params[name] = schema.enum[0];
  }

  const timeoutMs = media === 'video' ? 900_000 : 480_000;
  const genText = await openartCall(
    media === 'video' ? 'openart_generate_video' : 'openart_generate_image',
    { model, mode, params },
  );
  const gen = parseFirstJson(genText) as { status?: string; historyId?: string; error?: string } | null;
  if (!gen?.historyId || gen.historyId === 'submit-failed' || gen.status === 'FAILED') {
    throw new ImageGenError(`OpenArt rejected the generation: ${gen?.error || genText.slice(0, 300)}`);
  }

  interface WaitStatus { status?: string; error?: string; resources?: Array<{ url?: string }> }
  let done: WaitStatus | null = null;
  let blanks = 0;
  while (Date.now() - start < timeoutMs) {
    const w = parseFirstJson(await openartCall('openart_creation_wait', {
      historyId: gen.historyId, timeoutSeconds: 90,
    })) as WaitStatus | null;
    if (!w) {
      if (++blanks >= 3) throw new ImageGenError('OpenArt stopped returning parseable status.');
      continue;
    }
    blanks = 0;
    if (w.status === 'COMPLETED') { done = w; break; }
    if (w.status === 'FAILED' || w.status === 'CANCELLED') {
      throw new ImageGenError(`OpenArt generation ${w.status.toLowerCase()}: ${w.error || 'no reason given'}`);
    }
  }
  if (!done) throw new ImageGenError(`OpenArt generation timed out (${Math.round(timeoutMs / 60000)} min).`);
  const url = done.resources?.[0]?.url;
  if (!url) throw new ImageGenError('OpenArt finished but returned no resource URL.');

  const resp = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!resp.ok) throw new ImageGenError(`Could not download OpenArt result (${resp.status}).`);
  const buf = Buffer.from(await resp.arrayBuffer());

  const urlExt = extname(new URL(url).pathname).toLowerCase();
  const ext = (media === 'video')
    ? (VIDEO_EXTS.has(urlExt) ? urlExt : '.mp4')
    : (IMAGE_EXTS.has(urlExt) ? urlExt : '.png');
  const filename = await newGalleryName(ext, media === 'video' ? 'vid' : 'img');
  const dest = join(GALLERY_DIR, filename);
  await fs.writeFile(dest, buf);

  return {
    filename,
    path: dest,
    backend: 'openart',
    model,
    mediaType: media,
    durationMs: Date.now() - start,
    costUsd: 0,
  };
}

function estimateOpenAiCost(size: string): number {
  if (size === '1024x1024') return 0.07;
  return 0.1;
}

function openAiAcceptedSize(requested: string): '1024x1024' | '1024x1536' | '1536x1024' {
  const [width, height] = requested.split('x').map(Number);
  if (!width || !height || Math.abs(width / height - 1) < 0.18) return '1024x1024';
  return width > height ? '1536x1024' : '1024x1536';
}

async function generateViaOpenAi(input: GenerateInput): Promise<GenerateResult> {
  const start = Date.now();
  const key = getConfig('image_gen.openai_api_key');
  if (!key) throw new ImageGenError('OpenAI backend selected but no API key is set in Studio settings.');
  const settings = getImageGenSettings();
  const model = input.openaiModel || settings.openaiModel;
  const { quality } = settings;
  const { apiSize: requestedSize } = resolveSize(input);
  const apiSize = openAiAcceptedSize(requestedSize);
  const refs = await resolveAllRefs(input);

  let b64: string | undefined;
  if (refs.length > 0) {
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', input.prompt);
    form.set('size', apiSize);
    if (quality !== 'auto') form.set('quality', quality);
    for (const r of refs.slice(0, 4)) {
      const buf = await fs.readFile(r);
      form.append('image[]', new Blob([buf]), basename(r));
    }
    const resp = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    const data = (await resp.json()) as { data?: Array<{ b64_json?: string }>; error?: { message?: string } };
    if (!resp.ok) throw new ImageGenError(`OpenAI edits failed: ${data.error?.message || resp.status}`);
    b64 = data.data?.[0]?.b64_json;
  } else {
    const genBody: Record<string, unknown> = { model, prompt: input.prompt, size: apiSize, n: 1 };
    if (quality !== 'auto') genBody.quality = quality;
    const resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(genBody),
      signal: AbortSignal.timeout(180_000),
    });
    const data = (await resp.json()) as { data?: Array<{ b64_json?: string }>; error?: { message?: string } };
    if (!resp.ok) throw new ImageGenError(`OpenAI generation failed: ${data.error?.message || resp.status}`);
    b64 = data.data?.[0]?.b64_json;
  }

  if (!b64) throw new ImageGenError('OpenAI returned no image data.');
  const filename = await newGalleryName();
  const dest = join(GALLERY_DIR, filename);
  await fs.writeFile(dest, Buffer.from(b64, 'base64'));

  return {
    filename,
    path: dest,
    backend: 'openai',
    model,
    durationMs: Date.now() - start,
    costUsd: estimateOpenAiCost(apiSize),
  };
}

async function generateViaCloudflare(input: GenerateInput): Promise<GenerateResult> {
  const endpoint = getConfig('image_gen.cloudflare_endpoint') || process.env.IMAGEGEN_MCP_ENDPOINT;
  if (!endpoint) throw new ImageGenError('Cloudflare Flux is not configured. Set image_gen.cloudflare_endpoint (ImageGenMCP).');
  const token = getConfig('image_gen.cloudflare_token') || process.env.IMAGEGEN_MCP_TOKEN;
  const model = input.cloudflareModel || getConfig('image_gen.cloudflare_model') || '@cf/black-forest-labs/flux-1-schnell';
  const { apiSize } = resolveSize(input);
  const [width, height] = apiSize.split('x').map(Number);
  const start = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ prompt: input.prompt, model, width, height }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new ImageGenError(`Cloudflare Flux request failed: ${errMessage(error)}`);
  }
  if (!response.ok) throw new ImageGenError(`Cloudflare Flux failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const type = response.headers.get('content-type') || '';
  let bytes: Buffer;
  if (type.startsWith('image/')) bytes = Buffer.from(await response.arrayBuffer());
  else {
    const data = await response.json() as { image?: string; b64_json?: string; url?: string; result?: { image?: string } };
    const encoded = data.image || data.b64_json || data.result?.image;
    if (encoded) bytes = Buffer.from(encoded.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
    else if (data.url) {
      const download = await fetch(data.url, { signal: AbortSignal.timeout(60_000) });
      if (!download.ok) throw new ImageGenError(`Cloudflare Flux download failed (${download.status}).`);
      bytes = Buffer.from(await download.arrayBuffer());
    } else throw new ImageGenError('Cloudflare Flux returned no image data.');
  }
  const filename = await newGalleryName();
  const path = join(GALLERY_DIR, filename);
  await fs.writeFile(path, bytes);
  return { filename, path, backend: 'cloudflare', model, durationMs: Date.now() - start, costUsd: 0 };
}

export async function generateImage(input: GenerateInput): Promise<GenerateResult> {
  const settings = getImageGenSettings();
  if (!settings.enabled) {
    throw new ImageGenError('Image generation is switched off. Turn it on in Studio Settings.');
  }
  if (!input.prompt || !input.prompt.trim()) {
    throw new ImageGenError('A prompt is required to generate an image.');
  }

  const effectiveBackend = input.backend || settings.backend;
  if (effectiveBackend === 'openai' && settings.monthlyBudgetUsd > 0) {
    const spent = await monthlySpendUsd();
    if (spent >= settings.monthlyBudgetUsd) {
      throw new ImageGenError(
        `Monthly image budget reached ($${spent.toFixed(2)} / $${settings.monthlyBudgetUsd.toFixed(2)}). Raise it in Studio settings or switch to the free Codex backend.`,
      );
    }
  }

  if (effectiveBackend === 'openai') {
    return generateViaOpenAi(input);
  }
  if (effectiveBackend === 'cloudflare') return generateViaCloudflare(input);
  if (effectiveBackend === 'antigravity') {
    return generateViaAntigravity(input);
  }
  if (effectiveBackend === 'openart') {
    return generateViaOpenArt(input);
  }
  if (effectiveBackend !== 'codex') throw new ImageGenError(`Provider ${effectiveBackend} is not configured or supported.`);
  try {
    return await generateViaCodex(input);
  } catch (error) {
    if (!(error instanceof ImageGenError) || !error.message.startsWith('SAFETY_REFUSED:')) throw error;
    if ((input.subjects?.length ?? 0) || (input.extraRefs?.length ?? 0) || (input.oneOffRefs?.length ?? 0)) {
      console.warn('[image-gen] safety-refused with refs — retrying once without reference images');
      try { return await generateViaCodex({ ...input, subjects: undefined, extraRefs: undefined, oneOffRefs: undefined }); }
      catch (retryError) { throw stripSafetyPrefix(retryError); }
    }
    throw stripSafetyPrefix(error);
  }
}

function stripSafetyPrefix(error: unknown): unknown {
  return error instanceof ImageGenError && error.message.startsWith('SAFETY_REFUSED: ')
    ? new ImageGenError(error.message.slice('SAFETY_REFUSED: '.length))
    : error;
}

export function monthlyImageSpendUsd(): Promise<number> {
  return monthlySpendUsd();
}

async function monthlySpendUsd(): Promise<number> {
  try {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM usage_events
         WHERE engine = ? AND created_at >= ?`,
      )
      .get(IMAGE_GEN_ENGINE, monthStart.toISOString()) as { spent: number } | undefined;
    return row?.spent ?? 0;
  } catch {
    return 0;
  }
}

// ─── Async Job Pattern ───────────────────────────────────────────────
// Jobs are persisted so leaving Studio never loses the status. A server restart
// does not silently re-run a paid/slow request: incomplete jobs are marked
// interrupted and shown honestly to the phone instead.

export interface ImageJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input: GenerateInput;
  result?: GenerateResult;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

const jobs = new Map<string, ImageJob>();
let generationQueue: Promise<void> = Promise.resolve();

function persistJobs(): void {
  try {
    writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()], null, 2));
  } catch (error) {
    console.warn('[image-gen] could not persist job status:', error);
  }
}

function restoreJobs(): void {
  try {
    if (!existsSync(JOBS_FILE)) return;
    const saved = JSON.parse(readFileSync(JOBS_FILE, 'utf8')) as ImageJob[];
    for (const item of saved) {
      if (!item?.id || !item.status) continue;
      if (item.status === 'pending' || item.status === 'running') {
        item.status = 'failed';
        item.error = 'The server restarted before this image finished. Please run it again.';
        item.completedAt = Date.now();
      }
      jobs.set(item.id, item);
    }
    persistJobs();
  } catch (error) {
    console.warn('[image-gen] could not restore job status:', error);
  }
}
restoreJobs();

// Cleanup old finished jobs after 24 hours. Active work is always retained.
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
export function pruneFinishedJobs(now = Date.now()): void {
  const cutoff = now - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'pending' && job.status !== 'running' && (job.completedAt ?? job.createdAt) < cutoff) jobs.delete(id);
  }
  persistJobs();
}
setInterval(() => pruneFinishedJobs(), 60_000).unref();

export function getJobStatus(id: string): ImageJob | undefined {
  return jobs.get(id);
}

export function listImageJobs(): ImageJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function startGenerateJob(input: GenerateInput, onComplete?: (result: GenerateResult) => Promise<void> | void): string {
  const settings = getImageGenSettings();
  if (!settings.enabled) throw new ImageGenError('Image generation is switched off. Turn it on in Studio Settings.');
  if (!input.prompt || !input.prompt.trim()) throw new ImageGenError('A prompt is required to generate an image.');

  const id = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const job: ImageJob = { id, status: 'pending', input, createdAt: Date.now() };
  jobs.set(id, job);
  persistJobs();

  // One Studio image at a time: chat remains free, and Studio cannot pile up
  // competing Codex processes behind the user's back.
  generationQueue = generationQueue.catch(() => undefined).then(async () => {
    job.status = 'running';
    persistJobs();
    try {
      const result = await generateImage(input);
      try {
        await onComplete?.(result);
      } catch (error) {
        // The image exists even if its gallery index write hiccups. Never turn
        // a successful render into a fake failure because its filing failed.
        console.warn('[image-gen] gallery metadata write failed:', error);
      }
      job.status = 'completed';
      job.result = result;
    } catch (err) {
      job.status = 'failed';
      job.error = errMessage(err);
    } finally {
      job.completedAt = Date.now();
      persistJobs();
    }
  });

  return id;
}
