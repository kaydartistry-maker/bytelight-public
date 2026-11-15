// The Theater — the Ear: a browser extension that reads the subtitles off
// the page while she watches on the computer (Netflix, Hulu) and feeds them
// to the house as they play (packages/theater-ear/).
//
// THE WIRE (pairing). In the Theater she taps "Connect the Ear" (her door,
// authenticated): the house makes a one-time code, 8 easy characters, good
// for 10 minutes and one use. She pastes it into the extension, which trades
// it at the Ear's claim door (unauthenticated) for a long random token. The
// house keeps only the token's SHA-256 (config `theater.ear.token_hash`) and
// only the code's SHA-256 while it waits; "Disconnect the Ear" deletes both.
// One Ear at a time: a new claim replaces the old token. Too many wrong
// guesses at a waiting code burn it.
//
// THE EAR'S DOOR (routes/theater-ear.ts) sits outside the cookie session and
// asks for `Authorization: Bearer <token>`, compared in constant time
// against the kept hash. It can only read whether a computer night is live,
// bring in heard lines, report where the video is, and leave a probe.
//
// Lines become cues (services/theater.ts appendEarLines), so everything that
// reads cues (the couch's lookback, the Mouth's beats) works unchanged and
// still only sees what has played.

import crypto from 'crypto';
import { join } from 'path';
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { deleteConfig, getConfig, setConfig } from './db/config.js';
import { THEATER_LIMITS, TheaterError, theaterDir, type TheaterNight } from './theater.js';
import type { Cue } from './theater-subtitles.js';

export const EAR_KEYS = {
  tokenHash: 'theater.ear.token_hash',
  pairedAt: 'theater.ear.paired_at',
  pairing: 'theater.ear.pairing',
} as const;

/** Easy to read off a screen and type: no 0/O, 1/I/L. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60_000;
/** Wrong guesses a waiting code survives before it is burned. */
export const PAIRING_MAX_MISSES = 10;

export const EAR_LIMITS = {
  /** Lines in one post. */
  batch: 50,
  /** The JSON body of a lines or clock post. */
  bodyBytes: 32 * 1024,
  /** The probe file. */
  probeBytes: 64 * 1024,
  /** No video is longer than a day. */
  maxSeconds: 24 * 3600,
  /** One caption stays on screen at most this long. */
  maxLineSeconds: 60,
} as const;

/** The Ear counts as listening when it was in touch this recently. */
export const EAR_LISTENING_MS = 30_000;

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** "abcd-efgh" / " ABCDEFGH " → "ABCDEFGH" */
export function normalisePairingCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '') : '';
}

interface WaitingCode { hash: string; expiresAt: number; misses: number }

function readWaiting(): WaitingCode | null {
  const raw = getConfig(EAR_KEYS.pairing);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WaitingCode;
    if (typeof parsed.hash !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    return { hash: parsed.hash, expiresAt: parsed.expiresAt, misses: Number(parsed.misses) || 0 };
  } catch {
    return null;
  }
}

/** "Connect the Ear": a fresh one-time code (any older waiting code is replaced). */
export function createPairingCode(now = Date.now()): { code: string; expiresAt: string } {
  const bytes = crypto.randomBytes(PAIRING_LENGTH);
  let code = '';
  for (let i = 0; i < PAIRING_LENGTH; i++) code += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  const expiresAt = now + PAIRING_TTL_MS;
  setConfig(EAR_KEYS.pairing, JSON.stringify({ hash: sha256(code), expiresAt, misses: 0 } satisfies WaitingCode));
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * The extension trades a code for its token. The code is spent on success;
 * an expired code, or one guessed at too often, is gone. Answers the token
 * (shown once; only its hash is kept).
 */
export function claimPairingCode(raw: unknown, now = Date.now()): { token: string } {
  const code = normalisePairingCode(raw);
  const waiting = readWaiting();
  const refuse = () => new TheaterError(401, 'That code did not work. Make a new one in the Theater ("Connect the Ear") and try again.');
  if (!waiting) throw refuse();
  if (now > waiting.expiresAt) {
    deleteConfig(EAR_KEYS.pairing);
    throw refuse();
  }
  const given = Buffer.from(sha256(code), 'hex');
  const kept = Buffer.from(waiting.hash, 'hex');
  const match = code.length === PAIRING_LENGTH && given.length === kept.length && crypto.timingSafeEqual(given, kept);
  if (!match) {
    const misses = waiting.misses + 1;
    if (misses >= PAIRING_MAX_MISSES) deleteConfig(EAR_KEYS.pairing);
    else setConfig(EAR_KEYS.pairing, JSON.stringify({ ...waiting, misses }));
    throw refuse();
  }
  deleteConfig(EAR_KEYS.pairing);
  const token = crypto.randomBytes(32).toString('base64url');
  setConfig(EAR_KEYS.tokenHash, sha256(token));
  setConfig(EAR_KEYS.pairedAt, new Date(now).toISOString());
  lastContactAt = null;
  return { token };
}

/** Is this the Ear's token? Constant-time against the kept hash. */
export function earTokenValid(token: unknown): boolean {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
  const kept = getConfig(EAR_KEYS.tokenHash);
  if (!kept || !/^[0-9a-f]{64}$/.test(kept)) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(kept, 'hex'));
}

