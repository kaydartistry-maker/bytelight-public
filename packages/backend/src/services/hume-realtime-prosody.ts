import { WebSocket } from 'ws';

const HUME_EVI_URL = 'wss://api.hume.ai/v0/evi/chat';
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_SESSION_MS = 2 * 60_000;
const FINAL_SCORE_GRACE_MS = 350;

export interface HumeRealtimeSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export type HumeRealtimeSocketFactory = (url: string) => HumeRealtimeSocket;

export interface RealtimeProsodySession {
  pushAudio(chunk: Buffer): void;
  finish(timeoutMs?: number): Promise<Record<string, number> | null>;
  abort(): void;
}

export type RealtimeProsodySessionFactory = (apiKey: string) => RealtimeProsodySession;

interface HumeRealtimeProsodyOptions {
  connectTimeoutMs?: number;
  maxSessionMs?: number;
}

function defaultSocketFactory(url: string): HumeRealtimeSocket {
  return new WebSocket(url);
}

function rawMessageText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return null;
}

/** Return Hume's three strongest finite expression measurements. */
export function extractTopHumeProsodyScores(payload: unknown): Record<string, number> | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as {
    type?: unknown;
    interim?: unknown;
    models?: { prosody?: { scores?: unknown } | null } | null;
  };
  if (event.type !== 'user_message' || event.interim === true) return null;

  const scores = event.models?.prosody?.scores;
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return null;

  const ranked = Object.entries(scores as Record<string, unknown>)
    .filter((entry): entry is [string, number] => (
      entry[0].length > 0
      && typeof entry[1] === 'number'
      && Number.isFinite(entry[1])
    ))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return ranked.length > 0 ? Object.fromEntries(ranked) : null;
}

/** Keep the strongest expression signals seen across Hume-split clauses. */
function mergeTopHumeProsodyScores(
  current: Record<string, number> | null,
  next: Record<string, number>,
): Record<string, number> {
  const merged = new Map<string, number>(Object.entries(current || {}));
  for (const [label, score] of Object.entries(next)) {
    merged.set(label, Math.max(merged.get(label) ?? Number.NEGATIVE_INFINITY, score));
  }
  return Object.fromEntries(
    Array.from(merged.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3),
  );
}

/**
 * One short-lived Hume EVI connection per opted-in utterance.
 *
 * The browser never sees the Hume key. Audio waits in memory while the
 * server-side socket connects, then streams in the same order it arrived.
 * EVI is paused before the first audio frame so it measures/transcribes the
 * user without generating a competing assistant response.
 */
export class HumeRealtimeProsodySession implements RealtimeProsodySession {
  private readonly socket: HumeRealtimeSocket;
  private readonly pendingAudio: string[] = [];
  private readonly connectTimer: ReturnType<typeof setTimeout>;
  private readonly lifetimeTimer: ReturnType<typeof setTimeout>;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  private terminal = false;
  private finishRequested = false;
  private finishDeadlineAt = 0;
  private latestScores: Record<string, number> | null = null;
  private finishResolve: ((scores: Record<string, number> | null) => void) | null = null;

  constructor(
    apiKey: string,
    socketFactory: HumeRealtimeSocketFactory = defaultSocketFactory,
    options: HumeRealtimeProsodyOptions = {},
  ) {
    const url = new URL(HUME_EVI_URL);
    url.searchParams.set('api_key', apiKey);
    this.socket = socketFactory(url.toString());

    this.connectTimer = setTimeout(
      () => this.settle(null, 'terminate'),
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    this.connectTimer.unref?.();
    this.lifetimeTimer = setTimeout(
      () => this.settle(this.latestScores, 'terminate'),
      options.maxSessionMs ?? DEFAULT_MAX_SESSION_MS,
    );
    this.lifetimeTimer.unref?.();

    this.socket.on('open', () => this.handleOpen());
    this.socket.on('message', (data) => this.handleMessage(data));
    // Hume is an optional sidecar. Provider/socket failures resolve to no
    // tone rather than rejecting or delaying the authoritative Groq path.
    this.socket.on('error', () => this.settle(this.latestScores, 'terminate'));
    this.socket.on('close', () => this.settle(this.latestScores, 'none'));
  }

  pushAudio(chunk: Buffer): void {
    if (this.terminal || chunk.length === 0) return;
    const encoded = chunk.toString('base64');
    if (!this.opened) {
      this.pendingAudio.push(encoded);
      return;
    }
    this.sendAudio(encoded);
  }

  finish(timeoutMs = 1_800): Promise<Record<string, number> | null> {
    if (this.terminal) return Promise.resolve(this.latestScores);
    if (this.finishRequested) {
      return new Promise((resolve) => {
        const previousResolve = this.finishResolve;
        this.finishResolve = (scores) => {
          previousResolve?.(scores);
          resolve(scores);
        };
      });
    }

    this.finishRequested = true;
    const boundedTimeout = Math.max(0, timeoutMs);
    this.finishDeadlineAt = Date.now() + boundedTimeout;
    return new Promise((resolve) => {
      this.finishResolve = resolve;
      this.scheduleFinish(this.latestScores ? Math.min(FINAL_SCORE_GRACE_MS, boundedTimeout) : boundedTimeout);
    });
  }

  abort(): void {
    this.latestScores = null;
    this.settle(null, 'terminate');
  }

  private handleOpen(): void {
    if (this.terminal) return;
    this.opened = true;
    clearTimeout(this.connectTimer);
    try {
      this.socket.send(JSON.stringify({ type: 'pause_assistant_message' }));
      for (const encoded of this.pendingAudio) this.sendAudio(encoded);
      this.pendingAudio.length = 0;
    } catch {
      this.settle(this.latestScores, 'terminate');
    }
  }

  private sendAudio(data: string): void {
    if (this.terminal) return;
    try {
      this.socket.send(JSON.stringify({ type: 'audio_input', data }));
    } catch {
      this.settle(this.latestScores, 'terminate');
    }
  }

  private handleMessage(data: unknown): void {
    if (this.terminal) return;
    const text = rawMessageText(data);
    if (!text) return;

    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }

    const scores = extractTopHumeProsodyScores(event);
    if (!scores) return;
    this.latestScores = mergeTopHumeProsodyScores(this.latestScores, scores);
    if (this.finishRequested) {
      const remaining = Math.max(0, this.finishDeadlineAt - Date.now());
      this.scheduleFinish(Math.min(FINAL_SCORE_GRACE_MS, remaining));
    }
  }

  private scheduleFinish(delayMs: number): void {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null;
      this.settle(this.latestScores, this.latestScores ? 'close' : 'terminate');
    }, delayMs);
  }

  private settle(
    scores: Record<string, number> | null,
    socketCleanup: 'close' | 'terminate' | 'none',
  ): void {
    if (this.terminal) return;
    this.terminal = true;
    this.latestScores = scores;
    this.pendingAudio.length = 0;
    clearTimeout(this.connectTimer);
    clearTimeout(this.lifetimeTimer);
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;

    const resolve = this.finishResolve;
    this.finishResolve = null;
    resolve?.(scores);

    try {
      if (socketCleanup === 'terminate' && this.socket.terminate) this.socket.terminate();
      else if (socketCleanup !== 'none') this.socket.close(1000, 'complete');
    } catch {
      // Socket cleanup is best effort; the session is already terminal.
    }
  }
}

export function createHumeRealtimeProsodySession(apiKey: string): RealtimeProsodySession {
  return new HumeRealtimeProsodySession(apiKey);
}
