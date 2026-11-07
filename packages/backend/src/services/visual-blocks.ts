// Helpers for embedding images directly into the model's input as content
// blocks instead of surfacing them via path-hints + Read tool. Used for
// sticker refs in chat and image attachments — so the companions actually SEE
// the visual, not just know its name.
//
// The Anthropic API accepts user messages with content as an array of
// blocks (text + image). The Claude Agent SDK passes these through when
// the prompt is provided as AsyncIterable<SDKUserMessage>.

import { existsSync, readFileSync, statSync } from 'fs';
import { extname, join } from 'path';
import { getStickerByRef } from './stickers.js';
import { PROJECT_ROOT } from '../config.js';
import type { NormalizedImage } from './runtimes/types.js';

export type ImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
};

// Hard cap on total image bytes per turn so a sticker-spam message can't
// blow up the context window. 25MB raw covers ~5 max-size screenshots
// (Anthropic accepts up to 5MB per image and downscales server-side) or a
// big sticker batch. With 1M context windows this is comfortably affordable.
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGES_PER_TURN = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const STICKER_REF_REGEX = /:([A-Za-z0-9_-]+)_([A-Za-z0-9_-]+):/g;

function mediaTypeFromPath(filePath: string): ImageBlock['source']['media_type'] | null {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return null;
  }
}

export function fileToImageBlock(filePath: string): ImageBlock | null {
  if (!filePath || !existsSync(filePath)) return null;
  const mediaType = mediaTypeFromPath(filePath);
  if (!mediaType) return null;
  try {
    const buf = readFileSync(filePath);
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') },
    };
  } catch {
    return null;
  }
}

// Find every :PackName_StickerName: ref in a string and resolve to image
// blocks. Unknown refs and non-image sticker types are silently skipped.
export function stickerRefsToImageBlocks(text: string): ImageBlock[] {
  if (!text) return [];
  const out: ImageBlock[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  STICKER_REF_REGEX.lastIndex = 0;
  while ((match = STICKER_REF_REGEX.exec(text)) !== null) {
    const [full, packName, stickerName] = match;
    if (seen.has(full)) continue;
    seen.add(full);
    const sticker = getStickerByRef(packName, stickerName);
    if (!sticker) continue;
    const path = join(PROJECT_ROOT, 'data', 'stickers', sticker.pack_id, sticker.filename);
    const block = fileToImageBlock(path);
    if (block) out.push(block);
  }
  return out;
}

// Apply per-turn caps. Returns the slice that fits and a count of dropped images.
export function capImageBlocks(blocks: ImageBlock[]): { kept: ImageBlock[]; dropped: number } {
  if (blocks.length === 0) return { kept: [], dropped: 0 };
  const kept: ImageBlock[] = [];
  let bytes = 0;
  for (const b of blocks) {
    if (kept.length >= MAX_IMAGES_PER_TURN) break;
    const padding = b.source.data.endsWith('==') ? 2 : b.source.data.endsWith('=') ? 1 : 0;
    const approxBytes = Math.floor((b.source.data.length * 3) / 4) - padding;
    if (bytes + approxBytes > MAX_TOTAL_IMAGE_BYTES) break;
    kept.push(b);
    bytes += approxBytes;
  }
  return { kept, dropped: blocks.length - kept.length };
}

// Convenience for ws/message.ts — given a list of image attachment paths,
// build blocks (existence + mime checks already in fileToImageBlock).
export function attachmentPathsToImageBlocks(paths: string[]): ImageBlock[] {
  const out: ImageBlock[] = [];
  for (const p of paths) {
    const block = fileToImageBlock(p);
    if (block) out.push(block);
  }
  return out;
}

/** Translate runtime-normalized attachments for the Claude SDK prompt path. */
export function normalizedImagesToImageBlocks(images: readonly NormalizedImage[]): ImageBlock[] {
  const supported = new Set<ImageBlock['source']['media_type']>([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  ]);
  const out: ImageBlock[] = [];
  for (const image of images) {
    if (!image.base64 || !supported.has(image.mimeType as ImageBlock['source']['media_type'])) continue;
    const padding = image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0;
    const decodedBytes = Math.floor((image.base64.length * 3) / 4) - padding;
    if (decodedBytes > MAX_IMAGE_BYTES) continue;
    out.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType as ImageBlock['source']['media_type'],
        data: image.base64,
      },
    });
  }
  return out;
}

// File-size guard for fileToImageBlock callers that want to skip huge files
// (e.g. a 5MB photo that would dominate the turn). Returns true if file is
// safe to embed.
export function isEmbeddableImage(filePath: string, maxBytes = MAX_IMAGE_BYTES): boolean {
  if (!filePath || !existsSync(filePath)) return false;
  if (!mediaTypeFromPath(filePath)) return false;
  try {
    return statSync(filePath).size <= maxBytes;
  } catch {
    return false;
  }
}
