<script lang="ts">
  import type { Canvas as CanvasType } from '@bytelight/shared';
  import {
    getCanvases,
    getActiveCanvasId,
    setActiveCanvasId,
    sendCanvasUpdate,
    sendCanvasUpdateTitle,
    sendCanvasUpdateTags,
    sendCanvasDelete,
  } from '$lib/stores/websocket.svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { showToast } from '$lib/stores/toast.svelte';

  let { embedded = false, onreference } = $props<{
    embedded?: boolean;
    onreference?: (canvasId: string, title: string) => void;
  }>();


  let canvases = $derived(getCanvases());
  let activeCanvasId = $derived(getActiveCanvasId());
  let canvas = $derived(canvases.find(c => c.id === activeCanvasId) ?? null);

  // Local editing state
  let localContent = $state('');
  let localTitle = $state('');
  let localTags = $state<string[]>([]);
  let tagInput = $state('');
  let editMode = $state(true);
  let isDirty = $state(false);
  let prevCanvasId = $state<string | null>(null);
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;

  // Sync local state when canvas changes (only when not dirty)
  $effect(() => {
    if (canvas && !isDirty) {
      localContent = canvas.content;
      localTitle = canvas.title;
      localTags = canvas.tags || [];
    }
  });

  // Reset local state when switching to a different canvas
  $effect(() => {
    if (activeCanvasId !== prevCanvasId) {
      prevCanvasId = activeCanvasId;
      isDirty = false;
      editMode = true;
      tagInput = '';
      if (canvas) {
        localContent = canvas.content;
        localTitle = canvas.title;
        localTags = canvas.tags || [];
      }
    }
  });

  function handleContentInput(e: Event) {
    const textarea = e.target as HTMLTextAreaElement;
    localContent = textarea.value;
    isDirty = true;

    // Debounced auto-save
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (activeCanvasId && isDirty) {
        sendCanvasUpdate(activeCanvasId, localContent);
        isDirty = false;
      }
    }, 500);
  }

  function handleTitleBlur() {
    if (activeCanvasId && localTitle !== canvas?.title) {
      sendCanvasUpdateTitle(activeCanvasId, localTitle);
    }
  }

  function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }

  function handleClose() {
    // Flush pending save
    if (saveTimeout) clearTimeout(saveTimeout);
    if (activeCanvasId && isDirty) {
      sendCanvasUpdate(activeCanvasId, localContent);
    }
    setActiveCanvasId(null);
  }

  function handleDelete() {
    if (!activeCanvasId || !canvas) return;
    if (!confirm(`Delete canvas "${canvas.title}"?`)) return;
    sendCanvasDelete(activeCanvasId);
  }

  function toggleMode() {
    // Flush save before switching to preview
    if (editMode && activeCanvasId && isDirty) {
      sendCanvasUpdate(activeCanvasId, localContent);
      isDirty = false;
    }
    editMode = !editMode;
  }

  // Tag editing
  let showTagInput = $state(false);
  let newTag = $state('');

  // Collect all existing tags across all canvases for autocomplete suggestions
  let allExistingTags = $derived(() => {
    const tagSet = new Set<string>();
    for (const c of canvases) {
      if (c.tags) for (const t of c.tags) tagSet.add(t);
    }
    return [...tagSet].sort();
  });

  // Suggestions: existing tags that match input AND aren't already on this canvas
  let tagSuggestions = $derived(() => {
    const q = newTag.trim().toLowerCase();
    if (!q) return [];
    return allExistingTags().filter(t =>
      t.toLowerCase().includes(q) && !localTags.includes(t)
    );
  });

  function addTag(tag?: string) {
    const raw = (tag ?? (newTag || tagInput));
    const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!normalized || localTags.includes(normalized) || !activeCanvasId) {
      newTag = '';
      tagInput = '';
      showTagInput = false;
      return;
    }
    const updated = [...localTags, normalized];
    localTags = updated;
    sendCanvasUpdateTags(activeCanvasId, updated);
    newTag = '';
    tagInput = '';
    showTagInput = false;
  }

  function removeTag(tag: string) {
    if (!activeCanvasId) return;
    const updated = localTags.filter(t => t !== tag);
    localTags = updated;
    sendCanvasUpdateTags(activeCanvasId, updated);
  }

  function handleTagKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Escape') {
      showTagInput = false;
      newTag = '';
      tagInput = '';
    } else if (e.key === 'Backspace' && !newTag && !tagInput && localTags.length > 0) {
      removeTag(localTags[localTags.length - 1]);
    }
  }

  function handleReference() {
    if (!canvas || !activeCanvasId) return;
    if (onreference) {
      onreference(activeCanvasId, canvas.title);
      showToast('Canvas attached to message', 'success');
    }
  }

  let contentTypeBadge = $derived(
    canvas?.content_type === 'code'
      ? (canvas.language || 'code')
      : canvas?.content_type || 'markdown'
  );

  let copied = $state(false);
  function copyReference() {
    if (!canvas) return;
    const ref = `<<canvas:${canvas.id}:${canvas.title}>>`;
    navigator.clipboard.writeText(ref);
    copied = true;
    setTimeout(() => copied = false, 1500);
  }
