// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify in the house, as the phone reads it and presses it: the decisions behind the Spotify
// app. Nothing in here draws, so every choice (is this answer really the
// house's, what to say instead, which picture to show big) can be checked
// without a browser. components/SpotifyApp.tsx fetches; components/spotify/
// SpotifyViews.tsx draws what this decides.

import {
  isPlayableAlbumUri,
  isPlayablePlaylistUri,
  isPlayableTrackUri,
  type SpotifyNowView,
  type SpotifyPlaylistTracksView,
  type SpotifyPlaylistsView,
  type SpotifyProblemReason,
  type SpotifyRecentTrack,
  type SpotifyRecentView,
  type SpotifySearchView,
} from '@bytelight/shared';

/** The drawer id of the app. */
export const SPOTIFY_APP_ID = 'spotify';

/** Their words for it, from the brief: the routes exist only after the owner restart. */
export const RESTART_LINE = 'Spotify needs the house restarted once.';
export const UNREACHABLE_LINE = 'Spotify could not be reached just now.';
export const SIGNED_OUT_LINE = 'The house asked you to sign in again.';

/** What to say instead of the music. */
export type SpotifyTrouble =
  /** An answer that was not the house's JSON: a backend from before these routes, answering with the phone's own page. */
  | { kind: 'restart' }
  /** Spotify's sign-in on the server lapsed; its fix is theirs, on the worker. */
  | { kind: 'signin'; message: string; authUrl: string | null }
  /** `device`: Spotify found nowhere to play, the one trouble the app can answer by waking Spotify itself. */
  | { kind: 'problem'; message: string; device?: boolean };

export type SpotifyRead<T> = { ok: true; data: T } | { ok: false; trouble: SpotifyTrouble };

type Fetcher = (url: string) => Promise<Response>;

// ─── Is this really the answer ───────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown) => value === null || typeof value === 'string';

function isTrack(value: unknown): boolean {
  return isRecord(value) && isText(value.name) && isText(value.artist) && isTextOrNull(value.uri) && isTextOrNull(value.cover)
    && (value.albumUri === undefined || isTextOrNull(value.albumUri));
}

export function isNowView(value: unknown): value is SpotifyNowView {
  return isRecord(value) && typeof value.playing === 'boolean' && (value.track === null || isTrack(value.track));
}

export function isRecentView(value: unknown): value is SpotifyRecentView {
  return isRecord(value) && Array.isArray(value.tracks) && value.tracks.every(isTrack);
}

export function isPlaylistsView(value: unknown): value is SpotifyPlaylistsView {
  return isRecord(value) && Array.isArray(value.playlists) && value.playlists.every((list) =>
    isRecord(list) && isText(list.id) && isText(list.name)
    && (list.tracks === null || typeof list.tracks === 'number') && isTextOrNull(list.cover));
}

export function isPlaylistTracksView(value: unknown): value is SpotifyPlaylistTracksView {
  return isRecord(value) && isText(value.id) && Array.isArray(value.tracks) && value.tracks.every(isTrack);
}

export function isSearchView(value: unknown): value is SpotifySearchView {
  return isRecord(value) && isText(value.query) && Array.isArray(value.tracks) && value.tracks.every(isTrack);
}

/**
 * One read, shape-checked. A backend from before these routes answers their
 * address with the phone's own page, 200 and HTML, so res.ok says nothing; the
 * shape does, and anything that is not the expected JSON asks for a restart.
 */
export async function readSpotify<T>(
  fetcher: Fetcher,
  url: string,
  isView: (value: unknown) => value is T,
): Promise<SpotifyRead<T>> {
  let res: Response;
  try {
    res = await fetcher(url);
  } catch {
    return { ok: false, trouble: { kind: 'problem', message: UNREACHABLE_LINE } };
  }
  const body = await res.text().catch(() => '');
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    data = undefined;
  }
  if (res.ok && isView(data)) return { ok: true, data };
  if (res.status === 401) return { ok: false, trouble: { kind: 'problem', message: SIGNED_OUT_LINE } };
  if (isRecord(data) && isText(data.error) && data.error.trim()) {
    if (data.reason === 'signin') {
      return { ok: false, trouble: { kind: 'signin', message: data.error, authUrl: isText(data.authUrl) ? data.authUrl : null } };
    }
    return { ok: false, trouble: { kind: 'problem', message: data.error } };
  }
  if (res.ok) return { ok: false, trouble: { kind: 'restart' } };
  return { ok: false, trouble: { kind: 'problem', message: UNREACHABLE_LINE } };
}

export interface SpotifyHome {
  now: SpotifyRead<SpotifyNowView>;
  recent: SpotifyRead<SpotifyRecentView>;
  playlists: SpotifyRead<SpotifyPlaylistsView>;
}

