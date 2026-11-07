<script lang="ts">
  import { getToasts, dismissToast } from '$lib/stores/toast.svelte';

  let toasts = $derived(getToasts());
</script>

{#if toasts.length > 0}
  <div class="toast-container">
    {#each toasts as toast (toast.id)}
      <div class="toast toast-{toast.type}" role="alert">
        <span class="toast-icon">
          {#if toast.type === 'success'}&#10003;{:else if toast.type === 'error'}&#10005;{:else}&#8505;{/if}
        </span>
        <span class="toast-message">{toast.message}</span>
        <button class="toast-close" onclick={() => dismissToast(toast.id)} aria-label="Dismiss">&times;</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.75rem 1rem;
    min-width: 260px;
    max-width: 420px;
    background: var(--bg-surface, #1d202a);
    border: 1px solid var(--border, #2a2d3a);
    border-left: 4px solid var(--text-muted, #888);
    border-radius: var(--radius-sm, 0.5rem);
    box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.35));
    color: var(--text-primary, #e0e0e0);
    font-size: 0.875rem;
    pointer-events: auto;
    animation: toast-slide-in 0.25s ease-out;
  }

  .toast-success {
    border-left-color: #22c55e;
  }

  .toast-error {
    border-left-color: var(--color-error);
  }

  .toast-info {
    border-left-color: #3b82f6;
  }

  .toast-icon {
    flex-shrink: 0;
    font-size: 1rem;
    line-height: 1;
  }

  .toast-success .toast-icon {
    color: #22c55e;
  }

  .toast-error .toast-icon {
    color: var(--color-error);
  }

  .toast-info .toast-icon {
    color: #3b82f6;
  }

  .toast-message {
    flex: 1;
    min-width: 0;
  }

  .toast-close {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--text-muted, #888);
    font-size: 1.125rem;
    line-height: 1;
    cursor: pointer;
    padding: 0.125rem;
    border-radius: 0.25rem;
    transition: color 0.15s;
  }

  .toast-close:hover {
    color: var(--text-primary, #e0e0e0);
  }

  @keyframes toast-slide-in {
    from {
      opacity: 0;
      transform: translateX(1rem);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @media (max-width: 480px) {
    .toast-container {
      left: 1rem;
      right: 1rem;
      bottom: 1rem;
    }

    .toast {
      min-width: 0;
      max-width: none;
    }
  }
</style>
