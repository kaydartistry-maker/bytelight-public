// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The home screen's widgets, apart from how they are drawn. Kept free of
// imports so it can be tested without the app around it.

export type HomeWidget = 'companions' | 'note' | 'weather' | 'letter' | 'day' | 'status' | 'soundtrack';

/** The widgets in their default order, each with its size on a four-wide grid. */
export const HOME_WIDGETS: readonly { id: HomeWidget; label: string; cols: number; rows: number; hint: string }[] = [
  { id: 'companions', label: 'Companions', cols: 4, rows: 2, hint: 'The latest reply, and a box to answer it' },
  { id: 'note', label: 'A note', cols: 2, rows: 2, hint: 'The last sticky note a companion left' },
  { id: 'weather', label: 'Weather', cols: 2, rows: 1, hint: 'The temperature and the sky' },
  { id: 'letter', label: 'A letter', cols: 2, rows: 1, hint: 'Only while a letter is waiting for you' },
  { id: 'day', label: 'The day', cols: 4, rows: 1, hint: 'The day and the date, big' },
  { id: 'status', label: 'Status', cols: 4, rows: 1, hint: "What they're up to and their moods, and your own status, one at a time" },
  { id: 'soundtrack', label: 'Soundtrack', cols: 4, rows: 1, hint: 'What Spotify is playing, with its buttons. Only shows while a song is on; hold its row to move it' },
];

/** The widgets switched on, in the order they were turned on. Where each one
 *  sits is its own setting (homeSpotsOf, below); the order only decides how
 *  they pack before any has been moved. Unset is none, so the home screen
 *  stays as it was until one is added. */
export function homeWidgetsOf(value: unknown): HomeWidget[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<HomeWidget>();
  for (const v of value) {
    if (HOME_WIDGETS.some((w) => w.id === v) && !seen.has(v as HomeWidget)) seen.add(v as HomeWidget);
  }
  return [...seen];
}

/** On or off. Taking one away leaves the rest where they were put; a new one
 *  takes the first open place from the bottom, to be moved from there. */
