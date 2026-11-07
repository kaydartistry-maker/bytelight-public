<!--
  MemoryPanel.svelte — the operator's window into the companions' core memory.

  Rebuilt (not ported line-for-line) against byte-light's Settings design
  language from reference implementation's MemoryBlocksApp.tsx (Apache 2.0) — feature parity,
  byte-light styling. Three views:
    • Blocks   — every block, shared-first, click to expand → inline edit / delete
    • Create   — scope / label / description / content → POST
    • Archivist — manual extraction run + live {processed, applied} result

  All fetches go through the api/apiFetch wrapper. Live edits from
  the companions (or the CLI) arrive via the `memory_block_updated` WS event,
  surfaced by the websocket store's getMemoryBlockVersion() signal — an $effect
  re-fetches the list whenever it bumps, so the panel stays fresh while open.
-->
<script lang="ts">
  import { timeAgo } from '$lib/utils/time';
  import { onMount } from 'svelte';
  import { api, apiFetch } from '$lib/utils/api';
  import { getMemoryBlockVersion } from '$lib/stores/websocket.svelte';

  interface MemoryBlock {
    scope: string;
    label: string;
    content: string;
    description?: string;
    updated_at: string;
  }

  const SHARED_SCOPE = 'shared';
  // Scopes for this house: shared + the companion slugs. Kept as a small
  // constant (byte-light has no /api/companions endpoint — the memory service
  // validates against exactly this set server-side).
  const SCOPES = [SHARED_SCOPE, 'companion-a', 'companion-b'] as const;

  type Section = 'blocks' | 'create' | 'archivist';

  let blocks = $state<MemoryBlock[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let activeSection = $state<Section>('blocks');

  // Blocks view — expansion + inline edit + delete-confirm
  let expandedKey = $state<string | null>(null);
  let editingKey = $state<string | null>(null);
  let editContent = $state('');
  let editDescription = $state('');
  let confirmDeleteKey = $state<string | null>(null);
  let rowBusy = $state<string | null>(null);
  let rowError = $state<string | null>(null);

  // Create view
  let newScope = $state<string>(SHARED_SCOPE);
  let newLabel = $state('');
  let newDescription = $state('');
  let newContent = $state('');
  let creating = $state(false);
  let createMessage = $state('');

  // Archivist view
  let extracting = $state(false);
  let extractResult = $state<{ processed: number; applied: number } | null>(null);
  let extractError = $state<string | null>(null);
  let extractThreadId = $state('');

  function blockKey(b: { scope: string; label: string }): string {
    return `${b.scope}/${b.label}`;
  }

  function blockUrl(scope: string, label: string): string {
    return `/api/memory/blocks/${encodeURIComponent(scope)}/${encodeURIComponent(label)}`;
  }

  function sortBlocks(list: MemoryBlock[]): MemoryBlock[] {
    // Shared first, then companion scopes alphabetically, then by label.
    return [...list].sort(
      (a, b) =>
        (a.scope === SHARED_SCOPE ? '' : a.scope).localeCompare(b.scope === SHARED_SCOPE ? '' : b.scope) ||
        a.label.localeCompare(b.label),
    );
  }

  async function loadBlocks(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await apiFetch('/api/memory/blocks');
      if (!res.ok) throw new Error(`Failed to load memory blocks (${res.status})`);
      const data = await res.json();
      blocks = sortBlocks(Array.isArray(data) ? data : []);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function toggleExpand(block: MemoryBlock): void {
    const key = blockKey(block);
    if (expandedKey === key) {
      expandedKey = null;
      editingKey = null;
      confirmDeleteKey = null;
      rowError = null;
      return;
    }
    expandedKey = key;
    editingKey = null;
    confirmDeleteKey = null;
    rowError = null;
  }

  function startEdit(block: MemoryBlock): void {
    editingKey = blockKey(block);
    editContent = block.content;
    editDescription = block.description ?? '';
    confirmDeleteKey = null;
    rowError = null;
  }

  function cancelEdit(): void {
    editingKey = null;
    rowError = null;
  }

  async function saveEdit(block: MemoryBlock): Promise<void> {
    const key = blockKey(block);
    rowBusy = key;
    rowError = null;
    try {
      const res = await api.put(blockUrl(block.scope, block.label), {
        content: editContent,
        description: editDescription || undefined,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      editingKey = null;
      await loadBlocks();
    } catch (e) {
      rowError = e instanceof Error ? e.message : String(e);
    } finally {
      rowBusy = null;
    }
  }

  async function confirmDelete(block: MemoryBlock): Promise<void> {
    const key = blockKey(block);
    rowBusy = key;
    rowError = null;
    try {
      const res = await api.delete(blockUrl(block.scope, block.label));
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed (${res.status})`);
      }
      confirmDeleteKey = null;
      if (expandedKey === key) expandedKey = null;
      await loadBlocks();
    } catch (e) {
      rowError = e instanceof Error ? e.message : String(e);
    } finally {
      rowBusy = null;
    }
  }

  async function createBlock(): Promise<void> {
    if (!newLabel.trim()) return;
    creating = true;
    createMessage = '';
    try {
      const res = await api.post('/api/memory/blocks', {
        scope: newScope,
        label: newLabel.trim(),
        description: newDescription.trim() || undefined,
        content: newContent,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Create failed (${res.status})`);
      }
      newLabel = '';
      newDescription = '';
      newContent = '';
      createMessage = 'Created.';
      await loadBlocks();
      activeSection = 'blocks';
    } catch (e) {
      createMessage = `Error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      creating = false;
    }
  }

  async function runArchivist(): Promise<void> {
    extracting = true;
    extractResult = null;
    extractError = null;
    try {
      const res = await api.post('/api/memory/extract', {
        ...(extractThreadId.trim() ? { threadId: extractThreadId.trim() } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Extraction failed (${res.status})`);
      extractResult = { processed: data.processed ?? 0, applied: data.applied ?? 0 };
      // A run that applied ops will fire memory_block_updated events; the
      // $effect below re-fetches. Refresh explicitly too, so the count lands
      // even if nothing changed.
      await loadBlocks();
    } catch (e) {
      extractError = e instanceof Error ? e.message : String(e);
    } finally {
      extracting = false;
    }
  }

  onMount(loadBlocks);

  // Live updates: re-fetch whenever a memory_block_updated event bumps the
  // websocket store's version signal — companions editing blocks from chat
  // (or the CLI) show up here without a manual refresh. Skips the initial
  // run so it doesn't double-fetch against onMount.
  let lastSeenVersion = -1;
  $effect(() => {
    const v = getMemoryBlockVersion();
    if (lastSeenVersion === -1) {
      lastSeenVersion = v;
      return;
    }
    if (v !== lastSeenVersion) {
      lastSeenVersion = v;
      loadBlocks();
    }
  });
</script>

<div class="memory-panel">
  <header class="panel-head">
    <h2 class="panel-title">Memory</h2>
    <p class="panel-desc">
      Letta-style core memory. Blocks scoped <code>shared</code> are seen by
      every companion; a companion slug scopes a block to that companion alone.
      The companions edit these in place mid-conversation — this is your window to do
      the same, and to run the Archivist by hand.
    </p>
  </header>

  <!-- Section nav — same chip pattern as MindPanel -->
  <div class="section-nav">
    <button type="button" class="res-chip" class:res-chip--active={activeSection === 'blocks'} onclick={() => (activeSection = 'blocks')}>Blocks</button>
    <button type="button" class="res-chip" class:res-chip--active={activeSection === 'create'} onclick={() => (activeSection = 'create')}>Create</button>
    <button type="button" class="res-chip" class:res-chip--active={activeSection === 'archivist'} onclick={() => (activeSection = 'archivist')}>Archivist</button>
  </div>

  {#if activeSection === 'blocks'}
    {#if loading}
      <p class="loading-text">Loading memory blocks…</p>
    {:else if error}
      <div class="error-box">
        <p class="error-title">Couldn't load memory</p>
        <p class="error-detail">{error}</p>
        <button class="res-btn res-btn--ghost res-btn--sm" onclick={loadBlocks}>Retry</button>
      </div>
    {:else if blocks.length === 0}
      <p class="empty-text">No memory blocks yet. Create one, or run the Archivist.</p>
    {:else}
      <div class="blocks-list">
        {#each blocks as block (blockKey(block))}
          {@const key = blockKey(block)}
          <div class="block-card" class:expanded={expandedKey === key}>
            <button class="block-row" onclick={() => toggleExpand(block)} aria-expanded={expandedKey === key}>
              <div class="block-main">
                <div class="block-title-row">
                  <span class="block-label">{block.label}</span>
                  <span class="scope-badge" class:shared={block.scope === SHARED_SCOPE}>{block.scope}</span>
                </div>
                {#if block.description}
                  <div class="block-desc">{block.description}</div>
                {/if}
                <div class="block-meta">
                  <span>{block.content.length} chars</span>
                  <span class="dot">·</span>
                  <span>updated {timeAgo(block.updated_at, { sqliteUtc: true })}</span>
                </div>
              </div>
              <svg class="chevron" class:open={expandedKey === key} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>

            {#if expandedKey === key}
              <div class="block-detail">
                {#if editingKey === key}
                  <label class="form-field">
                    <span class="form-label">Description <span class="hint">(optional)</span></span>
                    <input type="text" bind:value={editDescription} placeholder="What this block is for" />
                  </label>
                  <label class="form-field">
                    <span class="form-label">Content</span>
                    <textarea bind:value={editContent} rows="8"></textarea>
                  </label>
                  <div class="detail-actions">
                    <button class="res-btn res-btn--primary res-btn--sm" onclick={() => saveEdit(block)} disabled={rowBusy === key}>
                      {rowBusy === key ? 'Saving…' : 'Save'}
                    </button>
                    <button class="res-btn res-btn--ghost res-btn--sm" onclick={cancelEdit} disabled={rowBusy === key}>Cancel</button>
                  </div>
                {:else}
                  <pre class="block-content">{block.content || '(empty)'}</pre>
                  <div class="detail-actions">
                    <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => startEdit(block)}>Edit</button>
                    {#if confirmDeleteKey === key}
                      <button class="res-btn res-btn--danger res-btn--sm" onclick={() => confirmDelete(block)} disabled={rowBusy === key}>
                        {rowBusy === key ? 'Deleting…' : 'Confirm delete'}
                      </button>
                      <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => (confirmDeleteKey = null)}>Keep</button>
                    {:else}
                      <button class="res-btn res-btn--ghost res-btn--sm delete-trigger" onclick={() => (confirmDeleteKey = key)}>Delete</button>
                    {/if}
                  </div>
                {/if}
                {#if rowError}
                  <p class="row-error">{rowError}</p>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <button class="res-btn res-btn--ghost res-btn--sm refresh-btn" onclick={loadBlocks}>Refresh</button>
    {/if}

  {:else if activeSection === 'create'}
    <div class="create-form">
      <label class="form-field">
        <span class="form-label">Scope</span>
        <select bind:value={newScope}>
          {#each SCOPES as s}
            <option value={s}>{s === SHARED_SCOPE ? 'shared (all companions)' : s}</option>
          {/each}
        </select>
      </label>
      <label class="form-field">
        <span class="form-label">Label <span class="hint">(unique within scope)</span></span>
        <input type="text" bind:value={newLabel} placeholder="e.g. persona, human, status" />
      </label>
      <label class="form-field">
        <span class="form-label">Description <span class="hint">(optional)</span></span>
        <input type="text" bind:value={newDescription} placeholder="What this block is for" />
      </label>
      <label class="form-field">
        <span class="form-label">Content</span>
        <textarea bind:value={newContent} rows="8" placeholder="Block content…"></textarea>
      </label>
      <div class="detail-actions">
        <button class="res-btn res-btn--primary res-btn--sm" onclick={createBlock} disabled={creating || !newLabel.trim()}>
          {creating ? 'Creating…' : 'Create block'}
        </button>
      </div>
      {#if createMessage}
        <p class="create-msg" class:err={createMessage.startsWith('Error')}>{createMessage}</p>
      {/if}
    </div>

  {:else if activeSection === 'archivist'}
    <div class="archivist-card">
      <h3 class="archivist-title">Run the Archivist</h3>
      <p class="archivist-desc">
        The Archivist reads recent conversation and proposes durable memory
        edits, applying the safe ones in place. Leave the thread blank to run
        the normal candidate sweep, or scope it to one thread by ID to backfill
        just that conversation.
      </p>
      <label class="form-field">
        <span class="form-label">Thread ID <span class="hint">(optional — blank = full sweep)</span></span>
        <input type="text" bind:value={extractThreadId} placeholder="leave blank for the normal sweep" autocomplete="off" />
      </label>
      <div class="detail-actions">
        <button class="res-btn res-btn--primary res-btn--sm" onclick={runArchivist} disabled={extracting}>
          {extracting ? 'Running…' : 'Run Archivist now'}
        </button>
      </div>
      {#if extractResult}
        <div class="extract-result">
          Processed <strong>{extractResult.processed}</strong>
          {extractResult.processed === 1 ? 'thread' : 'threads'} · applied
          <strong>{extractResult.applied}</strong>
          memory {extractResult.applied === 1 ? 'edit' : 'edits'}.
        </div>
      {/if}
      {#if extractError}
        <div class="extract-result err">{extractError}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .memory-panel {
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

  .panel-desc code,
  .archivist-desc code {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    padding: 0 0.25rem;
    background: var(--bg-input);
    border-radius: 3px;
    color: var(--text-secondary);
  }

  .section-nav {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  }

  .loading-text {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    padding: 2rem 0;
  }

  .empty-text {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    padding: 2rem 0;
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

  /* ── Blocks list ─────────────────────────────────────────────── */
  .blocks-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .block-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    transition: border-color var(--transition-fast);
  }

  .block-card:hover {
    border-color: var(--border-hover);
  }

  .block-card.expanded {
    border-color: var(--accent);
  }

  .block-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    text-align: left;
    padding: 0.75rem 0.875rem;
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .block-main {
    flex: 1;
    min-width: 0;
  }

  .block-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .block-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-primary);
  }

  .scope-badge {
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

  .scope-badge.shared {
    border-color: var(--border);
    color: var(--text-muted);
    background: var(--bg-hover);
  }

  .block-desc {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin-top: 0.125rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .block-meta {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.6875rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .block-meta .dot {
    opacity: 0.6;
  }

  .chevron {
    color: var(--text-muted);
    flex-shrink: 0;
    transition: transform var(--transition-fast);
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .block-detail {
    padding: 0.75rem 0.875rem 0.875rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .block-content {
    font-size: 0.8125rem;
    font-family: var(--font-mono);
    color: var(--text-primary);
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    max-height: 22rem;
    overflow-y: auto;
  }

  .detail-actions {
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

  /* ── Forms (create + inline edit + archivist) ────────────────── */
  .create-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .form-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .form-label .hint {
    color: var(--text-muted);
    text-transform: none;
    font-size: 0.6875rem;
    letter-spacing: 0;
  }

  .form-field input,
  .form-field select,
  .form-field textarea {
    padding: 0.5rem 0.625rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: var(--font-mono);
    width: 100%;
  }

  .form-field textarea {
    resize: vertical;
    line-height: 1.5;
  }

  .form-field input:focus,
  .form-field select:focus,
  .form-field textarea:focus {
    outline: none;
    border-color: var(--accent-muted, var(--accent));
    box-shadow: 0 0 0 2px var(--gold-glow, transparent);
  }

  .create-msg {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
  }

  .create-msg.err {
    color: var(--color-warning, #f59e0b);
  }

  /* ── Archivist ───────────────────────────────────────────────── */
  .archivist-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .archivist-title {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--text-primary);
    margin: 0;
  }

  .archivist-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }

  .extract-result {
    padding: 0.625rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    background: var(--color-success-muted, var(--bg-active));
    color: var(--color-success, var(--accent));
  }

  .extract-result strong {
    font-weight: 600;
  }

  .extract-result.err {
    background: var(--color-warning-muted, var(--bg-hover));
    color: var(--color-warning, #f59e0b);
  }
</style>
