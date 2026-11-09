// The Library's own-book door: an EPUB she uploads becomes chapters the
// reader, read-aloud and the companions already understand (the same
// paragraphs-split-by-blank-lines text a Gutenberg book has).
//
// An EPUB is a zip. META-INF/container.xml points at the OPF; the OPF lists
// the files (manifest), their reading order (spine), the title/authors and the
// cover; the table of contents (EPUB3 nav or EPUB2 NCX) names the chapters.
// Approach inspired by Lantern's Reading Nook; this is our own code.

import { unzipSync, strFromU8 } from 'fflate';
import type { LibraryChapter } from './library.js';

export class EpubError extends Error {}

export interface ParsedEpub {
  title: string;
  authors: string[];
  chapters: LibraryChapter[];
  cover: { data: Uint8Array; ext: 'jpg' | 'png' | 'gif' | 'webp' } | null;
}

export const MAX_EPUB_BYTES = 60 * 1024 * 1024;
// Front matter (cover, title page, copyright) is a few hundred characters; a
// spine file this short that the contents list doesn't name rides into the
// next chapter instead of being a chapter of its own.
const SHORT_CHARS = 400;

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–',
  hellip: '…', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è',
  agrave: 'à', aacute: 'á', ccedil: 'ç', ntilde: 'ñ', ouml: 'ö', uuml: 'ü',
  auml: 'ä', iacute: 'í', oacute: 'ó', uacute: 'ú', atilde: 'ã', otilde: 'õ',
  ecirc: 'ê', ocirc: 'ô', acirc: 'â', szlig: 'ß', shy: '',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

const attr = (tag: string, name: string): string | null =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'))?.[1] ?? null;

const textOf = (xml: string): string => decodeEntities(xml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Resolve an href against the file it appears in (zip paths, no leading /). */
export function resolvePath(base: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0]);
  const parts = (base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) + clean : clean).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

/** One XHTML file → paragraphs separated by blank lines, plus its first heading. */
export function xhtmlToText(xhtml: string): { text: string; heading: string | null } {
  let body = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? xhtml;
  body = body.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  const heading = body.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1];
  const marked = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|tr|pre)>/gi, '\u0000')
    .replace(/<(p|div|h[1-6]|li|blockquote|section|tr|pre)\b[^>]*>/gi, '\u0000');
  const paragraphs = decodeEntities(marked.replace(/<[^>]+>/g, ''))
    .split('\u0000')
    .map((p) => p.split('\n').map((l) => l.replace(/[ \t\r\f\v ]+/g, ' ').trim()).filter(Boolean).join('\n'))
    .filter((p) => p.replace(/\s/g, '').length > 0);
  return { text: paragraphs.join('\n\n'), heading: heading ? textOf(heading) || null : null };
}

interface ManifestItem { href: string; type: string; properties: string }
interface TocEntry { path: string; frag: string | null; label: string }

const fragOf = (href: string): string | null => {
  const f = href.split('#')[1];
  return f ? decodeURIComponent(f) : null;
};

