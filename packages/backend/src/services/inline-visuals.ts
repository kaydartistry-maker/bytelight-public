// The front door for stickers and custom emoji.
//
// A sticker (`:pack_name:`) or a custom emoji (`:name:`) in a message is only
// letters until something opens the file behind it. This turns each one into
// model-facing pictures once, before an engine is chosen, so every engine is
// handed the same thing a photo attachment is: NormalizedImage[]. An animated
// one is opened into a few still frames in time order, because a model shown
// an animation file sees the first frame at best.
//
// Lookups and file reading are injected so this can be tested without a
// database.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { NormalizedImage } from './runtimes/types.js';
import { STICKER_TOKEN, resolveStickerRef } from './sticker-ref.js';

/** Most frames one animated sticker or emoji is opened into. */
export const MAX_FRAMES_PER_VISUAL = 4;
/** Longest side of a frame handed to the model. */
const FRAME_MAX_DIMENSION = 512;
/** A still larger than this is left out, like any other oversized image. */
const MAX_STILL_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;

// Same shape heartbeat/emoji-sight.ts reads: one colon each side, not two.
const EMOJI_REF = /(?<!:):([a-z0-9_]+):(?!:)/gi;

export interface InlineVisual {
  kind: 'sticker' | 'emoji';
  /** The text as she typed it, colons included. */
  ref: string;
  /** One picture for a still; frames in time order for an animated one. */
  images: NormalizedImage[];
  animated: boolean;
  /** Frames in the source file (1 for a still). */
  totalFrames: number;
}

export interface InlineVisualLookups {
  /** Absolute path of the sticker file, or null when no such sticker. */
  stickerPath: (packName: string, stickerName: string) => string | null;
  /** Absolute path of the custom emoji file, or null when no such emoji. */
  emojiPath: (name: string) => string | null;
}

interface FoundRef {
  kind: 'sticker' | 'emoji';
  ref: string;
  path: string;
  index: number;
}

function mimeForFormat(format: string | undefined): string | null {
  switch (format) {
    case 'png': return 'image/png';
    case 'jpeg':
    case 'jpg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    default: return null;
  }
}

/** Every known sticker and custom emoji in the text, in the order typed. */
export function findInlineVisualRefs(text: string, lookups: InlineVisualLookups): FoundRef[] {
  if (!text) return [];
  const found = new Map<string, FoundRef>();
  for (const m of text.matchAll(STICKER_TOKEN)) {
    const ref = m[0];
    if (found.has(ref)) continue;
    const path = resolveStickerRef(m[1], lookups.stickerPath);
    if (path) found.set(ref, { kind: 'sticker', ref, path, index: m.index ?? 0 });
  }
  for (const m of text.matchAll(EMOJI_REF)) {
    const ref = `:${m[1]}:`;
    if (found.has(ref)) continue;
    let path: string | null = null;
    try { path = lookups.emojiPath(m[1]); } catch { path = null; }
    if (path) found.set(ref, { kind: 'emoji', ref, path, index: m.index ?? 0 });
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}

/** Which frames to keep: first, last, and evenly between. */
export function pickFrameIndexes(totalFrames: number, keep: number): number[] {
  const n = Math.max(1, Math.min(totalFrames, keep));
  if (n === 1) return [0];
  const out: number[] = [];
  for (let k = 0; k < n; k += 1) {
    const idx = Math.round((k * (totalFrames - 1)) / (n - 1));
    if (out[out.length - 1] !== idx) out.push(idx);
  }
  return out;
}

/** Open one file into model-facing pictures. Null when it cannot be read as an image. */
export async function fileToVisualImages(
  filePath: string,
  maxFrames: number,
): Promise<{ images: NormalizedImage[]; animated: boolean; totalFrames: number } | null> {
  let original: Buffer;
  try {
    original = await readFile(filePath);
  } catch {
    return null;
  }
  try {
    const metadata = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, animated: true }).metadata();
    const totalFrames = metadata.pages ?? 1;
    if (totalFrames > 1 && maxFrames > 1) {
      const images: NormalizedImage[] = [];
      for (const page of pickFrameIndexes(totalFrames, maxFrames)) {
        const frame = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, page, pages: 1 })
          .resize({ width: FRAME_MAX_DIMENSION, height: FRAME_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        images.push({ base64: frame.toString('base64'), mimeType: 'image/png' });
      }
      if (images.length > 0) return { images, animated: true, totalFrames };
    }
    const mimeType = mimeForFormat(metadata.format);
    // A small still in a format every engine reads goes through untouched.
    // A larger still, an animated file held to one frame, or any other
    // format is cut down to the frame size and becomes a PNG, so a big
    // sticker never makes a heavy envelope for the API lanes.
    const small = (metadata.width ?? Infinity) <= FRAME_MAX_DIMENSION
      && (metadata.height ?? Infinity) <= FRAME_MAX_DIMENSION;
    if (mimeType && totalFrames <= 1 && small && original.length <= MAX_STILL_BYTES) {
      return { images: [{ base64: original.toString('base64'), mimeType }], animated: false, totalFrames: 1 };
    }
    const still = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, page: 0, pages: 1 })
      .resize({ width: FRAME_MAX_DIMENSION, height: FRAME_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    return {
      images: [{ base64: still.toString('base64'), mimeType: 'image/png' }],
      animated: totalFrames > 1,
      totalFrames,
    };
  } catch {
    return null;
  }
}

