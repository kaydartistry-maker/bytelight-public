/**
 * Deciding what a link inside a message actually is.
 *
 * This lives out here rather than inline in MessageBubble because the two
 * faults it fixes were both invisible from the render tree and both threw her
 * out to the lock screen:
 *
 *  - a RELATIVE href — /api/files/… , which is how we write one — failed an
 *    absolute-only `new URL(href)` parse and came out as `href=""`, and an
 *    empty href RELOADS the page on tap;
 *  - an absolute one carried `target="_blank"`, which has no second tab inside
 *    the Android WebView: it replaced the whole app, and coming back remounts
 *    it with osState reset from scratch.
 *
 * Every bit of session state is React memory, so leaving the SPA reads as a
 * logout. Same fault the Files app had in July, through a different door.
 */

/** Extensions we can genuinely render in a bubble. Deliberately narrow: anything
 *  off this list takes the save path rather than a guess about its bytes. */
export const READABLE_EXTS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'sh', 'sql', 'html', 'css', 'xml', 'diff', 'patch',
]);

/**
 * Resolve a markdown link's href against the page it is being read on.
 * Returns '' for anything that must not become a link at all — an empty href
 * is a page reload, so a blocked link renders as plain text instead.
 */
export function resolveMessageHref(href: string | null | undefined, pageUrl: string): string {
  if (!href) return '';
  if (/^data:(image\/(jpeg|jpg|png|gif|webp)|application\/pdf)[;,]/i.test(href)) return href;
  try {
    const url = new URL(href, pageUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export type HouseFile = {
  /** Absolute, same-origin. */
  href: string;
  /** What the chip says — her link text if she wrote any, the filename if not. */
  label: string;
  /** True when we can read it into the bubble instead of saving it out. */
  textish: boolean;
};

/**
 * Non-null when a link points at something this house is serving under /api/.
 * Those never navigate: readable text opens in the bubble, everything else
 * goes out through saveToDevice and the shell's download listener.
 */
export function houseFileLink(
  safeHref: string,
  pageUrl: string,
  rawHref: string | null | undefined,
  childText: string,
): HouseFile | null {
  if (!safeHref || safeHref.startsWith('data:')) return null;
  let url: URL;
  let origin: string;
  try {
    url = new URL(safeHref);
    origin = new URL(pageUrl).origin;
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (!url.pathname.startsWith('/api/')) return null;
  const base = decodeURIComponent(url.pathname.split('/').pop() || '') || 'file';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  const text = (childText || '').trim();
  // A bare autolinked url reads as noise in a bubble; use the filename instead.
  const label = text && text !== rawHref && text !== safeHref ? text : base;
  return { href: url.href, label, textish: READABLE_EXTS.has(ext) };
}

/**
 * Is a [FILE:name] block carrying the file's TEXT, or just a link to it?
 *
 * The two producers disagree and always have. ChatInput embeds the real
 * content — `[FILE:notes.txt]:<the words>` — while the adapter turns a message
 * ATTACHMENT into `[FILE:notes.txt]:/api/files/<id>`. The bubble's download
 * button blobbed whichever it got, so tapping an attached file saved a text
 * file containing a URL. It looked like it worked. It has never worked.
 */
export function fileBlockIsHref(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (trimmed.startsWith('/')) return true;
  try {
    return ['http:', 'https:'].includes(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}
