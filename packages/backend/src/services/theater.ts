// The Theater — theater nights, kept on disk.
//
// She watches something on her TV; the Theater is the couch the companions
// sit on with her. A night is one sitting: what's playing, its subtitles as
// cues, the clock, her settings (how chatty, no spoilers), and whether it is
// still live. One live night at a time; ending a night keeps it, so past
// nights can be reopened and their couch talk read.
//
// Kept as JSON files beside the database, the way the Library keeps its shelf:
// data/theater/nights/<id>.json, written whole through a temp file. The couch
// talk itself lives in each night's own archived thread
// (services/theater-couch.ts); this module never touches the database.

import crypto from 'crypto';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { getBytelightConfig } from '../config.js';
import {
  clockPosition,
  formatClock,
  lastLines,
  lookbackWindow,
  newClock,
  pauseClock,
  resumeClock,
  resyncClock,
  seekClock,
  setClock,
  type TheaterClock,
} from './theater-clock.js';
import type { Cue } from './theater-subtitles.js';

export class TheaterError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type TheaterMode = 'tv' | 'computer';

export interface TheaterTurn {
  state: 'idle' | 'waiting' | 'empty';
  note: string | null;
  at: string;
}

export interface TheaterNight {
  id: string;
  title: string;
  season: number | null;
  episode: number | null;
  mode: TheaterMode;
  /** How chatty the couch is, 0 (quiet) to 100 (won't shut up). Sets the Mouth's pace (theater-mouth.ts). */
  chatty: number;
  noSpoilers: boolean;
  status: 'live' | 'ended';
  startedAt: string;
  endedAt: string | null;
  clock: TheaterClock;
  cues: Cue[];
  subtitleName: string | null;
  /** The night's own couch thread. */
  threadId: string;
  turn: TheaterTurn;
  /** The newest message sequence in the couch thread a turn has already been handed. */
  answeredThrough: number;
  /**
   * "Let them react": the Mouth may wake the couch at beats in the show.
   * Missing on nights kept before the Mouth existed; read it with mouthOnFor.
   */
  mouthOn?: boolean;
  /** Where the show was (seconds) at the last beat; null before the first. */
  lastBeatPosition?: number | null;
  /** When the beats in the last hour fired (ms since epoch), for the hourly cap. */
  beatTimes?: number[];
  /** Where the loaded subtitles came from: her own file, or found by the house (theater-subs-fetch.ts). */
  subtitleSource?: SubtitleSource | null;
  /** What a subtitle search for this night turned up, best first; kept so "Try another" needs no new search. */
  subtitleCandidates?: SubtitleCandidate[];
  /** The candidates already downloaded for this night, so "Try another" never repeats one. */
  subtitleTried?: number[];
  /** When the house first went looking for this night's subtitles (any outcome); the phone looks once on its own. */
  subtitleSearchedAt?: string | null;
  /** The night started after this one by "next episode" (theater-next.ts), so the phone and a retry can follow it. */
  nextNightId?: string | null;
  /** A computer night: what the Ear (the browser extension, theater-ear.ts) last heard. */
  ear?: TheaterEarHeard;
}

/** What the Ear last brought in for a computer night. */
export interface TheaterEarHeard {
  /** The newest line it heard, and when it arrived. */
  lastLine: string | null;
  lastHeardAt: string | null;
  /** How long the video is, in seconds, when the page says. */
  duration: number | null;
}

/** Her own file, one the house found, or lines the Ear heard on the computer. */
export type SubtitleSource = 'upload' | 'opensubtitles' | 'ear';

/** One subtitle file a search found for the night. */
export interface SubtitleCandidate {
  fileId: number;
  release: string;
  fileName: string | null;
  downloads: number;
  /** "Lucifer S02E07 · HDTV.x264-LOL": what she sees under the start form. */
  label?: string;
}

/** "Let them react" is on unless she switched it off. */
export function mouthOnFor(night: Pick<TheaterNight, 'mouthOn'>): boolean {
  return night.mouthOn !== false;
}

