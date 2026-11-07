<script lang="ts">
  import type { ReadAloudState } from './readAloud.svelte';

  // Presentational read-aloud toggle; MessageBubble owns the playback state.
  let { state, onclick }: { state: ReadAloudState; onclick: () => void } = $props();
</script>

<button
  class="read-aloud-btn"
  class:loading={state === 'loading'}
  class:playing={state === 'playing'}
  {onclick}
  disabled={state === 'loading'}
  title={state === 'playing' ? 'Stop' : state === 'loading' ? 'Generating...' : 'Read aloud'}
>
  {#if state === 'loading'}
    <svg class="tts-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/></svg>
  {:else if state === 'playing'}
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
  {:else}
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
  {/if}
</button>

<style>
  .read-aloud-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    width: 26px;
    padding: 0;
    border-radius: var(--radius-sm, 0.25rem);
    color: var(--text-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .read-aloud-btn:hover:not(:disabled) {
    color: var(--gold-dim);
    background: rgba(255, 255, 255, 0.05);
  }

  .read-aloud-btn.playing {
    color: var(--gold-dim);
  }

  .read-aloud-btn:disabled {
    cursor: wait;
  }

  .tts-spinner {
    animation: toolSpin 0.8s linear infinite;
  }

  @keyframes toolSpin {
    to { transform: rotate(360deg); }
  }
</style>
