// The Theater — the Mouth: the couch reacting on its own at beats in the show.
//
// While a night is live, the clock is playing and subtitles are loaded, the
// companions may react without being asked, the way friends on a couch do:
// not at every line, not to fill silence. Three pure parts and a small timer.
//
// THE BEAT RULE (detectBeat). Decided only from cues that have already come
// on (start <= the clock), so a later line can never trigger or shape a beat.
//   - A run then a gap: at least BEAT_RUN_LINES lines came on since the last
//     beat, and now nobody has spoken for BEAT_GAP_SECONDS (counted from when
//     the last heard line went off), but not so long that the moment has
//     passed (BEAT_STALE_SECONDS).
//   - Or a long stretch: the show has run `capSeconds` past the last beat
//     with no beat at all, and nobody is mid-line right now.
//
// THE PACE (mouthPace), from the night's `chatty` 0..100, piecewise linear
// through three points:
//      chatty   min gap between beats   max beats per hour   long-stretch cap
//        0          8 min (480 s)               5                 20 min
//       50          3 min (180 s)              12                  9 min
//      100         75 s                        30                  4 min
//   The cap is 3 x the min gap, kept between 4 and 20 minutes.
//
// THE SKIP RULES (beatSkipReason), checked in order every tick: the house
// flag `theater.mouth_enabled` is off; "Let them react" is off for the night;
// the night isn't live; the clock is paused (or never started); no subtitles;
// a turn is running or queued; she said something in the last 45 s; the min
// gap since the last beat hasn't passed; the hourly cap is reached; or it
// simply isn't a beat yet.
//
// THE TIMER. One interval, every TICK_MS, armed when a night goes live,
// plays, or changes settings (routes call armTheaterMouth), and re-armed on
// boot for a live, playing night (server.ts). Each tick reads the house's
// clock; with no live, playing night it disarms itself. A beat is recorded
// BEFORE its turn is queued, so a failed or empty beat never retries.
//
// The rollback: config key `theater.mouth_enabled` = 'false' turns the whole
// Mouth off; couch lines keep working.

import { getConfigBool } from './db/config.js';
import { clockPosition } from './theater-clock.js';
import type { Cue } from './theater-subtitles.js';
import { lastSaidAt, queueBeat, theaterTurnBusy, type TheaterLane } from './theater-couch.js';
import {
  getNight,
  liveNight,
  mouthOnFor,
  recordBeat,
  setLastBeatPosition,
  theaterDir,
  type TheaterNight,
} from './theater.js';

export const MOUTH_FLAG = 'theater.mouth_enabled';
export const BEAT_RUN_LINES = 3;
export const BEAT_GAP_SECONDS = 4;
export const BEAT_STALE_SECONDS = 20;
export const KAY_SPOKE_HOLD_MS = 45_000;
export const TICK_MS = 5_000;
const HOUR_MS = 3_600_000;

export interface MouthPace {
  /** The least time between two beats, in seconds of wall time. */
  minGapSeconds: number;
  /** Never more beats than this in any hour. */
  maxPerHour: number;
  /** Show time with no beat after which a quiet moment is a beat anyway. */
  capSeconds: number;
}

function between(chatty: number, at0: number, at50: number, at100: number): number {
  const c = Math.min(100, Math.max(0, Number.isFinite(chatty) ? chatty : 50));
  return c <= 50 ? at0 + (at50 - at0) * (c / 50) : at50 + (at100 - at50) * ((c - 50) / 50);
}

/** How often the couch may speak up at a chattiness of 0..100. See the table above. */
export function mouthPace(chatty: number): MouthPace {
  const minGapSeconds = Math.round(between(chatty, 480, 180, 75));
  return {
    minGapSeconds,
    maxPerHour: Math.round(between(chatty, 5, 12, 30)),
    capSeconds: Math.min(1200, Math.max(240, minGapSeconds * 3)),
  };
}

export type BeatKind = 'run-then-gap' | 'long-stretch';

export interface BeatInput {
  cues: readonly Cue[];
  /** The clock, in seconds. */
  position: number;
  /** Where the last beat was, in seconds; null before the first. */
  lastBeatPosition: number | null;
  capSeconds: number;
}

/** Is this moment a beat? Reads only cues that have come on (start <= position). */
export function detectBeat(input: BeatInput): BeatKind | null {
  const { position } = input;
  const heard = input.cues.filter((cue) => cue.start <= position);
  if (heard.length === 0) return null;
  // Rewound behind the last beat: count from where she is now.
  const since = input.lastBeatPosition === null ? 0 : Math.min(input.lastBeatPosition, position);
  const fresh = input.lastBeatPosition === null ? heard : heard.filter((cue) => cue.start > since);
  // Someone on screen is mid-line right now: never talk over it.
  const lastEnd = Math.max(...heard.map((cue) => Math.max(cue.end, cue.start)));
  const quietFor = position - lastEnd;
  if (quietFor < 0) return null;
  if (fresh.length >= BEAT_RUN_LINES && quietFor >= BEAT_GAP_SECONDS && quietFor <= BEAT_STALE_SECONDS) {
    return 'run-then-gap';
  }
  if (position - since >= input.capSeconds && fresh.length > 0 && quietFor >= 2) return 'long-stretch';
  return null;
}

export type BeatSkip =
  | 'house-off'
  | 'mouth-off'
  | 'not-live'
  | 'paused'
  | 'no-subtitles'
  | 'turn-running'
  | 'she-spoke'
  | 'cooldown'
  | 'hourly-cap'
  | 'no-beat';