export const THEATER_LIMITS = {
  title: 200,
  line: 1000,
  subtitleBytes: 2 * 1024 * 1024,
} as const;

/** The quick reactions on the phone; tapping one says it on the couch. */
export const THEATER_REACTIONS = ['😱', '🍿', '😭', '🔥'] as const;

export function theaterDir(): string {
  return join(dirname(getBytelightConfig().server.db_path), 'theater');
}

function nightsDir(root: string): string {
  return join(root, 'nights');
}

function nightPath(root: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new TheaterError(404, 'There is no theater night with that id.');
  return join(nightsDir(root), `${id}.json`);
}

function writeNight(root: string, night: TheaterNight): TheaterNight {
  mkdirSync(nightsDir(root), { recursive: true });
  const path = nightPath(root, night.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(night));
  renameSync(tmp, path);
  return night;
}

export function getNight(id: string, root = theaterDir()): TheaterNight | null {
  let path: string;
  try {
    path = nightPath(root, id);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TheaterNight;
  } catch (err) {
    console.error(`[theater] night ${id} could not be read:`, err);
    return null;
  }
}

function requireNight(id: string, root: string): TheaterNight {
  const night = getNight(id, root);
  if (!night) throw new TheaterError(404, 'There is no theater night with that id.');
  return night;
}

function requireLive(id: string, root: string): TheaterNight {
  const night = requireNight(id, root);
  if (night.status !== 'live') throw new TheaterError(409, 'That night is over; the credits already rolled.');
  return night;
}

