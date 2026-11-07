// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify in the house: the shapes /api/spotify/... answers with.
//
// The owner listening, read through the house's Spotify MCP server, with a cover
// picture on everything (GET), and since the owner ask that afternoon ("I want to be
// able to play Spotify stuff", Oct 20 2026) three presses (POST): play a song
// or a playlist or carry on, pause, and skip. Nothing queues, sets the volume
// or seeks. Since Oct 21 2026 a tapped song starts inside its playlist or its
// album and carries on through the rest of it (Oct 20), and the owner can search. The backend (services/spotify.ts) and the phone (lib/spotify.ts)
// code against these, so there is one contract.

/** One song. */
export interface SpotifyTrack {
  name: string;
  /** Every artist on the song, as one line ("Layto, WesGhost"). Empty when the answer named none. */
  artist: string;
  /** spotify:track:<id> (or spotify:episode:<id>), null when the answer carried none. */
  uri: string | null;
  /** Spotify's own cover picture for it, or null when none could be found. */
  cover: string | null;
  /**
   * The album it is on (spotify:album:<id>), when the answer said, so a tap
   * can start that album at this song. The owner recent songs and a search say it;
   * a playlist's songs do not, and are started inside their playlist instead.
   */
  albumUri?: string | null;
}

/** A song from the owner recent listening, with when it played (ISO), if Spotify said. */
export interface SpotifyRecentTrack extends SpotifyTrack {
  playedAt: string | null;
}

/** What is playing now. `album` only when the answer named it. */
export interface SpotifyNowTrack extends SpotifyTrack {
  album: string | null;
}

/** GET /api/spotify/now. A paused song comes back with playing false and the track. */
export interface SpotifyNowView {
  playing: boolean;
  track: SpotifyNowTrack | null;
  /**
   * How far into the song and how long it is, in ms, so the lock screen's card
   * can look again when it should end. Passed on from the owner Spotify server's
   * progress_ms and duration_ms since Oct 21 2026; absent when it did not say
   * (or before the owner backend restart), and then nothing waits on a song's end.
   */
  progressMs?: number | null;
  durationMs?: number | null;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  /** How many songs it holds, when Spotify said. */
  tracks: number | null;
  uri: string | null;
  cover: string | null;
  /**
   * Theirs to change (the owner owns it or it is collaborative), when their server said.
   * Only these are offered for adding songs, renaming, moving and a picture.
   */
  mine?: boolean;
}

/** GET /api/spotify/playlists */
export interface SpotifyPlaylistsView {
  playlists: SpotifyPlaylist[];
}

/** GET /api/spotify/playlists/:id */
export interface SpotifyPlaylistTracksView {
  id: string;
  tracks: SpotifyTrack[];
}

/** GET /api/spotify/recent, newest first. */
export interface SpotifyRecentView {
  tracks: SpotifyRecentTrack[];
}

/** The longest search the owner can send, in letters. */
export const SPOTIFY_SEARCH_LONGEST = 100;

/** GET /api/spotify/search?q=<words>: songs, best match first. `query` is the words as the house read them. */
export interface SpotifySearchView {
  query: string;
  tracks: SpotifyTrack[];
}

// ─── Playing ─────────────────────────────────────────────────────────

/** A Spotify id the way Spotify gives them out: 22 letters and digits (base62). */
const SPOTIFY_ID = '[0-9A-Za-z]{22}';
const TRACK_URI = new RegExp(`^spotify:track:${SPOTIFY_ID}$`);
const PLAYLIST_URI = new RegExp(`^spotify:playlist:${SPOTIFY_ID}$`);
const ALBUM_URI = new RegExp(`^spotify:album:${SPOTIFY_ID}$`);

/** A song the house will ask Spotify to play: spotify:track:<id>, and nothing else. */
export function isPlayableTrackUri(value: unknown): value is string {
  return typeof value === 'string' && TRACK_URI.test(value);
}

/** A playlist the house will ask Spotify to play: spotify:playlist:<id>, and nothing else. */
export function isPlayablePlaylistUri(value: unknown): value is string {
  return typeof value === 'string' && PLAYLIST_URI.test(value);
}

/** An album the house will ask Spotify to play from: spotify:album:<id>, and nothing else. */
export function isPlayableAlbumUri(value: unknown): value is string {
  return typeof value === 'string' && ALBUM_URI.test(value);
}

/**
 * POST /api/spotify/play: one song, one playlist or album, a song with its
 * playlist or album (that playlist or album started at the song, carrying on
 * through the rest of it), or nothing to carry on with what was paused. A
 * playlist and an album together are refused.
 */
export interface SpotifyPlayRequest {
  trackUri?: string;
  playlistUri?: string;
  albumUri?: string;
}

export type SpotifySkipDirection = 'next' | 'previous';

/** POST /api/spotify/skip */
export interface SpotifySkipRequest {
  direction: SpotifySkipDirection;
}

