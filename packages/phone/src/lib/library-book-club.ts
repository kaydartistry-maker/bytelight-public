// The Book Club and her reviews, the parts that decide things (the screens
// are components/LibraryBookClub.tsx and components/LibraryReview.tsx).

export const OWNER_SEAT = 'owner';

export interface BookReview { stars: number; text: string; updatedAt: string }

export interface ClubPitch {
  id: string;
  by: string;
  title: string;
  author: string;
  pitch: string;
  gutenbergId: number | null;
  bookId: number | null;
}

export interface ClubRound {
  id: string;
  status: 'open' | 'reading' | 'finished';
  startedAt: string;
  pitches: ClubPitch[];
  votes: Record<string, string>;
  winnerPitchId: string | null;
  bookId: number | null;
  shelveError: string | null;
  pickedAt: string | null;
  finishedAt: string | null;
  turn: { state: 'idle' | 'waiting' | 'empty'; note: string | null; at: string };
  tally?: Record<string, number>;
  leaders?: string[];
}

export interface ClubSeat { id: string; name: string }

export interface ClubView {
  current: ClubRound | null;
  past: ClubRound[];
  seats: ClubSeat[];
  owner: ClubSeat;
}

/** On her side of the screen she is "You". */
export function seatName(id: string, seats: ClubSeat[]): string {
  if (id === OWNER_SEAT) return 'You';
  return seats.find((s) => s.id === id)?.name ?? id;
}

/** "Companion A", "Companion A and Companion B", "A, B and C". */
export function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Who voted for this pitch, her first. */
export function votersFor(round: ClubRound, pitchId: string): string[] {
  return Object.entries(round.votes)
    .filter(([, p]) => p === pitchId)
    .map(([voter]) => voter)
    .sort((a, b) => (a === OWNER_SEAT ? -1 : b === OWNER_SEAT ? 1 : a.localeCompare(b)));
}

/** The pitches with the most votes (computed here too, in case the house left them off). */
export function leadersOf(round: ClubRound): string[] {
  if (round.leaders) return round.leaders;
  const counts = new Map(round.pitches.map((p) => [p.id, 0]));
  for (const p of Object.values(round.votes)) if (counts.has(p)) counts.set(p, counts.get(p)! + 1);
  const top = Math.max(0, ...counts.values());
  return round.pitches.filter((p) => counts.get(p.id) === top).map((p) => p.id);
}

/** What "Pick the winner" does: nothing to pick, one clear winner, or a tie for her to break. */
export function winnerMode(round: ClubRound): 'none' | 'single' | 'tie' {
  if (round.pitches.length === 0) return 'none';
  return leadersOf(round).length === 1 ? 'single' : 'tie';
}

/** Which companions still owe a pitch. */
export function stillToPitch(round: ClubRound, seats: ClubSeat[]): ClubSeat[] {
  return seats.filter((s) => !round.pitches.some((p) => p.by === s.id));
}

export function starLine(stars: number): string {
  const n = Math.max(0, Math.min(5, Math.round(stars)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export function roundDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
