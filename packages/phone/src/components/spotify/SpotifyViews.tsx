// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify in the house: what the app draws. Nothing in here fetches, so each
// state can be rendered on its own (components/spotify-app.test.ts does). A
// press only calls onPress; SpotifyApp.tsx sends it and looks at what is
// playing after it. A tapped song is pressed the way lib/spotify.ts songPress
// says: inside the playlist it was tapped in, else inside its album.
//
// LAYOUT NOTE: AppShell paints no background and their wallpaper is busy, so
// every word sits on a solid panel in the theme's own colors. Nothing is
// blurred, and every mix is OKLCH from the theme's variables. A button that
// plays wears the theme's selected fill with the ink made for it, the way
// every selected thing in the house does, and every press is a thumb wide.

import React, { useEffect, useState, type ReactNode } from 'react';
import { AudioLines, Heart, ImagePlus, Loader2, MoreHorizontal, Music, Pause, Pencil, Play, Plus, Search, SkipBack, SkipForward, X } from 'lucide-react';
import { SPOTIFY_SEARCH_LONGEST, type SpotifyNowView, type SpotifyPlaylist, type SpotifyPlaylistTracksView, type SpotifyRecentView, type SpotifySearchView, type SpotifyTrack, type SpotifyPlaylistsView } from '@bytelight/shared';
import { resolveThemeColor, type ThemeColors } from '../../lib/theme';
import { themeInk } from '../../lib/theme-ink';
import { cn } from '../../lib/utils';
import {
  largerCover,
  playableSong,
  playingUri,
  playlistUriOf,
  recentRow,
  songCount,
  songPress,
  troubleLine,
  wholeAppTrouble,
  type SpotifyHome,
  type SpotifyPress,
  type SpotifyRead,
  type SpotifyTrouble,
} from '../../lib/spotify';

/** Where a cover will be: a shade lifted off the panel. */
export const SHEET = 'color-mix(in oklch, var(--bytelight-text) 7%, var(--bytelight-panel-base))';
const COVER_SHADOW = '0 1px 1px oklch(0 0 0 / 0.16), 0 8px 16px -8px oklch(0 0 0 / 0.55)';
export const HAIRLINE = 'color-mix(in oklch, var(--bytelight-border) 80%, transparent)';
/** The lock screen's card is the house's solid surface, so its buttons lift off that. */
const CARD_SHEET = 'color-mix(in oklch, var(--bytelight-text) 9%, var(--bytelight-surface))';
/** A button that plays: the theme's selected fill, with the ink made for it. */
export const PLAY_FILL = { background: 'var(--bytelight-selected-fill, var(--bytelight-accent))', color: 'var(--bytelight-on-accent)' } as const;

type OpenLink = (url: string) => void;

/**
 * The presses, as the views see them. `where` names the button a press came
 * from ('now:pause', 'recent:2', 'playlist', 'song:7'): the one that is out
 * turns, and a press's sentence is shown by the button that made it.
 */
export interface PressState {
  /** Where the press that is out was made, or null. Every press button waits while one is out. */
  pressing: string | null;
  notice: { where: string; trouble: SpotifyTrouble } | null;
  /** Absent, the views only look: every press button is drawn, and waits. */
  onPress?: (press: SpotifyPress, where: string) => void;
}

const NO_PRESSES: PressState = { pressing: null, notice: null };

const waiting = (press: PressState) => press.pressing !== null || !press.onPress;

/** The theme's own color for a small mark on the panel, fitted to read there. */
function markInk(colors: ThemeColors): string {
  return themeInk('', resolveThemeColor(colors.accent, 'var(--bytelight-accent)'), colors);
}

/**
 * A cover from Spotify, straight from its address, or a quiet square where
 * there is none. The big picture is tried first and the given one after it.
 */
