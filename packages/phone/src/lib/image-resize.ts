export type ImageMime = 'image/png' | 'image/webp' | 'image/jpeg' | 'image/gif';

export interface SniffedImage {
  mime: ImageMime;
  animated: boolean;
}

export class ImageFitError extends Error {
  constructor(
    public readonly reason: 'animated_too_large' | 'unreadable' | 'too_large',
    message: string,
  ) {
    super(message);
    this.name = 'ImageFitError';
  }
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length && offset + i < bytes.length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>> 0
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>> 0
  );
}

function isAnimatedPng(bytes: Uint8Array): boolean {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    const next = offset + 12 + length;
    if (next <= offset) return false;
    offset = next;
  }
  return false;
}

function isAnimatedWebp(bytes: Uint8Array): boolean {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = readAscii(bytes, offset, 4);
    const size = readUint32LE(bytes, offset + 4);
    if (fourcc === 'VP8X' && offset + 9 <= bytes.length) {
      if ((bytes[offset + 8] & 0x02) !== 0) return true;
    }
    if (fourcc === 'ANIM') return true;
    const padded = size + (size & 1);
    const next = offset + 8 + padded;
    if (next <= offset) return false;
    offset = next;
  }
  return false;
}

function isAnimatedGif(bytes: Uint8Array): boolean {
  // Count Graphic Control Extensions (0x21 0xF9 0x04) — multi-frame GIFs have > 1.
  // Also fall back to counting plain Image Descriptors when GCEs are absent.
  let gceCount = 0;
  for (let i = 6; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
      gceCount++;
      if (gceCount > 1) return true;
    }
  }
  return false;
}

/** Identify actual image format and animation flag from file header bytes. */
export function sniffImageBytes(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length >= 8 && PNG_SIG.every((b, i) => bytes[i] === b)) {
    return { mime: 'image/png', animated: isAnimatedPng(bytes) };
  }
  if (
    bytes.length >= 12 &&
    readAscii(bytes, 0, 4) === 'RIFF' &&
    readAscii(bytes, 8, 4) === 'WEBP'
  ) {
    return { mime: 'image/webp', animated: isAnimatedWebp(bytes) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', animated: false };
  }
  if (bytes.length >= 6) {
    const header = readAscii(bytes, 0, 6);
    if (header === 'GIF87a' || header === 'GIF89a') {
      return { mime: 'image/gif', animated: isAnimatedGif(bytes) };
    }
  }
  return null;
}

export function extensionForMime(mime: ImageMime): '.png' | '.webp' | '.jpg' | '.gif' {
  switch (mime) {
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/jpeg': return '.jpg';
    case 'image/gif': return '.gif';
  }
}