/** Every night, newest first. */
export function listNights(root = theaterDir()): TheaterNight[] {
  const dir = nightsDir(root);
  if (!existsSync(dir)) return [];
  const nights: TheaterNight[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const night = getNight(name.slice(0, -5), root);
    if (night) nights.push(night);
  }
  return nights.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function liveNight(root = theaterDir()): TheaterNight | null {
  return listNights(root).find((n) => n.status === 'live') ?? null;
}

function wholeNumber(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw new TheaterError(400, `${field} is a whole number.`);
  return n;
}

export interface StartNightInput {
  title?: unknown;
  season?: unknown;
  episode?: unknown;
  mode?: unknown;
  chatty?: unknown;
  noSpoilers?: unknown;
  /** "Let them react", set on the start form; on unless she turned it off. */
  mouthOn?: unknown;
}

/** Read and check what she typed on "Start a theater night". */
export function readStartInput(input: StartNightInput): Pick<TheaterNight, 'title' | 'season' | 'episode' | 'mode' | 'chatty' | 'noSpoilers' | 'mouthOn'> {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new TheaterError(400, 'What are we watching? A title is needed.');
  if (title.length > THEATER_LIMITS.title) throw new TheaterError(400, `A title is ${THEATER_LIMITS.title} characters at most.`);
  const mode: TheaterMode | unknown = input.mode === undefined || input.mode === null || input.mode === '' ? 'tv' : input.mode;
  if (mode !== 'tv' && mode !== 'computer') throw new TheaterError(400, 'The Theater hears the show "on the TV" or "on the computer".');
  let chatty = 50;
  if (input.chatty !== undefined && input.chatty !== null) {
    const n = Number(input.chatty);
    if (!Number.isFinite(n)) throw new TheaterError(400, 'How chatty is a number from 0 to 100.');
    chatty = Math.round(Math.min(100, Math.max(0, n)));
  }
  return {
    title,
    season: wholeNumber(input.season, 'Season'),
    episode: wholeNumber(input.episode, 'Episode'),
    mode,
    chatty,
    noSpoilers: input.noSpoilers === undefined ? true : input.noSpoilers === true || input.noSpoilers === 'true',
    mouthOn: !(input.mouthOn === false || input.mouthOn === 'false'),
  };
}

/** Start a night. Only one can be live; she ends the last one first. */
export function startNight(input: StartNightInput, threadId: string, root = theaterDir(), now = Date.now()): TheaterNight {
  const fields = readStartInput(input);
  if (liveNight(root)) throw new TheaterError(409, 'A theater night is already on. End it before starting another.');
  const at = new Date(now).toISOString();
  return writeNight(root, {
    id: crypto.randomUUID(),
    ...fields,
    status: 'live',
    startedAt: at,
    endedAt: null,
    clock: newClock(now),
    cues: [],
    subtitleName: null,
    threadId,
    turn: { state: 'idle', note: null, at },
    answeredThrough: 0,
    lastBeatPosition: null,
    beatTimes: [],
  });
}

export function endNight(id: string, root = theaterDir(), now = Date.now()): TheaterNight {
  const night = requireNight(id, root);
  if (night.status === 'ended') return night;
  const at = new Date(now).toISOString();
  return writeNight(root, { ...night, status: 'ended', endedAt: at, clock: pauseClock(night.clock, now) });
}

/** Remember which night "next episode" started after this one. */
export function noteNextNight(id: string, nextId: string, root = theaterDir()): TheaterNight {
  const night = requireNight(id, root);
  return writeNight(root, { ...night, nextNightId: nextId });
}

/** Load subtitles onto a live night: her uploaded file, or one the house found ('opensubtitles'). */
export function setSubtitles(id: string, cues: Cue[], name: string | null, root = theaterDir(), source: SubtitleSource = 'upload'): TheaterNight {
  const night = requireLive(id, root);
  refuseComputerSubtitles(night);
  return writeNight(root, { ...night, cues, subtitleName: name ? name.slice(0, 200) : null, subtitleSource: source });
}

export interface SubtitleSearchNote {
  candidates?: SubtitleCandidate[];
  tried?: number[];
  searchedAt?: string;
}

/** A computer night hears its lines through the Ear; files and searches are for TV nights. */
export function refuseComputerSubtitles(night: Pick<TheaterNight, 'mode'>): void {
  if (night.mode === 'computer') {
    throw new TheaterError(409, 'This night is on the computer: the Ear hears the lines as they play, so there are no subtitles to load.');
  }
}

/** The most lines one night keeps from the Ear (a long movie runs ~2,000). */
export const EAR_MAX_CUES = 20_000;
/** The same words this close together (seconds) are the same line heard twice. */
export const EAR_DEDUPE_SECONDS = 2;

/**
 * Lines the Ear heard on a live computer night, slotted into the cues by
 * where they came on (a rewind can bring an earlier line late), so the rules
 * that read cues (only cues at or before the clock) hold unchanged. The same
 * words within EAR_DEDUPE_SECONDS of a line already kept are dropped.
 * Returns the night and how many lines were kept.
 */
export function appendEarLines(id: string, lines: readonly Cue[], root = theaterDir(), now = Date.now()): { night: TheaterNight; added: number } {
  const night = requireLive(id, root);
  if (night.mode !== 'computer') throw new TheaterError(409, 'This night is on the TV; the Ear only listens on computer nights.');
  const cues = [...night.cues];
  let added = 0;
  let newest: Cue | null = null;
  for (const line of lines) {
    if (cues.length >= EAR_MAX_CUES) break;
    const twin = cues.some((c) => c.text === line.text && Math.abs(c.start - line.start) <= EAR_DEDUPE_SECONDS);
    if (twin) continue;
    let at = cues.length;
    while (at > 0 && cues[at - 1].start > line.start) at--;
    cues.splice(at, 0, { start: line.start, end: line.end, text: line.text });
    added++;
    newest = line;
  }
  if (added === 0) return { night, added };
  const ear: TheaterEarHeard = {
    lastLine: newest ? newest.text : night.ear?.lastLine ?? null,
    lastHeardAt: new Date(now).toISOString(),
    duration: night.ear?.duration ?? null,
  };
  return { night: writeNight(root, { ...night, cues, subtitleSource: 'ear', ear }), added };
}

/** The Ear's report of where the video is: moves the clock the way "Match the TV's time" does. */
export function earClock(id: string, report: { position: number; paused: boolean; duration: number | null }, root = theaterDir(), now = Date.now()): TheaterNight {
  const night = requireLive(id, root);
  if (night.mode !== 'computer') throw new TheaterError(409, 'This night is on the TV; the Ear only drives the clock on computer nights.');
  const clock = resyncClock(night.clock, report.position, !report.paused, now);
  const ear: TheaterEarHeard = {
    lastLine: night.ear?.lastLine ?? null,
    lastHeardAt: night.ear?.lastHeardAt ?? null,
    duration: report.duration ?? night.ear?.duration ?? null,
  };
  return writeNight(root, { ...night, clock, ear });
}

/** Keep what a subtitle search found and which files were tried; the first search time sticks. */
export function noteSubtitleSearch(id: string, note: SubtitleSearchNote, root = theaterDir()): TheaterNight {
  const night = requireNight(id, root);
  const next: TheaterNight = { ...night };
  if (note.candidates) next.subtitleCandidates = note.candidates;
  if (note.tried) next.subtitleTried = note.tried;
  if (note.searchedAt && !night.subtitleSearchedAt) next.subtitleSearchedAt = note.searchedAt;
  return writeNight(root, next);
}

/** Found files this night hasn't tried yet, best first; null before any search. */
export function untriedCandidates(night: Pick<TheaterNight, 'subtitleCandidates' | 'subtitleTried'>): SubtitleCandidate[] | null {
  if (!night.subtitleCandidates) return null;
  const tried = new Set(night.subtitleTried ?? []);
  return night.subtitleCandidates.filter((c) => !tried.has(c.fileId));
}

export type ClockAction =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'seek'; delta: number }
  | { action: 'set'; position: number }
  | { action: 'resync'; position: number; playing: boolean };

