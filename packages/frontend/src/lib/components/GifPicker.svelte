<script lang="ts">
  const GIPHY_API_KEY = 'SzcHtpa5sytHL1yUNlXovym6gGV9mPZU';
  const GIPHY_SEARCH = 'https://api.giphy.com/v1/gifs/search';
  const GIPHY_TRENDING = 'https://api.giphy.com/v1/gifs/trending';

  let { onselect }: {
    onselect?: (url: string) => void;
  } = $props();

  let open = $state(false);
  let query = $state('');
  let results = $state<Array<{ id: string; url: string; preview: string; width: number; height: number }>>([]);
  let loading = $state(false);
  let searchInput: HTMLInputElement;
  let debounceTimer: ReturnType<typeof setTimeout>;
  let pickerEl: HTMLDivElement;

  function toggle() {
    open = !open;
    if (open) {
      results = [];
      query = '';
      loadTrending();
      setTimeout(() => searchInput?.focus(), 50);
    }
  }

  function close() {
    open = false;
  }

  async function loadTrending() {
    loading = true;
    try {
      const res = await fetch(`${GIPHY_TRENDING}?api_key=${GIPHY_API_KEY}&limit=20&rating=r`);
      const data = await res.json();
      results = mapResults(data.data);
    } catch {
      results = [];
    } finally {
      loading = false;
    }
  }

  async function search(q: string) {
    if (!q.trim()) {
      loadTrending();
      return;
    }
    loading = true;
    try {
      const res = await fetch(`${GIPHY_SEARCH}?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(q)}&limit=20&rating=r`);
      const data = await res.json();
      results = mapResults(data.data);
    } catch {
      results = [];
    } finally {
      loading = false;
    }
  }

  function mapResults(data: any[]): typeof results {
    return data.map((g: any) => ({
      id: g.id,
      url: g.images.original.url,
      preview: g.images.fixed_width_small.url || g.images.fixed_width.url,
      width: parseInt(g.images.fixed_width.width),
      height: parseInt(g.images.fixed_width.height),
    }));
  }

  function handleInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => search(query), 350);
  }

  function selectGif(url: string) {
    onselect?.(url);
    close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      close();
    }
  }

  // Close on click outside
  function handleClickOutside(e: MouseEvent) {
    if (pickerEl && !pickerEl.contains(e.target as Node)) {
      close();
    }
  }

  $effect(() => {
    if (open) {
      document.addEventListener('click', handleClickOutside, true);
      return () => document.removeEventListener('click', handleClickOutside, true);
    }
  });
</script>

<div class="gif-picker-wrapper" bind:this={pickerEl}>
  <button
    class="gif-button"
    class:active={open}
    onclick={(e) => { e.stopPropagation(); toggle(); }}
    aria-label="Search GIFs"
    title="Search GIFs"
  >
    <span class="gif-label">GIF</span>
  </button>

  {#if open}
    <div class="gif-panel" onkeydown={handleKeydown}>
      <div class="gif-search">
        <input
          bind:this={searchInput}
          bind:value={query}
          oninput={handleInput}
          placeholder="Search GIFs..."
          type="text"
        />
      </div>

      <div class="gif-grid">
        {#if loading}
          <div class="gif-loading">
            <span class="gif-spinner"></span>
          </div>
        {:else if results.length === 0}
          <div class="gif-empty">No GIFs found</div>
        {:else}
          {#each results as gif (gif.id)}
            <button
              class="gif-item"
              onclick={() => selectGif(gif.url)}
              title="Send GIF"
            >
              <img
                src={gif.preview}
                alt="GIF"
                loading="lazy"
              />
            </button>
          {/each}
        {/if}
      </div>

      <div class="gif-footer">
        <span class="giphy-attr">Powered by GIPHY</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .gif-picker-wrapper {
    position: relative;
  }

  .gif-button {
    padding: 0.5rem 0.625rem;
    color: var(--text-muted);
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color var(--transition), background var(--transition);
  }

  .gif-button:hover, .gif-button.active {
    color: var(--gold-dim);
    background: var(--gold-ember);
  }

  .gif-label {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    font-family: var(--font-heading, inherit);
  }

  .gif-panel {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 50%;
    transform: translateX(-50%);
    width: 320px;
    max-height: 400px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 0.75rem);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 100;
  }

  .gif-search {
    padding: 0.625rem;
    border-bottom: 1px solid var(--border);
  }

  .gif-search input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: 0.875rem;
  }

  .gif-search input:focus {
    outline: none;
    border-color: var(--border-hover);
  }

  .gif-search input::placeholder {
    color: var(--text-muted);
  }

  .gif-grid {
    flex: 1;
    overflow-y: auto;
    padding: 0.375rem;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.375rem;
    min-height: 200px;
    max-height: 300px;
  }

  .gif-item {
    border-radius: var(--radius-sm, 0.25rem);
    overflow: hidden;
    cursor: pointer;
    transition: opacity var(--transition-fast);
    padding: 0;
    background: var(--bg-tertiary);
  }

  .gif-item:hover {
    opacity: 0.8;
  }

  .gif-item img {
    width: 100%;
    height: auto;
    display: block;
    min-height: 60px;
  }

  .gif-loading {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }

  .gif-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--text-muted);
    border-top-color: var(--gold);
    border-radius: 50%;
    animation: gif-spin 0.6s linear infinite;
  }

  @keyframes gif-spin {
    to { transform: rotate(360deg); }
  }

  .gif-empty {
    grid-column: 1 / -1;
    text-align: center;
    padding: 2rem;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .gif-footer {
    padding: 0.375rem 0.625rem;
    border-top: 1px solid var(--border);
    text-align: right;
  }

  .giphy-attr {
    font-size: 0.6875rem;
    color: var(--text-muted);
    opacity: 0.7;
  }

  @media (max-width: 768px) {
    .gif-panel {
      position: fixed;
      bottom: 4rem;
      left: 0.5rem;
      right: 0.5rem;
      width: auto;
      transform: none;
      max-height: 50vh;
      z-index: 200;
    }

    .gif-grid {
      max-height: 40vh;
    }

    .gif-item {
      min-height: 120px;
      overflow: hidden;
    }

    .gif-item img {
      width: 100% !important;
      height: auto !important;
      min-height: 120px !important;
      object-fit: cover !important;
      display: block !important;
    }
  }
</style>
