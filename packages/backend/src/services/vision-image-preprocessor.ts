import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { NormalizedImage } from './runtimes/types.js';
import { errMessage } from '../util/errors.js';

export const MODEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_OUTPUT_DIMENSION = 4096;

export type PreparedVisionImage = {
  image?: NormalizedImage;
  resized: boolean;
  contextNote?: string;
  warning?: string;
};

/**
 * Prepare a private model-facing copy of an uploaded image. The source file is
 * never modified. Oversized images are autorotated and converted to WebP;
 * animated images use their first frame so resizing cannot silently corrupt an
 * animation while the original upload remains intact in chat.
 */
export async function prepareVisionImage(
  filePath: string,
  filename: string,
  maxBytes = MODEL_IMAGE_MAX_BYTES,
): Promise<PreparedVisionImage> {
  try {
    const original = await readFile(filePath);
    const metadata = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 }).metadata();
    const mimeType = formatToMimeType(metadata.format);
    if (!mimeType) throw new Error(`unsupported image format: ${metadata.format || 'unknown'}`);
    if (!metadata.width || !metadata.height) throw new Error('image dimensions unavailable');

    const needsNormalization = original.length > maxBytes
      || metadata.width > MAX_OUTPUT_DIMENSION
      || metadata.height > MAX_OUTPUT_DIMENSION;
    if (!needsNormalization) {
      return { image: { base64: original.toString('base64'), mimeType }, resized: false };
    }

    let width = Math.min(metadata.width, MAX_OUTPUT_DIMENSION);
    let height = Math.min(metadata.height, MAX_OUTPUT_DIMENSION);
    const scale = Math.min(width / metadata.width, height / metadata.height, 1);
    width = Math.max(1, Math.round(metadata.width * scale));
    height = Math.max(1, Math.round(metadata.height * scale));
    let quality = 82;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const output = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
        .rotate()
        .resize({ width, height, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();
      if (output.length <= maxBytes) {
        return {
          image: { base64: output.toString('base64'), mimeType: 'image/webp' },
          resized: true,
          contextNote: (metadata.pages ?? 1) > 1
            ? `[Vision note: ${filename} is animated. The model received the first frame only; the original animation remains preserved in chat.]`
            : undefined,
        };
      }
      if (quality > 46) quality -= 9;
      else {
        width = Math.max(1, Math.floor(width * 0.8));
        height = Math.max(1, Math.floor(height * 0.8));
      }
    }

    throw new Error(`could not reduce image below ${maxBytes} bytes`);
  } catch (error) {
    const reason = errMessage(error);
    return {
      resized: false,
      warning: `[Vision warning: ${filename} could not be prepared for the model (${reason}). The original upload is still preserved in chat, but the model cannot see this image.]`,
    };
  }
}

function formatToMimeType(format?: string): NormalizedImage['mimeType'] | undefined {
  switch (format) {
    case 'png': return 'image/png';
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    default: return undefined;
  }
}
