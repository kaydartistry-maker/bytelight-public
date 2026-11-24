// Painted frost (Slice 2 A/B): one blurred still of her wallpaper, so bubbles
// can look frosted without live backdrop blur (the Android grey-mush bug).
// The picture is drawn the way AppBackground draws the wallpaper (cover-fit
// to the screen, 80% over the page colour) and then blurred, so when a bubble
// shows it pinned to the screen (background-attachment: fixed) it lines up
// with the real wallpaper behind it.

export async function paintFrost(src: string, opts: { page: string; blurPx: number }): Promise<string | null> {
  if (typeof document === 'undefined' || !src) return null;
  const img = new Image();
  if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }

  // Small canvas: a blurred picture has no detail worth more pixels, and a
  // small JPEG keeps the CSS variable light.
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const W = 360;
  const H = Math.round(W * (vh / vw));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = opts.page || '#000000';
  ctx.fillRect(0, 0, W, H);

  // object-fit: cover, centred; drawn a little oversized so the blur doesn't
  // pull the page colour in at the edges.
  const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight) * 1.06;
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.globalAlpha = 0.8;
  ctx.filter = `blur(${Math.max(1, Math.round(opts.blurPx * (W / vw)))}px)`;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);

  try {
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    // A cross-origin picture without CORS taints the canvas: no frost, bubbles
    // simply stay Plain.
    return null;
  }
}
