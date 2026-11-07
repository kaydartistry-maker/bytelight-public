import { apiFetch } from '$lib/utils/api';

// Read-aloud (on-demand TTS) for one message. Resolved audio URLs are cached
// by message id across every bubble instance for the life of the page.
const ttsCache: Map<string, string> =
  ((globalThis as Record<string, unknown>).__ttsCache as Map<string, string> | undefined)
  ?? ((globalThis as Record<string, unknown>).__ttsCache = new Map<string, string>());

export type ReadAloudState = 'idle' | 'loading' | 'playing';

export class ReadAloud {
  state = $state<ReadAloudState>('idle');
  private audioEl: HTMLAudioElement | null = null;

  constructor(private getMessageId: () => string) {}

  async toggle() {
    const messageId = this.getMessageId();
    if (this.state === 'playing' && this.audioEl) {
      this.audioEl.pause();
      this.audioEl = null;
      this.state = 'idle';
      return;
    }
    if (this.state === 'loading') return;

    // Create and play a silent audio element NOW (during user gesture)
    // so mobile browsers unlock playback. We swap in the real src once TTS loads.
    const audio = new Audio();
    audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    try { await audio.play(); } catch { /* silent unlock attempt */ }
    audio.pause();

    this.audioEl = audio;
    const cached = ttsCache.get(messageId);

    try {
      let audioUrl: string;

      if (cached) {
        audioUrl = cached;
      } else {
        this.state = 'loading';
        const res = await apiFetch(`/api/messages/${messageId}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          // 503 voice_unavailable, 404 not found, 400 deleted/non-text — all no-op
          let errCode: string | undefined;
          try {
            const errBody = await res.json();
            errCode = errBody?.error;
          } catch { /* ignore parse failure */ }
          if (res.status === 503 || errCode === 'voice_unavailable') {
            console.warn('[TTS] Voice unavailable — read-aloud disabled for this message');
          } else {
            console.warn(`[TTS] Read aloud unavailable: ${res.status} ${errCode ?? ''}`.trim());
          }
          this.state = 'idle';
          this.audioEl = null;
          return;
        }
        const data = await res.json();
        if (!data?.success || !data?.url) throw new Error('TTS response missing url');
        audioUrl = data.url;
        ttsCache.set(messageId, audioUrl);
      }

      audio.onended = () => {
        this.state = 'idle';
        this.audioEl = null;
      };
      audio.onerror = () => {
        this.state = 'idle';
        this.audioEl = null;
      };

      audio.src = audioUrl;
      await audio.play();
      this.state = 'playing';
    } catch (err) {
      console.error('[TTS] Read aloud failed:', err);
      this.state = 'idle';
      this.audioEl = null;
    }
  }
}
