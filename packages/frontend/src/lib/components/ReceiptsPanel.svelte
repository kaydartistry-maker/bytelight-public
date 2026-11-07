<!--
  ReceiptsPanel.svelte — the operator's window into the memory ledger.

  The paper trail behind the shiver: one row per memory write / surface,
  newest first. When ambient recall surfaces a memory (or a déjà-vu is felt),
  the whisper writes a receipt here — this panel makes that trail readable.

  Built against byte-light's Settings design language (matches MemoryPanel).
  All fetches go through apiFetch (session cookie included). Read-only view: actor, action,
  detail, time.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '$lib/utils/api';

  interface LedgerEntry {
    id: number;
    actor: string;
    action: string;
    subject_type: string | null;
    subject_id: string | null;
    detail: string;
    metadata_json: string | null;
    seen_at: string | null;
    created_at: string;
  }

  let entries = $state<LedgerEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await apiFetch('/api/memory/ledger?limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entries = (await res.json()) as LedgerEntry[];
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function fmtTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  // A calm label for the action verbs the ledger records.
  function actionLabel(action: string): string {
    switch (action) {
      case 'memory.surface': return 'surfaced';
      case 'memory.dejavu': return 'déjà vu';
      case 'memory.append': return 'appended';
      case 'memory.replace': return 'replaced';
      case 'memory.rethink': return 'rewrote';
      case 'memory.delete': return 'deleted';
      default: return action;
    }
  }
</script>

<div class="receipts-panel">
  <header class="panel-head">
    <h2 class="panel-title">Receipts</h2>
    <p class="panel-desc">
      Every memory write and every ambient recall leaves a receipt. Newest first —
      who acted, what happened, and when. This is the trail behind the shimmer.
    </p>
  </header>

  <div class="panel-actions">
    <button class="refresh-btn" onclick={load} disabled={loading}>
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  </div>

  {#if loading}
    <p class="loading-text">Loading receipts…</p>
  {:else if error}
    <div class="error-box">
      <p class="error-title">Couldn't load receipts</p>
      <p class="error-detail">{error}</p>
    </div>
  {:else if entries.length === 0}
    <p class="empty-text">No receipts yet. They appear as memory is written or recalled.</p>
  {:else}
    <ul class="ledger-list">
      {#each entries as e (e.id)}
        <li class="ledger-row" class:recall={e.action === 'memory.surface' || e.action === 'memory.dejavu'}>
          <div class="row-top">
            <span class="actor">{e.actor}</span>
            <span class="action">{actionLabel(e.action)}</span>
            <span class="time">{fmtTime(e.created_at)}</span>
          </div>
          <p class="detail">{e.detail}</p>
          {#if e.subject_id}
            <p class="subject">{e.subject_type ?? 'subject'}: {e.subject_id}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .receipts-panel {
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

  .panel-actions {
    margin-bottom: 1rem;
  }

  .refresh-btn {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    transition: border-color var(--transition-fast, 0.15s), color var(--transition-fast, 0.15s);
  }
  .refresh-btn:hover:not(:disabled) {
    border-color: var(--gold, var(--accent));
    color: var(--text-primary);
  }
  .refresh-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .loading-text,
  .empty-text {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    padding: 2rem 0;
  }
  .empty-text { text-align: center; }

  .error-box {
    padding: 1.5rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .error-title {
    color: var(--color-error, var(--color-danger));
    font-weight: 500;
    margin: 0 0 0.25rem;
    font-size: 0.875rem;
  }
  .error-detail {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin: 0;
  }

  .ledger-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .ledger-row {
    padding: 0.6rem 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .ledger-row.recall {
    border-left: 2px solid var(--gold, var(--accent));
  }

  .row-top {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.75rem;
  }
  .actor {
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }
  .action {
    color: var(--gold, var(--accent));
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.68rem;
  }
  .time {
    margin-left: auto;
    color: var(--text-muted);
  }
  .detail {
    margin: 0.35rem 0 0;
    font-size: 0.8125rem;
    color: var(--text-primary);
    line-height: 1.45;
  }
  .subject {
    margin: 0.2rem 0 0;
    font-size: 0.7rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
</style>
