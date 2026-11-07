// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify in the house (Oct 20 2026).
//
// The owner's listening is read through the Spotify MCP server the house already has
// in Integrations > MCP, one plain JSON-RPC tools/call per read, and every
// item gets a cover. Three presses go through the same server: play (a song,
// a playlist, a song inside its playlist or album, or carry on), pause, and
// skip. Nothing queues, sets the volume or seeks. See "Playing" below for why a
// press's answer is not believed. Search (Oct 20 2026) reads songs through the same server's spotify_search.
//
// THE SERVER STRIPS IMAGES, so covers come from Spotify's public oEmbed page
// (open.spotify.com/oembed, no key), which answers a thumbnail_url for a
// track, album or playlist. Covers are remembered by uri, in memory and in
// data/spotify-covers.json, and looked up a few at a time with a short timeout
// and a budget per list: a slow or failed cover leaves that one item without a
// picture and never fails the list. A playlist's cover is its mosaic, which
// changes as the owner edits it, so it is re-asked daily; a song's cover is kept a
// month. A miss is remembered for a day; a timeout is not remembered at all.
//
// Measured against their server on Oct 20 2026: tools/call answers without an
// initialize handshake, as plain JSON (SSE is handled too), and an error comes
// back as a JSON-RPC error whose message carries Spotify's own words. A lapsed
// sign-in said 'Refresh token expired' / 'revoked' (Sep 25 2026); its fix is
// the owner's, on the server, so here it only becomes a plain sentence.

import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  isPlayableAlbumUri,
  isPlayablePlaylistUri,
  isPlayableTrackUri,
  SPOTIFY_PLAYLIST_DESCRIPTION_LONGEST,
  SPOTIFY_PLAYLIST_NAME_LONGEST,
  SPOTIFY_SEARCH_LONGEST,
  SPOTIFY_TRACKS_AT_ONCE,
  type SpotifyConnectView,
  type SpotifyDevice,
  type SpotifyDevicesView,
  type SpotifyLikedView,
  type SpotifyMoveRequest,
  type SpotifyNewPlaylistAnswer,
  type SpotifyNewPlaylistRequest,
  type SpotifyPlayerView,
  type SpotifyRenameRequest,
  type SpotifyRepeatMode,
  type SpotifySavedView,
  type SpotifyNowTrack,
  type SpotifyNowView,
  type SpotifyPlayRequest,
  type SpotifyPlaylist,
  type SpotifyPlaylistTracksView,
  type SpotifyPlaylistsView,
  type SpotifyPressAnswer,
  type SpotifyProblem,
  type SpotifyProblemReason,
  type SpotifyRecentTrack,
  type SpotifyRecentView,
  type SpotifySearchView,
  type SpotifySkipDirection,
  type SpotifyTrack,
} from '@bytelight/shared';
import { getBytelightConfig, PROJECT_ROOT } from '../config.js';
import { atomicWrite } from './heartbeat/atomic-write.js';
import { listMcpServers, type McpServerRow } from './db/mcp-servers.js';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface SpotifyServer {
  url: string;
  apiKey: string | null;
}

/** A read or press that could not come back, carrying the sentence their screen shows. */
export class SpotifyError extends Error {
  constructor(
    readonly reason: SpotifyProblemReason,
    message: string,
    readonly authUrl: string | null = null,
    /** What the server actually said, for the log only; never sent to the phone. */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'SpotifyError';
  }

  toProblem(): SpotifyProblem {
    return this.reason === 'signin'
      ? { error: this.message, reason: this.reason, authUrl: this.authUrl }
      : { error: this.message, reason: this.reason };
  }
}

// ─── Where the server is ─────────────────────────────────────────────

/**
 * byte-light adaptation: the owner can name her Spotify server outright, by its
 * id or its name in Integrations > MCP, with `integrations.spotify_server` in
 * bytelight.yaml (e.g. "Jukebox", whose name does not say Spotify).
 * Unset (the default) is null, and the auto-detect below is all there is.
 */
export function configuredSpotifyServer(): string | null {
  try {
    const chosen = getBytelightConfig().integrations.spotify_server;
    return typeof chosen === 'string' && chosen.trim() ? chosen.trim() : null;
  } catch {
    return null;
  }
}

let warnedMissing: string | null = null;

/**
 * The house's Spotify server, from its own MCP list, so no address lives in
 * this file. One that is switched off there is respected, and said so.
 * A server chosen by id or name (configuredSpotifyServer) is asked first; when
 * no server answers to that choice, the auto-detect by 'spotify' in the name
 * or address is the fallback.
 */
export function findSpotifyServer(
  rows: McpServerRow[] = listMcpServers(),
  chosen: string | null = configuredSpotifyServer(),
): SpotifyServer | SpotifyError {
  if (chosen) {
    const wanted = chosen.trim().toLowerCase();
    const picked = rows.find((row) => String(row.id) === wanted || (row.name ?? '').trim().toLowerCase() === wanted);
    if (picked) {
      if (Boolean(picked.enabled) && typeof picked.url === 'string' && picked.url.trim()) {
        return { url: picked.url.trim(), apiKey: picked.api_key?.trim() || null };
      }
      return new SpotifyError('unset', `The Spotify server "${picked.name}" is switched off in Integrations > MCP.`);
    }
    if (warnedMissing !== chosen) {
      warnedMissing = chosen;
      console.warn(`[spotify] no MCP server has the id or name "${chosen}" (integrations.spotify_server); looking for one named Spotify instead`);
    }
  }
  const spotify = rows.filter((row) => /spotify/i.test(`${row.name} ${row.url}`));
  const on = spotify.find((row) => Boolean(row.enabled) && typeof row.url === 'string' && row.url.trim());
  if (on) return { url: on.url.trim(), apiKey: on.api_key?.trim() || null };
  return new SpotifyError(
    'unset',
    spotify.length
      ? 'The Spotify server is switched off in Integrations > MCP.'
      : 'The house has no Spotify server yet. Add one in Integrations > MCP.',
  );
}

/**
 * The sign-in page of a Spotify worker. Only a Cloudflare worker is known to
 * have one at /auth. A locked worker (1.2.0) opens /auth only for
 * its own key, so a key on the server's address is carried onto the page.
 */
export function signInPageOf(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'https:' || !/\.workers\.dev$/i.test(url.hostname)) return null;
    const page = new URL('/auth', url);
    const key = url.searchParams.get('key');
    if (key) page.searchParams.set('key', key);
    return page.toString();
  } catch {
    return null;
  }
}

