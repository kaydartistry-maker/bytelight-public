<script lang="ts">
  import ConfirmDialog from './ConfirmDialog.svelte';
  import type { MessageActions } from './messageActions.svelte';

  // Edit, delete and regenerate dialogs for one message.
  let { actions }: { actions: MessageActions } = $props();
</script>

<ConfirmDialog open={actions.rerollPreview !== null} title="Regenerate this reply?"
  message={`This hides ${actions.rerollPreview?.count ?? 0} messages: this reply and everything after it, including your messages. Session memory is not erased.`}
  confirmLabel="Regenerate" destructive={true} onconfirm={actions.regenerateMessage}
  oncancel={() => actions.rerollPreview = null} />
{#if actions.rerollError}<p role="alert">{actions.rerollError}</p>{/if}

{#if actions.showEditModal}
  <div class="modal-backdrop" role="dialog" aria-modal="true" onclick={() => (actions.showEditModal = false)}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3 class="modal-title">Edit message</h3>
      <textarea
        class="modal-textarea"
        bind:value={actions.editValue}
        rows="4"
      ></textarea>
      <div class="modal-actions">
        <button type="button" class="modal-btn" onclick={() => (actions.showEditModal = false)} disabled={actions.actionPending}>Cancel</button>
        <button type="button" class="modal-btn" onclick={() => actions.patchMessage(false)} disabled={actions.actionPending || !actions.editValue.trim()}>Save</button>
        <button type="button" class="modal-btn primary" onclick={() => actions.patchMessage(true)} disabled={actions.actionPending || !actions.editValue.trim()}>Save & rerun</button>
      </div>
      <p class="modal-hint">Save & rerun deletes everything after this message and re-prompts.</p>
    </div>
  </div>
{/if}

{#if actions.showDeleteConfirm}
  <div class="modal-backdrop" role="dialog" aria-modal="true" onclick={() => (actions.showDeleteConfirm = false)}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3 class="modal-title">Delete this message?</h3>
      <p class="modal-body">It'll be hidden from the conversation. Cannot be undone.</p>
      <div class="modal-actions">
        <button type="button" class="modal-btn" onclick={() => (actions.showDeleteConfirm = false)} disabled={actions.actionPending}>Cancel</button>
        <button type="button" class="modal-btn destructive" onclick={actions.deleteMessage} disabled={actions.actionPending}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  .modal {
    background: var(--surface, #1a1a1a);
    border: 1px solid var(--border, #333);
    border-radius: 0.75rem;
    padding: 1.5rem;
    max-width: 28rem;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .modal-title {
    margin: 0 0 1rem;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text, #fff);
  }

  .modal-body {
    margin: 0 0 1rem;
    color: var(--text-secondary, #888);
    font-size: 0.875rem;
  }

  .modal-textarea {
    width: 100%;
    min-height: 6rem;
    padding: 0.75rem;
    border: 1px solid var(--border, #333);
    border-radius: 0.5rem;
    background: var(--input-bg, #0d0d0d);
    color: var(--text, #fff);
    font-family: inherit;
    font-size: 0.875rem;
    resize: vertical;
    margin-bottom: 0.5rem;
  }

  .modal-textarea:focus {
    outline: none;
    border-color: var(--accent, #5eaba5);
  }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .modal-btn {
    padding: 0.5rem 1rem;
    border: 1px solid var(--border, #333);
    border-radius: 0.375rem;
    background: transparent;
    color: var(--text, #fff);
    font-size: 0.875rem;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .modal-btn:hover {
    background: var(--surface-hover, rgba(255,255,255,0.05));
  }

  .modal-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .modal-btn.primary {
    background: var(--accent, #5eaba5);
    border-color: var(--accent, #5eaba5);
  }

  .modal-btn.primary:hover {
    background: var(--accent-hover, #7cc5c0);
  }

  .modal-btn.destructive {
    background: rgba(239, 68, 68, 0.15);
    border-color: rgba(239, 68, 68, 0.3);
    color: var(--color-error);
  }

  .modal-btn.destructive:hover {
    background: rgba(239, 68, 68, 0.25);
  }

  .modal-hint {
    margin: 0.75rem 0 0;
    font-size: 0.75rem;
    color: var(--text-tertiary, #666);
  }
</style>