export function Cover({
  src,
  fallback = null,
  className,
  eager = false,
}: {
  src: string | null;
  fallback?: string | null;
  className: string;
  eager?: boolean;
}) {
  const [current, setCurrent] = useState<string | null>(src ?? fallback);
  useEffect(() => setCurrent(src ?? fallback), [src, fallback]);
  if (!current) {
    return (
      <div aria-hidden className={cn(className, 'flex items-center justify-center')} style={{ background: SHEET, color: 'var(--bytelight-text-muted)' }}>
        <Music size={18} />
      </div>
    );
  }
  return (
    <img
      src={current}
      alt=""
      aria-hidden
      // Their house's address is nobody's business at Spotify's picture server.
      referrerPolicy="no-referrer"
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setCurrent(fallback && current !== fallback ? fallback : null)}
      className={cn(className, 'object-cover')}
      style={{ background: SHEET, boxShadow: COVER_SHADOW }}
    />
  );
}

function Section({ title, count, colors, children }: { title: string; count?: number; colors: ThemeColors; children: ReactNode }) {
  return (
    <section className={cn('mb-4 rounded-2xl border p-4', colors.panelBg, colors.panelBorder)}>
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className={cn('text-[10px] font-bold uppercase tracking-[0.14em]', colors.textMuted)}>{title}</h3>
        {typeof count === 'number' && count > 0 && <span className={cn('text-[10px] font-semibold tabular-nums', colors.textMuted)}>{count}</span>}
      </header>
      {children}
    </section>
  );
}

function Quiet({ colors, children }: { colors: ThemeColors; children: ReactNode }) {
  return <p className={cn('py-3 text-center text-xs leading-relaxed [overflow-wrap:anywhere]', colors.textMuted)}>{children}</p>;
}

/** A trouble in their words, with the sign-in page a tap away when there is one. */
function TroubleWords({ trouble, colors, onOpenLink }: { trouble: SpotifyTrouble; colors: ThemeColors; onOpenLink: OpenLink }) {
  return (
    <>
      <Quiet colors={colors}>{troubleLine(trouble)}</Quiet>
      {trouble.kind === 'signin' && trouble.authUrl && (
        <div className="flex justify-center pb-1">
          <button
            type="button"
            onClick={() => onOpenLink(trouble.authUrl!)}
            className={cn('rounded-full border px-4 py-1.5 text-xs font-semibold', colors.panelBorder, colors.textMain)}
          >
            Open the sign-in page
          </button>
        </div>
      )}
    </>
  );
}

/** A press's sentence, by the button that made it. */
function PressNotice({ press, at, colors, onOpenLink }: { press: PressState; at: (where: string) => boolean; colors: ThemeColors; onOpenLink: OpenLink }) {
  if (!press.notice || !at(press.notice.where)) return null;
  return (
    <div role="status">
      <TroubleWords trouble={press.notice.trouble} colors={colors} onOpenLink={onOpenLink} />
    </div>
  );
}

/** How the controls are drawn: big under the app's cover, or a thumb wide in a row on the lock screen's card. */
const CONTROL_SIZES = {
  app: { row: 'mt-5 flex items-center justify-center gap-6', side: 'h-12 w-12', sideIcon: 20, middle: 'h-16 w-16', middleIcon: 26, sheet: SHEET },
  card: { row: 'flex shrink-0 items-center gap-1', side: 'h-11 w-11', sideIcon: 18, middle: 'h-11 w-11', middleIcon: 20, sheet: CARD_SHEET },
} as const;

/**
 * Previous, play or pause (whichever applies), and next, under whatever is
 * playing: in the app, and on the lock screen's card (size 'card'), so both
 * press the same way, with the same labels and the same waiting.
 */
