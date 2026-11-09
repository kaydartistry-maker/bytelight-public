// The reading room's pure helpers (Library slice 2): which read-aloud piece
// holds a paragraph, and where a margin note's words sit inside a paragraph.

export interface Segment { from: number; to: number }

export interface MarginNote {
  id: string;
  chapter: number;
  quote: string;
  paragraph: number;
  note: string;
  author: string;
  createdAt: string;
}

/** The read-aloud piece that holds paragraph `p` (0 when there is none). */
export function segmentForParagraph(segments: Segment[], p: number): number {
  const i = segments.findIndex((s) => p >= s.from && p <= s.to);
  return i === -1 ? 0 : i;
}

export type Piece = { text: string; note?: MarginNote };

function quotePattern(quote: string): RegExp {
  const words = quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('\\s+'));
}

/**
 * Cut a paragraph into plain runs and noted runs. Notes are stored with
 * whitespace squashed, so the match is whitespace-tolerant. A note whose words
 * overlap one already placed waits its turn (it still shows in the list).
 */
export function markQuotes(paragraph: string, notes: MarginNote[]): Piece[] {
  const spans: Array<{ start: number; end: number; note: MarginNote }> = [];
  for (const note of notes) {
    const m = quotePattern(note.quote).exec(paragraph);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (spans.some((s) => start < s.end && end > s.start)) continue;
    spans.push({ start, end, note });
  }
  spans.sort((a, b) => a.start - b.start);
  const pieces: Piece[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) pieces.push({ text: paragraph.slice(at, s.start) });
    pieces.push({ text: paragraph.slice(s.start, s.end), note: s.note });
    at = s.end;
  }
  if (at < paragraph.length || pieces.length === 0) pieces.push({ text: paragraph.slice(at) });
  return pieces;
}

// ── her highlights (Library slice 4) ──────────────────────────────────────

export type HighlightColor = 'yellow' | 'pink' | 'blue' | 'orange';
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = ['yellow', 'pink', 'blue', 'orange'];

export interface Highlight {
  id: string;
  chapter: number;
  quote: string;
  color: HighlightColor;
  note: string;
  source: 'owner' | 'kindle';
  createdAt: string;
}

/** A run of a paragraph: plain, under a margin note, in a highlight, or both.
 *  `noteEnd` marks a note's last run, where its companion's sigil sits. */
export type PagePiece = { text: string; note?: MarginNote; noteEnd?: boolean; highlight?: Highlight };

/**
 * Lay a chapter's margin notes and her highlights over its paragraphs.
 * A highlight may cross paragraphs (the house stores it as the page's words
 * with breaks squashed to a space), so it is found in the chapter as a whole.
 * Where highlights overlap, the earlier one keeps the shared words and the
 * later one shows on the rest. Notes and highlights may overlap freely: the
 * shared words carry both, so both stay on the page.
 */
export function markPage(paragraphs: string[], notes: MarginNote[], highlights: Highlight[]): PagePiece[][] {
  // Each paragraph's start in the chapter joined with '\n' between paragraphs.
  const starts: number[] = [];
  let len = 0;
  for (const p of paragraphs) { starts.push(len); len += p.length + 1; }
  const page = paragraphs.join('\n');
  const owner: Array<Highlight | undefined> = new Array(page.length);
  const ordered = [...highlights].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const h of ordered) {
    if (!h.quote.trim()) continue;
    const m = quotePattern(h.quote).exec(page);
    if (!m) continue;
    for (let c = m.index; c < m.index + m[0].length; c++) if (!owner[c] && page[c] !== '\n') owner[c] = h;
  }

  return paragraphs.map((p, i) => {
    const base = markQuotes(p, notes.filter((n) => n.paragraph === i));
    const out: PagePiece[] = [];
    let at = starts[i];
    for (const piece of base) {
      // Cut each note/plain run wherever the highlight under it changes.
      let runStart = 0;
      for (let k = 1; k <= piece.text.length; k++) {
        if (k < piece.text.length && owner[at + k] === owner[at + runStart]) continue;
        const h = owner[at + runStart];
        out.push({
          text: piece.text.slice(runStart, k),
          ...(piece.note ? { note: piece.note } : {}),
          ...(h ? { highlight: h } : {}),
        });
        runStart = k;
      }
      if (piece.note && out.length) out[out.length - 1].noteEnd = true;
      at += piece.text.length;
    }
    return out.length ? out : [{ text: p }];
  });
}
