<script lang="ts">
  import type { ReactionGroup } from '$lib/utils/reactions';

  // Reaction chips; rendered without a wrapper so they sit directly in the parent's flex row.
  let { reactions, ontoggle }: { reactions: ReactionGroup[]; ontoggle: (emoji: string) => void } = $props();
</script>

{#each reactions as rxn (rxn.emoji)}
  <button
    class="reaction-chip"
    class:mine={rxn.users.includes('user')}
    onclick={() => ontoggle(rxn.emoji)}
    title={rxn.users.join(', ')}
  >
    <span class="reaction-emoji">{rxn.emoji}</span>
    {#if rxn.count > 1}
      <span class="reaction-count">{rxn.count}</span>
    {/if}
  </button>
{/each}

<style>
  .reaction-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    padding: 0.125rem 0.375rem;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--border);
    border-radius: 1rem;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.15s;
  }

  .reaction-chip:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: var(--gold-dim);
  }

  .reaction-chip.mine {
    background: rgba(245, 197, 66, 0.12);
    border-color: var(--gold-dim);
  }

  .reaction-emoji {
    font-size: 0.9375rem;
    line-height: 1;
  }

  .reaction-count {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
</style>