export function Controls({
  playing,
  press,
  colors,
  size = 'app',
  sheet,
}: {
  playing: boolean;
  press: PressState;
  colors?: ThemeColors;
  size?: keyof typeof CONTROL_SIZES;
  /** The sheet under the side buttons, when the card they sit on has its own look (the lock screen's). */
  sheet?: string;
}) {
  const look = CONTROL_SIZES[size];
  const waits = waiting(press);
  const middle: { press: SpotifyPress; where: string; label: string } = playing
    ? { press: { kind: 'pause' }, where: 'now:pause', label: 'Pause' }
    : { press: { kind: 'resume' }, where: 'now:resume', label: 'Play' };
  const side = (kind: 'previous' | 'next') => {
    const where = `now:${kind}`;
    const label = kind === 'previous' ? 'Previous song' : 'Next song';
    const Icon = kind === 'previous' ? SkipBack : SkipForward;
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={waits}
        onClick={() => press.onPress?.(kind === 'next' ? { kind: 'next' } : { kind: 'previous' }, where)}
        className={cn('flex items-center justify-center rounded-full transition-opacity disabled:opacity-50', look.side, colors?.textMain)}
        style={{ background: sheet ?? look.sheet }}
      >
        {press.pressing === where ? <Loader2 size={look.sideIcon} className="animate-spin" /> : <Icon size={look.sideIcon} fill="currentColor" />}
      </button>
    );
  };
  return (
    <div className={look.row}>
      {side('previous')}
      <button
        type="button"
        aria-label={middle.label}
        title={middle.label}
        disabled={waits}
        onClick={() => press.onPress?.(middle.press, middle.where)}
        className={cn('flex items-center justify-center rounded-full transition-opacity disabled:opacity-50', look.middle)}
        style={PLAY_FILL}
      >
        {press.pressing === middle.where ? (
          <Loader2 size={look.middleIcon} className="animate-spin" />
        ) : playing ? (
          <Pause size={look.middleIcon} fill="currentColor" />
        ) : (
          <Play size={look.middleIcon} fill="currentColor" className="translate-x-[2px]" />
        )}
      </button>
      {side('next')}
    </div>
  );
}

export function NowPlaying({
  read,
  colors,
  onOpenLink,
  press = NO_PRESSES,
  extra = null,
}: {
  read: SpotifyRead<SpotifyNowView>;
  colors: ThemeColors;
  onOpenLink: OpenLink;
  press?: PressState;
  /** Under the controls: shuffle, repeat, the heart, the device, place and volume (SpotifyMore.tsx PlayerExtras). */
  extra?: ReactNode;
}) {
  const view = read.ok ? read.data : null;
  const title = view?.track ? (view.playing ? 'Playing now' : 'Paused') : 'Now playing';
  return (
    <Section title={title} colors={colors}>
      {read.ok === false ? (
        <TroubleWords trouble={read.trouble} colors={colors} onOpenLink={onOpenLink} />
      ) : !view?.track ? (
        <Quiet colors={colors}>{view?.playing ? 'Something is playing, but Spotify did not say what.' : 'Nothing is playing right now.'}</Quiet>
      ) : (
        <div className="flex flex-col items-center text-center">
          <Cover
            src={largerCover(view.track.cover) ?? view.track.cover}
            fallback={view.track.cover}
            eager
            className="aspect-square w-full max-w-[18rem] rounded-xl"
          />
          <div className={cn('mt-4 text-lg font-semibold leading-snug [overflow-wrap:anywhere]', colors.textMain)}>{view.track.name}</div>
          {view.track.artist && <div className={cn('mt-0.5 text-sm [overflow-wrap:anywhere]', colors.textMuted)}>{view.track.artist}</div>}
          {view.track.album && view.track.album !== view.track.name && (
            <div className={cn('mt-0.5 text-[11px] [overflow-wrap:anywhere]', colors.textMuted)}>{view.track.album}</div>
          )}
          <Controls playing={view.playing} press={press} colors={colors} />
          {extra}
        </div>
      )}
      <PressNotice press={press} at={(where) => where.startsWith('now:')} colors={colors} onOpenLink={onOpenLink} />
    </Section>
  );
}

