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
