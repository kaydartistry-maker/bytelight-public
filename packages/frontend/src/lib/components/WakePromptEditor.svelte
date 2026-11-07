<script lang="ts">
  import { getWakePrompt, saveWakePrompt, resetWakePrompt } from '$lib/stores/settings.svelte';

  let { wakeType }: { wakeType: string } = $props();

  let open = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);

  let entry = $derived(getWakePrompt(wakeType));

  function toggle() {
    if (!open) {
      draft = entry?.body ?? '';
      error = null;
    }
    open = !open;
  }

  async function save() {
    if (!draft.trim()) { error = 'A bell needs something to say.'; return; }
    saving = true;
    error = null;
    const result = await saveWakePrompt(wakeType, draft);
    saving = false;
    if (result.ok) open = false;
    else error = result.error ?? 'Failed to save';
  }

  async function reset() {
    saving = true;
    error = null;
    const ok = await resetWakePrompt(wakeType);
    saving = false;
    if (ok) draft = getWakePrompt(wakeType)?.body ?? '';
    else error = 'Failed to reset';
  }
</script>

<div class="prompt-editor">
  <button class="prompt-toggle" type="button" onclick={toggle} aria-expanded={open}>
    <span class="chevron" class:open>▸</span>
    Prompt
    {#if entry}
      <span class="src src--{entry.source}">{entry.source === 'file' ? 'custom' : 'default'}</span>
    {/if}
  </button>

  {#if open}
    <div class="prompt-body">
      {#if entry}
        <textarea
          class="prompt-textarea"
          bind:value={draft}
          rows="7"
          spellcheck="false"
          placeholder="What this wake says when it fires…"
        ></textarea>

        {#if error}
          <p class="prompt-error">{error}</p>
        {/if}

        <div class="prompt-actions">
          <button class="res-btn res-btn--primary res-btn--sm" type="button" onclick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {#if entry.source === 'file' && entry.hasDefault}
            <button class="res-btn res-btn--ghost res-btn--sm" type="button" onclick={reset} disabled={saving}>
              Reset to default
            </button>
          {/if}
          <button class="res-btn res-btn--ghost res-btn--sm" type="button" onclick={() => (open = false)} disabled={saving}>
            Cancel
          </button>
        </div>
      {:else}
        <p class="prompt-empty">No prompt loaded for this wake yet.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .prompt-editor {
    margin-top: 0.3rem;
  }

  .prompt-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.1rem 0;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 0.6875rem;
    cursor: pointer;
  }
  .prompt-toggle:hover {
    color: var(--text-secondary);
  }

  .chevron {
    display: inline-block;
    transition: transform 0.12s ease;
    font-size: 0.625rem;
  }
  .chevron.open {
    transform: rotate(90deg);
  }

  .src {
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .src--file {
    background: var(--accent);
    color: white;
  }
  .src--default {
    background: var(--bg-tertiary);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  .prompt-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.4rem;
    /* Escape the narrow task-info column so the textarea is actually usable,
       capped on small screens. */
    width: min(34rem, 72vw);
    max-width: 100%;
  }

  .prompt-textarea {
    width: 100%;
    resize: vertical;
    font-family: inherit;
    font-size: 0.8125rem;
    line-height: 1.5;
    padding: 0.5rem 0.6rem;
    color: var(--text-primary);
    background: var(--bg-input, var(--bg-surface));
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .prompt-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .prompt-error {
    margin: 0;
    font-size: 0.75rem;
    color: var(--color-danger, #d04040);
  }

  .prompt-empty {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
</style>