/** The server's address with its key on it, so the sign-in page built from it opens. */
export function keyedAddress(serverUrl: string, apiKey: string | null): string {
  if (!apiKey) return serverUrl;
  try {
    const url = new URL(serverUrl);
    url.searchParams.set('key', apiKey);
    return url.toString();
  } catch {
    return serverUrl;
  }
}

// ─── Reading the server's answer ─────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The JSON-RPC answer in a response body: plain JSON, or a text/event-stream
 * whose events carry it in `data:` lines. A stream can carry notifications
 * first, so the first event with a result or an error is the answer.
 */
export function rpcAnswerOf(body: string): Record<string, unknown> | null {
  const text = body.trim();
  if (!text) return null;
  const whole = tryJson(text);
  if (isRecord(whole)) return whole;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    const message = tryJson(data);
    if (isRecord(message) && ('result' in message || 'error' in message)) return message;
  }
  return null;
}

/** A tool's answer: its structured content if it has some, else its text blocks, parsed as JSON where they are JSON. */
function toolValueOf(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (Array.isArray(result.content) ? result.content : [])
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
  const parsed = tryJson(text);
  return parsed === undefined ? text : parsed;
}

const SIGNED_OUT =
  /refresh token|invalid_grant|revoked|token (?:has )?expired|expired token|access token|\b401\b|unauthori[sz]ed|not authenticated|re-?authori[sz]e|sign(?:ed)?[ -]?in again/i;

const MISSING_SCOPE = /insufficient (?:client )?scope/i;