export function RecentRow({
  read,
  colors,
  onOpenLink,
  press = NO_PRESSES,
  nowUri = null,
}: {
  read: SpotifyRead<SpotifyRecentView>;
  colors: ThemeColors;
  onOpenLink: OpenLink;
  press?: PressState;
  /** The song playing right now, marked where it shows. */
  nowUri?: string | null;
}) {
  const songs = read.ok ? recentRow(read.data.tracks) : [];
  const ink = markInk(colors);
  return (
    <Section title="Recently played" colors={colors}>
      {read.ok === false ? (
        <TroubleWords trouble={read.trouble} colors={colors} onOpenLink={onOpenLink} />
      ) : songs.length === 0 ? (
        <Quiet colors={colors}>Nothing played lately.</Quiet>
      ) : (
        // Inside the card's padding, not bled to its edge: snapping lined the
        // first cover up with the scroll edge, which was the card's border.
        // Three to a row whatever the width, and lined up at the top, so a
        // two-line title never lifts its cover (Oct 23 2026).
        <div className="flex snap-x items-start gap-3 overflow-x-auto pb-1 scrollbar-hide">
          {songs.map((song, i) => {
            const where = `recent:${i}`;
            const play = songPress(song);
            const uri = play?.uri ?? null;
            const inner = (
              <>
                <div className="relative">
                  <Cover src={song.cover} className="aspect-square w-full rounded-lg" />
                  {press.pressing === where && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className={cn('rounded-full p-2', colors.textMain)} style={{ background: SHEET }}>
                        <Loader2 size={18} className="animate-spin" />
                      </span>
                    </span>
                  )}
                </div>
                <div className={cn('mt-2 line-clamp-2 text-[12px] font-semibold leading-snug [overflow-wrap:anywhere]', colors.textMain)}>
                  {uri !== null && uri === nowUri && (
                    <AudioLines size={12} aria-label="Playing now" className="mr-1 inline-block align-[-1px]" style={{ color: ink }} />
                  )}
                  {song.name}
                </div>
                {song.artist && <div className={cn('mt-0.5 truncate text-[11px]', colors.textMuted)}>{song.artist}</div>}
              </>
            );
            const key = `${song.uri ?? song.name}-${i}`;
            return play ? (
              <button
                key={key}
                type="button"
                aria-label={`Play ${song.name}`}
                disabled={waiting(press)}
                onClick={() => press.onPress?.(play, where)}
                className="block w-[calc((100%-1.5rem)/3)] shrink-0 snap-start text-left disabled:cursor-default"
              >
                {inner}
              </button>
            ) : (
              <div key={key} className="w-[calc((100%-1.5rem)/3)] shrink-0 snap-start">
                {inner}
              </div>
            );
          })}
        </div>
      )}
      <PressNotice press={press} at={(where) => where.startsWith('recent:')} colors={colors} onOpenLink={onOpenLink} />
    </Section>
  );
}

