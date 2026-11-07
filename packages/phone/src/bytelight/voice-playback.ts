import { apiFetch } from './api';

export interface MessageTtsResponse {
  success: boolean;
  cached?: boolean;
  fileId?: string;
  url: string;
}

export interface MessageTtsStreamSegment {
  index: number;
  voice?: string;
  url: string;
}

export interface MessageTtsStreamResponse {
  success: boolean;
  cached?: boolean;
  /**
   * Always normalized to playback order. A cached combined render is exposed
   * as one segment so callers have a single playback path.
   */
  segments: MessageTtsStreamSegment[];
}

type WebkitAudioWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

let context: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let fetchController: AbortController | null = null;
let nativeAudio: HTMLAudioElement | null = null;
let nativePlaybackController: AbortController | null = null;
let silentWavUrl: string | null = null;
let playbackGeneration = 0;
let contextTransition: Promise<void> = Promise.resolve();

const ANDROID_INTER_SEGMENT_DRAIN_MS = 90;
const ANDROID_FINAL_DRAIN_MS = 400;

class MessageTtsStreamRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'MessageTtsStreamRequestError';
    this.status = status;
  }
}

/** True only when the running backend predates the optional stream route. */
export function isMessageTtsStreamUnavailable(error: unknown): boolean {
  return error instanceof MessageTtsStreamRequestError
    && [404, 405, 501].includes(error.status);
}

function abortError(): DOMException {
  return new DOMException('Voice playback interrupted', 'AbortError');
}

function useNativeAndroidPlayback(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const capacitorPlatform = (window as typeof window & {
    Capacitor?: { getPlatform?: () => string };
  }).Capacitor?.getPlatform?.();
  return capacitorPlatform === 'android' || /Android/i.test(navigator.userAgent);
}

function getNativeAudio(): HTMLAudioElement {
  if (nativeAudio) return nativeAudio;
  nativeAudio = new Audio();
  nativeAudio.preload = 'auto';
  nativeAudio.volume = 1;
  nativeAudio.muted = false;
  return nativeAudio;
}

function getSilentWavUrl(): string {
  if (silentWavUrl) return silentWavUrl;
  const sampleRate = 8_000;
  const sampleCount = 160; // 20ms — enough to establish the media route.
  const dataBytes = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  silentWavUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  return silentWavUrl;
}

function getAudioContext(): AudioContext {
  if (context && context.state !== 'closed') return context;
  if (typeof window === 'undefined') {
    throw new Error('Voice playback is only available in the browser');
  }

  const AudioContextCtor = window.AudioContext
    || (window as WebkitAudioWindow).webkitAudioContext;
  if (!AudioContextCtor) throw new Error('This browser cannot play voice conversations');
  context = new AudioContextCtor();
  return context;
}

function serializeContextTransition(action: () => Promise<void>): Promise<void> {
  const next = contextTransition.catch(() => {}).then(action);
  // A rejected browser resume must reach its caller without poisoning every
  // later transition in this long-lived singleton.
  contextTransition = next.catch(() => {});
  return next;
}

async function ensureContextRunning(audioContext = getAudioContext()): Promise<AudioContext> {
  await serializeContextTransition(async () => {
    if (audioContext.state === 'closed') throw new Error('Voice audio context was closed');
    // iOS exposes an additional `interrupted` state after phone calls,
    // locks, and some tab transitions. DOM typings omit it, but resume()
    // is the recovery path for both interrupted and suspended contexts.
    if ((audioContext.state as string) !== 'running') await audioContext.resume();
  });
  return audioContext;
}

/**
 * Prime the shared AudioContext from a user gesture. iOS will otherwise
 * reject playback that starts after the asynchronous agent + TTS roundtrip.
 * Call this directly in the button handler that opens voice mode; the
 * overlay also calls it as a best-effort fallback.
 */
export async function unlockVoicePlayback(): Promise<boolean> {
  if (useNativeAndroidPlayback()) {
    stopVoicePlayback();
    const audio = getNativeAudio();
    audio.src = getSilentWavUrl();
    audio.currentTime = 0;
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute('src');
    audio.load();
    return true;
  }

  const audioContext = await ensureContextRunning();

  // Playing one silent sample while the gesture is still active establishes
  // the browser's media permission for audio that arrives later.
  const buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
  const silentSource = audioContext.createBufferSource();
  silentSource.buffer = buffer;
  silentSource.connect(audioContext.destination);
  silentSource.start(0);
  return audioContext.state === 'running';
}

/**
 * Two short rising notes the moment the microphone actually opens.
 *
 * Driving, the phone is face-down in the console and the listening indicator
 * is useless (Jul 28, 2026). The cue that works in a car is one she can hear,
 * so it rides the same output the companions' voices do — through the car
 * speakers if that is where the call is. Quiet on purpose, and never fatal.
 */
