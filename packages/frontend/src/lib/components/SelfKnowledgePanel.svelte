<!--
  SelfKnowledgePanel.svelte — the operator's window into the companions' living identity.

  Rebuilt (not ported line-for-line) against byte-light's Settings design
  language from the tris/Aerie fork's SelfKnowledgeApp.tsx — feature parity,
  byte-light styling. The four-drawer identity design is Annie's.

  Self-knowledge is who a companion has BECOME (distilled from journals, dreams,
  conversation), not the persona bedrock they were written with. A companion
  proposes an entry; the OWNER accepts or dismisses it into identity. The operator keeps
  full oversight from this panel — she can accept, dismiss, reword, restore, or
  delete any entry.

  Filters: To review (proposed) · Accepted · each companion · Dismissed.
  Live: the `self_knowledge` WS event bumps getSelfKnowledgeVersion(); an
  $effect re-fetches so the panel stays fresh while a companion works.

  All fetches go through the api/apiFetch wrapper (credentials: include).
  Nothing here auto-injects self-knowledge into companion context — this is a
  storage/review surface plus a manual search. See the slice report.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiFetch } from '$lib/utils/api';
  import { getSelfKnowledgeVersion } from '$lib/stores/websocket.svelte';

  type Category = 'i_am' | 'i_tend_to' | 'i_believe' | 'i_learned';
  type Status = 'proposed' | 'accepted' | 'dismissed';

  interface Entry {
    id: string;
    companion_id: string;
    category: Category;
    content: string;
    source_type: string | null;
    source_id: string | null;
    status: Status;
    created_at: string;
    reviewed_at: string | null;
  }

  interface Companion {
    id: string;
    display_name: string;
  }

  const CATEGORY_LABEL: Record<Category, string> = {
    i_am: 'I am',
    i_tend_to: 'I tend to',
    i_believe: 'I believe',
    i_learned: "I've learned",
  };

  // Filter is a virtual view: review / accepted / dismissed, or a companion id.
  type Filter = 'review' | 'accepted' | 'dismissed' | string;

  let entries = $state<Entry[]>([]);
  let companions = $state<Companion[]>([]);
  let filter = $state<Filter>('review');
  let loading = $state(true);
  let error = $state<string | null>(null);
  let rowBusy = $state<string | null>(null);
  let rowError = $state<string | null>(null);

  // Inline reword state
  let editingId = $state<string | null>(null);
  let editContent = $state('');

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [skRes, compRes] = await Promise.all([
        apiFetch('/api/self-knowledge?limit=200'),
        // The companions API exposes the registry ({ companions: [...] }); if it
        // isn't reachable we derive the chip set from the entries themselves.
        apiFetch('/api/companions').catch(() => null),
      ]);
      if (!skRes.ok) throw new Error(`Failed to load self-knowledge (${skRes.status})`);
      const skData = await skRes.json();
      entries = Array.isArray(skData.entries) ? skData.entries : [];
      if (compRes && compRes.ok) {
        const compData = await compRes.json();
        const list = Array.isArray(compData) ? compData : compData.companions;
        if (Array.isArray(list) && list.length) {
          companions = list.map((c: { id: string; display_name?: string }) => ({
            id: c.id,
            display_name: c.display_name || c.id,
          }));
        }
      }
      if (!companions.length) {
        // Derive from the entries we have, minus 'shared'.
        const ids = [...new Set(entries.map((e) => e.companion_id))].filter((id) => id !== 'shared');
        companions = ids.map((id) => ({ id, display_name: id.charAt(0).toUpperCase() + id.slice(1) }));
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function review(entry: Entry, status: 'accepted' | 'dismissed'): Promise<void> {
    rowBusy = entry.id;
    rowError = null;
    try {
      const res = await api.post(`/api/self-knowledge/${entry.id}/review`, { status });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Review failed (${res.status})`);
      }
      const updated = await res.json();
      entries = entries.map((e) => (e.id === entry.id ? updated : e));
    } catch (e) {
      rowError = e instanceof Error ? e.message : String(e);
    } finally {
      rowBusy = null;
    }
  }

  function startEdit(entry: Entry): void {
    editingId = entry.id;
    editContent = entry.content;
    rowError = null;
  }

  function cancelEdit(): void {
    editingId = null;
    rowError = null;
  }

  async function saveEdit(entry: Entry): Promise<void> {
    if (!editContent.trim()) return;
    rowBusy = entry.id;
    rowError = null;
    try {
      const res = await api.patch(`/api/self-knowledge/${entry.id}`, { content: editContent.trim() });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      const updated = await res.json();
      entries = entries.map((e) => (e.id === entry.id ? updated : e));
      editingId = null;
    } catch (e) {
      rowError = e instanceof Error ? e.message : String(e);
    } finally {
      rowBusy = null;
    }
  }

  async function remove(entry: Entry): Promise<void> {
    rowBusy = entry.id;
    rowError = null;
    try {
      const res = await api.delete(`/api/self-knowledge/${entry.id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed (${res.status})`);
      }
      entries = entries.filter((e) => e.id !== entry.id);
    } catch (e) {
      rowError = e instanceof Error ? e.message : String(e);
    } finally {
      rowBusy = null;
    }
  }

  function displayName(id: string): string {
    if (id === 'shared') return 'Shared';
    return companions.find((c) => c.id === id)?.display_name || id;
  }

  const visible = $derived(
    entries.filter((e) => {
      if (filter === 'review') return e.status === 'proposed';
      if (filter === 'accepted') return e.status === 'accepted';
      if (filter === 'dismissed') return e.status === 'dismissed';
      return e.companion_id === filter && e.status !== 'dismissed';
    }),
  );
  const proposedCount = $derived(entries.filter((e) => e.status === 'proposed').length);

  onMount(load);

  // Live updates: re-fetch when a self_knowledge event bumps the store's version
  // signal. Skips the initial run so it doesn't double-fetch against onMount.
  let lastSeenVersion = -1;
  $effect(() => {
    const v = getSelfKnowledgeVersion();
    if (lastSeenVersion === -1) {
      lastSeenVersion = v;
      return;
    }
    if (v !== lastSeenVersion) {
      lastSeenVersion = v;
      load();
    }
  });
</script>

<div class="sk-panel">
  <header class="panel-head">
    <h2 class="panel-title">Self-Knowledge</h2>
    <p class="panel-desc">
      Who the companions have <em>become</em> — not the persona bedrock they were
      written with, but the wear patterns in the stone, distilled from journals
      and dreams. A companion proposes an entry; the owner accepts it into
      identity. This is your window to review, reword, or overturn any of it.
    </p>
  </header>

  <!-- Filter chips — same chip pattern as MemoryPanel's section nav -->
  <div class="section-nav">
    <button
      type="button"
      class="res-chip"
      class:res-chip--active={filter === 'review'}
      onclick={() => (filter = 'review')}
    >
      To review{#if proposedCount}<span class="chip-badge">{proposedCount}</span>{/if}
    </button>
    <button
      type="button"
      class="res-chip"
      class:res-chip--active={filter === 'accepted'}
      onclick={() => (filter = 'accepted')}
    >
      Accepted
    </button>
    {#each companions as c (c.id)}
      <button
        type="button"
        class="res-chip"
        class:res-chip--active={filter === c.id}
        onclick={() => (filter = c.id)}
      >
        {c.display_name}
      </button>
    {/each}
    <button
      type="button"
      class="res-chip"
      class:res-chip--active={filter === 'dismissed'}
      onclick={() => (filter = 'dismissed')}
    >
      Dismissed
    </button>
  </div>

  {#if loading}
    <p class="loading-text">Loading self-knowledge…</p>
  {:else if error}
    <div class="error-box">
      <p class="error-title">Couldn't load self-knowledge</p>
      <p class="error-detail">{error}</p>
      <button class="res-btn res-btn--ghost res-btn--sm" onclick={load}>Retry</button>
    </div>
  {:else if visible.length === 0}
    <p class="empty-text">
      {#if filter === 'review'}
        Nothing to review yet. What the companions learn about themselves surfaces here.
      {:else}
        Nothing here yet.
      {/if}
    </p>
  {:else}
    <div class="entry-list">
      {#each visible as entry (entry.id)}
        {@const dismissed = entry.status === 'dismissed'}
        {@const proposed = entry.status === 'proposed'}
        <div class="entry-card" class:dismissed>
          <div class="entry-top">
            <span class="who">{displayName(entry.companion_id)}</span>
            <span class="cat-badge">{CATEGORY_LABEL[entry.category] || entry.category}</span>
            {#if entry.status === 'accepted'}
              <span class="status-badge accepted" title="Accepted into identity">accepted</span>
            {/if}
            {#if entry.source_type}
              <span class="source">from {entry.source_type}</span>
            {/if}
          </div>

          {#if editingId === entry.id}
            <textarea class="edit-area" bind:value={editContent} rows="3"></textarea>
            <div class="entry-actions">
              <button class="res-btn res-btn--primary res-btn--sm" onclick={() => saveEdit(entry)} disabled={rowBusy === entry.id}>
                {rowBusy === entry.id ? 'Saving…' : 'Save'}
              </button>
              <button class="res-btn res-btn--ghost res-btn--sm" onclick={cancelEdit} disabled={rowBusy === entry.id}>Cancel</button>
            </div>
          {:else}
            <p class="entry-content">{entry.content}</p>
            <div class="entry-actions">
              {#if proposed}
                <button class="res-btn res-btn--primary res-btn--sm" onclick={() => review(entry, 'accepted')} disabled={rowBusy === entry.id}>
                  {rowBusy === entry.id ? '…' : 'Accept'}
                </button>
                <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => review(entry, 'dismissed')} disabled={rowBusy === entry.id}>
                  Dismiss
                </button>
                <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => startEdit(entry)} disabled={rowBusy === entry.id}>
                  Reword
                </button>
              {:else}
                {#if dismissed}
                  <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => review(entry, 'accepted')} disabled={rowBusy === entry.id}>
                    Restore
                  </button>
                {:else}
                  <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => startEdit(entry)} disabled={rowBusy === entry.id}>
                    Reword
                  </button>
                  <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => review(entry, 'dismissed')} disabled={rowBusy === entry.id}>
                    Dismiss
                  </button>
                {/if}
                <button class="res-btn res-btn--ghost res-btn--sm delete-trigger" onclick={() => remove(entry)} disabled={rowBusy === entry.id}>
                  Delete
                </button>
              {/if}
            </div>
          {/if}

          {#if rowError && rowBusy === null && (editingId === entry.id || visible.some((v) => v.id === entry.id))}
            <p class="row-error">{rowError}</p>
          {/if}
        </div>
      {/each}
    </div>
    <button class="res-btn res-btn--ghost res-btn--sm refresh-btn" onclick={load}>Refresh</button>
  {/if}
</div>

<style>
  .sk-panel {
    max-width: 640px;
  }

  .panel-head {
    margin-bottom: 1.25rem;
  }

  .panel-title {
    font-size: 1.125rem;
    font-weight: 500;
    color: var(--text-primary);
    margin: 0 0 0.375rem;
  }

  .panel-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }

  .section-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  }

  .chip-badge {
    margin-left: 0.35rem;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    opacity: 0.85;
  }

  .loading-text,
  .empty-text {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    padding: 2rem 0;
  }

  .empty-text {
    text-align: center;
  }

  .error-box {
    padding: 1.5rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .error-title {
    color: var(--text-primary);
    font-weight: 500;
    margin: 0 0 0.5rem;
  }

  .error-detail {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin: 0 0 1rem;
  }

  /* ── Entry list ─────────────────────────────────────────────── */
  .entry-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .entry-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius);
    padding: 0.75rem 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color var(--transition-fast);
  }

  .entry-card:hover {
    border-color: var(--border-hover);
    border-left-color: var(--accent);
  }

  .entry-card.dismissed {
    opacity: 0.55;
  }

  .entry-top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .who {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-primary);
  }

  .cat-badge {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.0625rem 0.375rem;
    border-radius: 2rem;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  .status-badge.accepted {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.0625rem 0.375rem;
    border-radius: 2rem;
    border: 1px solid var(--accent);
    color: var(--accent);
    background: var(--bg-active);
  }

  .source {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .entry-content {
    font-size: 0.875rem;
    color: var(--text-primary);
    line-height: 1.55;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .edit-area {
    padding: 0.5rem 0.625rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: var(--font-mono);
    width: 100%;
    resize: vertical;
    line-height: 1.5;
  }

  .edit-area:focus {
    outline: none;
    border-color: var(--accent-muted, var(--accent));
    box-shadow: 0 0 0 2px var(--gold-glow, transparent);
  }

  .entry-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .delete-trigger {
    margin-left: auto;
  }

  .row-error {
    font-size: 0.75rem;
    color: var(--color-warning, #f59e0b);
    margin: 0;
  }

  .refresh-btn {
    margin-top: 1.25rem;
  }
</style>
