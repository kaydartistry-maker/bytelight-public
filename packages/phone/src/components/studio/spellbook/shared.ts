// Spellbook shared bits: the shapes the house sends, prompt helpers, the
// remembered cast, and the share card (slice 7).

import { apiFetch } from '../../../bytelight';

export interface Spell {
  id: string;
  title: string;
  scene: string;
  originalText: string | null;
  tags: string[];
  look: string | null;
  origin: 'mine' | 'community';
  author: string | null;
  credit: string | null;
  link: string | null;
  source: string | null;
  vault: string | null;
  engine: string | null;
  neutralized: boolean;
  createdAt: string;
  timesCast: number;
  lastCastAt: string | null;
  castSize: number;
  sourceUrl: string | null;
  cover: string | null;
  renderCount: number;
}

export interface Render { filename: string; url: string; createdAt: string; cast: string[]; prompt?: string }

export interface Look {
  id: string;
  name: string;
  label: string;
  recipe: string;
  images: string[];
  imageUrls: string[];
  keepPicture: boolean;
  isDefault: boolean;
  builtin: boolean;
  /** Starred: sorted first here and in Studio Create. */
  favorite: boolean;
  /** One of the old Create word presets, seeded once as a look. */
  starter: boolean;
}

export type SpellFilter = 'all' | 'mine' | 'community' | 'unmade';
export const FILTERS: Array<{ value: SpellFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
  { value: 'community', label: 'Community' },
  { value: 'unmade', label: 'Not made' },
];

export const MAX_CAST = 4;
export const MARKERS: Record<string, string> = { 'companion-a': '🔷', 'companion-b': '🔶', user: '🖤' };
export const SIZES = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'square', label: 'Square' },
  { value: '9:16', label: 'Tall' },
  { value: 'landscape', label: 'Landscape' },
];

const LAST_CAST_KEY = 'bytelight.spellbook.cast';
export function readLastCast(): string[] {
  try { const v = JSON.parse(localStorage.getItem(LAST_CAST_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []; }
  catch { return []; }
}
export function rememberCast(c: string[]) { try { localStorage.setItem(LAST_CAST_KEY, JSON.stringify(c)); } catch { /* private mode */ } }

export function lookLine(look: Look | undefined): string {
  return look && !look.keepPicture && look.recipe.trim() ? `\n\nLook: ${look.recipe.trim()}` : '';
}

/** The scene with the cast's names written in (same rule as the house). */
export function castNames(scene: string, names: string[]): string {
  let out = scene;
  names.forEach((n, i) => { out = out.split(`[Character ${i + 1}]`).join(n); });
  return out;
}

export async function jsonOrError(r: Response): Promise<any> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'The house said no.');
  return d;
}

// ─── Share card ─────────────────────────────────────────────────────

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) { lines.push(line); line = word; }
      else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Image + the no-names prompt + credit, as one PNG. The Discord-ready card:
 *  nobody's name and nothing from the vault but this one spell. */
export async function makeShareCard(opts: { imageUrl: string; title: string; prompt: string; credit?: string | null; accent: string }): Promise<Blob> {
  const r = await apiFetch(opts.imageUrl);
  if (!r.ok) throw new Error('Could not load the picture.');
  const bmp = await createImageBitmap(await r.blob());
  const W = 1080;
  const pad = 56;
  const imgH = Math.round(bmp.height * (W / bmp.width));
  const measure = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
  measure.font = '30px Georgia, serif';
  const lines = wrap(measure, opts.prompt, W - pad * 2).slice(0, 40);
  const textH = 70 + 60 + lines.length * 42 + (opts.credit ? 70 : 0) + 60 + pad;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = imgH + textH;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#121014';
  ctx.fillRect(0, 0, W, canvas.height);
  ctx.drawImage(bmp, 0, 0, W, imgH);
  let y = imgH + pad + 30;
  ctx.fillStyle = '#f4ede4';
  ctx.font = 'bold 44px Georgia, serif';
  ctx.fillText(opts.title, pad, y);
  y += 60;
  ctx.font = '30px Georgia, serif';
  ctx.fillStyle = '#d9d0c6';
  for (const l of lines) { ctx.fillText(l, pad, y); y += 42; }
  if (opts.credit) { y += 28; ctx.fillStyle = opts.accent; ctx.font = 'italic 30px Georgia, serif'; ctx.fillText(`Credit · ${opts.credit}`, pad, y); }
  y += 50;
  ctx.fillStyle = '#8a8178';
  ctx.font = '24px Georgia, serif';
  ctx.fillText('from the Spellbook', pad, Math.min(y, canvas.height - 24));
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the card.'))), 'image/png'));
}

export async function shareOrSave(blob: Blob, name: string): Promise<'shared' | 'saved'> {
  const file = new File([blob], name, { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file] });
    return 'shared';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'saved';
}