export async function playListeningCue(): Promise<void> {
  try {
    const audioContext = await ensureContextRunning();
    const now = audioContext.currentTime;
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.connect(audioContext.destination);

    [
      { frequency: 660, at: now, duration: 0.085 },
      { frequency: 880, at: now + 0.1, duration: 0.11 },
    ].forEach(({ frequency, at, duration }) => {
      const oscillator = audioContext.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, at);
      // Ramped rather than switched, so it reads as a chime instead of a click.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      oscillator.connect(gain);
      oscillator.start(at);
      oscillator.stop(at + duration + 0.02);
    });
  } catch {
    /* A missing or blocked audio context costs her the cue, nothing else. */
  }
}

/** Stop the current voice-mode fetch or decoded audio immediately. */
export function stopVoicePlayback(): void {
  playbackGeneration += 1;
  fetchController?.abort();
  fetchController = null;
  nativePlaybackController?.abort();
  nativePlaybackController = null;
  if (nativeAudio) {
    nativeAudio.pause();
    nativeAudio.removeAttribute('src');
    nativeAudio.load();
  }
  if (source) {
    source.onended = null;
    try { source.stop(0); } catch { /* already stopped */ }
    try { source.disconnect(); } catch { /* already disconnected */ }
    source = null;
  }
}

async function playNativeVoiceSegment(
  audio: HTMLAudioElement,
  url: string,
  controller: AbortController,
  drainMs: number,
): Promise<void> {
  if (controller.signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let tailDrainTimer: number | null = null;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (tailDrainTimer !== null) window.clearTimeout(tailDrainTimer);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      controller.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    // Android can fire `ended` as soon as the final encoded sample has
    // entered its native output buffer. Keep a short boundary between voice
    // segments, then use the full hardware-drain window only after the final
    // segment before Voice Mode reacquires the microphone.
    const onEnded = () => {
      tailDrainTimer = window.setTimeout(() => {
        tailDrainTimer = null;
        finish();
      }, drainMs);
    };
    const onError = () => finish(new Error('Android could not play the voice audio'));
    const onAbort = () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      finish(abortError());
    };

    const onCanPlay = () => {
      audio.removeEventListener('canplaythrough', onCanPlay);
      if (settled || controller.signal.aborted) return;
      void audio.play().catch(error => finish(error));
    };

    audio.addEventListener('ended', onEnded, { once: true });
    audio.addEventListener('error', onError, { once: true });
    audio.addEventListener('canplaythrough', onCanPlay, { once: true });
    controller.signal.addEventListener('abort', onAbort, { once: true });
    audio.src = url;
    audio.currentTime = 0;
    audio.load();
  });
}

async function playNativeVoiceSequence(urls: string[], signal?: AbortSignal): Promise<void> {
  stopVoicePlayback();
  const generation = playbackGeneration;
  const controller = new AbortController();
  nativePlaybackController = controller;
  const audio = getNativeAudio();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    if (signal?.aborted) throw abortError();
    for (let index = 0; index < urls.length; index += 1) {
      if (controller.signal.aborted || generation !== playbackGeneration) throw abortError();
      const isFinal = index === urls.length - 1;
      await playNativeVoiceSegment(
        audio,
        urls[index],
        controller,
        isFinal ? ANDROID_FINAL_DRAIN_MS : ANDROID_INTER_SEGMENT_DRAIN_MS,
      );
    }
    if (controller.signal.aborted || generation !== playbackGeneration) throw abortError();
  } catch (error) {
    const interrupted = controller.signal.aborted
      || signal?.aborted
      || generation !== playbackGeneration;
    if (!controller.signal.aborted) controller.abort();
    if (generation === playbackGeneration) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (interrupted) {
      throw abortError();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onExternalAbort);
    if (nativePlaybackController === controller) nativePlaybackController = null;
  }
}

/**
 * Suspend the shared audio engine after a call ends. The next explicit open
 * gesture should call unlockVoicePlayback() again before starting a session.
 */
export async function suspendVoicePlayback(): Promise<void> {
  stopVoicePlayback();
  const target = context;
  if (!target || target.state === 'closed') return;
  await serializeContextTransition(async () => {
    if (context === target && target.state === 'running') await target.suspend();
  }).catch(() => {});
}

/**
 * Ask the existing read-aloud route for the cached, correctly split
 * multi-companion MP3 belonging to a finalized companion message.
 */
export async function requestMessageTts(
  messageId: string,
  signal?: AbortSignal,
): Promise<MessageTtsResponse> {
  const response = await apiFetch(`/api/messages/${encodeURIComponent(messageId)}/tts`, {
    method: 'POST',
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `Voice render failed: HTTP ${response.status}`);
  }

  const data = await response.json() as Partial<MessageTtsResponse>;
  if (!data.url) throw new Error('Voice render did not return an audio URL');
  return { ...data, success: data.success !== false, url: data.url };
}

/**
 * Ask for an ordered voice manifest. Fresh replies can expose one URL per
 * companion so playback starts before a combined multi-voice file exists;
 * cached replies may return their existing combined URL instead.
 */
