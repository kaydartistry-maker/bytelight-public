// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * Local speech-to-text: a transcription server running on this machine, tried
 * before any hosted provider when `voice.local_stt_url` is set. Unset (the
 * default) keeps the old order exactly. (byte-light's hosted provider is
 * Groq Whisper; Aerie's chain also has ElevenLabs Scribe after it.)
 *
 * The server this was built against is CrispASR in `--server` mode running
 * Moonshine Streaming Small, which answers POST /inference with a multipart
 * `file` field and returns JSON carrying a top-level `text`. It reads WAV
 * natively, and the recording is converted to WAV before it goes over (see
 * toLocalSttWav), because its own webm reader does not read the phone's
 * recordings whole.
 */
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FFMPEG } from './binaries.js';

export const LOCAL_STT_CONFIG_KEY = 'voice.local_stt_url';

/** Long enough for a long voice note on a CPU model, short enough to fall back. */
export const LOCAL_STT_TIMEOUT_MS = 30_000;

/** A usable http(s) URL, or null. Anything else reads as unset. */
export function parseLocalSttUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

const WAV_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave']);

/**
 * The recording as 16 kHz mono WAV, converted by the system ffmpeg. The phone
 * records webm the way Chromium's MediaRecorder writes it, and the server's
 * own webm reader stops after the first cluster: measured Sep 27 2026, a
 * six-second recording made through Chromium's MediaRecorder reached the model
 * as its first 1.02 seconds and came back as three words, while the same file
 * converted by ffmpeg came back whole. A WAV is sent untouched. Throws when
 * ffmpeg is missing or cannot read the bytes, so the caller can fall back.
 */
export async function toLocalSttWav(audio: Buffer, mimeType: string, timeoutMs = 20_000): Promise<Buffer> {
  const baseMime = mimeType.split(';')[0].trim().toLowerCase();
  if (WAV_TYPES.has(baseMime)) return audio;

  const dir = await mkdtemp(join(tmpdir(), 'bytelight-stt-'));
  try {
    const input = join(dir, `recording.${EXTENSIONS[baseMime] ?? 'webm'}`);
    const output = join(dir, 'recording.wav');
    await writeFile(input, audio);
    await new Promise<void>((resolve, reject) => {
      execFile(
        // byte-light resolves ffmpeg through FFMPEG_PATH (binaries.ts).
        FFMPEG,
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output],
        { timeout: timeoutMs },
        (error, _stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message).trim().slice(0, 200);
            reject(new Error(`ffmpeg could not convert the recording: ${detail}`));
          } else {
            resolve();
          }
        },
      );
    });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface LocalSttOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * One request to the local server. Throws on anything that is not a clean
 * answer — a refused connection, a non-2xx status, a timeout, or a body with
 * no `text` — so the caller can fall back. An empty transcript comes back as
 * an empty string; transcribeLocally decides what that means.
 */
export async function transcribeWithLocalServer(
  url: string,
  audio: Buffer,
  mimeType: string,
  options: LocalSttOptions = {},
): Promise<string> {
  const baseMime = mimeType.split(';')[0].trim() || 'audio/webm';
  const ext = EXTENSIONS[baseMime] ?? 'webm';

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: baseMime }), `recording.${ext}`);
  form.append('response_format', 'json');
  form.append('language', 'en');

  const timeout = AbortSignal.timeout(options.timeoutMs ?? LOCAL_STT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const response = await (options.fetchImpl ?? fetch)(url, { method: 'POST', body: form, signal });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`Local transcription server answered ${response.status}: ${detail}`);
  }
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== 'string') {
    throw new Error('Local transcription server answered without a text field');
  }
  return result.text.trim();
}

export type LocalSttResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export interface LocalStepOptions extends LocalSttOptions {
  convert?: (audio: Buffer, mimeType: string) => Promise<Buffer>;
}

/**
 * The local step of the transcription chain. Anything short of real words
 * hands the turn on to the hosted providers, an empty transcript included,
 * because empty is also exactly what a decode fault looks like: on Sep 27
 * 2026 five voice turns in a row reached the model as their first second
 * only, each came back empty, and an empty answer stopped the chain, so voice
 * mode heard nothing at all. Only the caller's own abort is thrown.
 */
export async function transcribeLocally(
  url: string,
  audio: Buffer,
  mimeType: string,
  options: LocalStepOptions = {},
): Promise<LocalSttResult> {
  try {
    const wav = await (options.convert ?? toLocalSttWav)(audio, mimeType);
    const text = await transcribeWithLocalServer(url, wav, 'audio/wav', options);
    return text ? { ok: true, text } : { ok: false, reason: 'empty transcript' };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