/** Read a clock move off a request body. */
export function readClockAction(body: Record<string, unknown> | undefined): ClockAction {
  const action = body?.action;
  const num = (raw: unknown, field: string): number => {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) throw new TheaterError(400, `${field} is a number of seconds.`);
    return n;
  };
  switch (action) {
    case 'play':
    case 'resume':
    case 'start':
      return { action: 'play' };
    case 'pause':
      return { action: 'pause' };
    case 'seek':
      return { action: 'seek', delta: num(body?.delta, 'delta') };
    case 'set':
      return { action: 'set', position: num(body?.position, 'position') };
    case 'resync':
      return { action: 'resync', position: num(body?.position, 'position'), playing: body?.playing === true };
    default:
      throw new TheaterError(400, 'The clock takes play, pause, seek, set or resync.');
  }
}

export function moveClock(id: string, move: ClockAction, root = theaterDir(), now = Date.now()): TheaterNight {
  const night = requireLive(id, root);
  let clock = night.clock;
  switch (move.action) {
    case 'play': clock = resumeClock(clock, now); break;
    case 'pause': clock = pauseClock(clock, now); break;
    case 'seek': clock = seekClock(clock, move.delta, now); break;
    case 'set': clock = setClock(clock, move.position, now); break;
    case 'resync': clock = resyncClock(clock, move.position, move.playing, now); break;
  }
  return writeNight(root, { ...night, clock });
}

export interface NightSettingsInput {
  chatty?: unknown;
  mouthOn?: unknown;
}

/** Change a live night's settings from the live screen: how chatty, and "Let them react". */
export function updateNightSettings(id: string, input: NightSettingsInput, root = theaterDir()): TheaterNight {
  const night = requireLive(id, root);
  const next: TheaterNight = { ...night };
  let changed = false;
  if (input.chatty !== undefined && input.chatty !== null) {
    const n = Number(input.chatty);
    if (typeof input.chatty === 'boolean' || input.chatty === '' || !Number.isFinite(n)) throw new TheaterError(400, 'How chatty is a number from 0 to 100.');
    next.chatty = Math.round(Math.min(100, Math.max(0, n)));
    changed = true;
  }
  if (input.mouthOn !== undefined && input.mouthOn !== null) {
    if (typeof input.mouthOn !== 'boolean') throw new TheaterError(400, '"Let them react" is on (true) or off (false).');
    next.mouthOn = input.mouthOn;
    changed = true;
  }
  if (!changed) throw new TheaterError(400, 'Nothing to change: send chatty (0 to 100) or mouthOn (true or false).');
  return writeNight(root, next);
}

