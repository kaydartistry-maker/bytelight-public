// The Theater — the clock, and what the couch is allowed to have heard.
//
// The house owns the clock so the companions can read it mid-turn. It runs
// beside her TV: she starts it when she presses play, taps pause when she
// pauses, nudges it ±5 s or drags it when it drifts. Running, the position is
// positionAtStart plus the time since startedAt; paused, it is positionAtStart
// as it stood when she paused (pausedAt says when). The position is never
// negative. Every function here is pure and takes "now" in milliseconds.

import type { Cue } from './theater-subtitles.js';

export interface TheaterClock {
  /** When the clock last started running (ms since epoch); null before the first play. */
  startedAt: number | null;
  /** Seconds into the show at startedAt, or where it stopped when paused. */
  positionAtStart: number;
  paused: boolean;
  /** When she paused (ms since epoch); null while running. */
  pausedAt: number | null;
}

/** A new night's clock: at the very beginning, waiting for her to press play. */
export function newClock(now: number, at = 0): TheaterClock {
  return { startedAt: null, positionAtStart: Math.max(0, at), paused: true, pausedAt: now };
}

/** Where the show is now, in seconds. */
export function clockPosition(clock: TheaterClock, now: number): number {
  if (clock.paused || clock.startedAt === null) return Math.max(0, clock.positionAtStart);
  return Math.max(0, clock.positionAtStart + (now - clock.startedAt) / 1000);
}

/** Press play (or carry on after a pause). Already running: unchanged. */
export function resumeClock(clock: TheaterClock, now: number): TheaterClock {
  if (!clock.paused && clock.startedAt !== null) return clock;
  return { startedAt: now, positionAtStart: clockPosition(clock, now), paused: false, pausedAt: null };
}

/** Pause where it stands. Already paused: unchanged. */
export function pauseClock(clock: TheaterClock, now: number): TheaterClock {
  if (clock.paused) return clock;
  return { startedAt: clock.startedAt, positionAtStart: clockPosition(clock, now), paused: true, pausedAt: now };
}

/** Put the clock at a position, keeping it running or paused as it was. */
export function setClock(clock: TheaterClock, position: number, now: number): TheaterClock {
  const at = Number.isFinite(position) ? Math.max(0, position) : 0;
  if (clock.paused) return { ...clock, positionAtStart: at };
  return { startedAt: now, positionAtStart: at, paused: false, pausedAt: null };
}

/** Nudge by some seconds (−5 / +5), never below zero. */
export function seekClock(clock: TheaterClock, delta: number, now: number): TheaterClock {
  return setClock(clock, clockPosition(clock, now) + (Number.isFinite(delta) ? delta : 0), now);
}

/**
 * Resync: she reads the time off her TV and the clock takes it, and starts
 * running if she says the show is playing.
 */
export function resyncClock(clock: TheaterClock, position: number, playing: boolean, now: number): TheaterClock {
  const at = Number.isFinite(position) ? Math.max(0, position) : 0;
  return playing
    ? { startedAt: now, positionAtStart: at, paused: false, pausedAt: null }
    : { startedAt: clock.startedAt, positionAtStart: at, paused: true, pausedAt: now };
}

/** How far behind the clock the couch can look. */
export const LOOKBACK_SECONDS = 90;

/**
 * What the couch has heard: the lines that came on in the last `seconds`
 * before the position, and none after it. A line on screen right now counts
 * (it came on before the position); a line that hasn't come on yet never does.
 * No spoilers, by construction.
 */
export function lookbackWindow(cues: readonly Cue[], position: number, seconds = LOOKBACK_SECONDS): Cue[] {
  const from = position - seconds;
  return cues.filter((cue) => cue.start <= position && cue.start >= from);
}

/** The line or two behind the clock, for the phone's faint caption. */
export function lastLines(cues: readonly Cue[], position: number, count = 2): Cue[] {
  const heard = cues.filter((cue) => cue.start <= position);
  return heard.slice(-count);
}

/** 00:23:41 */
export function formatClock(position: number): string {
  const total = Math.max(0, Math.floor(position));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}