export function PlaylistGrid({
  read,
  colors,
  onOpen,
  onOpenLink,
  onOpenLiked = null,
  onNewPlaylist = null,
}: {
  read: SpotifyRead<SpotifyPlaylistsView>;
  colors: ThemeColors;
  onOpen: (playlist: SpotifyPlaylist) => void;
  onOpenLink: OpenLink;
  /** The owner Liked Songs, as a tile ahead of the playlists. */
  onOpenLiked?: (() => void) | null;
  /** A New playlist tile ahead of the playlists. */
  onNewPlaylist?: (() => void) | null;
}) {
  const lists = read.ok ? read.data.playlists : [];
  const tile = (key: string, label: string, icon: ReactNode, onClick: () => void) => (
    <button key={key} type="button" onClick={onClick} className="block w-full text-left">
      <div className={cn('flex aspect-square w-full items-center justify-center rounded-lg', colors.textMain)} style={{ background: SHEET, boxShadow: COVER_SHADOW }}>
        {icon}
      </div>
      <div className={cn('mt-2 line-clamp-2 text-[12px] font-semibold leading-snug', colors.textMain)}>{label}</div>
    </button>
  );
  const tiles = [
    onOpenLiked ? tile('liked', 'Liked Songs', <Heart size={34} fill="currentColor" />, onOpenLiked) : null,
    onNewPlaylist ? tile('new', 'New playlist', <Plus size={34} />, onNewPlaylist) : null,
  ].filter(Boolean);
  return (
    <Section title="Playlists" count={lists.length} colors={colors}>
      {read.ok === false ? (
        <TroubleWords trouble={read.trouble} colors={colors} onOpenLink={onOpenLink} />
      ) : lists.length === 0 && tiles.length === 0 ? (
        <Quiet colors={colors}>No playlists yet.</Quiet>
      ) : (
        // Lined up at the top: a grid stretches each button to its row and a
        // button centers what is inside it, so a two-line name lifted its
        // cover above the one beside it (Oct 23 2026).
        <div className="grid grid-cols-2 items-start gap-x-3 gap-y-4">
          {tiles}
          {lists.map((list) => (
            <button key={list.id} type="button" onClick={() => onOpen(list)} className="block w-full text-left">
              <Cover src={list.cover} className="aspect-square w-full rounded-lg" />
              <div className={cn('mt-2 line-clamp-2 text-[12px] font-semibold leading-snug [overflow-wrap:anywhere]', colors.textMain)}>{list.name}</div>
              {songCount(list.tracks) && <div className={cn('mt-0.5 text-[11px]', colors.textMuted)}>{songCount(list.tracks)}</div>}
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

/**
 * Search, at the top of the front page (Oct 20 2026): a box, and the songs it found under it, each a tap that starts
 * its album at that song. Asked when the owner presses search, never as the owner types.
 */
export function SearchSection({
  words,
  onWords,
  onSearch,
  onClear,
  read,
  searching,
  colors,
  onOpenLink,
  press = NO_PRESSES,
  nowUri = null,
  onMore = null,
}: {
  words: string;
  onWords: (words: string) => void;
  onSearch: () => void;
  onClear: () => void;
  /** The newest search to land, or null before the first. */
  read: SpotifyRead<SpotifySearchView> | null;
  searching: boolean;
  colors: ThemeColors;
  onOpenLink: OpenLink;
  press?: PressState;
  nowUri?: string | null;
  /** A song's dots: its heart, adding it to a playlist (SpotifyMore.tsx SongSheet). */
  onMore?: ((track: SpotifyTrack, index: number) => void) | null;
}) {
  const ink = markInk(colors);
  return (
    <Section title="Search" colors={colors}>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
        className="flex items-center gap-2"
      >
        <input
          type="text"
          inputMode="search"
          enterKeyHint="search"
          value={words}
          onChange={(event) => onWords(event.target.value)}
          maxLength={SPOTIFY_SEARCH_LONGEST}
          placeholder="Search songs"
          aria-label="Search Spotify"
          className={cn('h-11 min-w-0 flex-1 rounded-full border px-4 text-sm outline-none', colors.panelBorder, colors.textMain)}
          style={{ background: SHEET }}
        />
        {(read !== null || words !== '') && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear the search"
            title="Clear"
            className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', colors.textMuted)}
            style={{ background: SHEET }}
          >
            <X size={18} />
          </button>
        )}
        <button
          type="submit"
          aria-label="Search"
          title="Search"
          disabled={searching || !words.trim()}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-50"
          style={PLAY_FILL}
        >
          {searching ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
        </button>
      </form>
      {read === null ? null : read.ok === false ? (
        <TroubleWords trouble={read.trouble} colors={colors} onOpenLink={onOpenLink} />
      ) : read.data.tracks.length === 0 ? (
        <Quiet colors={colors}>Nothing found for “{read.data.query}”.</Quiet>
      ) : (
        <ol className="mt-2">
          {read.data.tracks.map((track, i) => (
            <TrackRow
              key={`${track.uri ?? track.name}-${i}`}
              track={track}
              where={`search:${i}`}
              divided={i > 0}
              colors={colors}
              press={press}
              nowUri={nowUri}
              ink={ink}
              onOpenLink={onOpenLink}
              onMore={onMore ? () => onMore(track, i) : null}
            />
          ))}
        </ol>
      )}
    </Section>
  );
}

/** The front page: search, what is playing, what played, and their playlists. */
export function SpotifyHomeView({
  home,
  colors,
  onOpenPlaylist,
  onOpenLink,
  press = NO_PRESSES,
  search = null,
  nowExtra = null,
  onOpenLiked = null,
  onNewPlaylist = null,
}: {
  home: SpotifyHome | null;
  colors: ThemeColors;
  onOpenPlaylist: (playlist: SpotifyPlaylist) => void;
  onOpenLink: OpenLink;
  press?: PressState;
  /** The search box and what it found (SearchSection), above the rest. */
  search?: ReactNode;
  /** Under what is playing: the player's extras. */
  nowExtra?: ReactNode;
  onOpenLiked?: (() => void) | null;
  onNewPlaylist?: (() => void) | null;
}) {
  if (!home) {
    return <div className={cn('rounded-2xl border px-4 py-6 text-center text-xs', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>;
  }
  const whole = wholeAppTrouble(home);
  if (whole) {
    return (
      <div className={cn('rounded-2xl border px-4 py-4', colors.panelBg, colors.panelBorder)}>
        <TroubleWords trouble={whole} colors={colors} onOpenLink={onOpenLink} />
      </div>
    );
  }
  return (
    <>
      {search}
      <NowPlaying read={home.now} colors={colors} onOpenLink={onOpenLink} press={press} extra={nowExtra} />
      <RecentRow read={home.recent} colors={colors} onOpenLink={onOpenLink} press={press} nowUri={playingUri(home.now)} />
      <PlaylistGrid read={home.playlists} colors={colors} onOpen={onOpenPlaylist} onOpenLink={onOpenLink} onOpenLiked={onOpenLiked} onNewPlaylist={onNewPlaylist} />
    </>
  );
}

function TrackRow({
  track,
  where,
  divided,
  colors,
  press,
  nowUri,
  ink,
  onOpenLink,
  playlistUri = null,
  onMore = null,
}: {
  track: SpotifyTrack;
  where: string;
  divided: boolean;
  colors: ThemeColors;
  press: PressState;
  nowUri: string | null;
  ink: string;
  onOpenLink: OpenLink;
  /** The playlist it was tapped in, which a tap starts at this song. */
  playlistUri?: string | null;
  /** The song's dots, opening its sheet. */
  onMore?: (() => void) | null;
}) {
  const play = songPress(track, playlistUri);
  const uri = play?.uri ?? null;
  const body = (
    <>
      <Cover src={track.cover} className="h-11 w-11 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-[13px] font-semibold', colors.textMain)}>{track.name}</div>
        {track.artist && <div className={cn('truncate text-[11px]', colors.textMuted)}>{track.artist}</div>}
      </div>
      {press.pressing === where ? (
        <Loader2 size={16} className={cn('shrink-0 animate-spin', colors.textMuted)} />
      ) : uri !== null && uri === nowUri ? (
        <AudioLines size={16} aria-label="Playing now" className="shrink-0" style={{ color: ink }} />
      ) : null}
    </>
  );
  return (
    <li style={divided ? { borderTop: `1px solid ${HAIRLINE}` } : undefined}>
      <div className="flex items-center gap-1">
        {play ? (
          <button
            type="button"
            aria-label={`Play ${track.name}`}
            disabled={waiting(press)}
            onClick={() => press.onPress?.(play, where)}
            className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left disabled:cursor-default"
          >
            {body}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3 py-2">{body}</div>
        )}
        {onMore && playableSong(track.uri) && (
          <button
            type="button"
            aria-label={`More for ${track.name}`}
            title="Heart, add to a playlist, and more"
            onClick={onMore}
            className={cn('-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full', colors.textMuted)}
          >
            <MoreHorizontal size={18} />
          </button>
        )}
      </div>
      <PressNotice press={press} at={(at) => at === where} colors={colors} onOpenLink={onOpenLink} />
    </li>
  );
}

/** One playlist opened: its cover, name and Play button, then every song with its own cover, each a tap that starts the playlist there. */
export function PlaylistView({
  playlist,
  read,
  colors,
  onOpenLink,
  press = NO_PRESSES,
  nowUri = null,
  onMore = null,
  onRename = null,
  onPicture = null,
  editing = null,
  notice = null,
}: {
  playlist: SpotifyPlaylist;
  read: SpotifyRead<SpotifyPlaylistTracksView> | null;
  colors: ThemeColors;
  onOpenLink: OpenLink;
  press?: PressState;
  /** The song playing right now, marked in the list. */
  nowUri?: string | null;
  onMore?: ((track: SpotifyTrack, index: number) => void) | null;
  /** On one of their own playlists: rename it, and give it a picture from their phone. */
  onRename?: (() => void) | null;
  onPicture?: ((file: File) => void) | null;
  /** Which of those is out ('picture'), or null. */
  editing?: string | null;
  /** Under the header, a sentence from one of those. */
  notice?: ReactNode;
}) {
  const count = read?.ok ? read.data.tracks.length : playlist.tracks;
  const listUri = playlistUriOf(playlist);
  const songs = read?.ok ? read.data.tracks.flatMap((track) => (track.uri ? [track.uri] : [])) : null;
  const ink = markInk(colors);
  return (
    <article className="pb-2">
      <section className={cn('mb-4 rounded-2xl border p-4', colors.panelBg, colors.panelBorder)}>
        <div className="flex items-center gap-4">
          <Cover src={playlist.cover} eager className="aspect-square w-32 shrink-0 rounded-lg" />
          <div className="min-w-0">
            <h2 className={cn('text-lg font-semibold leading-tight [overflow-wrap:anywhere]', colors.textMain)}>{playlist.name}</h2>
            {songCount(count) && <div className={cn('mt-1 text-[11px]', colors.textMuted)}>{songCount(count)}</div>}
            {(onRename || onPicture) && (
              <div className="mt-2 flex gap-2">
                {onRename && (
                  <button type="button" onClick={onRename} aria-label="Rename this playlist" title="Rename" className={cn('flex h-9 w-9 items-center justify-center rounded-full', colors.textMain)} style={{ background: SHEET }}>
                    <Pencil size={15} />
                  </button>
                )}
                {onPicture && (
                  <label aria-label="Give this playlist a picture" title="Picture" className={cn('flex h-9 w-9 cursor-pointer items-center justify-center rounded-full', colors.textMain)} style={{ background: SHEET }}>
                    {editing === 'picture' ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*"
                      className="hidden"
                      disabled={editing !== null}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file) onPicture(file);
                      }}
                    />
                  </label>
                )}
              </div>
            )}
            {listUri && (
              <button
                type="button"
                aria-label={`Play ${playlist.name}`}
                disabled={waiting(press)}
                onClick={() => press.onPress?.({ kind: 'playlist', uri: listUri, songs }, 'playlist')}
                className="mt-3 inline-flex h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold transition-opacity disabled:opacity-50"
                style={PLAY_FILL}
              >
                {press.pressing === 'playlist' ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} fill="currentColor" />}
                Play
              </button>
            )}
          </div>
        </div>
        <PressNotice press={press} at={(where) => where === 'playlist'} colors={colors} onOpenLink={onOpenLink} />
        {notice}
      </section>
      <Section title="Songs" colors={colors}>
        {read === null ? (
          <Quiet colors={colors}>Loading…</Quiet>
        ) : read.ok === false ? (
          <TroubleWords trouble={read.trouble} colors={colors} onOpenLink={onOpenLink} />
        ) : read.data.tracks.length === 0 ? (
          <Quiet colors={colors}>This playlist is empty.</Quiet>
        ) : (
          <ol>
            {read.data.tracks.map((track, i) => (
              <TrackRow
                key={`${track.uri ?? track.name}-${i}`}
                track={track}
                where={`song:${i}`}
                divided={i > 0}
                colors={colors}
                press={press}
                nowUri={nowUri}
                ink={ink}
                onOpenLink={onOpenLink}
                playlistUri={listUri}
                onMore={onMore ? () => onMore(track, i) : null}
              />
            ))}
          </ol>
        )}
      </Section>
    </article>
  );
}

// React is in scope for test renders that compile JSX the classic way.
void React;
