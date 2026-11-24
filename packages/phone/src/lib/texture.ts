// Her glass texture (Slice 3). Two jobs, both in a canvas, both browser-only:
//
// shrinkTexture: on upload, scale her image down so the longest side is at
//   most 1024 px. Every glass surface paints it, so a full-size photo would
//   slow the whole phone. Kept as a data URL in her theme, like her wallpaper.
//
// bakeTexture: CSS can't fade one background layer on its own, and giving
//   every surface a fading layer of its own would mean re-positioning the dock,
//   sheets and cards. So the fade (Texture strength) is baked into one copy of
//   the image instead, redone when she moves the slider. Every surface shares
//   that one copy through --bl-tex-image.

const MAX_SIDE = 1024;

async function load(src: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

function encode(canvas: HTMLCanvasElement): string {
  // WebP keeps transparency (stained-glass PNGs often have it) and stays small.
  // Anything that can't encode WebP falls back to PNG.
  const webp = canvas.toDataURL('image/webp', 0.86);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

export async function shrinkTexture(dataUrl: string): Promise<string | null> {
  if (typeof document === 'undefined' || !dataUrl.startsWith('data:image/')) return null;
  const img = await load(dataUrl);
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return encode(canvas);
}

/** The texture at her strength, as an object URL every surface can share. */
export async function bakeTexture(src: string, alpha: number): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const img = await load(src);
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
  const out = blob && blob.type === 'image/webp'
    ? blob
    : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return out ? URL.createObjectURL(out) : null;
}
