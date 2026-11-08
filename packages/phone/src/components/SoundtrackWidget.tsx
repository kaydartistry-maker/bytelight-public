// The home screen's Soundtrack bar (the operator, Nov 7 2026): a slim one-row player,
// the home screen's sibling of the lock screen's Spotify card. Cover, song and
// artist, and previous / play-pause / next. It shows only while a song is
// playing or paused. With nothing on, its row stays reserved and empty, so the
// wallpaper shows through and no other widget moves when music starts. While a
// widget is being carried, the empty row gets a faint outline so the operator can see
// where the bar lives.
//
// The reading and the presses are the lock card's own (lib/lock-spotify.ts and
// lib/spotify.ts), so a press here behaves exactly like a press there.

import React, { useEffect, useState } from 'react';
import { Music2 } from 'lucide-react';
import { apiFetch } from '../bytelight';
import { wakeSpotify } from '../bytelight/spotify-wake';
import { createLockSpotify, lockSpotifyTrack } from '../lib/lock-spotify';
import { troubleLine } from '../lib/spotify';
import { useSpotifyNow } from '../lib/use-spotify-now';
import { Controls, Cover, type PressState } from './spotify/SpotifyViews';

const SLIDE_SHEET = 'color-mix(in oklch, var(--bytelight-text) 9%, var(--bytelight-surface))';

export function SoundtrackWidget({ onOpen, editing = false }: { onOpen: () => void; editing?: boolean }) {
  const [player] = useState(() => createLockSpotify(apiFetch, undefined, wakeSpotify));
  const state = useSpotifyNow(player.keeper);
  useEffect(() => {
    void player.start();
    const woke = () => {
      if (document.visibilityState === 'visible') void player.look();
    };
    document.addEventListener('visibilitychange', woke);
    return () => {
      document.removeEventListener('visibilitychange', woke);
      player.stop();
    };
  }, [player]);

  const view = lockSpotifyTrack(state);
  const track = view?.track ?? null;

  if (!view || !track) {
    // Nothing on: the row stays the wallpaper's. While widgets are being
    // moved, a quiet outline marks where the bar sits.
    return (
      <div className="flex h-full w-full items-center">
      <div
        aria-hidden={!editing}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-full text-[11px] transition-opacity duration-300"
        style={{
          opacity: editing ? 1 : 0,
          border: '1px dashed var(--bytelight-hairline)',
          color: 'var(--bytelight-text-muted)',
        }}
      >
        <Music2 size={14} /> Soundtrack
      </div>
      </div>
    );
  }

  const press: PressState = {
    pressing: state.pressing,
    notice: state.notice,
    onPress: (what, where) => void player.keeper.press(what, where),
  };
  const notice = state.notice && state.notice.where.startsWith('now:') ? state.notice.trouble : null;

  // A skinny pill (the operator, Nov 7: the full-row card was too thick). It sits in
  // the middle of its row, so the row stays the same size for the grid.
  return (
    <div className="flex h-full w-full items-center">
    <div
      className="flex h-11 w-full items-center gap-2 rounded-full pl-1.5 pr-1 transition-opacity duration-300"
      style={{
        background: 'var(--bytelight-surface)',
        border: '1px solid var(--bytelight-hairline)',
        color: 'var(--bytelight-text)',
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open Spotify: ${track.name}${track.artist ? `, ${track.artist}` : ''}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <Cover src={track.cover} eager className="h-8 w-8 shrink-0 rounded-full" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-tight">{track.name}</span>
          <span className="block truncate text-[10px] leading-tight" style={{ color: 'var(--bytelight-text-muted)' }}>
            {notice ? troubleLine(notice) : track.artist}
          </span>
        </span>
      </button>
      <Controls playing={view.playing} press={press} size="slim" sheet={SLIDE_SHEET} />
    </div>
    </div>
  );
}
