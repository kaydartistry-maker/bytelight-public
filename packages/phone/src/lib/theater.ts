// The Theater, the parts that decide things (the screen is
// components/TheaterApp.tsx; the house's rules are backend services/theater*.ts).

export interface TheaterCue { start: number; end: number; text: string }

export interface TheaterTurn { state: 'idle' | 'waiting' | 'empty'; note: string | null; at: string }

export interface TheaterNightSummary {
  id: string;
  title: string;
  season: number | null;
  episode: number | null;
  mode: 'tv' | 'computer';
  chatty: number;
  noSpoilers: boolean;
  status: 'live' | 'ended';
  startedAt: string;
  endedAt: string | null;
  cueCount: number;
  subtitleName: string | null;
  threadId: string;
  turn: TheaterTurn;
  /** "Let them react" (the Mouth). Older houses leave it out: treat as on. */
  mouthOn?: boolean;
  /** Where the loaded subtitles came from. Older houses leave these three out. */
  subtitleSource?: 'upload' | 'opensubtitles' | 'ear' | null;
  /** Whether the house has looked for this night's subtitles yet. */
  subtitleSearched?: boolean;
  /** Found files not tried yet ("Try another"); null before any search. */
  subtitleOthers?: number | null;
  /** The night "next episode" started after this one. Older houses leave it out. */
  nextNightId?: string | null;
}

/** The Mouth as the house reads it: its switch, and whether it is listening right now. */
export interface TheaterMouthView { houseOn: boolean; armed: boolean }

export interface TheaterClockView { position: number; label: string; paused: boolean; started: boolean; readAt: number }

export interface CouchLine {
  id: string;
  role: 'user' | 'companion' | 'system';
  content: string;
  companionSlug: string | null;
  createdAt: string;
  sequence: number;
  at: number | null;
}

/** The Ear (the browser extension) as the house sees it. */
export interface TheaterEarPairing {
  paired: boolean;
  pairedAt: string | null;
  /** A pairing code is waiting to be claimed, until then. */
  codeWaitingUntil: string | null;
  /** The Ear was in touch in the last half minute. */
  listening: boolean;
  lastContactAt: string | null;
}

/** On a computer night: the Ear, plus the last line it heard. */
export interface TheaterEarView extends TheaterEarPairing {
  lastLine: string | null;
  lastHeardAt: string | null;
}

export interface TheaterNightView {
  night: TheaterNightSummary;
  /** A computer night's Ear; null (or left out by older houses) on a TV night. */
  ear?: TheaterEarView | null;
  clock: TheaterClockView;
  caption: TheaterCue[];
  talk: CouchLine[];
  seats: Array<{ id: string; name: string }>;
  reactions: string[];
  mouth?: TheaterMouthView;
}

export interface PastNight extends TheaterNightSummary { durationSeconds: number; said: number }

export interface TheaterHome { live: TheaterNightView | null; past: PastNight[]; reactions: string[] }

export const DEFAULT_REACTIONS = ['😱', '🍿', '😭', '🔥'];

export function isTheaterHome(data: unknown): data is TheaterHome {
  return Boolean(data && typeof data === 'object' && 'past' in data && Array.isArray((data as TheaterHome).past));
}

export function isNightView(data: unknown): data is TheaterNightView {
  return Boolean(data && typeof data === 'object' && 'night' in data && 'clock' in data && Array.isArray((data as TheaterNightView).talk));
}

/**
 * Where the show is now on her side: the house's reading, run on by the time
 * since the phone received it (never the house's own wall clock, which may
 * not agree with the phone's).
 */
export function projectPosition(clock: Pick<TheaterClockView, 'position' | 'paused'>, receivedAt: number, now: number): number {
  if (clock.paused) return Math.max(0, clock.position);
  return Math.max(0, clock.position + (now - receivedAt) / 1000);
}

