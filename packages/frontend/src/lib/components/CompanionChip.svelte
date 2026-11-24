<script lang="ts">
  // A single companion chip — face (profile photo if set, else emoji) + name.
  // Used in the thread-creation picker, the thread-header roster, and the
  // roster editor so seated companions read the same everywhere. The face
  // comes from the profiles store (getProfile(companion.id)), the exact same
  // source the Arc B message bubbles use — so a companion's photo in Settings →
  // Profiles shows here too. (Arc C, Slice 3.)
  import { getProfile } from '$lib/stores/profiles.svelte';
  import type { Companion } from '$lib/stores/companions.svelte';

  let {
    companion,
    selected = true,
    interactive = false,
    size = 'md',
    showName = true,
    onclick,
  }: {
    companion: Companion;
    /** Dimmed when false (used by the picker's toggle state). */
    selected?: boolean;
    /** Renders as a real button when true; a static chip otherwise. */
    interactive?: boolean;
    size?: 'sm' | 'md';
    showName?: boolean;
    onclick?: () => void;
  } = $props();

  const profile = $derived(getProfile(companion.id));
  const label = $derived(profile.name || companion.display_name);
</script>

{#snippet body()}
  <span class="avatar-ring" class:sm={size === 'sm'}>
    {#if profile.image}
      <img class="chip-avatar-img" src={profile.image} alt="" />
    {:else}
      <span class="chip-avatar" aria-hidden="true">{profile.emoji || '•'}</span>
    {/if}
  </span>
  {#if showName}<span class="chip-name">{label}</span>{/if}
{/snippet}

{#if interactive}
  <button
    type="button"
    class="companion-chip"
    class:sm={size === 'sm'}
    class:selected
    class:deselected={!selected}
    aria-pressed={selected}
    aria-label={selected ? `${label} — seated, tap to remove` : `${label} — tap to seat`}
    {onclick}
  >
    {@render body()}
  </button>
{:else}
  <span class="companion-chip static" class:sm={size === 'sm'} title={label}>
    {@render body()}
  </span>
{/if}

<style>
  .companion-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.6rem 0.2rem 0.2rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: 0.8125rem;
    line-height: 1;
    transition: all var(--transition);
    max-width: 100%;
  }
  .companion-chip.sm {
    gap: 0.3rem;
    padding: 0.1rem 0.45rem 0.1rem 0.1rem;
    font-size: 0.75rem;
  }
  button.companion-chip {
    cursor: pointer;
  }
  button.companion-chip:hover {
    border-color: var(--gold-dim);
    color: var(--text-primary);
  }
  button.companion-chip.selected {
    border-color: var(--gold);
    color: var(--text-accent);
    background: var(--gold-ember);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--gold) 30%, transparent);
  }
  button.companion-chip.deselected {
    opacity: 0.55;
  }
  button.companion-chip.deselected:hover {
    opacity: 1;
  }

  /* Avatar ring — the canonical companion-face ring. The operator picked this
     chip ring as "the GOOD one", so it's now the single source of truth: a
     2px accent (pink/magenta) halo, mirrored on the message-bubble avatars and
     the header roster stack so a companion face reads the same everywhere.
     Solid accent (not blended into --border) so the ring holds its colour over
     both photo and emoji avatars. */
  .avatar-ring {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    padding: 2px;
    background: var(--accent);
  }
  .chip-avatar,
  .chip-avatar-img {
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .avatar-ring.sm .chip-avatar,
  .avatar-ring.sm .chip-avatar-img {
    width: 1.3rem;
    height: 1.3rem;
  }
  .chip-avatar {
    background: var(--bg-tertiary);
    font-size: 0.95rem;
  }
  .avatar-ring.sm .chip-avatar {
    font-size: 0.8rem;
  }
  .chip-avatar-img {
    object-fit: cover;
  }
  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