/** Spotify's own words out of an error, e.g. "Invalid base62 id" out of 'Spotify API error (400): {...}'. */
export function spotifyWordsIn(text: string): string {
  const braces = text.indexOf('{');
  if (braces >= 0) {
    const inner = tryJson(text.slice(braces));
    if (isRecord(inner)) {
      const error = inner.error;
      const words = isRecord(error)
        ? error.message
        : inner.error_description ?? inner.message ?? error;
      if (typeof words === 'string' && words.trim()) return words.trim().slice(0, 200);
    }
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** The sentence an error from the server becomes. */
export function problemFrom(text: string, serverUrl: string | null): SpotifyError {
  // A permission the sign-in never granted (hearts and playlist pictures came
  // with worker 1.1.0, Oct 23 2026): signing in again grants it.
  if (MISSING_SCOPE.test(text)) {
    const page = serverUrl ? signInPageOf(serverUrl) : null;
    return new SpotifyError(
      'signin',
      page
        ? 'Spotify needs one more yes for that. Open the sign-in page, say yes to Spotify, and try again.'
        : "Spotify needs the house's Spotify server signed in again, with every permission, for that.",
      page,
    );
  }
  if (SIGNED_OUT.test(text)) {
    const page = serverUrl ? signInPageOf(serverUrl) : null;
    return new SpotifyError(
      'signin',
      page
        ? "Spotify's sign-in on the Spotify worker has lapsed. Open its sign-in page and say yes to Spotify. (A worker older than 1.1.0 also wants the token it shows you put into its settings on Cloudflare.)"
        : "Spotify's sign-in on the house's Spotify server has lapsed, and it has to be signed in to Spotify again.",
      page,
    );
  }
  const words = spotifyWordsIn(text) || 'something went wrong';
  return new SpotifyError('spotify', `Spotify answered with an error: ${words}${/[.!?]$/.test(words) ? '' : '.'}`);
}

// ─── Reading what Spotify said ───────────────────────────────────────

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** "Layto, WesGhost" out of a string, a list of names, or a list of artist objects. */
function artistsOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const list = Array.isArray(value) ? value : isRecord(value) ? [value] : [];
  return list
    .map((artist) => (typeof artist === 'string' ? artist.trim() : isRecord(artist) ? text(artist.name) ?? '' : ''))
    .filter(Boolean)
    .join(', ');
}

const COVER_KINDS = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist']);

/** spotify:<kind>:<id> from a uri or an open.spotify.com link, or null for anything else. */
export function spotifyUriOf(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /^spotify:([a-z]+):([A-Za-z0-9]{1,64})$/.exec(raw)
    ?? /^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?([a-z]+)\/([A-Za-z0-9]{1,64})(?:[/?#].*)?$/.exec(raw);
  return match && COVER_KINDS.has(match[1]) ? `spotify:${match[1]}:${match[2]}` : null;
}

/** A picture the answer already carried (Spotify's own `images`), when it did. */
function imageIn(value: unknown): string | null {
  const images = isRecord(value) ? value.images : null;
  if (!Array.isArray(images)) return null;
  for (const image of images) {
    const url = isRecord(image) ? text(image.url) : null;
    if (url && /^https:\/\//i.test(url)) return url;
  }
  return null;
}

function listIn(value: unknown, ...keys: string[]): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    for (const key of keys) if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return null;
}

/** spotify:album:<id> out of an address, or null when it is not an album's. */
function albumUriOf(value: unknown): string | null {
  const uri = spotifyUriOf(value);
  return uri?.startsWith('spotify:album:') ? uri : null;
}

/**
 * One song, from the server's {track, artist, uri, album_uri} or Spotify's own
 * {name, artists, album} shape (a search answers Spotify's own, unshaped).
 */
function trackOf(value: unknown): Required<SpotifyTrack> & { album: string | null; playedAt: string | null } | null {
  if (!isRecord(value)) return null;
  const inner = isRecord(value.track) ? value.track : isRecord(value.item) ? value.item : value;
  const name = text(inner.name) ?? text(value.track) ?? text(inner.title);
  if (!name) return null;
  const album = isRecord(inner.album) ? text(inner.album.name) : text(inner.album) ?? text(value.album);
  const links = isRecord(inner.external_urls) ? inner.external_urls.spotify : null;
  return {
    name,
    artist: artistsOf(inner.artists ?? inner.artist ?? value.artists ?? value.artist),
    uri: spotifyUriOf(inner.uri) ?? spotifyUriOf(value.uri) ?? spotifyUriOf(links) ?? spotifyUriOf(inner.url ?? value.url),
    cover: imageIn(inner.album) ?? imageIn(inner),
    albumUri: albumUriOf(isRecord(inner.album) ? inner.album.uri : null) ?? albumUriOf(inner.album_uri) ?? albumUriOf(value.album_uri),
    album,
    playedAt: text(value.played_at) ?? text(value.playedAt),
  };
}

/** A length of time in ms as their server says one, or null for anything that is not a plain one. */
function ms(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** The server answered in words where a list was due: those words are its answer. */
function unexpected(value: unknown, serverUrl: string | null): SpotifyError {
  if (typeof value === 'string' && value.trim()) return problemFrom(value, serverUrl);
  return new SpotifyError('unreachable', "Spotify's server answered in a way the house could not read.");
}

export function readNow(value: unknown, serverUrl: string | null = null): SpotifyNowView {
  if (typeof value === 'string' && /nothing|not playing|no track|no song/i.test(value)) return { playing: false, track: null };
  if (!isRecord(value)) throw unexpected(value, serverUrl);
  const found = trackOf(value);
  const track: SpotifyNowTrack | null = found
    ? { name: found.name, artist: found.artist, uri: found.uri, cover: found.cover, album: found.album }
    : null;
  const view: SpotifyNowView = { playing: value.playing === true || value.is_playing === true, track };
  // How far in and how long, so the lock screen's card can look again when the
  // song should end: passed on only when their server said them plainly.
  if (track) {
    const item = isRecord(value.item) ? value.item : null;
    const progressMs = ms(value.progress_ms ?? value.progressMs);
    const durationMs = ms(value.duration_ms ?? value.durationMs ?? item?.duration_ms);
    if (progressMs !== null) view.progressMs = progressMs;
    if (durationMs !== null && durationMs > 0) view.durationMs = durationMs;
  }
  return view;
}

export function readPlaylists(value: unknown, serverUrl: string | null = null): { items: SpotifyPlaylist[]; raw: unknown[] } {
  const raw = listIn(value, 'playlists', 'items');
  if (!raw) throw unexpected(value, serverUrl);
  const items: SpotifyPlaylist[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const uri = spotifyUriOf(entry.uri);
    const id = text(entry.id) ?? (uri?.startsWith('spotify:playlist:') ? uri.slice('spotify:playlist:'.length) : null);
    if (!id || !/^[A-Za-z0-9]{1,64}$/.test(id)) continue;
    const tracks = isRecord(entry.tracks) ? count(entry.tracks.total) : isRecord(entry.items) ? count(entry.items.total) : count(entry.tracks);
    items.push({
      id,
      name: text(entry.name) ?? 'Untitled playlist',
      tracks,
      uri: uri ?? `spotify:playlist:${id}`,
      cover: imageIn(entry),
      ...(typeof entry.mine === 'boolean' ? { mine: entry.mine } : {}),
    });
  }
  return { items, raw };
}

export function readTracks(value: unknown, serverUrl: string | null = null): { items: SpotifyRecentTrack[]; raw: unknown[] } {
  const raw = listIn(value, 'tracks', 'items');
  if (!raw) throw unexpected(value, serverUrl);
  const items: SpotifyRecentTrack[] = [];
  for (const entry of raw) {
    const track = trackOf(entry);
    if (!track) continue;
    const item: SpotifyRecentTrack = { name: track.name, artist: track.artist, uri: track.uri, cover: track.cover, playedAt: track.playedAt };
    // The album rides along only when the answer named one, so a tap can start it at this song.
    if (track.albumUri) item.albumUri = track.albumUri;
    items.push(item);
  }
  return { items, raw };
}

function readDevice(value: unknown): SpotifyDevice | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const volume = count(value.volume_percent);
  return {
    id,
    name: text(value.name) ?? 'A device',
    type: text(value.type) ?? 'Device',
    active: value.is_active === true || value.active === true,
    volume: volume === null ? null : Math.min(100, volume),
  };
}

/** What spotify_player_state answered, as the phone reads it. */
export function readPlayer(value: unknown, serverUrl: string | null = null): SpotifyPlayerView {
  if (!isRecord(value)) throw unexpected(value, serverUrl);
  const idle: SpotifyPlayerView = { active: false, playing: false, shuffle: false, repeat: 'off', volume: null, progressMs: null, durationMs: null, device: null };
  if (value.active !== true) return idle;
  const device = isRecord(value.device) ? readDevice({ ...value.device, is_active: true }) : null;
  const repeat = value.repeat === 'track' || value.repeat === 'context' ? value.repeat : 'off';
  const supportsVolume = !isRecord(value.device) || value.device.supports_volume !== false;
  return {
    active: true,
    playing: value.playing === true,
    shuffle: value.shuffle === true,
    repeat,
    volume: supportsVolume ? device?.volume ?? null : null,
    progressMs: ms(value.progress_ms),
    durationMs: ms(value.duration_ms),
    device,
  };
}

/** The client id and redirect out of a redirect to Spotify's own sign-in, or null. */
export function connectViewFrom(location: string | null): SpotifyConnectView | null {
  if (!location) return null;
  try {
    const url = new URL(location);
    if (url.hostname !== 'accounts.spotify.com') return null;
    const clientId = url.searchParams.get('client_id') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    if (!/^[0-9a-f]{32}$/i.test(clientId) || !/^https?:\/\//i.test(redirectUri)) return null;
    return { clientId, redirectUri };
  } catch {
    return null;
  }
}

/** What spotify_devices answered: the owner devices, the one playing first. */
export function readDevices(value: unknown, serverUrl: string | null = null): SpotifyDevicesView {
  const raw = Array.isArray(value) ? value : listIn(value, 'devices');
  if (!raw) throw unexpected(value, serverUrl);
  const devices = raw.map(readDevice).filter((d): d is SpotifyDevice => d !== null);
  devices.sort((a, b) => Number(b.active) - Number(a.active));
  return { devices };
}

/** What spotify_is_saved answered: a yes or no for each song asked about. */
export function readSaved(value: unknown, uris: string[], serverUrl: string | null = null): SpotifySavedView {
  if (!isRecord(value)) throw unexpected(value, serverUrl);
  return { saved: Object.fromEntries(uris.map((uri) => [uri, value[uri] === true])) };
}

// ─── Playing ─────────────────────────────────────────────────────────
//
// A press plays on whichever device the owner Spotify is active on (usually the owner
// phone with the Spotify app open); with none, Spotify refuses, and that
// becomes one sentence telling the owner what to do.
//
// A PRESS'S ANSWER IS NOT BELIEVED. Their server reads Spotify's answers as
// JSON and some of Spotify's answers are not JSON, so a press that worked can
// come back as an error (Oct 3 2026: a queued song played while the tool said
// "Unexpected token 'J', ... is not valid JSON"), and a yes can come back
// before the music moves. So these answers only say what the server said; the
// phone reads what is playing again after every press and shows that, and a
// press's error is shown only when that read does not show the change. Every
// press, with what the server answered, goes to the log, so their first real
// press can be read afterwards.

const NO_DEVICE = /no active device|NO_ACTIVE_DEVICE|device not found|no (?:available |active )?devices? (?:found|available)/i;
/** Their server failing to read Spotify's own answer: what happened is unknown, not refused. */
const ANSWER_UNREAD = /not valid JSON|Unexpected end of JSON input|in JSON at position/i;

export const NO_DEVICE_LINE = 'Open Spotify on your phone first, then try again.';
export const UNSURE_LINE = "Spotify's server could not tell whether that worked.";

/** The sentence an error from a press becomes. */
export function pressProblemFrom(text: string, serverUrl: string | null): SpotifyError {
  if (NO_DEVICE.test(text)) return new SpotifyError('device', NO_DEVICE_LINE, null, text);
  if (ANSWER_UNREAD.test(text)) return new SpotifyError('spotify', UNSURE_LINE, null, text);
  const problem = problemFrom(text, serverUrl);
  return new SpotifyError(problem.reason, problem.message, problem.authUrl, text);
}

/** A press as the phone sent it, checked, or the plain sentence it is refused with. */
export type PressRequest<T> = { ok: true; value: T } | { ok: false; error: string };

/** The fields a request body carries, or null when it is not a plain object of fields. */
function fieldsOf(body: unknown): Record<string, unknown> | null {
  if (body === undefined) return {};
  return isRecord(body) ? body : null;
}

const PLAY_FIELDS = new Set(['trackUri', 'playlistUri', 'albumUri']);

/**
 * POST /api/spotify/play's body: a song, a playlist or an album, a song with
 * its playlist or album (started at that song), or nothing (carry on).
 * Anything else is refused, never passed on.
 */
export function readPlayRequest(body: unknown): PressRequest<SpotifyPlayRequest> {
  const fields = fieldsOf(body);
  if (!fields || Object.keys(fields).some((key) => !PLAY_FIELDS.has(key))) {
    return { ok: false, error: 'Play takes a song, a playlist or an album, and nothing else.' };
  }
  const { trackUri, playlistUri, albumUri } = fields;
  if (playlistUri !== undefined && albumUri !== undefined) {
    return { ok: false, error: 'Play takes a playlist or an album, not both.' };
  }
  const value: SpotifyPlayRequest = {};
  if (trackUri !== undefined) {
    if (!isPlayableTrackUri(trackUri)) return { ok: false, error: 'That is not a Spotify song.' };
    value.trackUri = trackUri;
  }
  if (playlistUri !== undefined) {
    if (!isPlayablePlaylistUri(playlistUri)) return { ok: false, error: 'That is not a Spotify playlist.' };
    value.playlistUri = playlistUri;
  }
  if (albumUri !== undefined) {
    if (!isPlayableAlbumUri(albumUri)) return { ok: false, error: 'That is not a Spotify album.' };
    value.albumUri = albumUri;
  }
  return { ok: true, value };
}

/** GET /api/spotify/search's words: what the owner typed, spaces tidied, never empty and never past the longest. */
export function readSearchQuery(raw: unknown): PressRequest<string> {
  const words = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!words) return { ok: false, error: 'Search needs something to look for.' };
  if (words.length > SPOTIFY_SEARCH_LONGEST) {
    return { ok: false, error: `Search takes at most ${SPOTIFY_SEARCH_LONGEST} letters.` };
  }
  return { ok: true, value: words };
}

/** POST /api/spotify/skip's body: next or previous, and nothing else. */
export function readSkipRequest(body: unknown): PressRequest<SpotifySkipDirection> {
  const fields = fieldsOf(body);
  const direction = fields?.direction;
  if (!fields || Object.keys(fields).some((key) => key !== 'direction') || (direction !== 'next' && direction !== 'previous')) {
    return { ok: false, error: 'Skip goes to the next song or the previous one, and nothing else.' };
  }
  return { ok: true, value: direction };
}

/** POST /api/spotify/pause takes nothing. */
export function readPauseRequest(body: unknown): PressRequest<null> {
  const fields = fieldsOf(body);
  return fields && Object.keys(fields).length === 0
    ? { ok: true, value: null }
    : { ok: false, error: 'Pause takes nothing.' };
}

// ─── Their library, the player and their playlists (Oct 23 2026) ────────

const TRACK_ONLY = 'That is not a Spotify song.';

/** POST /api/spotify/like: one song, hearted or not. */
export function readLikeRequest(body: unknown): PressRequest<{ uri: string; liked: boolean }> {
  const fields = fieldsOf(body);
  if (!fields || Object.keys(fields).some((key) => key !== 'uri' && key !== 'liked') || typeof fields.liked !== 'boolean') {
    return { ok: false, error: 'A heart takes one song and whether it is liked, and nothing else.' };
  }
  if (!isPlayableTrackUri(fields.uri)) return { ok: false, error: TRACK_ONLY };
  return { ok: true, value: { uri: fields.uri, liked: fields.liked } };
}

/** GET /api/spotify/saved?uris=a,b: songs only, at most fifty. */
export function readSavedQuery(raw: unknown): PressRequest<string[]> {
  const uris = typeof raw === 'string' ? [...new Set(raw.split(',').map((u) => u.trim()).filter(Boolean))] : [];
  if (!uris.length) return { ok: false, error: 'Ask about at least one song.' };
  if (uris.length > 50) return { ok: false, error: 'Ask about fifty songs at most.' };
  if (!uris.every(isPlayableTrackUri)) return { ok: false, error: TRACK_ONLY };
  return { ok: true, value: uris };
}

function onlyField<T>(body: unknown, key: string, check: (value: unknown) => value is T, error: string): PressRequest<T> {
  const fields = fieldsOf(body);
  if (!fields || Object.keys(fields).some((k) => k !== key) || !check(fields[key])) return { ok: false, error };
  return { ok: true, value: fields[key] as T };
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isRepeat = (value: unknown): value is SpotifyRepeatMode => value === 'off' || value === 'track' || value === 'context';
const isPercent = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
const isPosition = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 24 * 60 * 60 * 1000;
const isDeviceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value);

export const readShuffleRequest = (body: unknown) => onlyField(body, 'on', isBoolean, 'Shuffle is on or off, and nothing else.');
export const readRepeatRequest = (body: unknown) => onlyField(body, 'mode', isRepeat, 'Repeat is off, the song, or the playlist or album, and nothing else.');
export const readVolumeRequest = (body: unknown) => onlyField(body, 'percent', isPercent, 'Volume is a whole number from 0 to 100.');
export const readSeekRequest = (body: unknown) => onlyField(body, 'positionMs', isPosition, 'A place in the song is a whole number of milliseconds.');
export const readTransferRequest = (body: unknown) => onlyField(body, 'deviceId', isDeviceId, 'That is not one of the owner Spotify devices.');

function words(value: unknown, longest: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= longest ? flat : null;
}

/** POST /api/spotify/playlists: a name, and a description if the owner likes. */
export function readNewPlaylistRequest(body: unknown): PressRequest<SpotifyNewPlaylistRequest> {
  const fields = fieldsOf(body);
  if (!fields || Object.keys(fields).some((key) => key !== 'name' && key !== 'description')) {
    return { ok: false, error: 'A new playlist takes a name and a description, and nothing else.' };
  }
  const name = words(fields.name, SPOTIFY_PLAYLIST_NAME_LONGEST);
  if (!name) return { ok: false, error: `A playlist needs a name, ${SPOTIFY_PLAYLIST_NAME_LONGEST} letters at most.` };
  const description = words(fields.description, SPOTIFY_PLAYLIST_DESCRIPTION_LONGEST);
  if (description === null) return { ok: false, error: `A description is ${SPOTIFY_PLAYLIST_DESCRIPTION_LONGEST} letters at most.` };
  return { ok: true, value: description ? { name, description } : { name } };
}

/** PATCH /api/spotify/playlists/:id: a new name, a new description, or both. */
export function readRenameRequest(body: unknown): PressRequest<SpotifyRenameRequest> {
  const fields = fieldsOf(body);
  if (!fields || Object.keys(fields).some((key) => key !== 'name' && key !== 'description')) {
    return { ok: false, error: 'A playlist can change its name and its description, and nothing else here.' };
  }
  const name = words(fields.name, SPOTIFY_PLAYLIST_NAME_LONGEST);
  const description = words(fields.description, SPOTIFY_PLAYLIST_DESCRIPTION_LONGEST);
  if (name === null || name === '') return { ok: false, error: `A playlist needs a name, ${SPOTIFY_PLAYLIST_NAME_LONGEST} letters at most.` };
  if (description === null) return { ok: false, error: `A description is ${SPOTIFY_PLAYLIST_DESCRIPTION_LONGEST} letters at most.` };
  if (name === undefined && description === undefined) return { ok: false, error: 'Give it a new name or a new description.' };
  return { ok: true, value: { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) } };
}

/** POST /api/spotify/playlists/:id/add and /remove: songs only. */
export function readTracksRequest(body: unknown): PressRequest<string[]> {
  const fields = fieldsOf(body);
  const uris = fields?.uris;
  if (!fields || Object.keys(fields).some((key) => key !== 'uris') || !Array.isArray(uris) || uris.length === 0) {
    return { ok: false, error: 'This takes a list of songs, and nothing else.' };
  }
  if (uris.length > SPOTIFY_TRACKS_AT_ONCE) return { ok: false, error: `${SPOTIFY_TRACKS_AT_ONCE} songs at a time at most.` };
  if (!uris.every(isPlayableTrackUri)) return { ok: false, error: TRACK_ONLY };
  return { ok: true, value: [...new Set(uris as string[])] };
}

/** POST /api/spotify/playlists/:id/move: from one place in the list to another. */
export function readMoveRequest(body: unknown): PressRequest<SpotifyMoveRequest> {
  const fields = fieldsOf(body);
  const ok = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 100_000;
  if (!fields || Object.keys(fields).some((key) => key !== 'from' && key !== 'to') || !ok(fields.from) || !ok(fields.to)) {
    return { ok: false, error: 'A move takes where the song is and where it goes, as places in the list.' };
  }
  if (fields.from === fields.to) return { ok: false, error: 'That song is already there.' };
  return { ok: true, value: { from: fields.from as number, to: fields.to as number } };
}

/** The most bytes a picture the owner hands in may be before it is made small. */
const COVER_IN_LARGEST = 8 * 1024 * 1024;
/** Spotify's own ceiling: 256 KB of base64. */
const COVER_OUT_LARGEST = 256 * 1024;

/** PUT /api/spotify/playlists/:id/cover: one picture, as a data URL. */
export function readCoverRequest(body: unknown): PressRequest<Buffer> {
  const fields = fieldsOf(body);
  const image = fields?.image;
  if (!fields || Object.keys(fields).some((key) => key !== 'image') || typeof image !== 'string') {
    return { ok: false, error: 'A playlist picture takes one picture, and nothing else.' };
  }
  const match = /^data:image\/(?:jpeg|jpg|png|webp|gif|heic|heif|avif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(image);
  if (!match) return { ok: false, error: 'That is not a picture the house can read.' };
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length) return { ok: false, error: 'That picture is empty.' };
  if (bytes.length > COVER_IN_LARGEST) return { ok: false, error: 'That picture is over 8 MB.' };
  return { ok: true, value: bytes };
}

/**
 * Any picture made into what Spotify takes for a playlist: a square JPEG whose
 * base64 is 256 KB at most. Squared from the middle, then the quality comes
 * down until it fits.
 */
export async function coverJpegBase64(image: Buffer): Promise<string> {
  const { default: sharp } = await import('sharp');
  for (const [size, quality] of [[640, 85], [640, 72], [512, 70], [400, 60], [300, 55]] as const) {
    const jpeg = await sharp(image, { failOn: 'none' }).rotate().resize(size, size, { fit: 'cover', position: 'attention' }).flatten({ background: '#000000' }).jpeg({ quality, mozjpeg: true }).toBuffer();
    const base64 = jpeg.toString('base64');
    if (base64.length <= COVER_OUT_LARGEST) return base64;
  }
  throw new SpotifyError('spotify', 'That picture would not come down small enough for Spotify.');
}

function clip(words: string): string {
  const flat = words.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

// ─── The reader ──────────────────────────────────────────────────────

export interface SpotifyDeps {
  fetch?: Fetcher;
  server?: () => SpotifyServer | SpotifyError;
  /** Where covers are kept between restarts; null keeps them in memory only. */
  coverFile?: string | null;
  now?: () => number;
  /** How long one cover lookup may take. */
  lookupTimeoutMs?: number;
  /** How long a list waits for its covers before going out with what it has. */
  coverBudgetMs?: number;
  /** Where a press's line goes (what was pressed, what the server answered). */
  log?: (line: string) => void;
}

const MCP_TIMEOUT_MS = 15_000;
const LOOKUP_TIMEOUT_MS = 4_000;
const COVER_BUDGET_MS = 6_000;
const LOOKUPS_AT_ONCE = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const SONG_COVER_KEPT_MS = 30 * DAY_MS;
const PLAYLIST_COVER_KEPT_MS = DAY_MS;
const MISS_KEPT_MS = DAY_MS;
const MOST_COVERS_KEPT = 3000;
const PAGE = 50;
const MOST_PLAYLISTS = 200;
const MOST_PLAYLIST_TRACKS = 500;
/** The owner Liked Songs, newest first, as far as this. */
const MOST_LIKED = 500;
const RECENT = 20;
/** Songs a search asks for: their server's own default. */
const SEARCH_RESULTS = 10;

interface CoverEntry {
  cover: string | null;
  at: number;
}

export function defaultCoverFile(): string {
  try {
    return join(dirname(getBytelightConfig().server.db_path), 'spotify-covers.json');
  } catch {
    return join(PROJECT_ROOT, 'data', 'spotify-covers.json');
  }
}

function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

export function createSpotify(deps: SpotifyDeps = {}) {
  const doFetch: Fetcher = deps.fetch ?? ((url, init) => fetch(url, init));
  const whereIsServer = deps.server ?? (() => findSpotifyServer());
  const coverFile = deps.coverFile === undefined ? defaultCoverFile() : deps.coverFile;
  const clock = deps.now ?? Date.now;
  const lookupTimeoutMs = deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  const coverBudgetMs = deps.coverBudgetMs ?? COVER_BUDGET_MS;
  const log = deps.log ?? ((line: string) => console.log(line));

  // ── The server ──

  async function call(
    tool: string,
    args: Record<string, unknown>,
    problemOf: (text: string, serverUrl: string | null) => SpotifyError = problemFrom,
  ): Promise<{ value: unknown; serverUrl: string }> {
    const server = whereIsServer();
    if (server instanceof SpotifyError) throw server;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (server.apiKey) headers.Authorization = `Bearer ${server.apiKey}`;
    let status: number;
    let body: string;
    try {
      const res = await doFetch(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
        signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
      });
      status = res.status;
      body = await res.text();
    } catch {
      throw new SpotifyError('unreachable', "Spotify's server could not be reached just now.");
    }
    const answer = rpcAnswerOf(body);
    if (!answer) {
      throw new SpotifyError(
        'unreachable',
        status >= 200 && status < 300
          ? "Spotify's server answered in a way the house could not read."
          : `Spotify's server could not be reached just now (it answered ${status}).`,
      );
    }
    if (answer.error !== undefined) {
      const error = answer.error;
      const words = isRecord(error) && typeof error.message === 'string' ? error.message : JSON.stringify(error);
      throw problemOf(words, keyedAddress(server.url, server.apiKey));
    }
    const result = isRecord(answer.result) ? answer.result : {};
    const value = toolValueOf(result);
    if (result.isError === true) {
      throw problemOf(typeof value === 'string' ? value : JSON.stringify(value), keyedAddress(server.url, server.apiKey));
    }
    // Only ever used to build the sign-in page, which needs the key on a locked worker.
    return { value, serverUrl: keyedAddress(server.url, server.apiKey) };
  }

  /** One press: the tool asked once, its answer logged, and only a plain yes or a SpotifyError back. */
  async function press(what: string, tool: string, args: Record<string, unknown>): Promise<SpotifyPressAnswer> {
    try {
      const { value } = await call(tool, args, pressProblemFrom);
      // A server that catches Spotify's refusal and says it in words, as if it were a yes.
      const words = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
      if (NO_DEVICE.test(words)) throw new SpotifyError('device', NO_DEVICE_LINE, null, words);
      log(`[spotify] ${what}: the server took it (${clip(words) || 'no words'})`);
      return { ok: true };
    } catch (error) {
      if (error instanceof SpotifyError) log(`[spotify] ${what}: ${error.reason} (${clip(error.detail ?? error.message)})`);
      throw error;
    }
  }

  /** Refused here as well as at the door, so nothing unchecked can reach the server by another road. */
  function checked<T>(request: PressRequest<T>): T {
    if (!request.ok) throw new SpotifyError('spotify', request.error);
    return request.value;
  }

  /** Every page of a list, until a short page, a repeat, or the ceiling. */
  async function pages<T extends { uri: string | null }>(
    tool: string,
    args: Record<string, unknown>,
    read: (value: unknown, serverUrl: string) => { items: T[]; raw: unknown[] },
    ceiling: number,
  ): Promise<T[]> {
    const all: T[] = [];
    let firstOfLastPage: string | null | undefined;
    for (let offset = 0; offset < ceiling; offset += PAGE) {
      const { value, serverUrl } = await call(tool, { ...args, limit: PAGE, offset });
      const { items, raw } = read(value, serverUrl);
      // A server that ignores offset hands the first page back for ever.
      if (offset > 0 && items[0]?.uri && items[0].uri === firstOfLastPage) break;
      firstOfLastPage = items[0]?.uri;
      all.push(...items);
      if (raw.length < PAGE) break;
    }
    return all;
  }

  // ── Covers ──

  const covers = new Map<string, CoverEntry>();
  const inFlight = new Map<string, Promise<string | null | undefined>>();
  let coversRead = false;

  function readCovers(): void {
    if (coversRead) return;
    coversRead = true;
    if (!coverFile) return;
    try {
      const saved: unknown = JSON.parse(readFileSync(coverFile, 'utf8'));
      const entries = isRecord(saved) && isRecord(saved.covers) ? saved.covers : {};
      for (const [uri, entry] of Object.entries(entries)) {
        if (!isRecord(entry) || typeof entry.at !== 'number') continue;
        if (entry.cover !== null && (typeof entry.cover !== 'string' || !/^https:\/\//i.test(entry.cover))) continue;
        covers.set(uri, { cover: entry.cover, at: entry.at });
      }
    } catch {
      // No file yet, or one that cannot be read: the covers are looked up again.
    }
  }

  function keepCovers(): void {
    if (!coverFile) return;
    const newest = [...covers.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MOST_COVERS_KEPT);
    if (newest.length < covers.size) {
      covers.clear();
      for (const [uri, entry] of newest) covers.set(uri, entry);
    }
    try {
      mkdirSync(dirname(coverFile), { recursive: true });
      atomicWrite(coverFile, JSON.stringify({ version: 1, covers: Object.fromEntries(newest) }));
    } catch (error) {
      console.warn('[spotify] could not keep the covers:', error instanceof Error ? error.message : error);
    }
  }

  function stillGood(uri: string, entry: CoverEntry, now: number): boolean {
    const kept = entry.cover === null
      ? MISS_KEPT_MS
      : uri.startsWith('spotify:playlist:') ? PLAYLIST_COVER_KEPT_MS : SONG_COVER_KEPT_MS;
    return now - entry.at < kept;
  }

  /** A cover from oEmbed. null when Spotify has none; undefined when it could not be told. */
  async function lookUp(uri: string): Promise<string | null | undefined> {
    const match = /^spotify:([a-z]+):([A-Za-z0-9]{1,64})$/.exec(uri);
    if (!match || !COVER_KINDS.has(match[1])) return null;
    const page = `https://open.spotify.com/${match[1]}/${match[2]}`;
    try {
      const res = await doFetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(page)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(lookupTimeoutMs),
      });
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok) return undefined;
      const data: unknown = await res.json();
      const url = isRecord(data) ? text(data.thumbnail_url) : null;
      return url && /^https:\/\//i.test(url) ? url : null;
    } catch {
      return undefined;
    }
  }

  function lookUpOnce(uri: string): Promise<string | null | undefined> {
    const running = inFlight.get(uri);
    if (running) return running;
    const work = lookUp(uri).finally(() => inFlight.delete(uri));
    inFlight.set(uri, work);
    return work;
  }

  /** Every item with its cover, as far as the budget allows. */
  async function withCovers<T extends { uri: string | null; cover: string | null }>(items: T[]): Promise<T[]> {
    readCovers();
    const now = clock();
    const wanted = [...new Set(items
      .filter((item) => !item.cover && item.uri)
      .map((item) => item.uri as string))]
      .filter((uri) => {
        const entry = covers.get(uri);
        return !entry || !stillGood(uri, entry, now);
      });
    if (wanted.length) {
      let next = 0;
      let learned = false;
      const worker = async () => {
        while (next < wanted.length) {
          const uri = wanted[next++];
          const cover = await lookUpOnce(uri);
          if (cover !== undefined) {
            covers.set(uri, { cover, at: clock() });
            learned = true;
          }
        }
      };
      // Lookups still running when the budget runs out carry on and are kept
      // for the next read; this list goes out with what it has.
      const all = Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, wanted.length) }, worker))
        .then(() => { if (learned) keepCovers(); });
      await within(all, coverBudgetMs);
    }
    return items.map((item) => (item.cover || !item.uri ? item : { ...item, cover: covers.get(item.uri)?.cover ?? null }));
  }

  // ── What the routes ask for ──

  let connectView: SpotifyConnectView | null = null;

  /** A playlist's cover is looked up again on the next read, after a change that moves it. */
  function forgetCover(playlistId: string): void {
    readCovers();
    covers.delete(`spotify:playlist:${playlistId}`);
  }

  return {
    async now(): Promise<SpotifyNowView> {
      const { value, serverUrl } = await call('spotify_now_playing', {});
      const view = readNow(value, serverUrl);
      if (!view.track) return view;
      const [track] = await withCovers([view.track]);
      return { ...view, track };
    },

    async playlists(): Promise<SpotifyPlaylistsView> {
      const lists = await pages('spotify_get_playlists', {}, readPlaylists, MOST_PLAYLISTS);
      return { playlists: await withCovers(lists) };
    },

    async playlistTracks(id: string): Promise<SpotifyPlaylistTracksView> {
      const songs = await pages('spotify_get_playlist_tracks', { playlist_id: id }, readTracks, MOST_PLAYLIST_TRACKS);
      const tracks: SpotifyTrack[] = songs.map(({ name, artist, uri, cover }) => ({ name, artist, uri, cover }));
      return { id, tracks: await withCovers(tracks) };
    },

    async recent(): Promise<SpotifyRecentView> {
      const { value, serverUrl } = await call('spotify_recently_played', { limit: RECENT });
      return { tracks: await withCovers(readTracks(value, serverUrl).items) };
    },

    /** Songs for what the owner typed, best match first, each with its cover and its album. */
    async search(query: string): Promise<SpotifySearchView> {
      const words = checked(readSearchQuery(query));
      const { value, serverUrl } = await call('spotify_search', { query: words, type: 'track', limit: SEARCH_RESULTS });
      const tracks: SpotifyTrack[] = readTracks(value, serverUrl).items.map(({ playedAt: _, ...track }) => track);
      return { query: words, tracks: await withCovers(tracks) };
    },

    /**
     * A song, a playlist or an album from its top, or (with none) carry on with
     * what was paused. A song with its playlist or album starts that playlist or
     * album at the song and carries on through the rest of it: a song asked for
     * alone was taken by Spotify and never played on their phone (Oct 20 2026),
     * while every playlist did.
     */
    async play(request: SpotifyPlayRequest = {}): Promise<SpotifyPressAnswer> {
      const { trackUri, playlistUri, albumUri } = checked(readPlayRequest(request));
      const within = playlistUri ?? albumUri;
      if (trackUri && within) return press(`play ${trackUri} in ${within}`, 'spotify_play', { context_uri: within, offset_uri: trackUri });
      if (trackUri) return press(`play ${trackUri}`, 'spotify_play', { track_uri: trackUri });
      if (playlistUri) return press(`play ${playlistUri}`, 'spotify_play', { playlist_uri: playlistUri });
      if (albumUri) return press(`play ${albumUri}`, 'spotify_play', { context_uri: albumUri });
      return press('play (carry on)', 'spotify_play', {});
    },

    async pause(): Promise<SpotifyPressAnswer> {
      return press('pause', 'spotify_pause', {});
    },

    async skip(direction: SpotifySkipDirection): Promise<SpotifyPressAnswer> {
      const to = checked(readSkipRequest({ direction }));
      return press(`skip ${to}`, 'spotify_skip', { direction: to });
    },

    /**
     * The client id and redirect the phone's Spotify kit connects with, read
     * once off the worker's sign-in page (its redirect to Spotify names both).
     */
    async connectInfo(): Promise<SpotifyConnectView> {
      if (connectView) return connectView;
      const server = whereIsServer();
      if (server instanceof SpotifyError) throw server;
      const page = signInPageOf(keyedAddress(server.url, server.apiKey));
      if (!page) throw new SpotifyError('spotify', "The house's Spotify server has no sign-in page it can read the app's id from.");
      let location: string | null = null;
      try {
        const res = await doFetch(page, { redirect: 'manual', signal: AbortSignal.timeout(MCP_TIMEOUT_MS) });
        location = res.headers.get('location');
      } catch {
        throw new SpotifyError('unreachable', "Spotify's server could not be reached just now.");
      }
      const view = connectViewFrom(location);
      if (!view) throw new SpotifyError('spotify', "The Spotify server's sign-in page did not name the app's id.");
      connectView = view;
      return view;
    },

    // ── The player ──

    async player(): Promise<SpotifyPlayerView> {
      const { value, serverUrl } = await call('spotify_player_state', {});
      return readPlayer(value, serverUrl);
    },

    async devices(): Promise<SpotifyDevicesView> {
      const { value, serverUrl } = await call('spotify_devices', {});
      return readDevices(value, serverUrl);
    },

    async shuffle(on: boolean): Promise<SpotifyPressAnswer> {
      const state = checked(readShuffleRequest({ on }));
      return press(`shuffle ${state ? 'on' : 'off'}`, 'spotify_shuffle', { state });
    },

    async repeat(mode: SpotifyRepeatMode): Promise<SpotifyPressAnswer> {
      const state = checked(readRepeatRequest({ mode }));
      return press(`repeat ${state}`, 'spotify_repeat', { state });
    },

    async volume(percent: number): Promise<SpotifyPressAnswer> {
      const level = checked(readVolumeRequest({ percent }));
      return press(`volume ${level}`, 'spotify_volume', { percent: level });
    },

    async seek(positionMs: number): Promise<SpotifyPressAnswer> {
      const at = checked(readSeekRequest({ positionMs }));
      return press(`seek ${at}`, 'spotify_seek', { position_ms: at });
    },

    async transfer(deviceId: string): Promise<SpotifyPressAnswer> {
      const id = checked(readTransferRequest({ deviceId }));
      return press(`play on ${id}`, 'spotify_transfer', { device_id: id, play: true });
    },

    // ── Their library ──

    async liked(): Promise<SpotifyLikedView> {
      const songs = await pages('spotify_saved_tracks', {}, readTracks, MOST_LIKED);
      const tracks: SpotifyTrack[] = songs.map(({ playedAt: _, ...track }) => track);
      return { tracks: await withCovers(tracks) };
    },

    async saved(uris: string[]): Promise<SpotifySavedView> {
      const asked = checked(readSavedQuery(uris.join(',')));
      const { value, serverUrl } = await call('spotify_is_saved', { uris: asked });
      return readSaved(value, asked, serverUrl);
    },

    async like(uri: string, liked: boolean): Promise<SpotifyPressAnswer> {
      const request = checked(readLikeRequest({ uri, liked }));
      return press(`${request.liked ? 'heart' : 'unheart'} ${request.uri}`, request.liked ? 'spotify_save' : 'spotify_unsave', { uris: [request.uri] });
    },

    // ── Their playlists ──

    async createPlaylist(request: SpotifyNewPlaylistRequest): Promise<SpotifyNewPlaylistAnswer> {
      const { name, description } = checked(readNewPlaylistRequest(request));
      const { value } = await call('spotify_create_playlist', { name, description: description ?? '', public: false }, pressProblemFrom);
      const id = isRecord(value) ? text(value.id) : null;
      if (!id || !/^[A-Za-z0-9]{1,64}$/.test(id)) throw new SpotifyError('spotify', UNSURE_LINE, null, JSON.stringify(value));
      log(`[spotify] new playlist ${id}: the server took it`);
      return { ok: true, playlist: { id, name, tracks: 0, uri: `spotify:playlist:${id}`, cover: null, mine: true } };
    },

    async renamePlaylist(id: string, request: SpotifyRenameRequest): Promise<SpotifyPressAnswer> {
      const change = checked(readRenameRequest(request));
      return press(`rename ${id}`, 'spotify_update_playlist', { playlist_id: id, ...change });
    },

    async addToPlaylist(id: string, uris: string[]): Promise<SpotifyPressAnswer> {
      const songs = checked(readTracksRequest({ uris }));
      const answer = await press(`add ${songs.length} to ${id}`, 'spotify_add_tracks', { playlist_id: id, track_uris: songs });
      forgetCover(id);
      return answer;
    },

    async removeFromPlaylist(id: string, uris: string[]): Promise<SpotifyPressAnswer> {
      const songs = checked(readTracksRequest({ uris }));
      const answer = await press(`remove ${songs.length} from ${id}`, 'spotify_remove_tracks', { playlist_id: id, track_uris: songs });
      forgetCover(id);
      return answer;
    },

    /** The song at `from` comes to sit at `to`; Spotify counts where it goes before the move. */
    async moveInPlaylist(id: string, request: SpotifyMoveRequest): Promise<SpotifyPressAnswer> {
      const { from, to } = checked(readMoveRequest(request));
      const answer = await press(`move ${from} to ${to} in ${id}`, 'spotify_reorder_tracks', { playlist_id: id, range_start: from, insert_before: to > from ? to + 1 : to, range_length: 1 });
      forgetCover(id);
      return answer;
    },

    async setPlaylistCover(id: string, image: Buffer): Promise<SpotifyPressAnswer> {
      const jpeg = await coverJpegBase64(image);
      const answer = await press(`picture for ${id}`, 'spotify_playlist_cover', { playlist_id: id, image_base64: jpeg });
      forgetCover(id);
      return answer;
    },
  };
}

export type SpotifyReader = ReturnType<typeof createSpotify>;

let reader: SpotifyReader | null = null;

/** The house's reader, made on first use. */
export function spotify(): SpotifyReader {
  if (!reader) reader = createSpotify();
  return reader;
}

/** Test seam: put a reader in place (null puts the house's own back on next use). */
export function setSpotifyForTest(next: SpotifyReader | null): void {
  reader = next;
}