/** Where an anchor's element starts in the file body, or null if it isn't there. */
export function anchorAt(body: string, frag: string): number | null {
  const esc = frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\b(?:id|name)\\s*=\\s*["']${esc}["']`).exec(body);
  if (!m) return null;
  const open = body.lastIndexOf('<', m.index);
  return open === -1 ? m.index : open;
}

/** Illustrated editions prefix the chapter with a picture caption
 *  ("He rode a black horse. CHAPTER III."); keep the chapter name. */
export function cleanLabel(label: string): string {
  const m = label.match(/\b(?:chapter|letter|book|part|stave|canto|volume)\s+(?:[ivxlcdm]+|\d+)\b.*$/i);
  return m && m.index && m.index > 0 ? m[0].trim() : label;
}

export function parseEpub(bytes: Uint8Array): ParsedEpub {
  if (bytes.length > MAX_EPUB_BYTES) throw new EpubError('That book is too large (60 MB max)');
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new EpubError('That file is not an EPUB');

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new EpubError('That EPUB could not be opened (the file looks damaged)');
  }
  const read = (path: string): string | null => (files[path] ? strFromU8(files[path]) : null);

  const container = read('META-INF/container.xml');
  const opfPath = container?.match(/<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i)?.[1];
  const opf = opfPath ? read(opfPath) : null;
  if (!opfPath || !opf) throw new EpubError('That EPUB has no table of contents file (OPF)');

  // Store-bought books are locked to their reader; say so plainly.
  const encryption = read('META-INF/encryption.xml');
  if (encryption && /<EncryptedData/i.test(encryption)) {
    const locked = [...encryption.matchAll(/<CipherReference\b[^>]*URI\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    // Font obfuscation (common and harmless) only touches fonts.
    if (locked.some((u) => /\.(x?html?|xml)$/i.test(u))) {
      throw new EpubError('That book is DRM-locked to the store it came from, so it can’t be opened here');
    }
  }

  const title = textOf(opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? '') || 'Untitled';
  const authors = [...opf.matchAll(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map((m) => textOf(m[1])).filter(Boolean);

  const manifest = new Map<string, ManifestItem>();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(m[0], 'id');
    const href = attr(m[0], 'href');
    if (id && href) manifest.set(id, { href: resolvePath(opfPath, href), type: attr(m[0], 'media-type') ?? '', properties: attr(m[0], 'properties') ?? '' });
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/gi)]
    .map((m) => manifest.get(attr(m[0], 'idref') ?? ''))
    .filter((it): it is ManifestItem => !!it && /x?html/i.test(it.type));
  if (spine.length === 0) throw new EpubError('That EPUB has no readable pages');

  // The contents list, in order: EPUB3 nav first, then EPUB2 NCX. An entry
  // may point inside a file (#anchor) — many books keep several chapters in
  // one file — so each file is cut at its entries' anchors.
  const toc: TocEntry[] = [];
  const navItem = [...manifest.values()].find((it) => /\bnav\b/.test(it.properties));
  const nav = navItem ? read(navItem.href) : null;
  if (nav && navItem) {
    const tocNav = nav.match(/<nav\b[^>]*(?:epub:)?type\s*=\s*["']toc["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? nav;
    for (const a of tocNav.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = attr(a[1], 'href');
      const label = textOf(a[2]);
      if (href && label) toc.push({ path: resolvePath(navItem.href, href), frag: fragOf(href), label: cleanLabel(label) });
    }
  }
  if (toc.length === 0) {
    const ncxId = opf.match(/<spine\b[^>]*toc\s*=\s*["']([^"']+)["']/i)?.[1];
    const ncxItem = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((it) => /dtbncx/i.test(it.type));
    const ncx = ncxItem ? read(ncxItem.href) : null;
    if (ncx && ncxItem) {
      for (const p of ncx.matchAll(/<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*src\s*=\s*["']([^"']+)["']/gi)) {
        const label = textOf(p[1]);
        if (label) toc.push({ path: resolvePath(ncxItem.href, p[2]), frag: fragOf(p[2]), label: cleanLabel(label) });
      }
    }
  }

  const chapters: LibraryChapter[] = [];
  let carry = '';
  const push = (title: string, text: string) => {
    chapters.push({ title, text: carry ? `${carry}\n\n${text}` : text });
    carry = '';
  };
  for (const item of spine) {
    const raw = read(item.href);
    if (!raw) continue;
    const body = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? raw;
    // This file's contents entries, each at its anchor's place in the file
    // (no anchor, or one that isn't there = the top). One entry per place.
    const seen = new Set<number>();
    const cuts = toc
      .filter((e) => e.path === item.href)
      .map((e) => ({ label: e.label, at: e.frag ? (anchorAt(body, e.frag) ?? 0) : 0 }))
      .filter((c) => !seen.has(c.at) && (seen.add(c.at), true))
      .sort((a, b) => a.at - b.at);

    if (cuts.length === 0) {
      const { text, heading } = xhtmlToText(body);
      if (!text) continue;
      if (text.length < SHORT_CHARS) { carry = carry ? `${carry}\n\n${text}` : text; continue; }
      push(heading ?? `Part ${chapters.length + 1}`, text);
      continue;
    }
    // Text before the first anchor belongs to whatever came before it.
    const lead = xhtmlToText(body.slice(0, cuts[0].at)).text;
    if (lead) {
      if (chapters.length > 0 && !carry) chapters[chapters.length - 1].text += `\n\n${lead}`;
      else carry = carry ? `${carry}\n\n${lead}` : lead;
    }
    cuts.forEach((c, k) => {
      const text = xhtmlToText(body.slice(c.at, cuts[k + 1]?.at ?? body.length)).text;
      if (text) push(c.label, text);
    });
  }
  if (carry) {
    if (chapters.length > 0) chapters[chapters.length - 1].text += `\n\n${carry}`;
    else chapters.push({ title, text: carry });
  }
  // A printed contents page is a list of links, not a chapter (the reader has its own).
  for (let k = chapters.length - 1; k >= 0 && chapters.length > 1; k--) {
    if (/^(?:table of )?contents\.?$/i.test(chapters[k].title.trim())) chapters.splice(k, 1);
  }
  // Gutenberg's own EPUBs end with its licence; the reader doesn't need it.
  while (chapters.length > 1 && /PROJECT GUTENBERG.*LICENSE/i.test(chapters[chapters.length - 1].title)) chapters.pop();
  if (chapters.length === 0) throw new EpubError('That EPUB has no readable text');

  // Cover: EPUB3 properties="cover-image", else EPUB2 <meta name="cover">.
  let coverItem = [...manifest.values()].find((it) => /\bcover-image\b/.test(it.properties));
  if (!coverItem) {
    const metaTag = opf.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i)?.[0];
    const coverId = metaTag ? attr(metaTag, 'content') : null;
    coverItem = coverId ? manifest.get(coverId) : undefined;
  }
  let cover: ParsedEpub['cover'] = null;
  if (coverItem && files[coverItem.href]) {
    const t = coverItem.type.toLowerCase();
    const ext = t.includes('png') ? 'png' : t.includes('gif') ? 'gif' : t.includes('webp') ? 'webp' : t.includes('jp') ? 'jpg' : null;
    if (ext) cover = { data: files[coverItem.href], ext };
  }

  return { title, authors, chapters, cover };
}
