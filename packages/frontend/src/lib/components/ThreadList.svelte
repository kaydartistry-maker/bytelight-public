<script lang="ts">
  import type { ThreadSummary } from '@bytelight/shared';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { apiFetch } from '$lib/utils/api';
  import { isRecentlyActive } from '$lib/utils/threadRecency';

  let {
    threads = [],
    activeThreadId = null,
    routingThreadId = null,
    onselect,
    oncreate,
    ondelete,
    loadThreads,
  } = $props<{
    threads: ThreadSummary[];
    activeThreadId: string | null;
    routingThreadId?: string | null;
    onselect?: (threadId: string) => void;
    oncreate?: () => void;
    ondelete?: (threadId: string) => void;
    loadThreads?: () => Promise<void> | void;
  }>();

  // Home marker (reference implementation's routing-dot, renamed): the routing thread is
  // where Discord, Telegram, and autonomous wakes land. User-facing copy says
  // "Home" — internal code keeps the routing vocabulary.
  let homePromptThreadId = $state<string | null>(null);
  let homePromptThreadName = $state('');

  function openHomePrompt(thread: ThreadSummary, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (thread.id === routingThreadId) return; // already Home
    homePromptThreadId = thread.id;
    homePromptThreadName = thread.name;
  }

  async function confirmHome() {
    if (!homePromptThreadId) return;
    try {
      await apiFetch(`/api/threads/${homePromptThreadId}/routing`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to set routing thread:', err);
      showToast('Failed to set Home thread', 'error');
    } finally {
      homePromptThreadId = null;
    }
  }

  function cancelHome() {
    homePromptThreadId = null;
  }

  let showArchived = $state(false);
  let archivedThreads = $state<ThreadSummary[]>([]);
  let contextMenuThread = $state<string | null>(null);
  let contextMenuIsArchived = $state(false);
  let renamingThread = $state<string | null>(null);
  let renameValue = $state('');
  let deleteConfirm = $state<string | null>(null);
  let collapsedMonths = $state<Set<string>>(new Set());
  let namedCollapsed = $state(true);
  let monthsInitialized = false;
  let filterQuery = $state('');

  function getMonthKey(dateStr: string | null): string {
    const d = dateStr ? new Date(dateStr) : new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function getMonthLabel(key: string): string {
    const [year, month] = key.split('-');
    const d = new Date(parseInt(year), parseInt(month) - 1, 1);
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }

  const currentMonthKey = getMonthKey(null);

  // Filtered threads (client-side name filter)
  const filteredThreads = $derived(() => {
    if (!filterQuery.trim()) return threads;
    const q = filterQuery.toLowerCase();
    return threads.filter((t: ThreadSummary) => t.name.toLowerCase().includes(q));
  });

  // Group threads: pinned, active (recency), monthly groups for remaining daily, named
  const groupedThreads = $derived(() => {
    const source = filteredThreads();
    const pinnedThreads: ThreadSummary[] = [];
    const activeThreads: ThreadSummary[] = [];
    const namedThreads: ThreadSummary[] = [];
    const monthMap = new Map<string, { label: string; threads: ThreadSummary[] }>();
    const pinnedIds = new Set<string>();

    // If filtering, show flat list (no grouping)
    if (filterQuery.trim()) {
      return {
        pinned: [],
        active: [],
        months: [] as Array<[string, { label: string; threads: ThreadSummary[] }]>,
        named: [],
        filtered: source,
      };
    }

    // First pass: collect pinned threads (includes pinned Home — it stays here,
    // never falls through into the Active recency group)
    source.forEach((thread: ThreadSummary) => {
      if (thread.pinned_at) {
        pinnedThreads.push(thread);
        pinnedIds.add(thread.id);
      }
    });
    pinnedThreads.sort((a, b) => (a.pinned_at! > b.pinned_at! ? 1 : -1));

    // Second pass: group non-pinned threads.
    // A thread surfaces in "Active" if it's the active thread OR was touched
    // within the rolling recency window — type-agnostic, so a recently-touched
    // named thread surfaces here too. Everything else keeps its existing home:
    // daily → month bucket, named → named section.
    const now = Date.now();
    source.forEach((thread: ThreadSummary) => {
      if (pinnedIds.has(thread.id)) return;
      if (thread.id === activeThreadId || isRecentlyActive(thread.last_activity_at, now)) {
        activeThreads.push(thread);
      } else if (thread.type === 'daily') {
        const key = getMonthKey(thread.last_activity_at);
        if (!monthMap.has(key)) {
          monthMap.set(key, { label: getMonthLabel(key), threads: [] });
        }
        monthMap.get(key)!.threads.push(thread);
      } else {
        namedThreads.push(thread);
      }
    });

    const months = Array.from(monthMap.entries()).sort((a, b) => b[0].localeCompare(a[0]));

    return {
      pinned: pinnedThreads,
      active: activeThreads,
      months,
      named: namedThreads,
      filtered: null as ThreadSummary[] | null,
    };
  });

  // Initialize collapsed state via effect — no side effects in derived
  $effect(() => {
    const { months } = groupedThreads();
    if (monthsInitialized || months.length === 0) return;
    monthsInitialized = true;

    const collapsed = new Set<string>();
    const activeThread = threads.find((t: ThreadSummary) => t.id === activeThreadId);
    const activeMonthKey = activeThread?.type === 'daily' ? getMonthKey(activeThread.last_activity_at) : null;

    const effectiveActiveKey = (activeMonthKey && activeMonthKey !== currentMonthKey) ? activeMonthKey : null;
    for (const [key] of months) {
      if (key !== effectiveActiveKey) {
        collapsed.add(key);
      }
    }
    collapsedMonths = collapsed;
  });

  function toggleMonth(key: string) {
    const next = new Set(collapsedMonths);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedMonths = next;
  }

  function toggleNamed() {
    namedCollapsed = !namedCollapsed;
  }

  function handleSelect(threadId: string) {
    onselect?.(threadId);
  }

  function handleCreate() {
    oncreate?.();
  }

  async function handleArchive(threadId: string) {
    try {
      const response = await apiFetch(`/api/threads/${threadId}/archive`, { method: 'POST' });
      if (response.ok) {
        contextMenuThread = null;
        // If this was the active thread, select the next one
        if (activeThreadId === threadId) {
          const nextId = getNextThreadIdAfterDelete(threadId);
          if (nextId) onselect?.(nextId);
        }
        await loadThreads?.();
        if (showArchived) await loadArchived();
        showToast('Thread archived', 'success');
      } else {
        showToast('Failed to archive thread', 'error');
      }
    } catch (err) {
      console.error('Failed to archive thread:', err);
      showToast('Failed to archive thread', 'error');
    }
  }

  async function handleUnarchive(threadId: string) {
    try {
      const response = await apiFetch(`/api/threads/${threadId}/unarchive`, { method: 'POST' });
      if (response.ok) {
        contextMenuThread = null;
        await loadThreads?.();
        await loadArchived();
        showToast('Thread restored', 'success');
      } else {
        const data = await response.json().catch(() => ({}));
        showToast(data.error || 'Failed to restore thread', 'error');
      }
    } catch (err) {
      console.error('Failed to unarchive thread:', err);
      showToast('Failed to restore thread', 'error');
    }
  }

  function startRename(threadId: string, currentName: string) {
    contextMenuThread = null;
    renamingThread = threadId;
    renameValue = currentName;
  }

  async function commitRename(threadId: string) {
    // Guard against double-fire: this is wired to both the input's
    // onblur AND (via handleRenameKeydown) the Enter key. Enter-calls-
    // commitRename → commit finishes → renamingThread nulled → input
    // unmounts → browser fires implicit blur → onblur calls commitRename
    // again. Escape → cancelRename also nulls renamingThread with the
    // same unmount-blur tail. Bail here if the thread is no longer the
    // active one being renamed.
    if (renamingThread !== threadId) return;

    if (!renameValue.trim()) {
      renamingThread = null;
      return;
    }

    // Null BEFORE the async work so any blur-triggered re-entry trips
    // the guard above rather than racing with the fetch.
    renamingThread = null;

    try {
      const response = await apiFetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      if (response.ok) {
        showToast('Thread renamed', 'success');
      } else {
        console.error('Failed to rename thread');
        showToast('Failed to rename thread', 'error');
      }
    } catch (err) {
      console.error('Failed to rename thread:', err);
      showToast('Failed to rename thread', 'error');
    }
  }

  function cancelRename() {
    renamingThread = null;
    renameValue = '';
  }

  function handleRenameKeydown(e: KeyboardEvent, threadId: string) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename(threadId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }

  function startDelete(threadId: string) {
    contextMenuThread = null;
    deleteConfirm = threadId;
  }

  async function confirmDelete(threadId: string) {
    try {
      const response = await apiFetch(`/api/threads/${threadId}`, { method: 'DELETE' });
      if (response.ok) {
        // Auto-select next thread if the deleted one was active
        if (activeThreadId === threadId) {
          const nextId = getNextThreadIdAfterDelete(threadId);
          if (nextId) onselect?.(nextId);
        }
        // Notify parent and refresh thread list
        ondelete?.(threadId);
        await loadThreads?.();
        if (showArchived) await loadArchived();
        showToast('Thread deleted', 'success');
      } else {
        console.error('Failed to delete thread');
        showToast('Failed to delete thread', 'error');
      }
    } catch (err) {
      console.error('Failed to delete thread:', err);
      showToast('Failed to delete thread', 'error');
    }
    deleteConfirm = null;
  }

  function cancelDelete() {
    deleteConfirm = null;
  }

  async function loadArchived() {
    try {
      const response = await apiFetch('/api/threads/archived');
      if (response.ok) {
        const data = await response.json();
        archivedThreads = data.threads;
      }
    } catch (err) {
      console.error('Failed to load archived threads:', err);
    }
  }

  function toggleArchived() {
    showArchived = !showArchived;
    if (showArchived) loadArchived();
  }

  async function handlePin(threadId: string) {
    try {
      await apiFetch(`/api/threads/${threadId}/pin`, { method: 'POST' });
      contextMenuThread = null;
    } catch (err) {
      console.error('Failed to pin thread:', err);
    }
  }

  async function handleUnpin(threadId: string) {
    try {
      await apiFetch(`/api/threads/${threadId}/unpin`, { method: 'POST' });
      contextMenuThread = null;
    } catch (err) {
      console.error('Failed to unpin thread:', err);
    }
  }

  let contextMenuPos = $state<{ x: number; y: number }>({ x: 0, y: 0 });

  function toggleContextMenu(threadId: string, e: MouseEvent, archived = false) {
    e.preventDefault();
    e.stopPropagation();
    if (contextMenuThread === threadId) {
      contextMenuThread = null;
      return;
    }
    // Position menu at click coordinates, fixed to viewport
    const menuHeight = 200;
    const y = e.clientY + menuHeight > window.innerHeight
      ? e.clientY - menuHeight
      : e.clientY;
    contextMenuPos = { x: e.clientX, y };
    contextMenuIsArchived = archived;
    contextMenuThread = threadId;
  }

  function getContextMenuThread(): ThreadSummary | undefined {
    if (!contextMenuThread) return undefined;
    const source = contextMenuIsArchived ? archivedThreads : threads;
    return source.find((thread: ThreadSummary) => thread.id === contextMenuThread);
  }

  function getNextThreadIdAfterDelete(deletedId: string): string | null {
    const idx = threads.findIndex((t: ThreadSummary) => t.id === deletedId);
    if (idx === -1) return threads.length > 0 ? threads[0].id : null;
    // Prefer the next thread, fall back to previous
    if (idx < threads.length - 1) return threads[idx + 1].id;
    if (idx > 0) return threads[idx - 1].id;
    return null;
  }
</script>

{#snippet threadItem(thread: ThreadSummary)}
  {#if renamingThread === thread.id}
    <div class="rename-input-wrapper">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="rename-input"
        type="text"
        bind:value={renameValue}
        onkeydown={(e) => handleRenameKeydown(e, thread.id)}
        onblur={() => commitRename(thread.id)}
        autofocus
      />
    </div>
  {:else}
    <div class="thread-item-wrapper">
      <button
        class="thread-item"
        class:active={thread.id === activeThreadId}
        onclick={() => handleSelect(thread.id)}
        oncontextmenu={(e) => toggleContextMenu(thread.id, e)}
      >
        <span class="thread-name">{thread.name}</span>
        {#if thread.unread_count > 0}
          <span class="unread-badge">{thread.unread_count}</span>
        {/if}
      </button>
      <button
        class="home-marker"
        class:home-active={thread.id === routingThreadId}
        title={thread.id === routingThreadId ? 'Home thread — Discord, Telegram, and wakes land here' : 'Make this thread Home'}
        aria-label={thread.id === routingThreadId ? 'Home thread' : 'Make this thread Home'}
        onclick={(e) => openHomePrompt(thread, e)}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
      </button>
    </div>
  {/if}
{/snippet}

<aside class="thread-list" aria-label="Thread list">
  <div class="thread-groups">
    {#if showArchived}
      <!-- Archive view -->
      <div class="thread-group">
        <h3 class="group-title">Archived</h3>
        {#if archivedThreads.length === 0}
          <p class="empty-filter">No archived threads</p>
        {:else}
          {#each archivedThreads as thread (thread.id)}
            <div class="thread-item-wrapper">
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="thread-item archived"
                role="listitem"
                oncontextmenu={(e) => toggleContextMenu(thread.id, e, true)}
              >
                <span class="thread-name">{thread.name}</span>
                <button class="restore-btn" onclick={() => handleUnarchive(thread.id)}>Restore</button>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      <!-- Active threads view -->
      <div class="filter-input-wrapper">
        <input
          class="filter-input"
          type="text"
          placeholder="Filter threads..."
          bind:value={filterQuery}
        />
        {#if filterQuery}
          <button class="filter-clear" onclick={() => filterQuery = ''} aria-label="Clear filter">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        {/if}
      </div>

      {#if groupedThreads().filtered}
        {#each groupedThreads().filtered as thread (thread.id)}
          {@render threadItem(thread)}
        {/each}
        {#if groupedThreads().filtered.length === 0}
          <p class="empty-filter">No matching threads</p>
        {/if}
      {:else}
        {#if groupedThreads().pinned.length > 0}
          <div class="thread-group">
            <h3 class="group-title pinned-title">Pinned</h3>
            {#each groupedThreads().pinned as thread (thread.id)}
              {@render threadItem(thread)}
            {/each}
          </div>
        {/if}

        {#if groupedThreads().active.length > 0}
          <div class="thread-group">
            <h3 class="group-title">Active</h3>
            {#each groupedThreads().active as thread (thread.id)}
              {@render threadItem(thread)}
            {/each}
          </div>
        {/if}

        {#each groupedThreads().months as [key, group]}
          <div class="thread-group">
            <button class="group-title collapsible" onclick={() => toggleMonth(key)}>
              <span class="group-chevron">{collapsedMonths.has(key) ? '▸' : '▾'}</span>
              {group.label}
              <span class="group-count">{group.threads.length}</span>
            </button>
            {#if !collapsedMonths.has(key)}
              {#each group.threads as thread (thread.id)}
                {@render threadItem(thread)}
              {/each}
            {/if}
          </div>
        {/each}

        {#if groupedThreads().named.length > 0}
          <div class="thread-group">
            <button class="group-title collapsible" onclick={toggleNamed}>
              <span class="group-chevron">{namedCollapsed ? '▸' : '▾'}</span>
              Named
              <span class="group-count">{groupedThreads().named.length}</span>
            </button>
            {#if !namedCollapsed}
              {#each groupedThreads().named as thread (thread.id)}
                {@render threadItem(thread)}
              {/each}
            {/if}
          </div>
        {/if}
      {/if}
    {/if}
  </div>

  <div class="thread-actions">
    <button class="action-button" class:active={showArchived} onclick={toggleArchived}>
      {showArchived ? 'Back to Threads' : 'Archive'}
    </button>
    <button class="new-thread-button" onclick={handleCreate}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14M5 12h14"/>
      </svg>
      New Thread
    </button>
  </div>
</aside>

<!-- Context menu (fixed, outside all overflow containers) -->
{#if contextMenuThread}
  {@const menuThread = getContextMenuThread()}
  {#if menuThread}
    <div class="context-menu" style="left: {contextMenuPos.x}px; top: {contextMenuPos.y}px;">
      {#if contextMenuIsArchived}
        <button onclick={() => handleUnarchive(menuThread.id)}>Restore</button>
        <button class="context-delete" onclick={() => startDelete(menuThread.id)}>Delete</button>
      {:else}
        {#if menuThread.pinned_at}
          <button onclick={() => handleUnpin(menuThread.id)}>Unpin</button>
        {:else}
          <button onclick={() => handlePin(menuThread.id)}>Pin</button>
        {/if}
        {#if menuThread.type === 'named'}
          <button onclick={() => startRename(menuThread.id, menuThread.name)}>Rename</button>
        {/if}
        <button onclick={() => handleArchive(menuThread.id)}>Archive</button>
        <button class="context-delete" onclick={() => startDelete(menuThread.id)}>Delete</button>
      {/if}
    </div>
  {/if}
{/if}

<ConfirmDialog
  open={deleteConfirm !== null}
  title="Delete this thread?"
  message="This can't be undone."
  confirmLabel="Delete"
  cancelLabel="Cancel"
  destructive={true}
  onconfirm={() => { if (deleteConfirm) confirmDelete(deleteConfirm); }}
  oncancel={cancelDelete}
/>

<ConfirmDialog
  open={homePromptThreadId !== null}
  title="Make this thread Home?"
  message={`Discord, Telegram, and autonomous wakes will land in "${homePromptThreadName}" until you move Home.`}
  confirmLabel="Make Home"
  cancelLabel="Cancel"
  onconfirm={confirmHome}
  oncancel={cancelHome}
/>

<style>
  .thread-list {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
  }

  .thread-groups {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0 1rem;
  }

  .filter-input-wrapper {
    position: relative;
    padding: 0.5rem 0.75rem;
  }

  .filter-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    padding-right: 2rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.8125rem;
    outline: none;
    transition: border-color var(--transition);
  }

  .filter-input:focus {
    border-color: var(--gold-dim);
  }

  .filter-input::placeholder {
    color: var(--text-muted);
  }

  .filter-clear {
    position: absolute;
    right: 1.25rem;
    top: 50%;
    transform: translateY(-50%);
    padding: 0.25rem;
    color: var(--text-muted);
    border-radius: 0.25rem;
    cursor: pointer;
    transition: color 0.15s;
  }

  .filter-clear:hover {
    color: var(--text-primary);
  }

  .empty-filter {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8125rem;
    padding: 1.5rem 1rem;
  }

  .pinned-title {
    color: var(--gold);
  }

  .thread-group {
    margin-bottom: 1.5rem;
  }

  .group-title {
    font-family: var(--font-heading);
    font-size: 0.6875rem;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--gold-dim);
    padding: 0 1.25rem;
    margin-bottom: 0.5rem;
    border: none;
  }

  .group-title.collapsible {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    background: transparent;
    cursor: pointer;
    transition: color var(--transition);
  }

  .group-title.collapsible:hover {
    color: var(--gold);
  }

  .group-chevron {
    font-size: 0.5rem;
    width: 0.75rem;
    flex-shrink: 0;
  }

  .group-count {
    margin-left: auto;
    font-size: 0.625rem;
    color: var(--text-muted);
    font-family: var(--font-mono, monospace);
  }

  .thread-item-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  /* Home marker — the routing thread indicator (reference implementation's routing-dot,
     rendered as a house so it doesn't collide with pin/star vocabulary) */
  .home-marker {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0.25rem;
    margin: 0 0.5rem 0 0.125rem;
    background: transparent;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    cursor: pointer;
    opacity: 0.35;
    transition: all var(--transition);
  }

  .home-marker:hover {
    opacity: 1;
    color: var(--gold);
  }

  .home-marker.home-active {
    opacity: 1;
    color: var(--gold);
    cursor: default;
  }

  .thread-item {
    width: 100%;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.25rem;
    text-align: left;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.9375rem;
    transition: all var(--transition);
    cursor: pointer;
  }

  .thread-item:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .thread-item.active {
    background: var(--bg-surface);
    color: var(--text-accent);
    border-left: 2px solid var(--gold);
    padding-left: calc(1.25rem - 2px);
  }

  .thread-item.archived {
    opacity: 0.6;
    font-style: italic;
  }

  .thread-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .unread-badge {
    background: var(--gold-dim);
    color: var(--bg-primary);
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0.0625rem 0.375rem;
    border-radius: 0.75rem;
    margin-left: 0.5rem;
  }

  .context-menu {
    position: fixed;
    z-index: 300;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.25rem;
    margin: 0 0.5rem;
    min-width: 10rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .context-menu button {
    width: 100%;
    padding: 0.5rem 0.75rem;
    text-align: left;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.875rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .context-menu button:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .context-delete {
    color: var(--color-error) !important;
  }

  .context-delete:hover {
    background: rgba(239, 68, 68, 0.1) !important;
    color: #f87171 !important;
  }

  .rename-input-wrapper {
    padding: 0.375rem 0.75rem;
  }

  .rename-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--gold-dim);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.9375rem;
    outline: none;
  }

  .rename-input:focus {
    border-color: var(--gold);
  }

  /* Delete confirm styles removed — now using ConfirmDialog component */

  .thread-actions {
    display: flex;
    border-top: 1px solid var(--border);
  }

  .action-button {
    flex: 1;
    padding: 0.875rem;
    background: transparent;
    color: var(--text-muted);
    font-size: 0.8125rem;
    transition: all var(--transition);
    cursor: pointer;
  }

  .action-button:hover {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
  }

  .new-thread-button {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.875rem;
    background: transparent;
    color: var(--gold-dim);
    font-size: 0.8125rem;
    font-weight: 500;
    border-left: 1px solid var(--border);
    transition: all var(--transition);
  }

  .new-thread-button:hover {
    background: var(--gold-ember);
    color: var(--gold);
  }

  .restore-btn {
    padding: 0.25rem 0.625rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--accent);
    background: transparent;
    border: 1px solid var(--accent);
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .restore-btn:hover {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--text-primary);
  }

  .action-button.active {
    color: var(--accent);
  }

  @media (max-width: 768px) {
    .thread-list {
      position: fixed;
      top: 0;
      left: 0;
      width: 80%;
      max-width: 20rem;
      z-index: 100;
      box-shadow: 2px 0 8px var(--shadow);
      padding-top: env(safe-area-inset-top, 0px);
    }

  }
</style>
