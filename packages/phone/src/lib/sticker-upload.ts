// Sticker uploads go up as the original bytes, the way the classic pack
// manager sends them. Nothing is redrawn through a canvas, so an animated
// WebP or APNG stays animated and a static PNG keeps its quality.
//
// The server takes PNG and WebP only, up to 2 MB. Classic filters on the
// type the picker reports; here the type comes from the file's own first
// bytes instead, because some Android pickers report no type at all, and a
// GIF renamed to .png must never go up labelled as something it is not.

export type StickerMime = 'image/png' | 'image/webp';

/** Same cap as the server's upload limit. */
export const STICKER_MAX_BYTES = 2 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** What the bytes actually are, or null when they are not PNG or WebP. */
export function sniffStickerType(bytes: Uint8Array): StickerMime | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'image/png';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) return 'image/webp';
  return null;
}

export function stickerExtension(mime: StickerMime): '.png' | '.webp' {
  return mime === 'image/png' ? '.png' : '.webp';
}

export type StickerVerdict =
  | { ok: true; mime: StickerMime }
  | { ok: false; reason: 'type' | 'size' };

/** Decide whether picked bytes can be staged, and with what type. */
export function checkStickerBytes(bytes: Uint8Array): StickerVerdict {
  const mime = sniffStickerType(bytes);
  if (!mime) return { ok: false, reason: 'type' };
  if (bytes.length > STICKER_MAX_BYTES) return { ok: false, reason: 'size' };
  return { ok: true, mime };
}