/**
 * Turn the stickers and custom emoji in a message into pictures.
 *
 * `budget` is how many pictures this message may still carry (the per-turn
 * image cap minus what is already attached). Frames are shared out so every
 * visual gets at least one picture before any animated one gets more; a
 * visual that does not fit is left out whole, never cut mid-animation.
 */
export async function resolveInlineVisuals(
  text: string,
  lookups: InlineVisualLookups,
  budget: number,
): Promise<InlineVisual[]> {
  if (budget <= 0) return [];
  const refs = findInlineVisualRefs(text, lookups).slice(0, budget);
  if (refs.length === 0) return [];
  const framesEach = Math.max(1, Math.min(MAX_FRAMES_PER_VISUAL, Math.floor(budget / refs.length)));
  const out: InlineVisual[] = [];
  let used = 0;
  for (const ref of refs) {
    const remaining = budget - used;
    if (remaining <= 0) break;
    const opened = await fileToVisualImages(ref.path, Math.min(framesEach, remaining));
    if (!opened || opened.images.length === 0) continue;
    out.push({ kind: ref.kind, ref: ref.ref, images: opened.images, animated: opened.animated, totalFrames: opened.totalFrames });
    used += opened.images.length;
  }
  return out;
}

/** All pictures, in the order the visuals appear. */
export function inlineVisualImages(visuals: readonly InlineVisual[]): NormalizedImage[] {
  return visuals.flatMap((v) => v.images);
}

/**
 * One line telling the engine what the attached pictures are, so a sticker's
 * frames are read as one moving thing and not as separate photos. Empty when
 * there is nothing to say.
 */
export function describeInlineVisuals(visuals: readonly InlineVisual[], attachmentCount = 0): string {
  if (visuals.length === 0) return '';
  const parts = visuals.map((v) => {
    const what = v.kind === 'sticker' ? 'sticker' : 'custom emoji';
    if (v.animated && v.images.length > 1) {
      return `${what} ${v.ref} (animated: ${v.images.length} frames in time order, from ${v.totalFrames})`;
    }
    if (v.animated) return `${what} ${v.ref} (animated: first frame only)`;
    return `${what} ${v.ref}`;
  });
  const after = attachmentCount > 0
    ? ` after the ${attachmentCount} attached image${attachmentCount > 1 ? 's' : ''}`
    : '';
  return `[Sent to you as pictures with this message${after}, in this order: ${parts.join('; ')}.]`;
}

/** The house's own lookups: sticker packs and custom emoji on disk. */
export async function houseInlineVisualLookups(): Promise<InlineVisualLookups> {
  const [{ PROJECT_ROOT }, { getStickerByRef }, { getEmojiByName }] = await Promise.all([
    import('../config.js'),
    import('./stickers.js'),
    import('./db/emojis.js'),
  ]);
  return {
    stickerPath: (packName, stickerName) => {
      const sticker = getStickerByRef(packName, stickerName);
      return sticker ? join(PROJECT_ROOT, 'data', 'stickers', sticker.pack_id, sticker.filename) : null;
    },
    emojiPath: (name) => {
      const emoji = getEmojiByName(name);
      return emoji ? join(PROJECT_ROOT, 'data', 'emojis', emoji.filename) : null;
    },
  };
}
