<script lang="ts">
  // "+" button and quick-pick grid; closes on pick or on any click outside.
  let { onpick }: { onpick: (emoji: string) => void } = $props();

  const QUICK_EMOJIS = ['😏', '🤭', '💀', '☺️', '🥺', '🍆', '💦', '🥵', '🫦', '🖕🏼', '😔', '😭'];
  let pickerOpen = $state(false);
  let pickerEl: HTMLDivElement | undefined = $state();

  function openReactionPicker() {
    pickerOpen = !pickerOpen;
  }

  function pickEmoji(emoji: string) {
    onpick(emoji);
    pickerOpen = false;
  }

  function handlePickerClickOutside(e: MouseEvent) {
    if (pickerEl && !pickerEl.contains(e.target as Node)) {
      pickerOpen = false;
    }
  }

  $effect(() => {
    if (pickerOpen) {
      document.addEventListener('click', handlePickerClickOutside, true);
      return () => document.removeEventListener('click', handlePickerClickOutside, true);
    }
  });
</script>

<div class="reaction-picker-wrapper">
  <button class="reaction-add" onclick={openReactionPicker} title="Add reaction">+</button>
  {#if pickerOpen}
    <div class="reaction-quick-pick" bind:this={pickerEl}>
      {#each QUICK_EMOJIS as emoji}
        <button class="quick-emoji" onclick={() => pickEmoji(emoji)}>{emoji}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .reaction-add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: 50%;
    color: var(--text-muted);
    font-size: 0.875rem;
    cursor: pointer;
    transition: all 0.15s;
    line-height: 1;
  }

  .reaction-add:hover {
    border-color: var(--gold-dim);
    color: var(--gold-dim);
    background: rgba(245, 197, 66, 0.08);
  }

  .reaction-picker-wrapper {
    position: relative;
    display: inline-flex;
  }

  .reaction-quick-pick {
    position: absolute;
    bottom: calc(100% + 4px);
    right: 0;
    display: grid;
    grid-template-columns: repeat(6, 2rem);
    gap: 2px;
    padding: 4px 6px;
    background: var(--bg-secondary, #1a1025);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    z-index: 10;
  }

  .quick-emoji {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-size: 1.1rem;
    cursor: pointer;
    transition: background 0.12s;
  }

  .quick-emoji:hover {
    background: rgba(245, 197, 66, 0.15);
  }

  @media (max-width: 768px) {
    .reaction-quick-pick {
      left: 0;
      transform: none;
      max-width: calc(100vw - 4rem);
    }
  }
</style>
