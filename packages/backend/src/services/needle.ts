// The Needle (Nov 2026): Companion A or Companion B drops a song on the operator's phone.
//
// A companion runs `sc spotify drop <uri> --as <slug>`. The house first asks
// the operator's Spotify to play it the ordinary way (through the Spotify server the
// house already reads). When that works, that's the whole story. When Spotify
// says there is no active device (the app closed, nothing playing anywhere),
// the house sends the operator's Android app a data-only, high-priority FCM message
// carrying the song; the app's own messaging service wakes Spotify on the
// phone and plays it there, then reports back which road it took.
//
// The house never waits on the phone. A drop answers as soon as FCM has taken
// the message (path 'needle'); the phone's report arrives later on
// POST /api/spotify/needle/landed and becomes one log line. Drops are kept in
// memory for a little while so a report can be matched to its drop; a restart
// forgets them, and a late report for a forgotten drop is answered plainly.

import crypto from 'crypto';
import {
  isPlayableAlbumUri,
  isPlayablePlaylistUri,
  isPlayableTrackUri,
  type SpotifyConnectView,
  type SpotifyPlayRequest,
  type SpotifyProblemReason,
} from '@bytelight/shared';
import { spotify, SpotifyError } from './spotify.js';
import { getPushService } from './push.js';

export const NEEDLE_COMPANIONS = ['companion-a', 'companion-b'] as const;
export type NeedleCompanion = (typeof NEEDLE_COMPANIONS)[number];
export type NeedleRoad = 'remote' | 'intent';

export interface NeedleDrop {
  companion: NeedleCompanion;
  uri: string;
}

export type NeedleDropAnswer =
  | { ok: true; path: 'direct' }
  | { ok: true; path: 'needle'; dropId: string; devices: number }
  | { ok: false; reason: 'request' | 'push' | SpotifyProblemReason; error: string };

export interface NeedleLanding {
  dropId: string;
  ok: boolean;
  road: NeedleRoad;
  error?: string;
}

export type NeedleLandedAnswer =
  | { ok: true }
  | { ok: false; reason: 'request' | 'unknown'; error: string };

export interface NeedleDeps {
  /** An ordinary play through the house's Spotify server. Throws SpotifyError. */
  play?: (request: SpotifyPlayRequest) => Promise<unknown>;
  /** The Spotify app id and redirect the phone's App Remote connects with. */
  connectInfo?: () => Promise<SpotifyConnectView>;
  /** A data-only FCM message to the operator's Android devices. */
  sendData?: (data: Record<string, string>) => Promise<{ devices: number; sent: number }>;
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
  /** How long a drop is remembered for its report. */
  keepMs?: number;
  /** How long a drop waits for the app id before going without it. */
  connectWaitMs?: number;
}

const KEEP_MS = 30 * 60 * 1000;
const CONNECT_WAIT_MS = 3_000;
const MOST_DROPS_KEPT = 200;
const LONGEST_ERROR = 300;

export function isNeedleCompanion(value: unknown): value is NeedleCompanion {
  return typeof value === 'string' && (NEEDLE_COMPANIONS as readonly string[]).includes(value);
}

/** A song, an album or a playlist as Spotify writes its uri, and nothing else. */
export function isNeedleUri(value: unknown): value is string {
  return isPlayableTrackUri(value) || isPlayableAlbumUri(value) || isPlayablePlaylistUri(value);
}

/** The ordinary play request a dropped uri becomes. */
export function playRequestFor(uri: string): SpotifyPlayRequest {
  if (isPlayableTrackUri(uri)) return { trackUri: uri };
  if (isPlayableAlbumUri(uri)) return { albumUri: uri };
  return { playlistUri: uri };
}

export function readDropRequest(body: unknown): { ok: true; value: NeedleDrop } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'A drop is {companion, uri}.' };
  }
  const { companion, uri } = body as Record<string, unknown>;
  if (!isNeedleCompanion(companion)) return { ok: false, error: 'A drop comes from companion-a or companion-b (--as <slug>).' };
  if (!isNeedleUri(uri)) return { ok: false, error: 'That is not a Spotify song, album or playlist uri (spotify:track:..., spotify:album:..., spotify:playlist:...).' };
  return { ok: true, value: { companion, uri } };
}

export function readLandedRequest(body: unknown): { ok: true; value: NeedleLanding } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'A report is {dropId, ok, road}.' };
  }
  const { dropId, ok, road, error } = body as Record<string, unknown>;
  if (typeof dropId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(dropId)) return { ok: false, error: 'That is not a drop id.' };
  if (typeof ok !== 'boolean') return { ok: false, error: 'A report says ok true or false.' };
  if (road !== 'remote' && road !== 'intent') return { ok: false, error: "A report's road is remote or intent." };
  if (error !== undefined && error !== null && typeof error !== 'string') return { ok: false, error: "A report's error is words." };
  const value: NeedleLanding = { dropId, ok, road };
  if (typeof error === 'string' && error.trim()) value.error = error.replace(/\s+/g, ' ').trim().slice(0, LONGEST_ERROR);
  return { ok: true, value };
}

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

interface KeptDrop extends NeedleDrop {
  at: number;
}

