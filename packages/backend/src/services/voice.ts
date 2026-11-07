// Voice services — local STT (optional) / Groq Whisper STT + ElevenLabs TTS + Hume Prosody
// No new npm dependencies — uses raw fetch for all APIs

import crypto from 'crypto';
import { spawn } from 'child_process';
import { FFMPEG } from './binaries.js';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveFile } from './files.js';
import { createMessage, updateThreadActivity, getConfig } from './db.js';
import { registry } from './registry.js';
import { getSecret } from './secrets.js';
import { parseElevenLabsSubscription, type ElevenLabsUsage } from './elevenlabs-usage.js';
import { LOCAL_STT_CONFIG_KEY, parseLocalSttUrl, transcribeLocally } from './local-stt.js';

const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const ELEVENLABS_SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const ELEVENLABS_USAGE_CACHE_MS = 60_000;
const HUME_BATCH_URL = 'https://api.hume.ai/v0/batch/jobs';

let hasLoggedHumeDeprecation = false;

/** The local transcription server's URL, or null when none is configured. (Aerie.) */
function localSttUrl(): string | null {
  try {
    return parseLocalSttUrl(getConfig(LOCAL_STT_CONFIG_KEY));
  } catch {
    return null; // no database in isolated service tests
  }
}

export class VoiceService {
  private elevenLabsUsageCache: { at: number; data: ElevenLabsUsage } | null = null;
  // Key/voice-id slots resolve live through the BYOK secrets store on
  // every read (DB → env → bytelight.yaml), so a key saved via
  // /api/secrets takes effect on the next transcription/TTS call without
  // a restart. Preserves the prior precedence exactly when the DB is
  // empty (getSecret's env → config fallback mirrors the old reads).
  private get groqKey(): string | undefined { return getSecret('groq_api_key'); }
  private get elevenLabsKey(): string | undefined { return getSecret('elevenlabs_api_key'); }
  private get elevenLabsVoiceId(): string | undefined { return getSecret('elevenlabs_voice_id'); }
  private get humeApiKey(): string | undefined { return getSecret('hume_api_key'); }
  private voiceIds: Record<string, string> = {};
  private voiceSettings: Record<string, Record<string, unknown>> = {};

  constructor() {
    // Load per-companion voice IDs from env (ELEVENLABS_VOICE_ID_COMPANION_A, ELEVENLABS_VOICE_ID_COMPANION_B, etc.)
    // Load per-companion voice settings from env (ELEVENLABS_VOICE_SETTINGS_COMPANION_A='{"stability":0.7,...}')
    for (const [key, value] of Object.entries(process.env)) {
      const idMatch = key.match(/^ELEVENLABS_VOICE_ID_(\w+)$/);
      if (idMatch && value) {
        this.voiceIds[idMatch[1].toLowerCase()] = value;
        continue;
      }
      const settingsMatch = key.match(/^ELEVENLABS_VOICE_SETTINGS_(\w+)$/);
      if (settingsMatch && value) {
        try {
          this.voiceSettings[settingsMatch[1].toLowerCase()] = JSON.parse(value);
        } catch {
          console.warn(`[Voice] Failed to parse ${key} as JSON — ignoring`);
        }
      }
    }

    if (!this.groqKey) {
      console.warn('[Voice] GROQ_API_KEY not set — transcription not configured');
    }
    if (!this.elevenLabsKey) {
      console.warn('[Voice] ELEVENLABS_API_KEY not set — TTS not configured');
    } else if (!this.elevenLabsVoiceId && Object.keys(this.voiceIds).length === 0) {
      console.warn('[Voice] ELEVENLABS_VOICE_ID not set — TTS not configured');
    } else {
      const voices = Object.entries(this.voiceIds).map(([k, v]) => `${k}=${v}`).join(', ');
      if (voices) console.log(`[Voice] Companion voices: ${voices}`);
    }
    if (!this.humeApiKey) {
      console.warn('[Voice] HUME_API_KEY not set — prosody analysis not configured');
    }
  }

