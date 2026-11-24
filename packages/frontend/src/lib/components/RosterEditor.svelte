<script lang="ts">
  // Lightweight roster editor for the open thread (Arc C, Slice 3). Opens from
  // the header roster chips. Shows every pickable companion as a toggle chip
  // (seated = highlighted); Save PUTs the roster (Slice 2 endpoint). Roster
  // never seats zero companions — Save is disabled when empty.
  import CompanionChip from '$lib/components/CompanionChip.svelte';
  import {
    allCompanions,
    setThreadRoster,
    type Companion,
  } from '$lib/stores/companions.svelte';
  import { showToast } from '$lib/stores/toast.svelte';

  let {
    threadId,
    seated = [],
    onsaved,
    onclose,
  }: {
    threadId: string;
    /** Currently-seated companions (rendered pre-selected). */
    seated?: Companion[];
    onsaved?: (roster: Companion[]) => void;
    onclose?: () => void;
  } = $props();

  // Local draft of seated ids — toggled by tapping chips. Seeded once from the
  // seated prop: the editor is remounted each time it opens (the parent guards
  // it behind {#if rosterEditorOpen}), so capturing the initial value here is
  // intentional, not a missed reactive dependency.
  // svelte-ignore state_referenced_locally
  let draftIds = $state<string[]>(seated.map((c: Companion) => c.id));
  let saving = $state(false);

  // On mobile the panel is fixed-positioned (clamped to the viewport's right
  // edge so it can't overflow like it did before). We still want it to drop
  // just below the header roster trigger, whose vertical offset varies (two-row
  // header + safe-area inset), so measure the trigger and set --roster-editor-top
  // to its bottom edge. Desktop re-anchors under the trigger via CSS and ignores
  // this value.
  let panelEl = $state<HTMLDivElement | null>(null);
  let panelTop = $state(72);

  $effect(() => {
    if (!panelEl) return;
    const trigger = panelEl.closest('.header-roster-wrapper');
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      panelTop = Math.round(rect.bottom + 8);
    }
  });

  const registry = $derived(allCompanions());

  function toggle(id: string) {
    draftIds = draftIds.includes(id)
      ? draftIds.filter((x) => x !== id)
      : [...draftIds, id];
  }

  async function save() {
    if (draftIds.length === 0 || saving) return;
    saving = true;
    // Preserve registry (picker) order in the PUT for a stable roster.
    const ordered = registry.filter((c) => draftIds.includes(c.id)).map((c) => c.id);
    const roster = await setThreadRoster(threadId, ordered);
    saving = false;
    if (roster) {
      onsaved?.(roster);
    } else {
      showToast('Failed to update roster', 'error');
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="roster-editor-backdrop" role="presentation" onclick={() => onclose?.()}></div>
<div
  class="roster-editor"
  role="dialog"
  aria-modal="true"
  aria-label="Edit thread roster"
  bind:this={panelEl}
  style="--roster-editor-top: {panelTop}px"
>
  <div class="re-header">
    <span class="re-title">Who's in this thread</span>
    <button class="re-close" onclick={() => onclose?.()} aria-label="Close">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>

  {#if registry.length === 0}
    <p class="re-empty">No companions available.</p>
  {:else}
    <div class="re-chips">
      {#each registry as c (c.id)}
        <CompanionChip
          companion={c}
          interactive
          selected={draftIds.includes(c.id)}
          onclick={() => toggle(c.id)}
        />
      {/each}
    </div>
  {/if}

  <div class="re-actions">
    <button class="res-btn res-btn--ghost" onclick={() => onclose?.()} disabled={saving}>Cancel</button>
    <button
      class="res-btn res-btn--primary"
      onclick={save}
      disabled={saving || draftIds.length === 0}
      title={draftIds.length === 0 ? 'Seat at least one companion' : undefined}
    >
      {saving ? 'Saving…' : 'Save'}
    </button>
  </div>
</div>

<style>
  .roster-editor-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: transparent;
  }
  .roster-editor {
    /* Mobile: fixed to the viewport, pinned 1rem from the RIGHT edge and grown
       leftward. The old rule anchored left:0 to the trigger — which sits
       right-of-centre on mobile — so the min(22rem, 100vw-2rem) panel spilled
       off the right of the screen and clipped "Save" to "Sa…". Pinning to the
       viewport's right edge (not the trigger) plus width <= 100vw-2rem is a hard
       guarantee: the panel keeps a 1rem margin on both sides at every phone
       width, so the Cancel/Save row is always fully on-screen and tappable.
       --roster-editor-top is set from JS to the trigger's bottom edge so it
       still reads as dropping from the roster chips. */
    position: fixed;
    top: var(--roster-editor-top, 4.5rem);
    right: 1rem;
    left: auto;
    z-index: 201;
    width: min(22rem, calc(100vw - 2rem));
    max-width: calc(100vw - 2rem);
    padding: 0.85rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  }
  /* Desktop / wide viewports: re-anchor under the trigger (absolute to the
     wrapper) so the panel drops from the roster chips instead of the viewport
     corner — there's room there and it reads as attached. Still right-anchored
     and width-clamped, so it can never overflow. */
  @media (min-width: 769px) {
    .roster-editor {
      position: absolute;
      top: calc(100% + 0.5rem);
      right: 0;
      left: auto;
    }
  }
  .re-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.6rem;
  }
  .re-title {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--gold-dim);
  }
  .re-close {
    display: flex;
    padding: 0.2rem;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .re-close:hover { color: var(--text-primary); }
  .re-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.85rem;
  }
  .re-empty {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin: 0 0 0.85rem;
  }
  .re-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