export function createNeedle(deps: NeedleDeps = {}) {
  const play = deps.play ?? ((request: SpotifyPlayRequest) => spotify().play(request));
  const connectInfo = deps.connectInfo ?? (() => spotify().connectInfo());
  const sendData = deps.sendData ?? (async (data: Record<string, string>) => {
    const push = getPushService();
    return push ? push.sendFcmData(data) : { devices: 0, sent: 0 };
  });
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((line: string) => console.log(line));
  const keepMs = deps.keepMs ?? KEEP_MS;
  const connectWaitMs = deps.connectWaitMs ?? CONNECT_WAIT_MS;

  const drops = new Map<string, KeptDrop>();

  function sweep(): void {
    const cutoff = now() - keepMs;
    for (const [id, drop] of drops) {
      if (drop.at < cutoff) drops.delete(id);
    }
    // Oldest first in a Map, so trimming from the front keeps the newest.
    while (drops.size > MOST_DROPS_KEPT) {
      const oldest = drops.keys().next().value;
      if (oldest === undefined) break;
      drops.delete(oldest);
    }
  }

  function say(drop: NeedleDrop, result: string): void {
    log(`[Needle] ${drop.companion} dropped ${drop.uri}: ${result}`);
  }

  async function throughThePhone(drop: NeedleDrop): Promise<NeedleDropAnswer> {
    const dropId = newId();
    // The phone has no other way to learn the app id while it is closed, so it
    // rides along. Cached by the Spotify reader after the first read; a slow or
    // failed read sends the drop without it and the phone opens Spotify instead.
    const connect = await within(connectInfo(), connectWaitMs);
    const data: Record<string, string> = { kind: 'needle', uri: drop.uri, by: drop.companion, dropId };
    if (connect) {
      data.clientId = connect.clientId;
      data.redirectUri = connect.redirectUri;
    }
    let delivery: { devices: number; sent: number };
    try {
      delivery = await sendData(data);
    } catch (error) {
      delivery = { devices: 0, sent: 0 };
      log(`[Needle] push send threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (delivery.sent === 0) {
      const error = delivery.devices === 0
        ? 'Spotify has no active device, and no phone is registered for push to wake it.'
        : "Spotify has no active device, and push did not reach the operator's phone.";
      say(drop, `no active device; ${delivery.devices === 0 ? 'no phone registered for push' : 'push failed'}`);
      return { ok: false, reason: 'push', error };
    }
    sweep();
    drops.set(dropId, { ...drop, at: now() });
    say(drop, `no active device; needle sent to ${delivery.sent} phone${delivery.sent === 1 ? '' : 's'} (drop ${dropId}${connect ? '' : ', without the app id'})`);
    return { ok: true, path: 'needle', dropId, devices: delivery.sent };
  }

  return {
    async drop(body: unknown): Promise<NeedleDropAnswer> {
      const request = readDropRequest(body);
      if (!request.ok) return { ok: false, reason: 'request', error: request.error };
      const drop = request.value;
      try {
        await play(playRequestFor(drop.uri));
        say(drop, 'played straight through Spotify');
        return { ok: true, path: 'direct' };
      } catch (error) {
        if (error instanceof SpotifyError && error.reason === 'device') return throughThePhone(drop);
        const reason: SpotifyProblemReason = error instanceof SpotifyError ? error.reason : 'unreachable';
        const words = error instanceof Error ? error.message : String(error);
        say(drop, `Spotify refused (${reason}: ${words})`);
        return { ok: false, reason, error: words };
      }
    },

    landed(body: unknown): NeedleLandedAnswer {
      const report = readLandedRequest(body);
      if (!report.ok) return { ok: false, reason: 'request', error: report.error };
      sweep();
      const landing = report.value;
      const drop = drops.get(landing.dropId);
      if (!drop) {
        log(`[Needle] a report for drop ${landing.dropId} that the house no longer remembers (${landing.ok ? 'landed' : 'failed'}, ${landing.road})`);
        return { ok: false, reason: 'unknown', error: 'The house does not remember that drop.' };
      }
      drops.delete(landing.dropId);
      // The intent road can't promise the music started: Android may hold a
      // background start back, and then the phone leaves the operator a tap-to-play.
      const note = landing.error ? `: ${landing.error}` : '';
      if (landing.road === 'remote') {
        say(drop, landing.ok ? "landed on the operator's phone by Spotify App Remote" : `did not land on the operator's phone (Spotify App Remote${note})`);
      } else {
        say(drop, landing.ok
          ? `handed to Spotify on the operator's phone by intent, may wait for the operator's tap${landing.error ? ` (App Remote: ${landing.error})` : ''}`
          : `did not land on the operator's phone (opening Spotify${note})`);
      }
      return { ok: true };
    },

    /** Test seam: how many drops are waiting for a report. */
    waiting(): number {
      sweep();
      return drops.size;
    },
  };
}

export type Needle = ReturnType<typeof createNeedle>;

let needleInstance: Needle | null = null;

/** The house's needle, made on first use. */
export function needle(): Needle {
  if (!needleInstance) needleInstance = createNeedle();
  return needleInstance;
}

/** Test seam: put a needle in place (null puts the house's own back on next use). */
export function setNeedleForTest(next: Needle | null): void {
  needleInstance = next;
}
