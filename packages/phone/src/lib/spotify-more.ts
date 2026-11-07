// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The player, their library and their playlists, as the phone reads and presses
// them (Oct 23 2026). Like lib/spotify.ts, nothing in here
// draws, so every decision can be checked without a browser.
//
// These presses do not go through the now-playing keeper's look-after: a
// heart, a rename or a song added to a playlist changes nothing that is
// playing. The app reads again what each one changed (the player, the
// playlist, the heart) and believes that.

import {
  isPlayableTrackUri,
  type SpotifyDevicesView,
  type SpotifyLikedView,
  type SpotifyPlayerView,
  type SpotifyPlaylist,
  type SpotifyPlaylistTracksView,
  type SpotifyRepeatMode,
  type SpotifySavedView,
} from '@bytelight/shared';
import { readSpotify, SIGNED_OUT_LINE, UNREACHABLE_LINE, type SpotifyRead, type SpotifyTrouble } from './spotify';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isNumberOrNull = (value: unknown) => value === null || typeof value === 'number';

function isDevice(value: unknown): boolean {
  return isRecord(value) && isText(value.id) && isText(value.name) && isText(value.type) && typeof value.active === 'boolean' && isNumberOrNull(value.volume);
}

export function isPlayerView(value: unknown): value is SpotifyPlayerView {
  return isRecord(value) && typeof value.active === 'boolean' && typeof value.playing === 'boolean'
    && typeof value.shuffle === 'boolean' && (value.repeat === 'off' || value.repeat === 'track' || value.repeat === 'context')
    && isNumberOrNull(value.volume) && isNumberOrNull(value.progressMs) && isNumberOrNull(value.durationMs)
    && (value.device === null || isDevice(value.device));
}

export function isDevicesView(value: unknown): value is SpotifyDevicesView {
  return isRecord(value) && Array.isArray(value.devices) && value.devices.every(isDevice);
}

function isTrack(value: unknown): boolean {
  return isRecord(value) && isText(value.name) && isText(value.artist) && (value.uri === null || isText(value.uri)) && (value.cover === null || isText(value.cover));
}

export function isLikedView(value: unknown): value is SpotifyLikedView {
  return isRecord(value) && Array.isArray(value.tracks) && value.tracks.every(isTrack);
}

export function isSavedView(value: unknown): value is SpotifySavedView {
  return isRecord(value) && isRecord(value.saved) && Object.values(value.saved).every((v) => typeof v === 'boolean');
}

export const loadPlayer = (fetcher: Fetcher): Promise<SpotifyRead<SpotifyPlayerView>> => readSpotify(fetcher, '/api/spotify/player', isPlayerView);
export const loadDevices = (fetcher: Fetcher): Promise<SpotifyRead<SpotifyDevicesView>> => readSpotify(fetcher, '/api/spotify/devices', isDevicesView);

/** The id their Liked Songs open under, so the playlist page can show them. */
export const LIKED_ID = 'liked';

/** The owner Liked Songs as a page the playlist view can draw. It has no Play button: each song starts its album. */
export const LIKED_PLAYLIST: SpotifyPlaylist = { id: LIKED_ID, name: 'Liked Songs', tracks: null, uri: null, cover: null, mine: false };

/** The owner Liked Songs, shaped as a playlist's songs. */
export async function loadLiked(fetcher: Fetcher): Promise<SpotifyRead<SpotifyPlaylistTracksView>> {
  const read = await readSpotify(fetcher, '/api/spotify/liked', isLikedView);
  if (read.ok === false) return { ok: false, trouble: read.trouble };
  return { ok: true, data: { id: LIKED_ID, tracks: read.data.tracks } };
}

/** Whether these songs are hearted. Only songs are asked about; nothing to ask is an empty yes. */
export async function loadSaved(fetcher: Fetcher, uris: Array<string | null | undefined>): Promise<SpotifyRead<SpotifySavedView>> {
  const songs = [...new Set(uris.filter(isPlayableTrackUri))].slice(0, 50);
  if (!songs.length) return { ok: true, data: { saved: {} } };
  return readSpotify(fetcher, `/api/spotify/saved?uris=${encodeURIComponent(songs.join(','))}`, isSavedView);
}

export type SpotifyActionResult<T = unknown> = { ok: true; data: T } | { ok: false; trouble: SpotifyTrouble };

