<script lang="ts">
  // Voice-note player: hidden <audio> driven by a custom play/seek bar.
  let { src, transcript }: { src: string; transcript?: unknown } = $props();

  let audioEl: HTMLAudioElement | null = $state(null);
  let audioPlaying = $state(false);
  let audioDuration = $state(0);
  let audioCurrentTime = $state(0);

  function toggleAudio() {
    if (!audioEl) return;
    if (audioPlaying) {
      audioEl.pause();
    } else {
      audioEl.play();
    }
  }

  function onAudioTimeUpdate() {
    if (audioEl) audioCurrentTime = audioEl.currentTime;
  }

  function onAudioLoaded() {
    if (audioEl && isFinite(audioEl.duration)) audioDuration = audioEl.duration;
  }

  function onAudioEnded() {
    audioPlaying = false;
    audioCurrentTime = 0;
  }

  function onAudioSeek(e: MouseEvent) {
    if (!audioEl || !audioDuration) return;
    const bar = e.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audioEl.currentTime = pct * audioDuration;
  }

  function formatAudioTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
</script>

<div class="media-audio">
  <audio
    bind:this={audioEl}
    preload="metadata"
    src={src}
    ontimeupdate={onAudioTimeUpdate}
    onloadedmetadata={onAudioLoaded}
    ondurationchange={onAudioLoaded}
    onplay={() => audioPlaying = true}
    onpause={() => audioPlaying = false}
    onended={onAudioEnded}
  >
    <track kind="captions" />
  </audio>
  <div class="audio-player">
    <button class="audio-play-btn" onclick={toggleAudio} aria-label={audioPlaying ? 'Pause' : 'Play'}>
      {#if audioPlaying}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      {/if}
    </button>
    <span class="audio-time">{formatAudioTime(audioCurrentTime)}</span>
    <button class="audio-bar" onclick={onAudioSeek} aria-label="Seek">
      <div class="audio-track">
        <div class="audio-progress" style:width="{audioDuration ? (audioCurrentTime / audioDuration) * 100 : 0}%"></div>
      </div>
    </button>
    <span class="audio-time">{formatAudioTime(audioDuration)}</span>
  </div>
  {#if transcript}
    <div class="audio-transcript">{transcript}</div>
  {/if}
</div>

<style>
  .media-audio {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.25rem 0;
  }

  .media-audio audio {
    display: none;
  }

  .audio-player {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.25rem;
    min-width: 220px;
    max-width: 320px;
  }

  .audio-play-btn {
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--gold-dim);
    color: var(--bg-primary);
    flex-shrink: 0;
    transition: all var(--transition);
    cursor: pointer;
  }

  .audio-play-btn:hover {
    background: var(--gold);
    box-shadow: 0 0 10px var(--gold-ember);
  }

  .audio-time {
    font-size: 0.6875rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    min-width: 2.25rem;
    text-align: center;
    flex-shrink: 0;
  }

  .audio-bar {
    flex: 1;
    padding: 0.5rem 0;
    cursor: pointer;
    background: none;
  }

  .audio-track {
    height: 3px;
    background: var(--border-hover);
    border-radius: 2px;
    position: relative;
    overflow: hidden;
  }

  .audio-progress {
    height: 100%;
    background: var(--gold-dim);
    border-radius: 2px;
    transition: width 0.1s linear;
  }

  .audio-bar:hover .audio-track {
    height: 4px;
  }

  .audio-bar:hover .audio-progress {
    background: var(--gold);
  }

  .audio-transcript {
    font-size: 0.875rem;
    color: var(--text-secondary);
    font-style: italic;
  }
</style>