export interface BeatCheck {
  houseOn: boolean;
  night: Pick<TheaterNight, 'status' | 'chatty' | 'mouthOn' | 'cues' | 'lastBeatPosition' | 'beatTimes'> & { clock: TheaterNight['clock'] };
  position: number;
  turnBusy: boolean;
  /** When she last said something (ms), or null. */
  lastSaidAt: number | null;
  now: number;
}

/** Why there is no beat now, or null: there is one (and `kind` says which). */
export function beatSkipReason(check: BeatCheck): { skip: BeatSkip } | { skip: null; kind: BeatKind } {
  const { night, now } = check;
  if (!check.houseOn) return { skip: 'house-off' };
  if (!mouthOnFor(night)) return { skip: 'mouth-off' };
  if (night.status !== 'live') return { skip: 'not-live' };
  if (night.clock.paused || night.clock.startedAt === null) return { skip: 'paused' };
  if (night.cues.length === 0) return { skip: 'no-subtitles' };
  if (check.turnBusy) return { skip: 'turn-running' };
  if (check.lastSaidAt !== null && now - check.lastSaidAt < KAY_SPOKE_HOLD_MS) return { skip: 'she-spoke' };
  const pace = mouthPace(night.chatty);
  const times = (night.beatTimes ?? []).filter((t) => now - t < HOUR_MS);
  const lastBeatAt = times.length > 0 ? Math.max(...times) : null;
  if (lastBeatAt !== null && now - lastBeatAt < pace.minGapSeconds * 1000) return { skip: 'cooldown' };
  if (times.length >= pace.maxPerHour) return { skip: 'hourly-cap' };
  const kind = detectBeat({ cues: night.cues, position: check.position, lastBeatPosition: night.lastBeatPosition ?? null, capSeconds: pace.capSeconds });
  if (!kind) return { skip: 'no-beat' };
  return { skip: null, kind };
}

/** The line handed to the couch with a beat. */
export function beatNote(kind: BeatKind): string {
  return kind === 'run-then-gap'
    ? 'A stretch of dialogue just ended and the show has gone quiet for a moment.'
    : "It's been a while since anyone on the couch said anything, and the show is between lines.";
}

export function mouthHouseOn(): boolean {
  try {
    return getConfigBool(MOUTH_FLAG, true);
  } catch {
    return true;
  }
}

/** The Mouth is listening: everything is in place for a beat to fire (the phone's "they're watching"). */
export function mouthArmed(night: TheaterNight, houseOn = mouthHouseOn()): boolean {
  return houseOn && mouthOnFor(night) && night.status === 'live' && !night.clock.paused
    && night.clock.startedAt !== null && night.cues.length > 0;
}

// ── the timer ──────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let mouthLane: TheaterLane | null = null;
let mouthRoot: string | null = null;
let mouthNightId: string | null = null;

/**
 * One look at the live night. Returns what happened, for tests and the log.
 * Exported so tests can drive it without the interval.
 */
export function mouthTick(lane: TheaterLane, root = theaterDir(), now = Date.now(), nightId?: string): BeatSkip | BeatKind {
  // The timer knows which night it armed for, so a tick reads one file, not the whole shelf.
  const night = nightId ? getNight(nightId, root) : liveNight(root);
  if (!night || night.status !== 'live') return 'not-live';
  const position = clockPosition(night.clock, now);
  // First look at this night: the run counts from where she started watching
  // with them, not from the top of the show.
  if (typeof night.lastBeatPosition !== 'number') {
    setLastBeatPosition(night.id, position, root);
    night.lastBeatPosition = position;
  }
  // She rewound behind the last beat: move the mark back so the run counts from here.
  if (night.lastBeatPosition > position) {
    setLastBeatPosition(night.id, position, root);
    night.lastBeatPosition = position;
  }
  const verdict = beatSkipReason({
    houseOn: mouthHouseOn(),
    night,
    position,
    turnBusy: theaterTurnBusy(),
    lastSaidAt: lastSaidAt(night),
    now,
  });
  if (verdict.skip) return verdict.skip;
  // Recorded first: a beat that fails or passes is not tried again.
  recordBeat(night.id, position, now, root);
  // The turn reads the clock when it runs, on the same time line as this tick
  // (the same as Date.now() in the house; a test's tick can be ahead of it).
  const skew = now - Date.now();
  queueBeat(lane, night.id, beatNote(verdict.kind), root, () => Date.now() + skew);
  return verdict.kind;
}

function tick(): void {
  if (!mouthLane) return;
  try {
    const root = mouthRoot ?? theaterDir();
    const night = mouthNightId ? getNight(mouthNightId, root) : null;
    if (!night || night.status !== 'live' || night.clock.paused || night.clock.startedAt === null) {
      stopTheaterMouth();
      return;
    }
    mouthTick(mouthLane, root, Date.now(), night.id);
  } catch (err) {
    console.error('[theater] the Mouth could not look at the show:', err);
  }
}

/**
 * Start listening if a night is live and playing (idempotent). The routes
 * call it after a night starts, the clock moves or settings change; boot
 * calls it so a reload picks a live night back up.
 */
export function armTheaterMouth(lane: TheaterLane | null, root?: string): boolean {
  if (!lane) return false;
  mouthLane = lane;
  mouthRoot = root ?? null;
  let night: TheaterNight | null = null;
  try {
    night = liveNight(root ?? theaterDir());
  } catch {
    night = null;
  }
  if (!night || night.clock.paused || night.clock.startedAt === null) {
    stopTheaterMouth();
    return false;
  }
  mouthNightId = night.id;
  if (!timer) {
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
  }
  return true;
}

export function stopTheaterMouth(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function theaterMouthTicking(): boolean {
  return timer !== null;
}

/** The night the Mouth is listening to, or null when it isn't ticking. */
export function theaterMouthNightId(): string | null {
  return timer ? mouthNightId : null;
}