/** Replace or append a filename extension to match the actual image MIME. */
export function normalizeImageFilename(fileName: string, mime: ImageMime): string {
  const clean = (fileName || 'image')
    .replace(/[\x00-\x1f\x7f/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const stem = (clean.replace(/\.[^.]+$/, '') || 'image').slice(0, 140);
  return `${stem}${extensionForMime(mime)}`;
}

/** Scale dimensions proportionally to satisfy both maxDimension and maxPixels. */
export function fitDimensions(
  width: number,
  height: number,
  maxDimension?: number,
  maxPixels?: number,
): { width: number; height: number; scaled: boolean } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  let scale = 1;
  if (maxDimension && (w > maxDimension || h > maxDimension)) {
    scale = Math.min(scale, maxDimension / Math.max(w, h));
  }
  if (maxPixels && w * h > maxPixels) {
    scale = Math.min(scale, Math.sqrt(maxPixels / (w * h)));
  }
  if (scale >= 1) return { width: w, height: h, scaled: false };
  let nextW = Math.max(1, Math.floor(w * scale));
  let nextH = Math.max(1, Math.floor(h * scale));
  if (maxPixels && nextW * nextH > maxPixels) {
    const tighten = Math.sqrt(maxPixels / (nextW * nextH)) * 0.99;
    nextW = Math.max(1, Math.floor(nextW * tighten));
    nextH = Math.max(1, Math.floor(nextH * tighten));
  }
  return { width: nextW, height: nextH, scaled: true };
}

export interface FitImageOptions {
  /** Target maximum byte size (leave ~5% headroom under server cap). */
  maxBytes: number;
  /** Optional total pixel cap (width * height). */
  maxPixels?: number;
  /** Optional longest-edge pixel cap. */
  maxDimension?: number;
  /** Allowed output MIMEs; if the original is outside this set, it will be converted. */
  allowedMimes?: readonly ImageMime[];
  /** Preferred re-encode format when resizing/converting. Defaults to WebP (preserves transparency). */
  preferredMime?: 'image/webp' | 'image/png' | 'image/jpeg';
  /** Keep original bytes untouched if they already satisfy format, size, and pixel limits. Default true. */
  preserveOriginalIfWithinLimits?: boolean;
  /** Optional filename override (otherwise uses file.name). */
  fileName?: string;
}

export interface FitImageResult {
  blob: Blob;
  file: File;
  mime: ImageMime;
  fileName: string;
  resized: boolean;
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImageFitError('unreadable', 'Could not decode this image.'));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

function formatLimitMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(mb % 1 === 0 ? 0 : 1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Automatically resizes and compresses an image on the client so it fits
 * within byte, pixel, and format limits before upload.
 *
 * Original bytes are preserved untouched when already valid and within limits
 * (keeping animated GIF/WebP/APNG moving and avoiding unnecessary re-encoding).
 */
export async function fitImageToLimits(
  input: File | Blob,
  options: FitImageOptions,
): Promise<FitImageResult> {
  const {
    maxBytes,
    maxPixels,
    maxDimension,
    allowedMimes,
    preferredMime = 'image/webp',
    preserveOriginalIfWithinLimits = true,
  } = options;

  const rawName = options.fileName ?? (input instanceof File ? input.name : 'image');
  const bytes = new Uint8Array(await input.arrayBuffer());
  if (!bytes.length) {
    throw new ImageFitError('unreadable', 'Selected image file is empty.');
  }

  const sniffed = sniffImageBytes(bytes);
  const originalMime = sniffed?.mime ?? null;
  const originalAllowed = Boolean(originalMime && (!allowedMimes || allowedMimes.includes(originalMime)));
  const withinBytes = bytes.length <= maxBytes;

  // Fast path: already valid format and within bytes, with no pixel/dimension check required
  // (or an animated image that fits in bytes and doesn't have a pixel cap to verify).
  if (preserveOriginalIfWithinLimits && originalAllowed && originalMime && withinBytes && !maxPixels && !maxDimension) {
    const fileName = normalizeImageFilename(rawName, originalMime);
    const blob = new Blob([bytes], { type: originalMime });
    return {
      blob,
      file: new File([blob], fileName, { type: originalMime }),
      mime: originalMime,
      fileName,
      resized: false,
    };
  }

  const decodeBlob = new Blob([bytes], { type: originalMime || input.type || 'image/png' });
  const objectUrl = URL.createObjectURL(decodeBlob);
  let img: HTMLImageElement;
  try {
    img = await loadImageElement(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const natW = img.naturalWidth || img.width;
  const natH = img.naturalHeight || img.height;
  if (!natW || !natH) {
    throw new ImageFitError('unreadable', 'Could not read image dimensions.');
  }

  const fitsPixels = !maxPixels || natW * natH <= maxPixels;
  const fitsDim = !maxDimension || (natW <= maxDimension && natH <= maxDimension);

  // Preserve original bytes untouched if everything already fits.
  if (preserveOriginalIfWithinLimits && originalAllowed && originalMime && withinBytes && fitsPixels && fitsDim) {
    const fileName = normalizeImageFilename(rawName, originalMime);
    const blob = new Blob([bytes], { type: originalMime });
    return {
      blob,
      file: new File([blob], fileName, { type: originalMime }),
      mime: originalMime,
      fileName,
      resized: false,
    };
  }

  // Animated images cannot be resized on a 2D canvas without freezing to frame 1.
  if (sniffed?.animated) {
    throw new ImageFitError(
      'animated_too_large',
      `Animated image is over the ${formatLimitMb(maxBytes)} limit and cannot be auto-resized without losing animation.`,
    );
  }

  // Compute initial target dimensions.
  const initial = fitDimensions(natW, natH, maxDimension, maxPixels);
  let targetW = initial.width;
  let targetH = initial.height;

  // Choose output MIME that is allowed.
  const encodeMime: ImageMime =
    !allowedMimes || allowedMimes.includes(preferredMime)
      ? preferredMime
      : allowedMimes.includes('image/webp')
        ? 'image/webp'
        : allowedMimes.includes('image/png')
          ? 'image/png'
          : allowedMimes[0];

  const qualities = encodeMime === 'image/png' ? [undefined] : [0.92, 0.84, 0.75, 0.65, 0.52];

  for (let round = 0; round < 8; round++) {
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ImageFitError('unreadable', 'Canvas unavailable in this browser.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, targetW, targetH);

    for (const quality of qualities) {
      let blob = await canvasToBlob(canvas, encodeMime, quality);
      if (!blob && encodeMime !== 'image/png') {
        blob = await canvasToBlob(canvas, 'image/png');
      }
      if (!blob) continue;

      const actualMime: ImageMime =
        blob.type === 'image/webp' || blob.type === 'image/png' || blob.type === 'image/jpeg' || blob.type === 'image/gif'
          ? blob.type
          : encodeMime;

      if (blob.size <= maxBytes && (!allowedMimes || allowedMimes.includes(actualMime))) {
        const fileName = normalizeImageFilename(rawName, actualMime);
        return {
          blob,
          file: new File([blob], fileName, { type: actualMime }),
          mime: actualMime,
          fileName,
          resized: true,
        };
      }

      // If browser fell back to lossless PNG, further quality steps won't help — shrink dimensions next.
      if (actualMime === 'image/png') break;
    }

    if (Math.max(targetW, targetH) <= 64) break;
    targetW = Math.max(32, Math.floor(targetW * 0.76));
    targetH = Math.max(32, Math.floor(targetH * 0.76));
  }

  throw new ImageFitError(
    'too_large',
    `Image could not be shrunk under the ${formatLimitMb(maxBytes)} limit.`,
  );
}

/**
 * Resize a base64 image data URL (e.g. "Use Full Image" wallpapers/avatars)
 * so inline settings stay compact and never exceed sync payload limits.
 */
export async function resizeDataUrl(
  dataUrl: string,
  maxDimension: number,
  quality = 0.88,
  maxBytes = 1.8 * 1024 * 1024,
): Promise<string> {
  // Keep small animated GIFs intact.
  if (dataUrl.startsWith('data:image/gif') && dataUrl.length <= maxBytes * 1.4) {
    return dataUrl;
  }
  const img = await loadImageElement(dataUrl);
  const natW = img.naturalWidth || img.width;
  const natH = img.naturalHeight || img.height;
  if (!natW || !natH) return dataUrl;

  let { width, height } = fitDimensions(natW, natH, maxDimension);
  const qualities = [quality, 0.8, 0.7, 0.58];

  for (let round = 0; round < 5; round++) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);

    for (const q of qualities) {
      const out = canvas.toDataURL('image/webp', q) || canvas.toDataURL('image/jpeg', q);
      if (out.length <= Math.ceil(maxBytes * 1.37)) return out;
      if (out.startsWith('data:image/png')) break;
    }

    if (Math.max(width, height) <= 256) break;
    width = Math.max(128, Math.floor(width * 0.78));
    height = Math.max(128, Math.floor(height * 0.78));
  }

  return dataUrl;
}