/** 00:23:41 */
export function formatClock(position: number): string {
  const total = Math.max(0, Math.floor(position));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** "23:41", "1:02:03" or "90" (seconds) off her TV, as seconds; null when it isn't a time. */
export function parseClockInput(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+(:\d{1,2}){0,2}$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some((n) => n >= 60)) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/** The line or two behind the clock, never one ahead of it. */
export function captionAt(cues: readonly TheaterCue[], position: number, count = 2): TheaterCue[] {
  const heard: TheaterCue[] = [];
  for (const cue of cues) if (cue.start <= position) heard.push(cue);
  return heard.slice(-count);
}

/** "S1 · E3", "S2", "E10", or '' */
export function episodeLabel(night: Pick<TheaterNightSummary, 'season' | 'episode'>): string {
  return [night.season !== null ? `S${night.season}` : '', night.episode !== null ? `E${night.episode}` : ''].filter(Boolean).join(' · ');
}

/** "1h 12m", "45m", "under a minute" */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** "Sat, Nov 8" */
export function nightDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** How far the drag bar reaches: the end of the subtitles, or past where the clock is. */
export function scrubLength(cues: readonly TheaterCue[], position: number): number {
  const last = cues.length > 0 ? cues[cues.length - 1].end : 0;
  return Math.max(60, Math.ceil(last + 60), Math.ceil(position + 600));
}

/** "Quiet", "A few words", "Chatty", "Won't shut up" */
export function chattyLabel(value: number): string {
  if (value < 25) return 'Quiet';
  if (value < 50) return 'A few words';
  if (value < 80) return 'Chatty';
  return "Won't shut up";
}

/**
 * The quiet line under the screen about the couch reacting on its own, or
 * null when there is nothing worth saying (paused, or switched off by her).
 */
export function mouthLine(view: Pick<TheaterNightView, 'mouth' | 'night' | 'clock'>): string | null {
  if (!view.mouth) return null;
  if (!view.mouth.houseOn) return 'Reacting on their own is switched off in the house.';
  if (view.night.mouthOn === false) return null;
  if (view.mouth.armed) return "They're watching";
  if (view.night.cueCount === 0) {
    return view.night.mode === 'computer' ? 'Once the Ear hears some lines they can react on their own.' : 'Load subtitles and they can react on their own.';
  }
  return null;
}

/** The start form's subtitle search, as the house answers it. */
export interface SubtitleMatch { best: { fileId: number; label: string; release: string } | null; count: number }

export function isSubtitleMatch(data: unknown): data is SubtitleMatch {
  return Boolean(data && typeof data === 'object' && 'best' in data && 'count' in data);
}

/**
 * The search the start form runs as she types: a title, and for a show both
 * season and episode. null while there is nothing to search yet (no title,
 * or only one of season / episode).
 */
export function subtitleSearchQuery(title: string, season: string, episode: string): string | null {
  const t = title.trim();
  if (!t) return null;
  const s = season.trim();
  const e = episode.trim();
  if (Boolean(s) !== Boolean(e)) return null;
  const params = new URLSearchParams({ title: t });
  if (s && e) { params.set('season', s); params.set('episode', e); }
  return params.toString();
}

/** The line under the start form: "Found: …" or "No subtitles found, you can load a file". */
export function matchLine(match: SubtitleMatch): string {
  return match.best ? `Found: ${match.best.label}` : 'No subtitles found, you can load a file';
}

/** "Try another" shows on subtitles the house found, while it has others to try. */
export function canTryAnother(night: Pick<TheaterNightSummary, 'cueCount' | 'subtitleSource' | 'subtitleOthers'>): boolean {
  return night.cueCount > 0 && night.subtitleSource === 'opensubtitles' && (night.subtitleOthers ?? 0) > 0;
}

/** The line about what's loaded: "Found: <release>", "Subtitles: <file>", or "No subtitles yet". */
export function subtitleLine(night: Pick<TheaterNightSummary, 'cueCount' | 'subtitleName' | 'subtitleSource'>): string {
  if (night.cueCount === 0) return 'No subtitles yet';
  const name = night.subtitleName ?? 'loaded';
  return night.subtitleSource === 'opensubtitles' ? `Found: ${name}` : `Subtitles: ${name}`;
}

/** How long an ended night stays on screen after their last word, before the next episode takes over. */
export const HANDOFF_LINGER_MS = 5000;
/** The longest an ended night waits on their reply before moving on anyway. */
export const HANDOFF_MAX_WAIT_MS = 60_000;

/**
 * The live screen found its night ended (she asked for the next episode, or
 * it was ended somewhere else): how long until it hands off to whatever is
 * on now, in ms. null while the night is still live. A night that moved on
 * to the next episode stays a moment so their reply can land and be read.
 */
export function handoffDelay(night: Pick<TheaterNightSummary, 'status' | 'turn' | 'nextNightId'>): number | null {
  if (night.status !== 'ended') return null;
  if (!night.nextNightId) return 0;
  return night.turn.state === 'waiting' ? HANDOFF_MAX_WAIT_MS : HANDOFF_LINGER_MS;
}

// ─── the Ear (browser extension) ────────────────────────────────────

export function isEarPairing(data: unknown): data is TheaterEarPairing {
  return Boolean(data && typeof data === 'object' && 'paired' in data && typeof (data as TheaterEarPairing).paired === 'boolean');
}

/** "ABCDEFGH" → "ABCD-EFGH", easier to read across a room. */
export function pairingCodeLabel(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Whole minutes left before a code runs out (0 once it has). */
export function minutesLeft(expiresAt: string, now: number): number {
  const ms = Date.parse(expiresAt) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

/** The Ear's status line on a computer night. */
export function earLine(ear: Pick<TheaterEarView, 'paired' | 'listening'> | null | undefined): string {
  if (!ear || !ear.paired) return 'The Ear is not connected yet';
  return ear.listening ? 'The Ear is listening' : 'Waiting for the Ear…';
}

export type TheaterMode = 'tv' | 'computer';

/**
 * What "Start theater night" sends. On the TV the match the form found is
 * downloaded onto the night; on the computer nothing is: the Ear hears the lines.
 */
export function startNightBody(form: {
  title: string; season: string; episode: string; mode: TheaterMode; chatty: number; noSpoilers: boolean; mouthOn?: boolean; matchFileId: number | null;
}): Record<string, unknown> {
  return {
    title: form.title,
    season: form.season || null,
    episode: form.episode || null,
    mode: form.mode,
    chatty: form.chatty,
    noSpoilers: form.noSpoilers,
    mouthOn: form.mouthOn !== false,
    subtitleFileId: form.mode === 'tv' ? form.matchFileId : null,
  };
}