/**
 * What POST /api/spotify/play, /pause and /skip answer when Spotify's server
 * took the press. It is not proof the music changed (their server has said no
 * to a press that worked), so the phone reads what is playing again after
 * every press and believes that.
 */
export interface SpotifyPressAnswer {
  ok: true;
}

/**
 * Why a Spotify read or press did not come back.
 *  - `unset`: the house has no Spotify server switched on (Integrations > MCP).
 *  - `unreachable`: the server could not be reached, or answered nonsense.
 *  - `signin`: Spotify's sign-in on the server has lapsed; only its owner can renew it.
 *  - `device`: a press found nowhere to play: Spotify is not open on any of the owner devices.
 *  - `spotify`: Spotify (or the server) answered with an error of its own.
 */
export type SpotifyProblemReason = 'unset' | 'unreachable' | 'signin' | 'device' | 'spotify';

/** Every Spotify route's answer when it could not read or press: a plain sentence for their screen. */
export interface SpotifyProblem {
  error: string;
  reason: SpotifyProblemReason;
  /** On `signin`, the server's own sign-in page, when the house knows where it is. */
  authUrl?: string | null;
}

// ─── The player, their library and their playlists (Oct 23 2026) ─────────
//
// Since Oct 23 2026, so the owner never has to leave the app:
// hearting songs and their Liked Songs, shuffle, repeat, volume, jumping within
// a song, choosing the device, and building playlists (new, add, remove,
// move, rename, a picture). Each is a press like play: checked at the door,
// answered { ok: true } when their server took it, and the phone reads again.

export type SpotifyRepeatMode = 'off' | 'track' | 'context';

/** GET /api/spotify/player: what the player is doing. `active` false means no device has Spotify going. */
export interface SpotifyPlayerView {
  active: boolean;
  playing: boolean;
  shuffle: boolean;
  repeat: SpotifyRepeatMode;
  /** 0 to 100, or null when the device does not say or cannot be turned up and down. */
  volume: number | null;
  progressMs: number | null;
  durationMs: number | null;
  device: SpotifyDevice | null;
}

export interface SpotifyDevice {
  id: string;
  name: string;
  /** Spotify's word for it: Smartphone, Computer, Speaker, TV... */
  type: string;
  active: boolean;
  volume: number | null;
}

/** GET /api/spotify/devices */
export interface SpotifyDevicesView {
  devices: SpotifyDevice[];
}

/** GET /api/spotify/liked: their Liked Songs, newest first. */
export interface SpotifyLikedView {
  tracks: SpotifyTrack[];
}

/** GET /api/spotify/saved?uris=a,b: whether each song is in their Liked Songs. */
export interface SpotifySavedView {
  saved: Record<string, boolean>;
}

/** The most songs one add or remove takes. */
export const SPOTIFY_TRACKS_AT_ONCE = 100;
/** The longest playlist name and description, in letters. */
export const SPOTIFY_PLAYLIST_NAME_LONGEST = 100;
export const SPOTIFY_PLAYLIST_DESCRIPTION_LONGEST = 300;

/** POST /api/spotify/like */
export interface SpotifyLikeRequest { uri: string; liked: boolean }
/** POST /api/spotify/shuffle */
export interface SpotifyShuffleRequest { on: boolean }
/** POST /api/spotify/repeat */
export interface SpotifyRepeatRequest { mode: SpotifyRepeatMode }
/** POST /api/spotify/volume */
export interface SpotifyVolumeRequest { percent: number }
/** POST /api/spotify/seek */
export interface SpotifySeekRequest { positionMs: number }
/** POST /api/spotify/transfer: play on this device instead. */
export interface SpotifyTransferRequest { deviceId: string }
/** POST /api/spotify/playlists: a new playlist of theirs, private. */
export interface SpotifyNewPlaylistRequest { name: string; description?: string }
/** What a new playlist answers. */
export interface SpotifyNewPlaylistAnswer { ok: true; playlist: SpotifyPlaylist }
/** PATCH /api/spotify/playlists/:id */
export interface SpotifyRenameRequest { name?: string; description?: string }
/** POST /api/spotify/playlists/:id/add and /remove */
export interface SpotifyTracksRequest { uris: string[] }
/** POST /api/spotify/playlists/:id/move: the song at `from` goes to sit at `to` (0-based, as the list reads now). */
export interface SpotifyMoveRequest { from: number; to: number }
/** PUT /api/spotify/playlists/:id/cover: a picture as a data URL; the house makes it the JPEG Spotify takes. */
export interface SpotifyCoverRequest { image: string }

/**
 * GET /api/spotify/connect: what the phone app needs to wake Spotify on the owner's
 * phone itself (Spotify's App Remote kit, Oct 23 2026): the Spotify app's client id and a redirect address registered to
 * it. Neither is a secret; both are read off the worker's own sign-in page.
 */
export interface SpotifyConnectView {
  clientId: string;
  redirectUri: string;
}
