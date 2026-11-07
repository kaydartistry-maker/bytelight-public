<script lang="ts">
  import { timeAgo } from '$lib/utils/time';
  import type { Canvas } from '@bytelight/shared';
  import {
    getCanvases,
    getActiveCanvasId,
    setActiveCanvasId,
    sendCanvasCreate,
    sendCanvasDelete,
  } from '$lib/stores/websocket.svelte';

  let {
    onclose,
    embedded = false,
    stayOpenOnSelect = false,
  }: {
    onclose: () => void;
    embedded?: boolean;
    stayOpenOnSelect?: boolean;
  } = $props();

  let canvases = $derived(getCanvases());
  let activeCanvasId = $derived(getActiveCanvasId());

  // Search — filters title AND tags in one input
  let searchQuery = $state('');

  let filteredCanvases = $derived(() => {
    let result = canvases;
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(c =>
        c.title.toLowerCase().includes(q) ||
        c.tags?.some(t => t.toLowerCase().includes(q))
      );
    }
    if (activeTag) {
      result = result.filter(c => c.tags?.includes(activeTag!));
    }
    return result;
  });

  // New canvas form
  let showNewForm = $state(false);
  let newTitle = $state('');
  let newType = $state<'markdown' | 'code' | 'text' | 'html'>('markdown');
  let newLanguage = $state('');

  function handleCreate() {
    const title = newTitle.trim() || 'Untitled';
    sendCanvasCreate(title, newType, newType === 'code' ? newLanguage || undefined : undefined);
    newTitle = '';
    newType = 'markdown';
    newLanguage = '';
    showNewForm = false;
  }

  function handleSelect(id: string) {
    setActiveCanvasId(id);
    if (!stayOpenOnSelect) onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreate();
    } else if (e.key === 'Escape') {
      showNewForm = false;
    }
  }

  function contentPreview(content: string): string {
    // Strip markdown syntax for a clean preview
    return content
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*|__/g, '')
      .replace(/\*|_/g, '')
      .replace(/`{1,3}[^`]*`{1,3}/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\n+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  function handleWindowClick() {
    if (tagDropdownOpen) tagDropdownOpen = false;
  }

  // Tag filter dropdown
  let activeTag = $state<string | null>(null);
  let tagDropdownOpen = $state(false);
  let tagSearch = $state('');

  let allTags = $derived(() => {
    const tagSet = new Set<string>();
    for (const c of canvases) {
      if (c.tags) for (const t of c.tags) tagSet.add(t);
    }
    return [...tagSet].sort();
  });

  let filteredTags = $derived(() => {
    const q = tagSearch.trim().toLowerCase();
    if (!q) return allTags();
    return allTags().filter(t => t.toLowerCase().includes(q));
  });
</script>

<svelte:window onclick={handleWindowClick} />

<div class="cl" class:embedded>
  <!-- Header -->
  <div class="cl-header">
    <span class="cl-title">Canvases</span>
    <button class="cl-close" onclick={onclose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  </div>

  <!-- Search + New -->
  <div class="cl-toolbar">
    {#if canvases.length > 0}
      <div class="cl-search-wrap">
        <svg class="cl-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          type="text"
          class="cl-search"
          bind:value={searchQuery}
          placeholder="Search by title or tag..."
        />
      </div>
    {/if}
    {#if !showNewForm}
      <button class="cl-new-btn" onclick={() => showNewForm = true}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        New
      </button>
    {/if}
  </div>

  <!-- New canvas form -->
  {#if showNewForm}
    <div class="cl-form">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        class="cl-form-input"
        bind:value={newTitle}
        onkeydown={handleKeydown}
        placeholder="Canvas title..."
        autofocus
      />
      <div class="cl-form-row">
        <select class="cl-form-select" bind:value={newType}>
          <option value="markdown">Markdown</option>
          <option value="code">Code</option>
          <option value="text">Text</option>
          <option value="html">HTML</option>
        </select>
        {#if newType === 'code'}
          <input type="text" class="cl-form-input cl-form-lang" bind:value={newLanguage} placeholder="Language" />
        {/if}
      </div>
      <div class="cl-form-actions">
        <button class="cl-btn cl-btn-primary" onclick={handleCreate}>Create</button>
        <button class="cl-btn cl-btn-ghost" onclick={() => showNewForm = false}>Cancel</button>
      </div>
    </div>
  {/if}

  <!-- Tag filter -->
  {#if allTags().length > 0}
    <div class="cl-tag-bar">
      <span class="cl-tag-label">Tag:</span>
      <div class="cl-tag-dropdown-wrap">
        <button class="cl-tag-trigger" onclick={(e) => { e.stopPropagation(); tagDropdownOpen = !tagDropdownOpen; tagSearch = ''; }}>
          <span class="cl-tag-trigger-text">{activeTag || 'All'}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        {#if tagDropdownOpen}
          <div class="cl-tag-dropdown" role="listbox" tabindex="-1" onkeydown={() => {}} onclick={(e) => e.stopPropagation()}>
            {#if allTags().length > 5}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                type="text"
                class="cl-tag-search"
                bind:value={tagSearch}
                placeholder="Filter tags..."
                autofocus
              />
            {/if}
            <div class="cl-tag-options">
              <button class="cl-tag-option" class:active={!activeTag}
                onclick={() => { activeTag = null; tagDropdownOpen = false; }}>All</button>
              {#each filteredTags() as tag}
                <button class="cl-tag-option" class:active={activeTag === tag}
                  onclick={() => { activeTag = tag; tagDropdownOpen = false; }}>{tag}</button>
              {/each}
              {#if filteredTags().length === 0}
                <span class="cl-tag-option cl-tag-none">No matching tags</span>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Canvas cards -->
  <div class="cl-grid">
    {#if canvases.length === 0}
      <div class="cl-empty">
        <div class="cl-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" opacity="0.4">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
        </div>
        <span>No canvases yet</span>
        <span class="cl-empty-sub">Create one to start writing</span>
      </div>
    {:else if filteredCanvases().length === 0}
      <div class="cl-empty">
        <span>No matches</span>
      </div>
    {:else}
      {#each filteredCanvases() as c (c.id)}
        <button
          class="cl-card"
          class:active={c.id === activeCanvasId}
          onclick={() => handleSelect(c.id)}
        >
          <div class="cl-card-top">
            <span class="cl-card-type">{c.content_type}{c.language ? ` · ${c.language}` : ''}</span>
            <span class="cl-card-time">{timeAgo(c.updated_at, { dateAfterDays: 1 })}</span>
          </div>
          <div class="cl-card-title">{c.title}</div>
          {#if c.content}
            <div class="cl-card-preview">{contentPreview(c.content)}</div>
          {/if}
          {#if c.tags && c.tags.length > 0}
            <div class="cl-card-tags">
              {#each c.tags as tag}
                <span class="cl-tag">{tag}</span>
              {/each}
            </div>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .cl {
    position: absolute;
    top: calc(100% + 0.25rem);
    right: 0;
    width: 320px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    z-index: 50;
    display: flex;
    flex-direction: column;
    max-height: 480px;
    animation: clFade 0.2s ease-out;
  }

  .cl.embedded {
    position: static;
    width: 100%;
    max-height: none;
    height: 100%;
    border: none;
    border-radius: 0;
    box-shadow: none;
    background: transparent;
    animation: none;
  }

  @keyframes clFade {
    from { opacity: 0; transform: translateY(-0.5rem); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* On mobile the trigger sits mid-header, so a right-anchored 320px panel
     shoots off-screen. Pin it as a full-width sheet instead. */
  @media (max-width: 768px) {
    .cl {
      position: fixed;
      top: auto;
      bottom: 4.5rem;
      left: 0.5rem;
      right: 0.5rem;
      width: auto;
      max-height: 60vh;
      z-index: 200;
    }
  }

  /* Header */
  .cl-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0.875rem;
    border-bottom: 1px solid var(--border);
  }

  .cl-title {
    font-family: var(--font-heading);
    font-size: 0.875rem;
    color: var(--text-secondary);
    letter-spacing: 0.04em;
  }

  .cl-close {
    color: var(--text-muted);
    padding: 0.25rem;
    border-radius: 0.25rem;
    transition: color var(--transition);
  }
  .cl-close:hover { color: var(--text-primary); }

  /* Toolbar: search + new */
  .cl-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    border-bottom: 1px solid var(--border);
  }

  .cl-search-wrap {
    flex: 1;
    position: relative;
  }

  .cl-search-icon {
    position: absolute;
    left: 0.45rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }

  .cl-search {
    width: 100%;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    color: var(--text-primary);
    padding: 0.35rem 0.5rem 0.35rem 1.6rem;
    font-size: 0.75rem;
    outline: none;
    transition: border-color var(--transition);
  }
  .cl-search:focus { border-color: var(--accent); }
  .cl-search::placeholder { color: var(--text-muted); }

  .cl-new-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.6rem;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--bg-primary);
    background: var(--accent);
    border-radius: 0.5rem;
    white-space: nowrap;
    transition: opacity var(--transition);
  }
  .cl-new-btn:hover { opacity: 0.85; }

  /* Create form */
  .cl-form {
    padding: 0.625rem 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }

  .cl-form-input {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    color: var(--text-primary);
    padding: 0.375rem 0.5rem;
    font-size: 0.8rem;
    outline: none;
  }
  .cl-form-input:focus { border-color: var(--accent); }

  .cl-form-row { display: flex; gap: 0.375rem; }

  .cl-form-select {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    color: var(--text-primary);
    padding: 0.25rem 0.375rem;
    font-size: 0.75rem;
    outline: none;
    flex: 1;
  }

  .cl-form-lang { flex: 1; font-size: 0.75rem; padding: 0.25rem 0.375rem; }

  .cl-form-actions { display: flex; gap: 0.375rem; justify-content: flex-end; }

  .cl-btn {
    padding: 0.3rem 0.75rem;
    font-size: 0.75rem;
    border-radius: 0.375rem;
    font-weight: 500;
    transition: all var(--transition);
    cursor: pointer;
  }

  .cl-btn-primary {
    background: var(--accent);
    color: var(--bg-primary);
  }
  .cl-btn-primary:hover { opacity: 0.85; }

  .cl-btn-ghost {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .cl-btn-ghost:hover { color: var(--text-primary); }

  /* Tag filter */
  .cl-tag-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.375rem 0.875rem;
    border-bottom: 1px solid var(--border);
  }

  .cl-tag-label {
    font-size: 0.675rem;
    color: var(--text-muted);
    letter-spacing: 0.03em;
  }

  .cl-tag-dropdown-wrap {
    position: relative;
  }

  .cl-tag-trigger {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.4rem;
    font-size: 0.7rem;
    color: var(--text-primary);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    cursor: pointer;
    transition: border-color var(--transition);
  }

  .cl-tag-trigger:hover { border-color: var(--border-hover); }

  .cl-tag-trigger-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cl-tag-dropdown {
    position: absolute;
    top: calc(100% + 0.2rem);
    left: 0;
    min-width: 8rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
    z-index: 60;
    display: flex;
    flex-direction: column;
  }

  .cl-tag-search {
    padding: 0.3rem 0.4rem;
    font-size: 0.675rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--text-primary);
    outline: none;
  }
  .cl-tag-search::placeholder { color: var(--text-muted); }

  .cl-tag-options {
    max-height: 120px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .cl-tag-none {
    color: var(--text-muted);
    font-style: italic;
    cursor: default;
  }

  .cl-tag-option {
    padding: 0.3rem 0.5rem;
    font-size: 0.7rem;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    transition: background var(--transition);
  }

  .cl-tag-option:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .cl-tag-option.active {
    color: var(--accent);
    font-weight: 600;
  }

  /* Card grid */
  .cl-grid {
    overflow-y: auto;
    flex: 1;
    padding: 0.5rem 0.625rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .cl-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 2rem 1rem;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .cl-empty-icon { margin-bottom: 0.25rem; }
  .cl-empty-sub { font-size: 0.7rem; opacity: 0.6; }

  /* Canvas card */
  .cl-card {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.6rem 0.7rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s ease;
    width: 100%;
  }

  .cl-card:hover {
    border-color: var(--border-hover, var(--border));
    background: var(--bg-hover);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }

  .cl-card.active {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px rgba(155, 114, 207, 0.2), 0 2px 8px rgba(155, 114, 207, 0.1);
  }

  .cl-card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .cl-card-type {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.6rem;
    padding: 0.1rem 0.35rem;
    border-radius: 0.25rem;
    background: rgba(155, 114, 207, 0.1);
    color: var(--accent);
    letter-spacing: 0.04em;
    font-weight: 600;
  }

  .cl-card-time {
    font-size: 0.625rem;
    color: var(--text-muted);
  }

  .cl-card-title {
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-primary);
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .cl-card-preview {
    font-size: 0.675rem;
    color: var(--text-muted);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    opacity: 0.7;
  }

  .cl-card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem;
    margin-top: 0.1rem;
  }

  .cl-tag {
    font-size: 0.575rem;
    padding: 0.08rem 0.35rem;
    border-radius: 0.5rem;
    background: rgba(155, 114, 207, 0.1);
    color: var(--accent, #9b72cf);
    letter-spacing: 0.02em;
  }

  /* Mobile embedded */
  @media (max-width: 768px) {
    .cl.embedded .cl-header {
      padding: calc(env(safe-area-inset-top, 0px) + 0.8rem) 0.85rem 0.75rem;
      background: linear-gradient(180deg, var(--bg-hover), transparent);
      backdrop-filter: blur(16px);
    }

    .cl.embedded .cl-grid {
      padding: 0.75rem 0.75rem calc(env(safe-area-inset-bottom, 0px) + 1rem);
    }
  }
</style>
