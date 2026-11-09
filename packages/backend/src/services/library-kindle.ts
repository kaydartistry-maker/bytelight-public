// Kindle notebooks — the PDF the Kindle app's "Export Notebook" sends.
// pdftotext (poppler) turns it into text; parseKindleNotebook reads that text.
// Pure apart from extractPdfText; library.ts does the placing and storing.

import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export type HighlightColor = 'yellow' | 'pink' | 'blue' | 'orange';
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = ['yellow', 'pink', 'blue', 'orange'];

export interface KindleHighlight {
  /** The chapter heading Kindle printed above it, when there was one. */
  chapterHint: string | null;
  page: string | null;
  color: HighlightColor;
  text: string;
  /** Her note on this highlight (Kindle prints notes as their own entry). */
  note: string;
  /** The date line, as ISO, when it could be read. */
  date: string | null;
}

export interface KindleNotebook {
  title: string;
  authors: string[];
  highlights: KindleHighlight[];
  bookmarks: number;
}

export class KindleError extends Error {}

export const MAX_NOTEBOOK_BYTES = 10 * 1024 * 1024;

/** Kindle's color names onto the Library's four. Aqua is Kindle's blue. */
export function kindleColor(name: string | undefined): HighlightColor {
  const c = (name ?? '').trim().toLowerCase();
  if (c === 'aqua' || c === 'blue') return 'blue';
  if (c === 'pink' || c === 'orange' || c === 'yellow') return c;
  return 'yellow';
}

const ENTRY = /^(?:Page|Location|Loc\.?)\s+([\w,–-]+)\s*\|\s*(Highlight|Bookmark|Note)\b(?:\s*\(([^)]*)\))?/i;
const DATE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+\d{4}$/i;
const FOOTER = /^\d{1,4}$/;

function isoDate(line: string): string | null {
  const t = Date.parse(line.replace(/^Sept/i, 'Sep'));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Read a Kindle notebook's text (pdftotext output, with or without -layout).
 * Shape: title, "by <author>", a preview URL, "Annotations (N)" with a short
 * summary, then entries: an optional chapter heading, "Page N | Highlight
 * (Color)" (or Bookmark / Note), the words (may wrap over lines), a date line.
 * Page-footer numbers sit between entries and are skipped.
 */
export function parseKindleNotebook(raw: string): KindleNotebook {
  const lines = raw.replace(/\r\n?/g, '\n').replace(/\f/g, '\n').split('\n').map((l) => l.trim());
  let i = 0;
  const next = () => { while (i < lines.length && !lines[i]) i++; return i < lines.length ? lines[i] : null; };

  // Header: everything up to "Annotations (N)" and its bullet summary.
  const head: string[] = [];
  while (next() !== null && !/^Annotations\s*\(\d+\)/i.test(lines[i]) && !ENTRY.test(lines[i])) head.push(lines[i++]);
  const byAt = head.findIndex((l) => /^by\s+/i.test(l));
  const byLine = byAt === -1 ? undefined : head[byAt];
  // A long title wraps; it is every line above the byline.
  const title = (byAt > 0 ? head.slice(0, byAt).join(' ') : head.find((l) => !/^Free Kindle instant preview/i.test(l) && !/^https?:/i.test(l)) ?? '').replace(/\s+/g, ' ').trim();
  const authors = byLine ? byLine.replace(/^by\s+/i, '').split(/\s*(?:,|&|\band\b)\s*/).map((s) => s.trim()).filter(Boolean) : [];
  if (next() !== null && /^Annotations\s*\(\d+\)/i.test(lines[i])) {
    i++;
    while (next() !== null && /^[•·*-]\s/.test(lines[i])) i++;
  }

  const highlights: KindleHighlight[] = [];
  let bookmarks = 0;
  let chapter: string | null = null;
  let pendingHeading: string[] = [];

  while (next() !== null) {
    const line = lines[i];
    const m = ENTRY.exec(line);
    if (!m) {
      i++;
      if (FOOTER.test(line) || DATE.test(line)) continue;
      pendingHeading.push(line);
      continue;
    }
    if (pendingHeading.length) { chapter = pendingHeading.join(' '); pendingHeading = []; }
    i++;
    const kind = m[2].toLowerCase();
    const body: string[] = [];
    let date: string | null = null;
    while (i < lines.length) {
      const l = lines[i];
      if (ENTRY.test(l)) break;
      i++;
      if (!l) continue;
      if (DATE.test(l)) { date = isoDate(l); break; }
      if (FOOTER.test(l)) continue;
      body.push(l);
    }
    const text = body.join(' ').replace(/\s+/g, ' ').trim();
    if (kind === 'bookmark') { bookmarks++; continue; }
    if (kind === 'note') {
      // A note follows the highlight it belongs to, on the same page.
      const prev = highlights[highlights.length - 1];
      if (prev && text && (prev.page === m[1] || !prev.note)) prev.note = prev.note ? `${prev.note}\n${text}` : text;
      continue;
    }
    if (!text) continue;
    highlights.push({ chapterHint: chapter, page: m[1], color: kindleColor(m[3]), text, note: '', date });
  }
  if (!title) throw new KindleError('That PDF doesn\'t look like a Kindle notebook.');
  return { title, authors, highlights, bookmarks };
}

/** Run pdftotext on a PDF (no shell, temp file cleaned up, time-limited). */
export function extractPdfText(pdf: Uint8Array, timeoutMs = 20_000): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'bl-kindle-'));
  const file = join(dir, 'notebook.pdf');
  writeFileSync(file, pdf);
  return new Promise<string>((resolve, reject) => {
    execFile('pdftotext', ['-enc', 'UTF-8', file, '-'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new KindleError(missing ? 'The house can\'t read PDFs right now (pdftotext isn\'t installed).' : 'That PDF couldn\'t be read. Try exporting the notebook again.'));
        return;
      }
      resolve(stdout);
    });
  });
}