/** The front page's three reads, side by side. */
export async function loadSpotifyHome(fetcher: Fetcher): Promise<SpotifyHome> {
  const [now, recent, playlists] = await Promise.all([
    readSpotify(fetcher, '/api/spotify/now', isNowView),
    readSpotify(fetcher, '/api/spotify/recent', isRecentView),
    readSpotify(fetcher, '/api/spotify/playlists', isPlaylistsView),
  ]);
  return { now, recent, playlists };
}

export function loadSpotifyPlaylist(fetcher: Fetcher, id: string): Promise<SpotifyRead<SpotifyPlaylistTracksView>> {
  return readSpotify(fetcher, `/api/spotify/playlists/${encodeURIComponent(id)}`, isPlaylistTracksView);
}

/**
 * Songs for what the owner typed (Oct 20 2026).
 * Only when the owner asks, never as the owner types, so their server is asked once a search.
 */
export function searchSpotify(fetcher: Fetcher, words: string): Promise<SpotifyRead<SpotifySearchView>> {
  return readSpotify(fetcher, `/api/spotify/search?q=${encodeURIComponent(words.trim())}`, isSearchView);
}

/**
 * The one thing to say instead of the whole front page, when there is one: a
 * restart or a lapsed sign-in is the same news three times, so it is said
 * once. Anything else only stands in for the page when all three failed;
 * otherwise each section says its own.
 */
export function wholeAppTrouble(home: SpotifyHome): SpotifyTrouble | null {
  const reads = [home.now, home.recent, home.playlists];
  const troubles = reads.flatMap((read) => (read.ok === false ? [read.trouble] : []));
  return troubles.find((t) => t.kind === 'restart')
    ?? troubles.find((t) => t.kind === 'signin')
    ?? (troubles.length === reads.length ? troubles[0] : null);
}

/** The sentence a trouble is shown as. */
export function troubleLine(trouble: SpotifyTrouble): string {
  return trouble.kind === 'restart' ? RESTART_LINE : trouble.message;
}

// ─── Telling it ──────────────────────────────────────────────────────

/** How many songs, the way the owner would say it. Empty when Spotify did not say. */
export function songCount(count: number | null | undefined): string {
  if (typeof count !== 'number') return '';
  return count === 1 ? '1 song' : `${count} songs`;
}