</script>

{#if canvas}
  <div class="canvas-panel">
    <header class="canvas-header">
      <div class="canvas-header-left">
        <input
          type="text"
          class="canvas-title-input"
          bind:value={localTitle}
          onblur={handleTitleBlur}
          onkeydown={handleTitleKeydown}
          placeholder="Untitled"
        />
        <span class="canvas-badge">{contentTypeBadge}</span>
      </div>
      <div class="canvas-tags-bar">
        {#if canvas.tags && canvas.tags.length > 0}
          {#each canvas.tags as tag}
            <span class="canvas-tag-pill">
              {tag}
              <button class="canvas-tag-remove" onclick={() => removeTag(tag)} aria-label="Remove tag {tag}">x</button>
            </span>
          {/each}
        {/if}
        {#if showTagInput}
          <div class="canvas-tag-input-wrap">
            <!-- svelte-ignore a11y_autofocus -->
            <input
              type="text"
              class="canvas-tag-input"
              bind:value={newTag}
              onkeydown={handleTagKeydown}
              onblur={() => { setTimeout(() => { if (!newTag.trim()) showTagInput = false; }, 150); }}
              placeholder="tag name"
              autofocus
            />
            {#if tagSuggestions().length > 0}
              <div class="canvas-tag-suggest">
                {#each tagSuggestions() as suggestion}
                  <button class="canvas-tag-suggest-item" onmousedown={() => addTag(suggestion)}>
                    {suggestion}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <button class="canvas-tag-add" onclick={() => showTagInput = true}>+ tag</button>
        {/if}
      </div>
      <div class="canvas-header-actions">
        {#if canvas.content_type === 'markdown' || canvas.content_type === 'html'}
          <button class="canvas-btn" onclick={toggleMode} title={editMode ? 'Preview' : 'Edit'}>
            {#if editMode}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            {:else}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            {/if}
          </button>
        {/if}
        <button class="canvas-btn" onclick={copyReference} title={copied ? 'Copied!' : 'Copy reference'}>
          {#if copied}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
            </svg>
          {/if}
        </button>
        {#if onreference}
        <button class="canvas-btn" onclick={handleReference} title="Attach to message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          </svg>
        </button>
        {/if}
        <button class="canvas-btn canvas-btn-danger" onclick={handleDelete} title="Delete canvas">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
        </button>
        <button class="canvas-btn" onclick={handleClose} title="Close canvas">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </header>

    <div class="canvas-tags">
      {#each localTags as tag}
        <span class="canvas-tag">
          {tag}
          <button class="canvas-tag-remove" onclick={() => removeTag(tag)} aria-label="Remove tag">×</button>
        </span>
      {/each}
      <input
        type="text"
        class="canvas-tag-input"
        bind:value={tagInput}
        onkeydown={handleTagKeydown}
        onblur={() => addTag()}
        placeholder={localTags.length === 0 ? 'Add tags...' : '+'}
      />
    </div>

    <div class="canvas-body">
      {#if (canvas.content_type === 'markdown' || canvas.content_type === 'html') && !editMode}
        <div class="canvas-preview">
          {#if canvas.content_type === 'html'}
            <iframe class="canvas-iframe" srcdoc={localContent} sandbox="allow-same-origin" title={canvas.title}></iframe>
          {:else}
            {@html renderMarkdown(localContent)}
          {/if}
        </div>
      {:else}
        <textarea
          class="canvas-editor"
          class:mono={canvas.content_type === 'code' || canvas.content_type === 'html'}
          bind:value={localContent}
          oninput={handleContentInput}
          placeholder={canvas.content_type === 'code' ? 'Write code...' : canvas.content_type === 'html' ? 'Write HTML...' : 'Start writing...'}
          spellcheck={canvas.content_type !== 'code' && canvas.content_type !== 'html'}
        ></textarea>
      {/if}
    </div>

    {#if isDirty}
      <div class="canvas-save-indicator">Saving...</div>
    {/if}
  </div>
{/if}

<style>
  .canvas-panel {
    width: 450px;
    min-width: 350px;
    max-width: 50vw;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border);
    position: relative;
    flex-shrink: 0;
  }

  .canvas-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    padding: 0.9rem 1rem 0.85rem;
    border-bottom: 1px solid var(--border);
    gap: 0.5rem 0.75rem;
    flex-shrink: 0;
  }

  .canvas-tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    min-height: 2.25rem;
  }

  .canvas-tag {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
    background: rgba(139, 92, 246, 0.15);
    color: var(--accent, #8b5cf6);
    border-radius: 1rem;
    font-size: 0.6875rem;
    text-transform: lowercase;
    letter-spacing: 0.02em;
  }

  .canvas-tag-remove {
    font-size: 0.875rem;
    line-height: 1;
    color: var(--text-muted);
    padding: 0;
    margin-left: 0.125rem;
    opacity: 0.6;
    transition: opacity var(--transition);
  }

  .canvas-tag-remove:hover {
    opacity: 1;
    color: var(--error, var(--color-error));
  }

  .canvas-tag-input {
    flex: 1;
    min-width: 4rem;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 0.75rem;
    padding: 0.125rem 0;
    outline: none;
  }

  .canvas-tag-input::placeholder {
    color: var(--text-muted);
    opacity: 0.6;
  }

  .canvas-header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .canvas-title-input {
    background: transparent;
    border: none;
    color: var(--gold);
    font-family: var(--font-heading);
    font-size: 1rem;
    font-weight: 400;
    letter-spacing: 0.04em;
    padding: 0.25rem 0;
    flex: 1;
    min-width: 0;
    outline: none;
    border-bottom: 1px solid transparent;
    transition: border-color var(--transition);
  }

  .canvas-title-input:focus {
    border-bottom-color: var(--gold-dim);
  }

  .canvas-tags-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    order: 3;
  }

  .canvas-tag-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.65rem;
    padding: 0.1rem 0.4rem;
    border-radius: 0.75rem;
    background: rgba(155, 114, 207, 0.12);
    color: var(--accent, #9b72cf);
    letter-spacing: 0.02em;
  }

  .canvas-tag-remove {
    font-size: 0.6rem;
    color: var(--text-muted);
    padding: 0;
    line-height: 1;
    cursor: pointer;
  }

  .canvas-tag-remove:hover {
    color: var(--text-primary);
  }

  .canvas-tag-add {
    font-size: 0.65rem;
    color: var(--text-muted);
    padding: 0.1rem 0.35rem;
    border-radius: 0.75rem;
    border: 1px dashed var(--border);
    cursor: pointer;
    transition: all var(--transition);
  }

  .canvas-tag-add:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .canvas-tag-input-wrap {
    position: relative;
  }

  .canvas-tag-input {
    font-size: 0.65rem;
    padding: 0.1rem 0.35rem;
    border-radius: 0.75rem;
    border: 1px solid var(--accent);
    background: var(--bg-surface);
    color: var(--text-primary);
    outline: none;
    width: 5rem;
  }

  .canvas-tag-suggest {
    position: absolute;
    top: calc(100% + 0.2rem);
    left: 0;
    min-width: 6rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 60;
    max-height: 100px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .canvas-tag-suggest-item {
    padding: 0.25rem 0.4rem;
    font-size: 0.65rem;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    transition: background var(--transition);
  }

  .canvas-tag-suggest-item:hover {
    background: var(--bg-hover);
    color: var(--accent);
  }

  .canvas-badge {
    font-size: 0.6875rem;
    padding: 0.125rem 0.5rem;
    border-radius: 1rem;
    background: rgba(139, 92, 246, 0.15);
    color: var(--accent, #8b5cf6);
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }

  .canvas-header-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .canvas-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.375rem;
    border-radius: 0.375rem;
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .canvas-btn:hover {
    color: var(--gold-dim);
    background: rgba(255, 255, 255, 0.05);
  }

  .canvas-btn-danger:hover {
    color: var(--error, var(--color-error));
  }

  .canvas-body {
    flex: 1;
    overflow: hidden;
    display: flex;
  }

  .canvas-editor {
    flex: 1;
    background: transparent;
    color: var(--text-primary);
    border: none;
    padding: 1rem;
    font-family: var(--font-body);
    font-size: 0.9375rem;
    line-height: 1.6;
    resize: none;
    outline: none;
    overflow-y: auto;
  }

  .canvas-editor.mono {
    font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace);
    font-size: 0.875rem;
    line-height: 1.5;
    tab-size: 2;
  }

  .canvas-preview {
    flex: 1;
    padding: 1rem;
    overflow-y: auto;
    color: var(--text-primary);
    font-size: 0.9375rem;
    line-height: 1.6;
  }

  .canvas-preview :global(p) { margin: 0.5rem 0; }
  .canvas-preview :global(p:first-child) { margin-top: 0; }
  .canvas-preview :global(p:last-child) { margin-bottom: 0; }

  .canvas-preview :global(code) {
    background: rgba(0, 0, 0, 0.3);
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-family: var(--font-mono);
    font-size: 0.875em;
  }

  .canvas-preview :global(pre) {
    background: rgba(0, 0, 0, 0.3);
    padding: 0.75rem;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    margin: 0.5rem 0;
  }

  .canvas-preview :global(pre code) { background: none; padding: 0; }

  .canvas-preview :global(a) {
    color: var(--gold);
    text-decoration: underline;
    text-decoration-color: var(--gold-dim);
  }

  .canvas-preview :global(strong) { font-weight: 600; }
  .canvas-preview :global(em) { font-style: italic; }

  .canvas-preview :global(ul),
  .canvas-preview :global(ol) {
    margin: 0.5rem 0;
    padding-left: 1.5rem;
  }

  .canvas-preview :global(blockquote) {
    border-left: 2px solid var(--gold-dim);
    padding-left: 1rem;
    margin: 0.5rem 0;
    color: var(--text-secondary);
  }

  .canvas-preview :global(h1),
  .canvas-preview :global(h2),
  .canvas-preview :global(h3) {
    color: var(--gold);
    font-family: var(--font-heading);
    margin: 1rem 0 0.5rem;
  }

  .canvas-preview :global(h1) { font-size: 1.5rem; }
  .canvas-preview :global(h2) { font-size: 1.25rem; }
  .canvas-preview :global(h3) { font-size: 1.1rem; }

  .canvas-preview :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1rem 0;
  }

  .canvas-iframe {
    width: 100%;
    height: 100%;
    border: none;
    background: #fff;
    border-radius: 0.25rem;
  }

  .canvas-save-indicator {
    position: absolute;
    bottom: 0.5rem;
    right: 0.75rem;
    font-size: 0.6875rem;
    color: var(--text-muted);
    opacity: 0.6;
    pointer-events: none;
  }

  /* Mobile: full-screen overlay */
  @media (max-width: 768px) {
    .canvas-panel {
      position: fixed;
      inset: 0;
      width: 100%;
      max-width: 100%;
      min-width: unset;
      z-index: 200;
      animation: canvasSlideIn 0.25s ease-out;
      padding-top: env(safe-area-inset-top, 0px);
    }

    .canvas-header {
      padding: 0.5rem 0.75rem;
    }

    .canvas-title-input {
      font-size: 0.9375rem;
    }

    .canvas-editor {
      padding: 0.75rem;
      font-size: 1rem;
    }

    .canvas-preview {
      padding: 0.75rem;
    }

    .canvas-btn {
      padding: 0.5rem;
    }
  }

  @keyframes canvasSlideIn {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }
</style>