export function toggleWidget(current: readonly HomeWidget[], id: HomeWidget): HomeWidget[] {
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

// Where each widget sits. Dropping used to change only the ORDER, and the
// grid packs from the left, so a note could never sit on the right on its
// own. Now each widget has a place on a four-wide grid, kept where it is
// dropped. Rows count up from the dock, so the widgets stay low and the grid
// grows upward into the wallpaper only as far as things are put.

export const GRID_COLS = 4;

/** A widget's place: its left column (0 to 3) and its bottom row, where row 0
 *  is the row nearest the dock. */
export interface Spot {
  col: number;
  row: number;
}

export type Layout = Partial<Record<HomeWidget, Spot>>;

const sizeOf = (id: HomeWidget) => HOME_WIDGETS.find((w) => w.id === id)!;

/** The saved places. Anything malformed is no place, and that widget
 *  gets the first open one. */
export function homeSpotsOf(value: unknown): Layout {
  const out: Layout = {};
  if (!value || typeof value !== 'object') return out;
  for (const w of HOME_WIDGETS) {
    const s = (value as Record<string, unknown>)[w.id] as { col?: unknown; row?: unknown } | undefined;
    if (!s || typeof s !== 'object') continue;
    const { col, row } = s;
    if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
    if ((col as number) < 0 || (col as number) + w.cols > GRID_COLS || (row as number) < 0 || (row as number) > 40) continue;
    out[w.id] = { col: col as number, row: row as number };
  }
  return out;
}

class Cells {
  private taken = new Set<string>();
  fits(col: number, row: number, cols: number, rows: number): boolean {
    if (col < 0 || row < 0 || col + cols > GRID_COLS) return false;
    for (let r = row; r < row + rows; r++) for (let c = col; c < col + cols; c++) if (this.taken.has(`${c},${r}`)) return false;
    return true;
  }
  take(col: number, row: number, cols: number, rows: number) {
    for (let r = row; r < row + rows; r++) for (let c = col; c < col + cols; c++) this.taken.add(`${c},${r}`);
  }
}

/** How the grid drew them before places existed: each widget at the first
 *  place it fits from the top left, in the saved order (CSS row dense), turned
 *  so rows count up from the dock. The screen does not move until a drag. */
function packedFromTop(order: readonly HomeWidget[]): Layout {
  const cells = new Cells();
  const top: { id: HomeWidget; col: number; row: number; rows: number }[] = [];
  for (const id of order) {
    const { cols, rows } = sizeOf(id);
    let placed = false;
    for (let r = 0; !placed; r++) {
      for (let c = 0; c + cols <= GRID_COLS; c++) {
        if (cells.fits(c, r, cols, rows)) { cells.take(c, r, cols, rows); top.push({ id, col: c, row: r, rows }); placed = true; break; }
      }
    }
  }
  const height = top.reduce((h, t) => Math.max(h, t.row + t.rows), 0);
  const out: Layout = {};
  for (const t of top) out[t.id] = { col: t.col, row: height - t.row - t.rows };
  return out;
}

/** The open place nearest to a spot, counted in cells; ties go to the lower
 *  row, then the left. Searches up to rowLimit rows and past it if it must. */
function nearestOpen(cells: Cells, cols: number, rows: number, near: Spot, rowLimit: number): Spot {
  let best: Spot | null = null;
  let bestD = Infinity;
  for (let limit = Math.max(rowLimit, rows); ; limit += 4) {
    for (let r = 0; r + rows <= limit; r++) {
      for (let c = 0; c + cols <= GRID_COLS; c++) {
        if (!cells.fits(c, r, cols, rows)) continue;
        const d = Math.abs(c - near.col) + Math.abs(r - near.row);
        if (d < bestD || (d === bestD && best && (r < best.row || (r === best.row && c < best.col)))) { best = { col: c, row: r }; bestD = d; }
      }
    }
    if (best) return best;
  }
}

/** Every widget switched on, each with a place, none overlapping. Saved
 *  places are kept; a widget with none (or one that no longer fits) takes the
 *  first open place from the bottom. With nothing saved at all, they sit the
 *  way the grid always packed them. */
export function layoutWidgets(widgets: readonly HomeWidget[], spots: Layout): Record<HomeWidget, Spot> {
  if (!widgets.some((id) => spots[id])) return packedFromTop(widgets) as Record<HomeWidget, Spot>;
  const cells = new Cells();
  const out: Layout = {};
  for (const id of widgets) {
    const s = spots[id];
    const { cols, rows } = sizeOf(id);
    if (s && cells.fits(s.col, s.row, cols, rows)) { cells.take(s.col, s.row, cols, rows); out[id] = s; }
  }
  for (const id of widgets) {
    if (out[id]) continue;
    const { cols, rows } = sizeOf(id);
    const s = nearestOpen(cells, cols, rows, { col: 0, row: 0 }, 0);
    cells.take(s.col, s.row, cols, rows);
    out[id] = s;
  }
  return out as Record<HomeWidget, Spot>;
}

/** How many rows tall the widgets stand. */
export function layoutHeight(layout: Layout): number {
  let h = 0;
  for (const [id, s] of Object.entries(layout) as [HomeWidget, Spot][]) h = Math.max(h, s.row + sizeOf(id).rows);
  return h;
}

/** The places after a widget is dropped at a spot: it stays exactly there
 *  (kept inside the grid's four columns and above the dock), everything it
 *  doesn't cover stays put, and anything it does cover moves to the open
 *  place nearest where it was. */
export function placeWidget(layout: Record<HomeWidget, Spot>, order: readonly HomeWidget[], id: HomeWidget, to: Spot, rowLimit: number): Record<HomeWidget, Spot> {
  const { cols, rows } = sizeOf(id);
  const target = {
    col: Math.min(GRID_COLS - cols, Math.max(0, Math.round(to.col))),
    row: Math.max(0, Math.min(Math.max(0, rowLimit - rows), Math.round(to.row))),
  };
  const cells = new Cells();
  cells.take(target.col, target.row, cols, rows);
  const out: Layout = { [id]: target };
  const moved: HomeWidget[] = [];
  for (const other of order) {
    if (other === id || !layout[other]) continue;
    const s = layout[other]!;
    const size = sizeOf(other);
    if (cells.fits(s.col, s.row, size.cols, size.rows)) { cells.take(s.col, s.row, size.cols, size.rows); out[other] = s; } else moved.push(other);
  }
  for (const other of moved) {
    const size = sizeOf(other);
    const s = nearestOpen(cells, size.cols, size.rows, layout[other]!, rowLimit);
    cells.take(s.col, s.row, size.cols, size.rows);
    out[other] = s;
  }
  return out as Record<HomeWidget, Spot>;
}

interface NoteLike { id: string | number; text: string; color: string; timestamp: string; sender: string | null }

/** The newest sticky note a companion left: a note whose sender is a companion. */
export function latestCompanionNote<T extends NoteLike>(notes: readonly T[], companionSlugs: readonly string[]): T | null {
  const companions = new Set(companionSlugs.map((s) => s.toLowerCase()));
  let best: T | null = null;
  let bestAt = -Infinity;
  for (const n of notes) {
    if (!n.sender || !companions.has(n.sender.toLowerCase())) continue;
    const at = Date.parse(n.timestamp);
    const when = Number.isFinite(at) ? at : -Infinity;
    if (best === null || when > bestAt) { best = n; bestAt = when; }
  }
  return best;
}

/** Where the phone keeps the moment Notes was last opened (lib/home-widgets.ts). */
export const NOTES_SEEN_KEY = 'bytelight.notes-seen-at';

/**
 * A note a companion left since Notes was last opened, for the card on the
 * lock screen (a note on the fridge, saying who left it). Before Notes has
 * ever been opened with this in place, nothing counts as new, so a note from
 * last week doesn't light up the first night.
 */
export function unseenCompanionNote<T extends NoteLike>(notes: readonly T[], companionSlugs: readonly string[], seenAt: number | null): T | null {
  if (seenAt === null || !Number.isFinite(seenAt)) return null;
  const note = latestCompanionNote(notes, companionSlugs);
  if (!note) return null;
  const at = Date.parse(note.timestamp);
  return Number.isFinite(at) && at > seenAt ? note : null;
}

interface LetterLike { author: string; hidden: boolean; state: string; written_at: string }

/** A letter that is ready and not yet opened. A hidden letter never counts,
 *  not even by its author's name. */
export function waitingLetter<T extends LetterLike>(letters: readonly T[], ownerSlug: string | null): T | null {
  const ready = letters.filter((l) => !l.hidden && l.state === 'openable' && l.author !== ownerSlug);
  ready.sort((a, b) => (Date.parse(b.written_at) || 0) - (Date.parse(a.written_at) || 0));
  return ready[0] ?? null;
}

export interface ReplyLine { text: string; action: boolean }

/** The first lines of a reply as a widget shows them: voice headers dropped,
 *  action lines kept but marked so they can be drawn quieter. */
export function replyLines(content: string, max = 2): ReplyLine[] {
  const out: ReplyLine[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\*\*[^*]+\*\*$/.test(line)) continue;
    const action = /^\*[^*].*\*$/.test(line);
    const text = (line.startsWith('-# ') ? line.slice(3) : line).replace(/\*/g, '').trim();
    if (!text) continue;
    out.push({ text, action });
    if (out.length >= max) break;
  }
  return out;
}

/** A word for the sky off an Open-Meteo weather code. */
export function skyWord(code: number): string {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 48) return 'Foggy';
  if (code <= 67 || (code >= 80 && code <= 82)) return 'Rain';
  if (code <= 77 || code === 85 || code === 86) return 'Snow';
  return 'Storms';
}