/** Recently played as a row of covers: each song once, at its newest play. */
export function recentRow(tracks: SpotifyRecentTrack[]): SpotifyRecentTrack[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = track.uri ?? `${track.name}\u0000${track.artist}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Spotify's 640px picture for an album cover it hands out at 300px (the size
 * oEmbed gives), for the one cover shown big. Null when the address is not one
 * it knows how to size; the big picture then falls back to the cover as given.
 */
export function largerCover(url: string | null | undefined): string | null {
  if (!url) return null;
  const big = url.replace('/image/ab67616d00001e02', '/image/ab67616d0000b273');
  return big === url ? null : big;
}

// ─── Playing ─────────────────────────────────────────────────────────
//
// Since Oct 20 2026, a tap on a
// song plays it, a playlist's Play button plays the whole playlist, and under
// whatever is playing sit previous, play or pause, and next. Those are the
// only presses there are.
//
// A TAPPED SONG STARTS INSIDE SOMETHING (that evening). Every song asked for alone was taken by Spotify and never played
// on their phone, while every playlist did; so a song tapped in a playlist starts
// that playlist at the song, and a recent or searched song starts its album at
// the song, carrying on through the rest. Only a song with neither is asked for
// alone, the way every song used to be.
//
// A PRESS'S ANSWER IS NOT BELIEVED. The owner Spotify server has called a press that
// worked an error (Oct 3 2026), so after every press the phone gives Spotify a
// moment, reads what is playing once, and shows that. A press's sentence is
// shown only when that read does not show what the owner asked for.

/** What the owner pressed. */
export type SpotifyPress =
  /** A song; with `playlistUri` or `albumUri`, that playlist or album started at the song. */
  | { kind: 'song'; uri: string; playlistUri?: string; albumUri?: string }
  /** `songs`: the playlist's own songs when they are on screen, so the look after can tell it is playing. */
  | { kind: 'playlist'; uri: string; songs: string[] | null }
  | { kind: 'resume' }
  | { kind: 'pause' }
  | { kind: 'next' }
  | { kind: 'previous' };

export type SpotifySongPress = Extract<SpotifyPress, { kind: 'song' }>;

export type SpotifyPressResult = { ok: true } | { ok: false; trouble: SpotifyTrouble };

/** What the screen shows after a press. */
export interface SpotifyPressOutcome {
  /** What is playing, read after the press; null when that read did not come back, so the screen keeps what it had. */
  now: SpotifyNowView | null;
  /** The one sentence to show by the button the owner pressed, or null. */
  trouble: SpotifyTrouble | null;
}

/** How long Spotify is given to move before the phone looks. */
export const PRESS_SETTLE_MS = 1500;
/** How long a freshly woken Spotify is given to show up as the owner device before the press goes again. */
export const WAKE_SETTLE_MS = 1200;

type PressFetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** A song the owner can tap: only a Spotify song address, never an episode or a local file. */
export function playableSong(uri: string | null | undefined): uri is string {
  return isPlayableTrackUri(uri);
}

/**
 * The press a tap on a song makes, or null for a song the owner cannot tap: inside
 * the playlist it was tapped in, else inside its album when Spotify said which,
 * else the song alone.
 */
export function songPress(track: { uri: string | null; albumUri?: string | null }, playlistUri: string | null = null): SpotifySongPress | null {
  if (!playableSong(track.uri)) return null;
  if (isPlayablePlaylistUri(playlistUri)) return { kind: 'song', uri: track.uri, playlistUri };
  if (isPlayableAlbumUri(track.albumUri)) return { kind: 'song', uri: track.uri, albumUri: track.albumUri };
  return { kind: 'song', uri: track.uri };
}

/** The address a playlist is played by, or null when it has none the house would pass on. */
export function playlistUriOf(playlist: { id: string; uri: string | null }): string | null {
  const uri = playlist.uri ?? `spotify:playlist:${playlist.id}`;
  return isPlayablePlaylistUri(uri) ? uri : null;
}

/** The song playing right now, for marking its row; null when nothing is (a paused song is not playing). */
export function playingUri(read: SpotifyRead<SpotifyNowView> | null | undefined): string | null {
  return read?.ok && read.data.playing ? read.data.track?.uri ?? null : null;
}

/** Where a press goes in the house, and what it carries. */
export function pressRequest(press: SpotifyPress): { url: string; body: Record<string, string> } {
  switch (press.kind) {
    case 'song': return {
      url: '/api/spotify/play',
      body: press.playlistUri
        ? { trackUri: press.uri, playlistUri: press.playlistUri }
        : press.albumUri ? { trackUri: press.uri, albumUri: press.albumUri } : { trackUri: press.uri },
    };
    case 'playlist': return { url: '/api/spotify/play', body: { playlistUri: press.uri } };
    case 'resume': return { url: '/api/spotify/play', body: {} };
    case 'pause': return { url: '/api/spotify/pause', body: {} };
    case 'next': return { url: '/api/spotify/skip', body: { direction: 'next' } };
    case 'previous': return { url: '/api/spotify/skip', body: { direction: 'previous' } };
  }
}

const PROBLEM_REASONS = new Set<string>(['unset', 'unreachable', 'signin', 'device', 'spotify'] satisfies SpotifyProblemReason[]);

/**
 * One press, shape-checked. Only { ok: true } is a yes, and a refusal is the
 * house's own sentence. A backend from before these routes has no such
 * address: Express answers a POST there with its own 404 page, so anything
 * that is not the house's JSON asks for a restart.
 */
export async function sendPress(fetcher: PressFetcher, press: SpotifyPress): Promise<SpotifyPressResult> {
  const { url, body } = pressRequest(press);
  let res: Response;
  try {
    res = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, trouble: { kind: 'problem', message: UNREACHABLE_LINE } };
  }
  const text = await res.text().catch(() => '');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (res.ok && isRecord(data) && data.ok === true) return { ok: true };
  if (res.status === 401) return { ok: false, trouble: { kind: 'problem', message: SIGNED_OUT_LINE } };
  if (!res.ok && isRecord(data) && isText(data.error) && data.error.trim() && isText(data.reason) && PROBLEM_REASONS.has(data.reason)) {
    if (data.reason === 'signin') {
      return { ok: false, trouble: { kind: 'signin', message: data.error, authUrl: isText(data.authUrl) ? data.authUrl : null } };
    }
    return { ok: false, trouble: { kind: 'problem', message: data.error, ...(data.reason === 'device' ? { device: true } : {}) } };
  }
  if (res.ok || res.status === 404) return { ok: false, trouble: { kind: 'restart' } };
  return { ok: false, trouble: { kind: 'problem', message: UNREACHABLE_LINE } };
}

/** Whether what is playing shows the change the owner pressed for. */
export function pressShows(press: SpotifyPress, before: SpotifyNowView | null, after: SpotifyNowView): boolean {
  const uri = after.track?.uri ?? null;
  const was = before?.track?.uri ?? null;
  switch (press.kind) {
    case 'song':
      return after.playing && uri === press.uri;
    case 'playlist':
      if (!after.playing || uri === null) return false;
      return press.songs?.length ? press.songs.includes(uri) : uri !== was || !before?.playing;
    case 'resume':
      return after.playing;
    case 'pause':
      return !after.playing;
    case 'next':
    case 'previous':
      return uri !== null && uri !== was;
  }
}

/**
 * The whole press: send it, give Spotify a moment, read what is playing once,
 * and decide what to say. `looking` is told just before that read starts, so
 * the screen can tell a newer read from an older one.
 */
export async function pressAndLook(
  fetcher: PressFetcher,
  press: SpotifyPress,
  before: SpotifyNowView | null,
  hooks: { wait?: (ms: number) => Promise<void>; looking?: () => void; wake?: () => Promise<boolean> } = {},
): Promise<SpotifyPressOutcome> {
  const wait = hooks.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result = await sendPress(fetcher, press);
  // Nowhere to play: in the installed app, wake Spotify on their phone and send
  // the press once more (Aerie's spotify-wake.ts; byte-light passes no wake, so
  // this never runs there). Only once, and only when the
  // wake says Spotify is running now.
  if (result.ok === false && result.trouble.kind === 'problem' && result.trouble.device && hooks.wake && await hooks.wake()) {
    await wait(WAKE_SETTLE_MS);
    result = await sendPress(fetcher, press);
  }
  await wait(PRESS_SETTLE_MS);
  hooks.looking?.();
  const look = await readSpotify(fetcher, '/api/spotify/now', isNowView);
  const now = look.ok ? look.data : null;
  if (result.ok === false && !(now && pressShows(press, before, now))) return { now, trouble: result.trouble };
  return { now, trouble: null };
}

// ─── What is playing, kept one way ───────────────────────────────────
//
// The Spotify app and the lock screen's card (Oct 20 2026) both show what is playing and press it,
// through this one keeper, so the two cannot drift: one press at a time, every
// press button waiting while it is out, the one look after it (pressAndLook),
// and a press's sentence only when that look does not show what the owner asked for,
// never on a page the owner has since left. Every read of what is playing is numbered
// as it starts, and an older one never replaces a newer one on screen: the look
// after a press can land before a read that started earlier does.

export interface SpotifyNowState {
  /** The newest read of what is playing to land, or null before the first. */
  read: SpotifyRead<SpotifyNowView> | null;
  /** Where the press that is out was made ('now:pause'), or null. */
  pressing: string | null;
  /** A press's sentence and the button it is shown by, or null. */
  notice: { where: string; trouble: SpotifyTrouble } | null;
}

export interface SpotifyNowKeeper {
  state(): SpotifyNowState;
  /** Told after every change; answers how to stop being told. */
  subscribe(listener: () => void): () => void;
  /** Number a read of what is playing as it starts. */
  begin(): number;
  /** Show a numbered read, unless a newer one already shows. True when it landed. */
  land(look: number, read: SpotifyRead<SpotifyNowView>): boolean;
  /** Read what is playing once, and show it. */
  look(): Promise<void>;
  /** A press, the one way; a second one while it is out is not sent. */
  press(what: SpotifyPress, where: string): Promise<void>;
  /** The owner left the page: a sentence still on its way is not shown, and one showing goes. */
  leave(): void;
  /** Take a press's sentence away (a refresh). */
  quiet(): void;
}

export function createSpotifyNow(
  fetcher: PressFetcher,
  options: { wait?: (ms: number) => Promise<void>; wake?: () => Promise<boolean> } = {},
): SpotifyNowKeeper {
  let state: SpotifyNowState = { read: null, pressing: null, notice: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<SpotifyNowState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };
  let started = 0;
  let shown = 0;
  let out = false;
  let page = 0;
  const begin = () => ++started;
  const land = (look: number, read: SpotifyRead<SpotifyNowView>) => {
    if (look <= shown) return false;
    shown = look;
    set({ read });
    return true;
  };
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin,
    land,
    async look() {
      const look = begin();
      land(look, await readSpotify(fetcher, '/api/spotify/now', isNowView));
    },
    async press(what, where) {
      if (out) return;
      out = true;
      const onPage = page;
      set({ pressing: where, notice: null });
      let look = 0;
      try {
        const current = state.read;
        const before = current?.ok ? current.data : null;
        const outcome = await pressAndLook(fetcher, what, before, {
          wait: options.wait,
          wake: options.wake,
          looking: () => {
            look = begin();
          },
        });
        if (outcome.now) land(look, { ok: true, data: outcome.now });
        if (outcome.trouble && page === onPage) set({ notice: { where, trouble: outcome.trouble } });
      } finally {
        out = false;
        set({ pressing: null });
      }
    },
    leave() {
      page += 1;
      if (state.notice) set({ notice: null });
    },
    quiet() {
      if (state.notice) set({ notice: null });
    },
  };
}
