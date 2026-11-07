// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The lock screen's Spotify card (Oct 20 2026): while a song is playing or paused, its cover, the
// song and the artist, and previous, play or pause, and next, pressed the way
// the Spotify app presses them (the one keeper, lib/spotify.ts
// createSpotifyNow, and the app's own Controls). A tap on the cover or the
// words opens the Spotify app. Anything that is not the house's own answer is
// no card, and the only words it ever says are a press's sentence.
//
// LAYOUT NOTE: the shape and the look of the lock screen's other cards, dark
// or light the way the owner switch says (lib/lock-cards.ts), nothing blurred. It
// sits on top of the other cards, and when that would touch the clock or the
// weather it climbs above them; where nothing has room it waits out of sight
// (lib/lock-spotify.ts liftLockCard).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SpotifyNowView } from '@bytelight/shared';
import { Controls, Cover, type PressState } from './spotify/SpotifyViews';
import { useSpotifyNow } from '../lib/use-spotify-now';
import { createLockSpotify, liftLockCard, lockSpotifyTrack, type Span } from '../lib/lock-spotify';
import { troubleLine } from '../lib/spotify';
import { wakeSpotify } from '../bytelight/spotify-wake';
import { LOCK_CARD_LOOKS, type LockCardLook } from '../lib/lock-cards';

/** The card as drawn: nothing in here fetches, so each state renders on its own. */
export function LockSpotifyCardView({ view, press, onOpen, look = 'dark' }: { view: SpotifyNowView; press: PressState; onOpen?: () => void; look?: LockCardLook }) {
  const track = view.track;
  if (!track) return null;
  const ink = LOCK_CARD_LOOKS[look];
  const notice = press.notice && press.notice.where.startsWith('now:') ? press.notice.trouble : null;
  const words = (
    <>
      <Cover src={track.cover} eager className="h-12 w-12 shrink-0 rounded-lg" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{track.name}</span>
        {track.artist && <span className={`block truncate text-xs ${ink.muted}`}>{track.artist}</span>}
      </span>
    </>
  );
  return (
    <div className={`rounded-2xl border px-3 py-2.5 ${ink.card}`}>
      <div className="flex items-center gap-2">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open Spotify: ${track.name}${track.artist ? `, ${track.artist}` : ''}`}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            {words}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{words}</div>
        )}
        <Controls playing={view.playing} press={press} size="card" sheet={ink.sheet} />
      </div>
      {notice && (
        <p role="status" className={`mt-1.5 line-clamp-2 text-xs [overflow-wrap:anywhere] ${ink.muted}`}>
          {troubleLine(notice)}
        </p>
      )}
    </div>
  );
}

/**
 * The card, live. `base` is its own spot in px above the bottom safe edge, on
 * top of the other cards; it reads when it mounts, on every wake, and when the
 * song should end, and stops when the lock screen goes.
 */
export function LockSpotifyCard({
  fetcher,
  base,
  onOpen,
  look = 'dark',
}: {
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  base: number;
  onOpen?: () => void;
  look?: LockCardLook;
}) {
  const [lock] = useState(() => createLockSpotify(fetcher, undefined, wakeSpotify));
  const state = useSpotifyNow(lock.keeper);
  useEffect(() => {
    void lock.start();
    const woke = () => {
      if (document.visibilityState === 'visible') void lock.look();
    };
    document.addEventListener('visibilitychange', woke);
    return () => {
      document.removeEventListener('visibilitychange', woke);
      lock.stop();
    };
  }, [lock]);

  // Where it sits, measured against the clock and the weather wherever the owner has
  // put them, on every draw (the lock screen draws once a second).
  const ref = useRef<HTMLDivElement>(null);
  const ceilingRef = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState<number | null | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    const frame = el?.closest<HTMLElement>('[data-lock-frame]');
    if (!el || !frame) return;
    const top = frame.getBoundingClientRect().top;
    const box = el.getBoundingClientRect();
    const raised = lift ?? 0;
    const own: Span = { top: box.top - top + raised, bottom: box.bottom - top + raised };
    const pieces: Span[] = Array.from(frame.querySelectorAll<HTMLElement>('[data-lock-piece]')).map((piece) => {
      const r = piece.getBoundingClientRect();
      return { top: r.top - top, bottom: r.bottom - top };
    });
    const ceiling = (ceilingRef.current?.getBoundingClientRect().top ?? top) - top + 8;
    const next = liftLockCard(own, pieces, ceiling);
    if (next !== lift) setLift(next);
  });

  const view = lockSpotifyTrack(state);
  if (!view) return null;
  const away = lift === undefined || lift === null;
  const press: PressState = {
    pressing: state.pressing,
    notice: state.notice,
    onPress: (what, where) => void lock.keeper.press(what, where),
  };
  return (
    <>
      <div ref={ceilingRef} aria-hidden className="pointer-events-none absolute inset-x-0 h-0" style={{ top: 'var(--sat, 0px)' }} />
      <div
        ref={ref}
        data-lock-spotify=""
        aria-hidden={away || undefined}
        className="absolute inset-x-5 z-20"
        style={{ bottom: `calc(var(--sab, 0px) + ${base + (lift ?? 0)}px)`, visibility: away ? 'hidden' : undefined }}
      >
        <LockSpotifyCardView view={view} press={press} onOpen={onOpen} look={look} />
      </div>
    </>
  );
}