/**
 * One press of the player, their library or their playlists. Only an answer with
 * ok true is a yes; a refusal is the house's own sentence; a backend from
 * before these routes (no such address) asks for a restart.
 */
export async function sendSpotify(
  fetcher: Fetcher,
  method: 'POST' | 'PATCH' | 'PUT',
  url: string,
  body: unknown,
): Promise<SpotifyActionResult<Record<string, unknown>>> {
  let res: Response;
  try {
    res = await fetcher(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  if (res.ok && isRecord(data) && data.ok === true) return { ok: true, data };
  if (res.status === 401) return { ok: false, trouble: { kind: 'problem', message: SIGNED_OUT_LINE } };
  if (!res.ok && isRecord(data) && isText(data.error) && data.error.trim()) {
    if (data.reason === 'signin') {
      return { ok: false, trouble: { kind: 'signin', message: data.error, authUrl: isText(data.authUrl) ? data.authUrl : null } };
    }
    return { ok: false, trouble: { kind: 'problem', message: data.error } };
  }
  if (res.ok || res.status === 404) return { ok: false, trouble: { kind: 'restart' } };
  return { ok: false, trouble: { kind: 'problem', message: UNREACHABLE_LINE } };
}

/** What each press of theirs sends, in one place. */
export const spotifyActions = {
  like: (uri: string, liked: boolean) => ['POST', '/api/spotify/like', { uri, liked }] as const,
  shuffle: (on: boolean) => ['POST', '/api/spotify/shuffle', { on }] as const,
  repeat: (mode: SpotifyRepeatMode) => ['POST', '/api/spotify/repeat', { mode }] as const,
  volume: (percent: number) => ['POST', '/api/spotify/volume', { percent: Math.max(0, Math.min(100, Math.round(percent))) }] as const,
  seek: (positionMs: number) => ['POST', '/api/spotify/seek', { positionMs: Math.max(0, Math.round(positionMs)) }] as const,
  transfer: (deviceId: string) => ['POST', '/api/spotify/transfer', { deviceId }] as const,
  newPlaylist: (name: string, description = '') => ['POST', '/api/spotify/playlists', description.trim() ? { name, description } : { name }] as const,
  rename: (id: string, name: string, description?: string) => ['PATCH', `/api/spotify/playlists/${encodeURIComponent(id)}`, description === undefined ? { name } : { name, description }] as const,
  add: (id: string, uris: string[]) => ['POST', `/api/spotify/playlists/${encodeURIComponent(id)}/add`, { uris }] as const,
  remove: (id: string, uris: string[]) => ['POST', `/api/spotify/playlists/${encodeURIComponent(id)}/remove`, { uris }] as const,
  move: (id: string, from: number, to: number) => ['POST', `/api/spotify/playlists/${encodeURIComponent(id)}/move`, { from, to }] as const,
  cover: (id: string, image: string) => ['PUT', `/api/spotify/playlists/${encodeURIComponent(id)}/cover`, { image }] as const,
};

/** Repeat's next setting when the owner taps it: off, then the whole playlist or album, then this song, then off. */
export function nextRepeat(mode: SpotifyRepeatMode): SpotifyRepeatMode {
  return mode === 'off' ? 'context' : mode === 'context' ? 'track' : 'off';
}

/** 3:05, or 1:02:09 for something past an hour. */
export function clockOf(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Where the song is now, from the last read and the time since it, without
 * asking Spotify again: a playing song moves on with the clock and stops at
 * its end; a paused one stays where it was read.
 */
export function positionNow(player: Pick<SpotifyPlayerView, 'playing' | 'progressMs' | 'durationMs'>, readAt: number, now: number): number | null {
  if (typeof player.progressMs !== 'number') return null;
  const moved = player.playing ? Math.max(0, now - readAt) : 0;
  const at = player.progressMs + moved;
  return typeof player.durationMs === 'number' ? Math.min(at, player.durationMs) : at;
}

/** Their playlists a song can be added to: only theirs, in their order. */
export function playlistsForAdding(lists: SpotifyPlaylist[] | null | undefined): SpotifyPlaylist[] {
  return (lists ?? []).filter((list) => list.mine === true);
}

/** Where a song can move to in a list of `length`: up and down, never off either end. */
export function moveTargets(index: number, length: number): { up: number | null; down: number | null } {
  return { up: index > 0 ? index - 1 : null, down: index < length - 1 ? index + 1 : null };
}