export async function requestMessageTtsStream(
  messageId: string,
  signal?: AbortSignal,
): Promise<MessageTtsStreamResponse> {
  const response = await apiFetch(`/api/messages/${encodeURIComponent(messageId)}/tts/stream`, {
    method: 'POST',
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new MessageTtsStreamRequestError(
      data.error || `Voice stream failed: HTTP ${response.status}`,
      response.status,
    );
  }

  const data = await response.json() as {
    success?: boolean;
    cached?: boolean;
    url?: unknown;
    segments?: Array<{
      index?: unknown;
      voice?: unknown;
      url?: unknown;
    }>;
  };

  const segments: MessageTtsStreamSegment[] = Array.isArray(data.segments)
    ? data.segments
      .map((segment, position) => ({
        index: typeof segment.index === 'number' && Number.isFinite(segment.index)
          ? segment.index
          : position,
        voice: typeof segment.voice === 'string' ? segment.voice : undefined,
        url: typeof segment.url === 'string' ? segment.url : '',
        position,
      }))
      .filter(segment => Boolean(segment.url))
      .sort((left, right) => left.index - right.index || left.position - right.position)
      .map(({ index, voice, url }) => ({ index, voice, url }))
    : [];

  // A cached combined file is already correctly ordered and should not be
  // split again. Prefer it when the server returns no fresh segment list.
  if (segments.length === 0 && typeof data.url === 'string' && data.url) {
    segments.push({ index: 0, url: data.url });
  }
  if (segments.length === 0) throw new Error('Voice stream did not return any audio');

  return {
    success: data.success !== false,
    cached: data.cached,
    segments,
  };
}

async function loadVoiceBuffer(
  url: string,
  audioContext: AudioContext,
  controller: AbortController,
  generation: number,
): Promise<AudioBuffer> {
  const response = await fetch(url, {
    credentials: 'include',
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`Could not load voice audio: HTTP ${response.status}`);
  const encoded = await response.arrayBuffer();
  if (controller.signal.aborted || generation !== playbackGeneration) throw abortError();
  const buffer = await audioContext.decodeAudioData(encoded.slice(0));
  if (controller.signal.aborted || generation !== playbackGeneration) throw abortError();
  return buffer;
}

async function playVoiceBuffer(
  buffer: AudioBuffer,
  audioContext: AudioContext,
  controller: AbortController,
): Promise<void> {
  await ensureContextRunning(audioContext);
  if (controller.signal.aborted) throw abortError();

  await new Promise<void>((resolve, reject) => {
    const nextSource = audioContext.createBufferSource();
    source = nextSource;
    nextSource.buffer = buffer;
    nextSource.connect(audioContext.destination);

    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener('abort', onAbort);
      if (source === nextSource) source = null;
      try { nextSource.disconnect(); } catch { /* already disconnected */ }
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      nextSource.onended = null;
      try { nextSource.stop(0); } catch { /* already stopped */ }
      finish(abortError());
    };

    controller.signal.addEventListener('abort', onAbort, { once: true });
    nextSource.onended = () => finish();
    try {
      nextSource.start(0);
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Fetch, decode, and play one same-origin voice file through the unlocked
 * AudioContext. A new call always interrupts the prior one, making this the
 * single playback owner for voice conversations.
 */
export async function playVoiceUrl(url: string, signal?: AbortSignal): Promise<void> {
  return playVoiceSequence([url], signal);
}

/**
 * Play a manifest's URLs in order under one interruptible playback owner.
 * Browser audio preloads/decode segments concurrently; Android keeps the
 * gesture-primed native media element alive and advances it segment by
 * segment so the OS audio route is never torn down between companions.
 */
export async function playVoiceSequence(urls: string[], signal?: AbortSignal): Promise<void> {
  const playableUrls = urls.filter(url => typeof url === 'string' && url.length > 0);
  if (playableUrls.length === 0) throw new Error('Voice playback did not receive any audio');
  if (useNativeAndroidPlayback()) {
    return playNativeVoiceSequence(playableUrls, signal);
  }

  stopVoicePlayback();
  const generation = playbackGeneration;
  const controller = new AbortController();
  fetchController = controller;

  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    if (signal?.aborted) throw abortError();
    const audioContext = await ensureContextRunning();
    // Start every request now so later companions can render/download while
    // the first voice is already speaking. Convert failures to values to
    // avoid an unhandled rejection before their ordered turn is awaited.
    const pendingBuffers = playableUrls.map(url => (
      loadVoiceBuffer(url, audioContext, controller, generation).then(
        buffer => ({ buffer }),
        error => ({ error }),
      )
    ));

    for (const pending of pendingBuffers) {
      const loaded = await pending;
      if ('error' in loaded) throw loaded.error;
      if (controller.signal.aborted || generation !== playbackGeneration) throw abortError();
      // Mobile audio focus can change while an MP3 decodes. Resume directly
      // before each segment, serialized against call-close.
      await playVoiceBuffer(loaded.buffer, audioContext, controller);
    }
  } catch (error) {
    const interrupted = controller.signal.aborted
      || signal?.aborted
      || generation !== playbackGeneration;
    // A later segment may still be downloading or decoding when an earlier
    // one fails. Cancel the shared request owner before surfacing the error.
    if (!controller.signal.aborted) controller.abort();
    if (interrupted) {
      throw abortError();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onExternalAbort);
    if (fetchController === controller) fetchController = null;
  }
}
