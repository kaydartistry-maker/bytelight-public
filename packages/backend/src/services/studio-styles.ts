import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { PROJECT_ROOT } from '../config.js';
import { getConfig, setConfig } from './db.js';

export interface StyleReference { id: string; filename: string; name: string; url: string }
export interface StudioStyle { id: string; title: string; prompt: string; references: StyleReference[]; revision: number }
export interface StudioStyleStore { styles: StudioStyle[]; defaultChatStyleId: string | null }
export class StudioStyleError extends Error {}
export const STYLE_REFS_DIR = join(PROJECT_ROOT, 'data', 'studio-style-refs');
const KEY = 'studio.my_styles.v1';
export const MAX_STYLE_REFS = 8;
export const MAX_GENERATION_REFS = 16;
export const hasMJFlags = (text: string) => /(?:^|\s)--[a-z][\w-]*/i.test(text);

export function getStudioStyles(): StudioStyleStore {
  const raw = getConfig(KEY);
  if (!raw) return { styles: [], defaultChatStyleId: null };
  try {
    const store = JSON.parse(raw) as StudioStyleStore;
    if (!Array.isArray(store.styles) || store.styles.some(s => !s.id || !s.title || !Array.isArray(s.references))) throw Error();
    return store;
  } catch { throw new StudioStyleError('Saved styles could not be read. They have not been overwritten.'); }
}
function persist(store: StudioStyleStore) { setConfig(KEY, JSON.stringify(store)); }
export function requireStyle(id: string, store = getStudioStyles()): StudioStyle {
  const style = store.styles.find(s => s.id === id);
  if (!style) throw new StudioStyleError('That saved style no longer exists. Select a style again.');
  return style;
}
export function saveStyle(value: { title?: unknown; prompt?: unknown; referenceIds?: unknown; revision?: unknown }, id?: string): StudioStyle {
  const store = getStudioStyles();
  const old = id ? requireStyle(id, store) : undefined;
  if (old && value.revision !== old.revision) throw new StudioStyleError('This style changed elsewhere. Reload it before saving.');
  if (!old && store.styles.length >= 100) throw new StudioStyleError('The style library is full (100 styles).');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 100) throw new StudioStyleError('Give the style a title of 1–100 characters.');
  if (typeof value.prompt !== 'string' || value.prompt.length > 12000) throw new StudioStyleError('The written style must be text, up to 12,000 characters.');
  if (hasMJFlags(value.prompt)) throw new StudioStyleError('Leave Midjourney flags out of the saved style. Use the image size controls instead.');
  let references = old?.references ?? [];
  if (value.referenceIds !== undefined) {
    if (!Array.isArray(value.referenceIds) || value.referenceIds.length > MAX_STYLE_REFS || new Set(value.referenceIds).size !== value.referenceIds.length) throw new StudioStyleError('Invalid style reference order.');
    references = value.referenceIds.map(id => {
      const ref = old?.references.find(r => r.id === id);
      if (!ref) throw new StudioStyleError('An unknown style reference was selected.');
      return ref;
    });
  }
  const style: StudioStyle = { id: old?.id ?? randomUUID(), title: value.title.trim(), prompt: value.prompt, references, revision: (old?.revision ?? 0) + 1 };
  store.styles = old ? store.styles.map(s => s.id === old.id ? style : s) : [...store.styles, style];
  persist(store);
  return style;
}
export function deleteStyle(id: string) {
  const store = getStudioStyles(); requireStyle(id, store);
  store.styles = store.styles.filter(s => s.id !== id);
  if (store.defaultChatStyleId === id) store.defaultChatStyleId = null;
  // Assets remain available to already-submitted jobs and their saved receipts.
  persist(store);
}
export function setDefaultChatStyle(id: string | null) {
  const store = getStudioStyles();
  if (id !== null) requireStyle(id, store);
  store.defaultChatStyleId = id; persist(store);
  return store;
}
export function duplicateStyle(id: string) {
  const store = getStudioStyles(), original = requireStyle(id, store);
  if (store.styles.length >= 100) throw new StudioStyleError('The style library is full.');
  const copy = { ...original, id: randomUUID(), title: `${original.title.slice(0, 90)} copy`, revision: 1 };
  store.styles.push(copy); persist(store); return copy;
}
export function styleAssetPath(filename: string): string {
  if (!/^[a-f0-9-]{36}\.(?:png|jpeg|webp)$/.test(filename)) throw new StudioStyleError('Invalid style image.');
  return join(STYLE_REFS_DIR, filename);
}
export async function addStyleReference(id: string, bytes: Buffer, name: string, revision: number) {
  if (bytes.length > 10 * 1024 * 1024) throw new StudioStyleError('Style images must be under 10 MB.');
  let format: string | undefined;
  try { const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata(); format = meta.format; }
  catch { throw new StudioStyleError('Use a valid PNG, JPEG or WebP image.'); }
  if (!['png', 'jpeg', 'webp'].includes(format ?? '')) throw new StudioStyleError('Use PNG, JPEG or WebP style references.');
  // Re-read after decoding: another request may have edited/deleted the style.
  const store = getStudioStyles(), style = requireStyle(id, store);
  if (revision !== style.revision) throw new StudioStyleError('This style changed elsewhere. Reload it before uploading.');
  if (style.references.length >= MAX_STYLE_REFS) throw new StudioStyleError(`A style can hold up to ${MAX_STYLE_REFS} reference images.`);
  const refId = randomUUID(), filename = `${refId}.${format}`;
  mkdirSync(STYLE_REFS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(styleAssetPath(filename), bytes, { flag: 'wx', mode: 0o600 });
  const reference = { id: refId, filename, name: name.slice(0, 160), url: `/api/studio/styles/assets/${filename}` };
  style.references.push(reference); style.revision++; persist(store); return style;
}
export function snapshotStyle(id: string | undefined): StudioStyle | undefined {
  const store = getStudioStyles();
  // Undefined is the chat door. Empty string is Studio's explicit “No style”.
  const chosen = id === undefined ? store.defaultChatStyleId : id;
  if (!chosen) return undefined;
  const style = requireStyle(chosen, store);
  for (const ref of style.references) if (!existsSync(styleAssetPath(ref.filename))) throw new StudioStyleError(`A reference image for “${style.title}” is missing. Repair the style before generating.`);
  return structuredClone(style);
}
export function composeStyledPrompt(scene: string, style?: Pick<StudioStyle, 'prompt'>): string {
  return style?.prompt.trim() ? `${style.prompt}\n\nScene: ${scene.trim()}` : scene.trim();
}

export const OPENAI_IMAGE_MODELS = [
  { id: 'subscription-auto', label: 'ChatGPT subscription · automatic image model', backend: 'codex', metered: false },
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', backend: 'openrouter', metered: true },
  { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', backend: 'openrouter', metered: true },
  { id: 'gpt-image-2', label: 'GPT Image 2', backend: 'openrouter', metered: true },
] as const;
export function resolveImageModel(id = 'subscription-auto') {
  const model = OPENAI_IMAGE_MODELS.find(m => m.id === id);
  if (!model) throw new StudioStyleError('That OpenAI image model is not supported.');
  if (model.metered && getConfig('studio.allow_metered_images') !== 'true') throw new StudioStyleError('Specific API image models are metered. Enable them explicitly in Studio settings first.');
  return model;
}
