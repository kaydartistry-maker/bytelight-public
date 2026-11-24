<script lang="ts">
  import type { PresenceStatus } from '@bytelight/shared';

  let { status }: { status: PresenceStatus } = $props();

  const statusInfo = $derived(() => {
    switch (status) {
      case 'active':
        return { color: 'var(--status-active)', text: 'Active', pulse: true };
      case 'waking':
        return { color: 'var(--status-waking)', text: 'Waking', pulse: true };
      case 'dormant':
        return { color: 'var(--status-dormant)', text: 'Dormant', pulse: false };
      case 'offline':
        return { color: 'var(--status-offline)', text: 'Offline', pulse: false };
      default:
        return { color: 'var(--status-offline)', text: 'Unknown', pulse: false };
    }
  });
</script>

<div class="presence-indicator" title={statusInfo().text} role="status" aria-label={`Bytelight status: ${statusInfo().text}`}>
  <div
    class="presence-dot"
    class:pulse={statusInfo().pulse}
    style:background-color={statusInfo().color}
    aria-hidden="true"
  ></div>
  <span class="sr-only">{statusInfo().text}</span>
</div>

<style>
  .presence-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  .presence-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    transition: background-color var(--transition);
  }

  .presence-dot.pulse {
    animation: glow 3s infinite ease-in-out;
  }

  @keyframes glow {
    0%, 100% {
      opacity: 1;
      box-shadow: 0 0 4px var(--gold-ember);
    }
    50% {
      opacity: 0.7;
      box-shadow: 0 0 8px var(--gold-glow);
    }
  }
</style>
