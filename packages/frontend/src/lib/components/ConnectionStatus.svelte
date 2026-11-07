<script lang="ts">
  let { state, error = null, pendingCount = 0, reconnectScheduled = false, onReconnect } = $props<{
    state: string;
    error?: { code: string; message: string } | null;
    pendingCount?: number;
    reconnectScheduled?: boolean;
    onReconnect?: () => void;
  }>();

  const isVisible = $derived(state !== 'connected' || !!error);

  // A retry is genuinely in flight when the state machine is actively reconnecting,
  // OR when we're disconnected but a reconnect timer is armed. Only then do we show
  // the spinner + "Retrying…". A bare 'disconnected' with no armed timer is idle —
  // the banner must NOT pretend it's retrying.
  const isRetrying = $derived(
    state === 'reconnecting' || state === 'connecting' ||
    (state === 'disconnected' && reconnectScheduled)
  );
  // Idle-disconnected: nothing scheduled, no error. Offer a tap to reconnect.
  const isIdleDisconnected = $derived(!error && state === 'disconnected' && !reconnectScheduled);

  const statusMessage = $derived(() => {
    if (error) return error.message;
    if (isRetrying) return 'Retrying…';
    if (state === 'disconnecting') return 'Disconnecting…';
    if (isIdleDisconnected) return 'Disconnected';
    return '';
  });

  const isError = $derived(!!error);
  // Spinner only while something is genuinely in motion.
  const showSpinner = $derived(!isError && (isRetrying || state === 'disconnecting'));
  const showPending = $derived(pendingCount > 0 && state !== 'connected');
</script>

{#if isVisible}
  <div class="connection-status" class:error={isError} role="alert" aria-live="polite">
    <div class="status-content">
      {#if isError}
        <div class="error-icon">!</div>
      {:else if showSpinner}
        <div class="spinner"></div>
      {/if}
      <span>{statusMessage()}</span>
      {#if isIdleDisconnected && onReconnect}
        <button type="button" class="reconnect-btn" onclick={() => onReconnect?.()}>Reconnect</button>
      {/if}
      {#if showPending}
        <span class="pending-badge">{pendingCount} queued</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .connection-status {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border);
    padding: 0.75rem;
    z-index: 50;
    animation: slideDown 0.3s ease-out;
  }

  .connection-status.error {
    background: rgba(180, 60, 60, 0.1);
    border-bottom-color: rgba(180, 60, 60, 0.2);
  }

  @keyframes slideDown {
    from {
      transform: translateY(-100%);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .status-content {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .error .status-content {
    color: #c07070;
  }

  .spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid var(--border);
    border-top-color: var(--gold-dim);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .error-icon {
    width: 1.25rem;
    height: 1.25rem;
    background: #8a4040;
    color: var(--text-primary);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 700;
    flex-shrink: 0;
  }

  .pending-badge {
    background: var(--bg-surface);
    padding: 0.125rem 0.5rem;
    border-radius: 1rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .reconnect-btn {
    background: transparent;
    border: 1px solid var(--gold-dim);
    color: var(--gold-dim);
    padding: 0.125rem 0.625rem;
    border-radius: 1rem;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .reconnect-btn:hover {
    background: var(--gold-dim);
    color: var(--bg-primary);
  }

</style>
