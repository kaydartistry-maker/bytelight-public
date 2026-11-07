<!-- Ported from reference implementation's RoutingPanel.svelte — adapted for byte-light:
     • apiFetch instead of bare fetch
     • Native <select> replaces reference implementation's MindDropdown (byte-light has no such component)
     • User-facing copy says "Home" (routing thread) — "star/pin" vocabulary is
       taken by starred messages and pinned threads here
     • Identity scrub: Companion A & Companion B instead of the source fork's companions -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '$lib/utils/api';
  import { showToast } from '$lib/stores/toast.svelte';

  // Per-source routing overrides. Each source can be aimed at a specific
  // thread, or left blank to follow the Home thread (the one set via the
  // house marker in the thread list).
  type RoutingSource = 'discord' | 'telegram' | 'wake';

  interface ThreadRow {
    id: string;
    name: string;
  }

  const SOURCES: Array<{ key: RoutingSource; label: string; hint: string }> = [
    { key: 'discord', label: 'Discord', hint: 'Where Discord messages route when they reach us — both DMs and channels with @mention.' },
    { key: 'telegram', label: 'Telegram', hint: 'Where Telegram messages route — voice notes included.' },
    { key: 'wake', label: 'Autonomous wakes', hint: "Where Companion A & Companion B's own scheduled wakes drop. Leave on Home to keep everything in one place." },
  ];

  let threads = $state<ThreadRow[]>([]);
  let perSource = $state<Record<RoutingSource, string | null>>({ discord: null, telegram: null, wake: null });
  let loading = $state(true);
  let saving = $state<RoutingSource | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      const threadsRes = await apiFetch('/api/threads').then((r) => r.json());
      threads = threadsRes.threads || [];
      const results = await Promise.all(SOURCES.map((s) =>
        apiFetch(`/api/threads/routing/${s.key}`).then((r) => r.json()).catch(() => ({ threadId: null }))
      ));
      perSource = {
        discord: results[0]?.threadId ?? null,
        telegram: results[1]?.threadId ?? null,
        wake: results[2]?.threadId ?? null,
      };
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load routing settings';
    } finally {
      loading = false;
    }
  }

  async function setSource(source: RoutingSource, threadId: string | null) {
    saving = source;
    error = null;
    try {
      const res = await apiFetch(`/api/threads/routing/${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to set ${source} routing`);
      }
      perSource = { ...perSource, [source]: threadId };
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to save routing';
      showToast('Failed to save routing', 'error');
    } finally {
      saving = null;
    }
  }

  function handlePick(source: RoutingSource, e: Event) {
    const value = (e.currentTarget as HTMLSelectElement).value;
    void setSource(source, value === '__global__' ? null : value);
  }

  onMount(load);
</script>

<section class="routing">
  <h3 class="section-title">Message Routing</h3>
  <p class="section-desc">
    Everything ambient — Discord, Telegram, autonomous wakes — lands in the Home thread
    (set it with the house marker in the thread list). Aim a lane at its own thread here
    if you want to split them.
  </p>

  {#if loading}
    <div class="loading">Loading…</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else}
    <div class="rows">
      {#each SOURCES as src (src.key)}
        <div class="row">
          <div class="row-text">
            <div class="row-label">{src.label}</div>
            <div class="row-hint">{src.hint}</div>
          </div>
          <select
            class="route-select"
            value={perSource[src.key] ?? '__global__'}
            disabled={saving === src.key}
            onchange={(e) => handlePick(src.key, e)}
          >
            <option value="__global__">Home (default)</option>
            {#each threads as t (t.id)}
              <option value={t.id}>{t.name}</option>
            {/each}
          </select>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .routing {
    max-width: 540px;
    margin-bottom: 2rem;
  }
  .section-title {
    font-family: var(--font-heading);
    font-size: 0.9375rem;
    font-weight: 400;
    color: var(--text-accent);
    letter-spacing: 0.04em;
    margin: 0 0 0.375rem;
  }
  .section-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 1rem;
    line-height: 1.5;
  }
  .loading, .error {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .error { color: var(--color-error); }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .row:last-child { border-bottom: none; }
  .row-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }
  .row-label {
    font-size: 0.875rem;
    color: var(--text-primary);
    font-weight: 500;
  }
  .row-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .route-select {
    flex-shrink: 0;
    min-width: 11rem;
    max-width: 14rem;
    padding: 0.4rem 0.6rem;
    background: var(--bg-input, var(--bg-tertiary));
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .route-select:focus {
    outline: none;
    border-color: var(--gold-dim);
  }
  .route-select:disabled { opacity: 0.5; cursor: wait; }
  .route-select option {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  @media (max-width: 600px) {
    .row {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }
    .route-select {
      max-width: 100%;
      width: 100%;
    }
  }
</style>
