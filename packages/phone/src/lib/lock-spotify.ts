// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The lock screen's Spotify card (Oct 20 2026), apart from how it is drawn: its switch, what it shows,
// when it reads, and where it sits. components/LockSpotifyCard.tsx draws it.
//
// It reads when the lock screen shows, when the phone wakes or the app comes
// back, once after every press (the Spotify app's own keeper, lib/spotify.ts
// createSpotifyNow), and once more when the song playing should end. Nothing
// else runs on a timer.

import type { SpotifyNowView } from '@bytelight/shared';
import { createSpotifyNow, type SpotifyNowKeeper, type SpotifyNowState } from './spotify';

/** The switch in Settings > Lock screen. Unset is on; only the owner switch turns it off. */
export function lockSpotifyOf(value: unknown): boolean {
  return value !== false;
}

/** What the card shows, or null for no card: a song playing or paused, in the house's own answer. */
export function lockSpotifyTrack(state: SpotifyNowState): SpotifyNowView | null {
  const read = state.read;
  return read?.ok && read.data.track ? read.data : null;
}

/** A little past the song's end, so the next one has started when the card looks. */
export const SONG_END_SLACK_MS = 2000;
/** Longer than any song: past this the numbers are not believed. */
const LONGEST_WAIT_MS = 3 * 60 * 60 * 1000;

/**
 * How long until the card should look again, read off the song's progress and
 * length; null when nothing should wait (paused, or no numbers: the house does
 * not send them yet, see SpotifyNowView).
 */
export function songEndsInMs(view: SpotifyNowView | null): number | null {
  if (!view?.playing || !view.track) return null;
  const { progressMs, durationMs } = view;
  if (typeof progressMs !== 'number' || typeof durationMs !== 'number') return null;
  if (!Number.isFinite(progressMs) || !Number.isFinite(durationMs) || progressMs < 0 || durationMs <= 0) return null;
  const wait = Math.max(0, durationMs - progressMs) + SONG_END_SLACK_MS;
  return wait <= LONGEST_WAIT_MS ? wait : null;
}

export interface LockClockHands {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Whether the phone is asleep or the app is away: the wake reads then, not the wait. */
  hidden: () => boolean;
  /** The pause before the look after a press; tests pass an instant one. */
  wait?: (ms: number) => Promise<void>;
}

const REAL_HANDS: LockClockHands = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
};

export interface LockSpotify {
  keeper: SpotifyNowKeeper;
  /** The lock screen showed: read once. */
  start(): Promise<void>;
  /** The phone woke or the app came back: read once. */
  look(): Promise<void>;
  /** The lock screen went away: the song-end wait is cancelled and nothing more is read. */
  stop(): void;
}

export function createLockSpotify(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  hands: LockClockHands = REAL_HANDS,
  wake?: () => Promise<boolean>,
): LockSpotify {
  const keeper = createSpotifyNow(fetcher, { wait: hands.wait, wake });
  let timer: unknown = null;
  let stopped = true;
  let seen: SpotifyNowState['read'] = null;
  const cancel = () => {
    if (timer === null) return;
    hands.clearTimeout(timer);
    timer = null;
  };
  // Every read that lands sets the one wait for its song's end, in place of any before it.
  keeper.subscribe(() => {
    const read = keeper.state().read;
    if (read === seen) return;
    seen = read;
    cancel();
    if (stopped) return;
    const wait = songEndsInMs(read?.ok ? read.data : null);
    if (wait === null) return;
    timer = hands.setTimeout(() => {
      timer = null;
      if (stopped || hands.hidden()) return;
      void keeper.look();
    }, wait);
  });
  const look = async () => {
    if (!stopped) await keeper.look();
  };
  return {
    keeper,
    start() {
      stopped = false;
      return look();
    },
    look,
    stop() {
      stopped = true;
      cancel();
      keeper.leave();
    },
  };
}

/** A piece of the lock screen, top and bottom in px from the top of the screen. */
export interface Span {
  top: number;
  bottom: number;
}

/** How far the card keeps from the clock and the weather. */
export const LOCK_CARD_GAP = 12;

/**
 * How far above its own spot (on top of the other cards) the card sits so it
 * touches nothing, in px, or null when nowhere has room for it. It only ever
 * climbs, past whatever is in its way (the clock, the weather), and never
 * above `ceiling`; a piece below its own spot is the other cards' business.
 */
export function liftLockCard(card: Span, inTheWay: Span[], ceiling: number, gap = LOCK_CARD_GAP): number | null {
  const height = card.bottom - card.top;
  const pieces = inTheWay.filter((p) => p.bottom > p.top && p.top < card.bottom).sort((a, b) => b.bottom - a.bottom);
  let bottom = card.bottom;
  let moved = true;
  while (moved) {
    moved = false;
    for (const p of pieces) {
      if (bottom - height < p.bottom + gap && bottom + gap > p.top) {
        bottom = p.top - gap;
        moved = true;
      }
    }
  }
  if (bottom - height < ceiling) return null;
  return card.bottom - bottom;
}