/** "Disconnect the Ear": the token and any waiting code are forgotten. */
export function revokeEar(): void {
  deleteConfig(EAR_KEYS.tokenHash);
  deleteConfig(EAR_KEYS.pairedAt);
  deleteConfig(EAR_KEYS.pairing);
  lastContactAt = null;
}

// ── when the Ear was last in touch (memory only; a restart just means "waiting") ──

let lastContactAt: number | null = null;

export function noteEarContact(now = Date.now()): void {
  lastContactAt = now;
}

export interface EarPairingView {
  paired: boolean;
  pairedAt: string | null;
  /** A code is waiting to be claimed, and until when. */
  codeWaitingUntil: string | null;
  /** The Ear was in touch in the last EAR_LISTENING_MS. */
  listening: boolean;
  lastContactAt: string | null;
}

export function earPairingView(now = Date.now()): EarPairingView {
  const paired = Boolean(getConfig(EAR_KEYS.tokenHash));
  const waiting = readWaiting();
  const live = waiting && waiting.expiresAt > now ? waiting : null;
  return {
    paired,
    pairedAt: paired ? getConfig(EAR_KEYS.pairedAt) : null,
    codeWaitingUntil: live ? new Date(live.expiresAt).toISOString() : null,
    listening: paired && lastContactAt !== null && now - lastContactAt < EAR_LISTENING_MS,
    lastContactAt: paired && lastContactAt !== null ? new Date(lastContactAt).toISOString() : null,
  };
}

/** What the phone shows on a computer night about the Ear. */
export interface EarNightView extends EarPairingView {
  lastLine: string | null;
  lastHeardAt: string | null;
}

export function earNightView(night: TheaterNight, now = Date.now()): EarNightView {
  return { ...earPairingView(now), lastLine: night.ear?.lastLine ?? null, lastHeardAt: night.ear?.lastHeardAt ?? null };
}

// ── reading what the Ear sends ─────────────────────────────────────────────

function seconds(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > EAR_LIMITS.maxSeconds) return null;
  return Math.round(raw * 1000) / 1000;
}

/** A caption's words, the way cues keep them: trimmed lines, inner runs of space squeezed, blanks dropped. */
export function cleanEarText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, THEATER_LIMITS.line);
}

/** { lines: [{ text, start, end }] } → cues; anything unreadable is refused whole. */
export function readEarLines(body: unknown): Cue[] {
  const lines = (body as { lines?: unknown } | undefined)?.lines;
  if (!Array.isArray(lines)) throw new TheaterError(400, 'Send { lines: [{ text, start, end }] }.');
  if (lines.length > EAR_LIMITS.batch) throw new TheaterError(413, `At most ${EAR_LIMITS.batch} lines at a time.`);
  const cues: Cue[] = [];
  for (const line of lines) {
    const l = line as { text?: unknown; start?: unknown; end?: unknown } | null;
    const text = cleanEarText(l?.text);
    const start = seconds(l?.start);
    if (!text || start === null) throw new TheaterError(400, 'Each line needs its text and a start in seconds.');
    let end = l?.end === undefined || l?.end === null ? start + 2 : seconds(l.end);
    if (end === null) throw new TheaterError(400, 'A line\'s end is in seconds.');
    end = Math.min(Math.max(end, start), start + EAR_LIMITS.maxLineSeconds);
    cues.push({ text, start, end });
  }
  return cues;
}

/** { position, paused, duration? } in seconds of the video. */
export function readEarClock(body: unknown): { position: number; paused: boolean; duration: number | null } {
  const b = (body ?? {}) as { position?: unknown; paused?: unknown; duration?: unknown };
  const position = seconds(b.position);
  if (position === null) throw new TheaterError(400, 'position is the video\'s time in seconds.');
  if (typeof b.paused !== 'boolean') throw new TheaterError(400, 'paused is true or false.');
  const duration = b.duration === undefined || b.duration === null ? null : seconds(b.duration);
  return { position, paused: b.paused, duration };
}

export function earProbePath(root = theaterDir()): string {
  return join(root, 'ear-probe.json');
}

/** The extension's "What do you hear?": kept whole, one file, overwritten each time. */
export function saveEarProbe(body: unknown, root = theaterDir(), now = Date.now()): { bytes: number } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TheaterError(400, 'A probe is a JSON object.');
  const text = JSON.stringify({ receivedAt: new Date(now).toISOString(), probe: body }, null, 2);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > EAR_LIMITS.probeBytes) throw new TheaterError(413, `A probe is ${EAR_LIMITS.probeBytes / 1024} KB at most.`);
  mkdirSync(root, { recursive: true });
  const path = earProbePath(root);
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
  return { bytes };
}