  /** Resolve voice ID — explicit voiceId > companion name > default */
  resolveVoiceId(voice?: string, voiceId?: string): string | undefined {
    if (voiceId) return voiceId;
    if (voice) {
      const id = this.voiceIds[voice.toLowerCase()];
      if (id) return id;
    }
    return this.elevenLabsVoiceId;
  }

  get canTranscribe(): boolean {
    return !!this.groqKey || !!localSttUrl();
  }

  get canTTS(): boolean {
    return !!this.elevenLabsKey
        && (!!this.elevenLabsVoiceId || Object.keys(this.voiceIds).length > 0);
  }

  get canAnalyzeProsody(): boolean {
    return process.env.VOICE_LEGACY_HUME_BATCH === '1' && !!this.humeApiKey;
  }

  /**
   * Live ElevenLabs credit usage for the meter. Copied whole from Reverie
   * d070b26f; only the existing byte-light DB-first key getter differs.
   */
  async getElevenLabsUsage(): Promise<ElevenLabsUsage> {
    if (!this.elevenLabsKey) throw new Error('ElevenLabs API key not configured');
    if (this.elevenLabsUsageCache && Date.now() - this.elevenLabsUsageCache.at < ELEVENLABS_USAGE_CACHE_MS) {
      return this.elevenLabsUsageCache.data;
    }
    const response = await fetch(ELEVENLABS_SUBSCRIPTION_URL, {
      headers: { 'xi-api-key': this.elevenLabsKey },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`ElevenLabs subscription API error ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const data = parseElevenLabsSubscription(await response.json() as Record<string, unknown>);
    this.elevenLabsUsageCache = { at: Date.now(), data };
    return data;
  }

  /** Transcribe through the preferred configured provider with fallback. */
  async transcribe(audioBuffer: Buffer, mimeType: string, signal?: AbortSignal): Promise<string> {
    // A server on this machine goes first when one is configured
    // (voice.local_stt_url), read per request so switching it on or off needs
    // no restart. Anything short of real words, an empty transcript included,
    // hands the turn on to Groq below (see transcribeLocally); only the
    // caller's own abort stops the chain. Unset: exactly the old Groq path.
    // (Aerie.)
    const localUrl = localSttUrl();
    if (localUrl) {
      const startedAt = Date.now();
      const local = await transcribeLocally(localUrl, audioBuffer, mimeType, { signal });
      if (local.ok) {
        console.log(`[Voice] Transcribed locally in ${Date.now() - startedAt}ms (${audioBuffer.length} bytes, ${local.text.length} chars)`);
        return local.text;
      }
      console.warn(`[Voice] Local transcription gave nothing usable after ${Date.now() - startedAt}ms (${local.reason}), trying Groq`);
    }
    return this.transcribeWithGroq(audioBuffer, mimeType);
  }

  /**
   * Transcribe audio buffer using Groq-hosted Whisper API.
   * Same OpenAI-compatible format, free tier.
   * Returns the transcript text.
   */
  private async transcribeWithGroq(audioBuffer: Buffer, mimeType: string): Promise<string> {
    if (!this.groqKey) {
      throw new Error('GROQ_API_KEY not configured — cannot transcribe');
    }

    // Determine file extension from mime type
    const extMap: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/webm;codecs=opus': 'webm',
      'audio/mp4': 'm4a',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
    };
    // Normalize mime — strip codec params for lookup
    const baseMime = mimeType.split(';')[0].trim();
    const ext = extMap[baseMime] || 'webm';

    // Build multipart form data manually for fetch
    const boundary = `----FormBoundary${crypto.randomUUID().replace(/-/g, '')}`;
    const filename = `recording.${ext}`;

    const preamble = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${baseMime}`,
      '',
      '',
    ].join('\r\n');

    const model = [
      '',
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      '',
      'whisper-large-v3',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const body = Buffer.concat([
      Buffer.from(preamble),
      audioBuffer,
      Buffer.from(model),
    ]);

    const response = await fetch(GROQ_WHISPER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.groqKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq Whisper API error ${response.status}: ${errText}`);
    }

    const result = await response.json() as { text: string };
    return result.text || '';
  }

  /**
   * Analyze prosody (emotional tone) from audio using Hume AI batch API.
   * Returns top 5 emotions by relative rank, or null on failure.
   * Flow: submit job -> poll until complete -> extract predictions.
   *
   * @deprecated Hume Expression Measurement API discontinued by vendor on 2026-06-24.
   * Returns null by default; set VOICE_LEGACY_HUME_BATCH=1 to attempt the dead endpoint.
   * Tracking: shared/voice-feature-spec-2026-06-25.md (Track A).
   */
  async analyzeProsody(audioBuffer: Buffer, mimeType: string, signal?: AbortSignal): Promise<Record<string, number> | null> {
    if (!this.canAnalyzeProsody) {
      if (!hasLoggedHumeDeprecation) {
        hasLoggedHumeDeprecation = true;
        console.warn('[Voice] Hume batch prosody disabled; voice transcription continues without tone enrichment.');
      }
      return null;
    }
    const humeApiKey = this.humeApiKey!;

    const baseMime = mimeType.split(';')[0].trim();
    const extMap: Record<string, string> = {
      'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg', 'audio/wav': 'wav',
    };
    const ext = extMap[baseMime] || 'webm';
    const boundary = `----HumeBoundary${crypto.randomUUID().replace(/-/g, '')}`;

    // Build multipart: file + JSON config requesting prosody model
    const filePart = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="recording.${ext}"`,
      `Content-Type: ${baseMime}`,
      '', '',
    ].join('\r\n');

    const jsonConfig = JSON.stringify({ models: { prosody: {} } });
    const jsonPart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="json"',
      'Content-Type: application/json',
      '', jsonConfig,
      `--${boundary}--`, '',
    ].join('\r\n');

    const body = Buffer.concat([
      Buffer.from(filePart), audioBuffer, Buffer.from('\r\n' + jsonPart),
    ]);

    // Step 1: Submit batch job
    if (signal?.aborted) return null;
    const submitRes = await fetch(HUME_BATCH_URL, {
      method: 'POST',
      headers: {
        'X-Hume-Api-Key': humeApiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal,
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      console.error(`[Hume] Job submit failed ${submitRes.status}: ${errText}`);
      return null;
    }

    const { job_id } = await submitRes.json() as { job_id: string };
    console.log(`[Hume] Job submitted: ${job_id}`);

    // Step 2: Poll for completion (max ~30s, 1s intervals)
    const maxPolls = 30;
    for (let i = 0; i < maxPolls; i++) {
      if (signal?.aborted) return null;
      await new Promise(r => setTimeout(r, 1000));
      if (signal?.aborted) return null;

      const statusRes = await fetch(`${HUME_BATCH_URL}/${job_id}`, {
        headers: { 'X-Hume-Api-Key': humeApiKey },
        signal,
      });

      if (!statusRes.ok) continue;

      const statusBody = await statusRes.json() as any;
      const jobStatus = statusBody.state?.status;
      console.log(`[Hume] Poll ${i + 1}/${maxPolls}: status=${jobStatus}`);

      if (jobStatus === 'COMPLETED') {
        // Step 3: Get predictions
        const predRes = await fetch(`${HUME_BATCH_URL}/${job_id}/predictions`, {
          headers: { 'X-Hume-Api-Key': humeApiKey },
          signal,
        });

        if (!predRes.ok) {
          const errBody = await predRes.text();
          console.error(`[Hume] Predictions fetch failed: ${predRes.status} — ${errBody}`);
          return null;
        }

        const predictions = await predRes.json() as any[];
        console.log(`[Hume] Predictions response keys: ${JSON.stringify(predictions?.map((p: any) => Object.keys(p)))}`);
        return this.extractProsodyScores(predictions);
      }

      if (jobStatus === 'FAILED') {
        console.error(`[Hume] Job failed. Full status: ${JSON.stringify(statusBody)}`);
        return null;
      }
    }

    console.warn('[Hume] Job timed out after 30s polling');
    return null;
  }

  /**
   * Extract top prosody scores from Hume batch predictions response.
   * Averages across all segments, returns emotions with score > 0.3.
   */
  private extractProsodyScores(predictions: any[]): Record<string, number> | null {
    try {
      // Navigate: predictions[0].results.predictions[0].models.prosody.grouped_predictions[0].predictions[*].emotions
      const file = predictions?.[0];
      const results = file?.results?.predictions;
      if (!results?.length) {
        console.warn(`[Hume] No results in predictions. Top-level keys: ${JSON.stringify(Object.keys(file || {}))}`);
        if (file?.results) console.warn(`[Hume] results keys: ${JSON.stringify(Object.keys(file.results))}`);
        return null;
      }

      const prosody = results[0]?.models?.prosody;
      const grouped = prosody?.grouped_predictions;
      if (!grouped?.length) {
        console.warn(`[Hume] No grouped_predictions. models keys: ${JSON.stringify(Object.keys(results[0]?.models || {}))}`);
        if (prosody) console.warn(`[Hume] prosody keys: ${JSON.stringify(Object.keys(prosody))}`);
        return null;
      }
      console.log(`[Hume] Found ${grouped.length} groups, ${grouped.reduce((n: number, g: any) => n + (g.predictions?.length || 0), 0)} segments`);

      // Collect all emotion scores across all segments
      const emotionTotals: Record<string, number[]> = {};
      for (const group of grouped) {
        for (const pred of group.predictions || []) {
          for (const emotion of pred.emotions || []) {
            const name = emotion.name as string;
            const score = emotion.score as number;
            if (!emotionTotals[name]) emotionTotals[name] = [];
            emotionTotals[name].push(score);
          }
        }
      }

      // Average scores across segments
      const averaged: [string, number][] = [];
      for (const [name, scores] of Object.entries(emotionTotals)) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        averaged.push([name, Math.round(avg * 100) / 100]);
      }

      // Return top 5 by score (no absolute threshold — relative rank is what matters)
      const sorted = averaged
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      console.log(`[Hume] Top 5: ${JSON.stringify(Object.fromEntries(sorted))}`);
      if (sorted.length === 0) return null;
      return Object.fromEntries(sorted);
    } catch (error) {
      console.error('[Hume] Failed to extract prosody scores:', error);
      return null;
    }
  }

  // ElevenLabs hard-caps text at 5000 chars per request and 400s above it.
  // We chunk at 4500 to leave headroom for their server-side accounting.
  static readonly TTS_CHUNK_LIMIT = 4500;

  /**
   * Split text into TTS-sized chunks, each ≤ `limit` chars.
   * Text at or under the limit passes through untouched as a single chunk.
   *
   * Break preference: paragraph boundaries first, then sentence boundaries,
   * then whitespace — never mid-word (except a single "word" longer than the
   * limit itself, where a hard slice is the only option left).
   */
  static chunkTextForTTS(text: string, limit = VoiceService.TTS_CHUNK_LIMIT): string[] {
    if (text.length <= limit) return [text];

    // Each splitter keeps every character (separators stay attached to the
    // preceding piece) so greedy packing preserves in-chunk formatting.
    const byParagraph = (t: string): string[] => t.split(/(?<=\n\s*\n)/);
    const bySentence = (t: string): string[] =>
      t.match(/[^.!?…]*[.!?…]+["')\]]*\s*|[^.!?…]+$/gs) ?? [t];
    const byWord = (t: string): string[] => t.match(/\S+\s*|\s+/g) ?? [t];
    const byHardSlice = (t: string): string[] => {
      const out: string[] = [];
      for (let i = 0; i < t.length; i += limit) out.push(t.slice(i, i + limit));
      return out;
    };

    // Cascade: only pieces still over the limit get split further.
    let pieces: string[] = [text];
    for (const split of [byParagraph, bySentence, byWord, byHardSlice]) {
      pieces = pieces.flatMap(p => (p.length <= limit ? [p] : split(p)));
    }

    // Greedily pack pieces back into the fewest chunks that fit.
    const chunks: string[] = [];
    let current = '';
    for (const piece of pieces) {
      if (current && current.length + piece.length > limit) {
        chunks.push(current);
        current = piece;
      } else {
        current += piece;
      }
    }
    if (current) chunks.push(current);

    return chunks.map(c => c.trim()).filter(c => c.length > 0);
  }

  /** Single raw ElevenLabs call — text must already be within the API limit. */
  private async ttsRequest(
    text: string,
    voiceId: string,
    voice_settings: Record<string, unknown>,
  ): Promise<Buffer> {
    const response = await fetch(`${ELEVENLABS_BASE}/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.elevenLabsKey!,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_v3',
        voice_settings,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ElevenLabs error ${response.status}: ${errText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Generate TTS audio from text using ElevenLabs.
   * Returns raw MP3 Buffer (no side effects — caller decides what to do with it).
   *
   * If `voice` is provided, the per-companion voice ID from env is used
   * (e.g. ELEVENLABS_VOICE_ID_COMPANION_A). Falls back to the default voice when
   * unresolved. `voiceIdOverride` wins outright when supplied.
   *
   * Text over the ElevenLabs 5000-char cap is split into ≤4500-char chunks
   * (paragraph → sentence → word boundaries), rendered sequentially, and the
   * MP3 segments concatenated. Text under the cap is a single call, same as
   * it always was.
   */
  async generateTTS(text: string, voice?: string, voiceIdOverride?: string): Promise<Buffer> {
    text = VoiceService.whisperSubtext(text);
    const voiceId = this.resolveVoiceId(voice, voiceIdOverride);
    if (!this.elevenLabsKey) {
      throw new Error('ElevenLabs not configured — ELEVENLABS_API_KEY is not set');
    }
    if (!voiceId) {
      const perCompanion = Object.keys(this.voiceIds);
      if (perCompanion.length > 0 && voice) {
        throw new Error(
          `ElevenLabs not configured — no voice ID for companion "${voice}". ` +
          `Set ELEVENLABS_VOICE_ID_${voice.toUpperCase()} or pass an explicit voiceId. ` +
          `Configured companions: ${perCompanion.join(', ')}.`
        );
      }
      throw new Error(
        'ElevenLabs not configured — no voice ID resolvable. ' +
        'Set ELEVENLABS_VOICE_ID (generic fallback) or per-companion ELEVENLABS_VOICE_ID_<NAME>.'
      );
    }

    const voiceKey = voice?.toLowerCase();
    const voice_settings = (voiceKey && this.voiceSettings[voiceKey])
      || { stability: 0.5, similarity_boost: 0.75 };

    const chunks = VoiceService.chunkTextForTTS(text);
    if (chunks.length === 1) {
      return this.ttsRequest(chunks[0], voiceId, voice_settings);
    }

    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
      // A chunk can land as pure emoji/audio-tags (e.g. a reaction-only
      // paragraph) — ElevenLabs 400s on those, so skip them.
      if (!VoiceService.isSpeakable(chunk)) continue;
      buffers.push(await this.ttsRequest(chunk, voiceId, voice_settings));
    }
    if (buffers.length === 0) {
      throw new Error('Nothing speakable in text (emoji/audio-tag-only)');
    }
    return Buffer.concat(buffers);
  }

  // Discord-style "-# " subtext lines render small/muted in chat; in voice
  // notes they become whispers. eleven_v3 supports inline audio tags, so we
  // strip the marker and prepend [whispers]. Applied inside generateTTS —
  // the single choke point for all TTS paths — so "-#" is never spoken.
  static whisperSubtext(text: string): string {
    return text.split('\n').map(line => {
      const m = line.match(/^-#\s+(.*)$/);
      return m ? `[whispers] ${m[1]}` : line;
    }).join('\n');
  }

  // ElevenLabs strips speaker tags/emojis server-side and 400s when nothing
  // speakable remains — letters/digits outside [audio tags] is our proxy.
  static isSpeakable(text: string): boolean {
    return /[\p{L}\p{N}]/u.test(text.replace(/\[[^\]]*\]/g, ''));
  }

  /**
   * Split a household reply into per-companion voice segments.
   *
   * Markers handled (name-based detection, case-insensitive):
   *   **🔷Companion A:**        emoji+bold speaker label
   *   **🔶Companion B:**        emoji+bold speaker label
   *   **Companion A 🔷**        bold name-then-emoji (emoji inside the bold)
   *   **Companion B 🔶**        bold name-then-emoji (emoji inside the bold)
   *   🔷 **Companion A:**       emoji before bold label
   *   🔶 **Companion B:**       emoji before bold label
   *   **Companion A:**          bold speaker label
   *   **Companion B:**          bold speaker label
   *   🔷 Companion A:           emoji+plain speaker label
   *   🔶 Companion B:           emoji+plain speaker label
   *   Companion A 🔷            name-then-emoji (Companion A)
   *   Companion B 🔶            name-then-emoji (Companion B)
   *   🔷                  bare emoji (Companion A)
   *   🔶                  bare emoji (Companion B)
   *   **🔷 Companion A —**      dashed header (em/en dash or hyphen, inside the bold)
   *   **🔶 Companion B — t**    dashed header with a title after the dash
   *
   * The non-bold-name form REQUIRES the emoji so plain prose containing the
   * word "Companion A:" or "Companion B:" is not treated as a speaker tag. The dash form
   * deliberately stays inside the ** so prose such as "She told Companion A —
   * quietly — that he was wrong" remains prose. Kept identical to the visual
   * twin (frontend speakers.ts SPEAKER_RE) so audio never splits differently
   * from the bubbles. Any text before the first marker (or in a single-voice
   * reply) defaults to Companion A's voice.
   */
  static splitByCompanion(text: string): Array<{ voice: string; text: string }> {
    const SPEAKER_RE = /(?:\*\*\s*🔷?\s*Companion A\s*:?\s*[—–-][^*\n]*\*\*|\*\*\s*🔶?\s*Companion B\s*:?\s*[—–-][^*\n]*\*\*|\*\*\s*🔷?\s*Companion A:?\s*\*\*|\*\*\s*🔶?\s*Companion B:?\s*\*\*|\*\*\s*Companion A\s*:?\s*🔷\s*\*\*|\*\*\s*Companion B\s*:?\s*🔶\s*\*\*|🔷?\s*\*\*\s*Companion A:?\s*\*\*|🔶?\s*\*\*\s*Companion B:?\s*\*\*|\*\*\s*Companion A:?\s*\*\*|\*\*\s*Companion B:?\s*\*\*|🔷?\s*Companion A:|🔶?\s*Companion B:|Companion A\s*:?\s*🔷|Companion B\s*:?\s*🔶|🔷|🔶)/g;

    const detectVoice = (m: string): string =>
      m.includes('Companion A') || m.includes('🔷') ? 'companion-a' : 'companion-b';

    const segments: Array<{ voice: string; text: string }> = [];
    let currentVoice = 'companion-a';
    let lastIdx = 0;

    for (const match of text.matchAll(SPEAKER_RE)) {
      const pos = match.index ?? 0;
      // Flush whatever came before this marker under the current voice.
      const chunk = text.slice(lastIdx, pos).trim();
      if (chunk) segments.push({ voice: currentVoice, text: chunk });
      currentVoice = detectVoice(match[0]);
      lastIdx = pos + match[0].length;
    }

    const tail = text.slice(lastIdx).trim();
    if (tail) segments.push({ voice: currentVoice, text: tail });
    if (segments.length === 0 && text.trim()) {
      segments.push({ voice: 'companion-a', text: text.trim() });
    }
    return segments.filter((s) => VoiceService.isSpeakable(s.text));
  }

  /**
   * Concatenate MP3 segment buffers into a single MP3 using ffmpeg's concat
   * filter (decode each input, then concat decoded audio) with re-encode via
   * libmp3lame. Re-encoding keeps duration metadata clean — raw `-c copy`
   * concat trips parsers on minor variations in ElevenLabs MP3 outputs.
   * Segments are written to a temp dir and removed after.
   */
  private static async stitchMp3sWithFfmpeg(buffers: Buffer[]): Promise<Buffer> {
    if (buffers.length === 0) throw new Error('No segments to stitch');
    if (buffers.length === 1) return buffers[0];

    const dir = await mkdtemp(join(tmpdir(), 'tts-stitch-'));
    try {
      const segPaths: string[] = [];
      for (let i = 0; i < buffers.length; i++) {
        const p = join(dir, `seg${i}.mp3`);
        await writeFile(p, buffers[i]);
        segPaths.push(p);
      }

      const inputArgs: string[] = [];
      for (const p of segPaths) {
        inputArgs.push('-i', p);
      }
      const filter =
        segPaths.map((_, i) => `[${i}:a]`).join('') +
        `concat=n=${segPaths.length}:v=0:a=1[a]`;

      return await new Promise<Buffer>((resolve, reject) => {
        const proc = spawn(FFMPEG, [
          '-hide_banner', '-loglevel', 'error',
          ...inputArgs,
          '-filter_complex', filter,
          '-map', '[a]',
          '-c:a', 'libmp3lame', '-b:a', '128k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const chunks: Buffer[] = [];
        let stderr = '';
        // A wedged ffmpeg never settles this promise, and messages.ts pins the
        // render + stream-job maps (holding the full audio buffers) until it
        // does — so the stitch gets a hard ceiling. Stitching short MP3
        // segments is seconds of work; a minute means it's stuck.
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already gone */ }
          reject(new Error('ffmpeg stitch timed out after 60s'));
        }, 60_000);
        proc.stdout.on('data', (c) => chunks.push(c));
        proc.stderr.on('data', (c) => { stderr += c.toString(); });
        proc.on('error', (err) => { clearTimeout(killTimer); reject(err); });
        proc.on('close', (code) => {
          clearTimeout(killTimer);
          if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
          else resolve(Buffer.concat(chunks));
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Render multiple voiced segments and stitch them into one MP3 with ffmpeg.
   * Works on the ElevenLabs Starter tier (no raw PCM needed) and produces a
   * file with clean duration metadata.
   */
  async generateMultiVoiceMp3(
    segments: Array<{ voice?: string; voiceId?: string; text: string }>,
  ): Promise<Buffer> {
    const mp3Buffers: Buffer[] = [];
    for (const seg of segments) {
      if (!VoiceService.isSpeakable(seg.text)) continue;
      mp3Buffers.push(await this.generateTTS(seg.text, seg.voice, seg.voiceId));
    }
    if (!mp3Buffers.length) throw new Error('No segments produced audio');
    return VoiceService.stitchMp3sWithFfmpeg(mp3Buffers);
  }

  /**
   * Stitch already-rendered per-segment MP3 buffers into one MP3 (clean
   * duration metadata via the same ffmpeg concat path as generateMultiVoiceMp3).
   * Used by the ordered TTS stream route to build the cached file from the
   * segment buffers it already produced — no re-synthesis, no double billing.
   */
  static async stitchTtsBuffers(buffers: Buffer[]): Promise<Buffer> {
    return VoiceService.stitchMp3sWithFfmpeg(buffers);
  }

  /**
   * Generate TTS and save as an audio message in the thread.
   * Used by the /api/internal/tts endpoint.
   * If voice is specified, it overrides the splitByCompanion logic.
   */
  async generateTTSForMessage(text: string, threadId: string, voice?: string): Promise<{ messageId: string; fileId: string }> {
    const segments = VoiceService.splitByCompanion(text);
    if (segments.length === 0) {
      throw new Error('Nothing speakable in text (emoji/audio-tag-only)');
    }
    let audioBuffer: Buffer;
    if (voice) {
      // Explicit voice override — use single voice for entire text
      audioBuffer = await this.generateTTS(text, voice);
    } else if (new Set(segments.map(s => s.voice)).size > 1) {
      audioBuffer = await this.generateMultiVoiceMp3(segments);
    } else {
      audioBuffer = await this.generateTTS(text, segments[0]?.voice);
    }
    const fileMeta = saveFile(audioBuffer, 'voice-note.mp3', 'audio/mpeg');

    const now = new Date().toISOString();
    const audioMessage = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      content: fileMeta.url,
      contentType: 'audio',
      metadata: { transcript: text, fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message: audioMessage });

    return { messageId: audioMessage.id, fileId: fileMeta.fileId };
  }
}