/** A beat fired: remember where the show was and when, keeping only the last hour. */
export function recordBeat(id: string, position: number, now = Date.now(), root = theaterDir()): TheaterNight | null {
  const night = getNight(id, root);
  if (!night) return null;
  const beatTimes = [...(night.beatTimes ?? []).filter((t) => now - t < 3_600_000), now];
  return writeNight(root, { ...night, lastBeatPosition: position, beatTimes });
}

/** Move the beat mark without a beat (she rewound past it). */
export function setLastBeatPosition(id: string, position: number, root = theaterDir()): void {
  const night = getNight(id, root);
  if (!night) return;
  writeNight(root, { ...night, lastBeatPosition: position });
}

export function setTheaterTurn(id: string, turn: Omit<TheaterTurn, 'at'>, root = theaterDir()): TheaterNight | null {
  const night = getNight(id, root);
  if (!night) return null;
  return writeNight(root, { ...night, turn: { ...turn, at: new Date().toISOString() } });
}

export function setAnsweredThrough(id: string, sequence: number, root = theaterDir()): void {
  const night = getNight(id, root);
  if (!night || sequence <= night.answeredThrough) return;
  writeNight(root, { ...night, answeredThrough: sequence });
}

// ── what the doors answer with ─────────────────────────────────────────────

export interface TheaterClockView {
  position: number;
  label: string;
  paused: boolean;
  started: boolean;
  /** The house's time when this was read, so the phone can run the clock on from here. */
  readAt: number;
}

export function clockView(night: TheaterNight, now = Date.now()): TheaterClockView {
  const position = clockPosition(night.clock, now);
  return { position, label: formatClock(position), paused: night.clock.paused, started: night.clock.startedAt !== null, readAt: now };
}

export interface TheaterNightSummary {
  id: string;
  title: string;
  season: number | null;
  episode: number | null;
  mode: TheaterMode;
  chatty: number;
  noSpoilers: boolean;
  status: 'live' | 'ended';
  startedAt: string;
  endedAt: string | null;
  cueCount: number;
  subtitleName: string | null;
  threadId: string;
  turn: TheaterTurn;
  /** "Let them react" (the Mouth), on unless she switched it off. */
  mouthOn: boolean;
  /** Where the loaded subtitles came from; null when none are loaded or the night predates this. */
  subtitleSource: SubtitleSource | null;
  /** Whether the house has looked for this night's subtitles yet. */
  subtitleSearched: boolean;
  /** Found files not tried yet ("Try another"); null when no search has run. */
  subtitleOthers: number | null;
  /** The night "next episode" started after this one; null otherwise. */
  nextNightId: string | null;
}

export function summaryOf(night: TheaterNight): TheaterNightSummary {
  const {
    cues, clock: _clock, answeredThrough: _a, mouthOn: _m, lastBeatPosition: _l, beatTimes: _b,
    subtitleSource: _ss, subtitleCandidates: _sc, subtitleTried: _st, subtitleSearchedAt: _sa, ear: _ear,
    ...rest
  } = night;
  const others = untriedCandidates(night);
  return {
    ...rest,
    cueCount: cues.length,
    mouthOn: mouthOnFor(night),
    subtitleSource: cues.length > 0 ? night.subtitleSource ?? 'upload' : null,
    subtitleSearched: Boolean(night.subtitleSearchedAt),
    subtitleOthers: others ? others.length : null,
    nextNightId: night.nextNightId ?? null,
  };
}

/** The live night as the companions read it: what's on, where the clock is, and what they've heard. */
export function companionView(night: TheaterNight, now = Date.now()) {
  const clock = clockView(night, now);
  return {
    night: summaryOf(night),
    clock,
    subtitles: night.cues.length > 0,
    lookback: lookbackWindow(night.cues, clock.position).map((cue) => ({ ...cue, at: formatClock(cue.start) })),
  };
}

/** The faint line or two behind the clock on the phone. */
export function captionOf(night: TheaterNight, now = Date.now()): Cue[] {
  return lastLines(night.cues, clockPosition(night.clock, now));
}
