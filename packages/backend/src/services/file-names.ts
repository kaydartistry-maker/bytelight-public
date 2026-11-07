// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The name the user gave a file, kept separately from where it lives.
 *
 * Files are stored as <uuid><ext> and there is no files table — getFile is a
 * filesystem probe. So every save took an originalFilename, returned it in the
 * metadata, and then threw it away, and the Files app has always listed the
 * bare uuid — so a file could not be told apart from the others, or found again
 * to download it.
 *
 * The decisions live out here so they can be tested without a disk. The disk
 * half is a sidecar rather than a table, deliberately: it keeps the probe
 * design, needs no migration, and a file with no sidecar — every one of the
 * ~3,900 already on disk — simply falls back to the old behaviour.
 */

export const NAME_SIDECAR_EXT = '.name';

/**
 * The name arrives from an uploader, so it is sanitised on the way OUT as well
 * as in: basename only, no separators, no control characters, bounded length.
 * It is display text and a Content-Disposition value, never a path.
 */
export function safeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, 120);
}

/** A sidecar matches the uuid filename pattern too. Listing it would put a
 *  phantom entry beside every named file the user owns. */
export function isNameSidecar(ext: string): boolean {
  return ext.toLowerCase() === NAME_SIDECAR_EXT;
}

/** What the Files app shows: the given name when we kept one, the stored name when
 *  the file predates the sidecar. */
export function displayFilename(remembered: string | null, storedName: string): string {
  const safe = safeDisplayName(remembered);
  return safe || storedName;
}

/**
 * What lands in the user's Downloads folder. A remembered name wins outright; a file
 * with only its uuid gets a short stamped name instead, because a wall of hex
 * in a downloads list is worse than no name at all.
 */
export function downloadFilename(fileId: string, resolvedName: string, ext: string): string {
  const remembered = resolvedName.startsWith(fileId) ? '' : safeDisplayName(resolvedName);
  return remembered || `bytelight-${fileId.slice(0, 8)}${ext}`;
}

/**
 * Whether a recovered upload name says nothing about which file it is.
 *
 * Every photo off the phone arrives called image.jpg — 2,626 of the 3,077
 * names recoverable from message attachments are that exact string. Writing
 * those into sidecars would replace a wall of distinct hex with a wall of
 * identical words, which is worse: the uuid at least differs per row. So a
 * generic name is deliberately NOT remembered, and those files keep the
 * fallback. This is about display, never about identity — the uuid remains the
 * only identifier anything keys on.
 */
export function isGenericUploadName(raw: unknown): boolean {
  const safe = safeDisplayName(raw).toLowerCase();
  if (!safe) return true;
  return /^(image|img|photo|video|file|document|unnamed|untitled)\.[a-z0-9]{1,5}$/.test(safe);
}
