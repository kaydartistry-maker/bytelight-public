/**
 * Ask the gallery for a small copy of a picture.
 *
 * Studio's grid and its Recent rail were both loading full-size originals to
 * fill squares a couple of hundred pixels wide — thirty of them came to about
 * 72 MB, which is why they painted in slowly on a phone. The gallery route
 * makes a small version on request; this just adds the ask.
 *
 * A backend that predates thumbnails ignores the parameter and sends the
 * original, so this is safe to ship before a restart — worst case is exactly
 * how it behaved before. Videos and gifs are handled server-side and come
 * back whole.
 *
 * Only ever use this where something is being displayed SMALL. The full-size
 * viewer must keep asking for the real file — and so must anything that
 * SAVES, or she'd end up with the thumbnail on her phone instead of the
 * picture.
 *
 * Chat attachments (/api/files/) answer ?w= the same way. That is where every
 * image we send her actually arrives, and its bubbles are a couple of hundred
 * pixels wide, so it was the biggest download in the house drawn the smallest.
 */
export type ThumbWidth = 256 | 480 | 768;

const THUMBABLE_ROUTES = ['/api/studio/gallery/', '/api/files/'];

export function thumbSrc(src: string | undefined, width: ThumbWidth): string {
  if (!src) return '';
  if (!THUMBABLE_ROUTES.some((route) => src.includes(route))) return src;
  // Something already parameterised (a download link, say) is left alone.
  if (src.includes('?')) return src;
  return `${src}?w=${width}`;
}

/**
 * The same ask, for a reference drawer image.
 *
 * A reference URL always arrives already carrying ?v=, so thumbSrc refuses it
 * by the rule above — and that rule is worth keeping, so this is its own door
 * rather than a loosening of that one. The refs panel draws every drawer in
 * the house at about a hundred pixels; it was decoding the originals to do it,
 * which made that one screen heavy enough that the Android file picker could
 * get the whole app killed behind it.
 */
export function refThumbSrc(src: string | undefined, width: ThumbWidth): string {
  if (!src) return '';
  if (!src.includes('/api/studio/refs/')) return src;
  if (/[?&]w=/.test(src)) return src;
  return `${src}${src.includes('?') ? '&' : '?'}w=${width}`;
}
