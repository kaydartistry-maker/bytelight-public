<script lang="ts">
  let {
    percentage = 0,
    tokensUsed = 0,
    contextWindow = 0,
  } = $props<{
    percentage: number;
    tokensUsed: number;
    contextWindow: number;
  }>();

  const barColor = $derived(() => {
    if (percentage >= 95) return 'var(--context-critical, var(--color-error))';
    if (percentage >= 85) return 'var(--context-warning, #f97316)';
    if (percentage >= 70) return 'var(--context-caution, #f59e0b)';
    return 'var(--gold-dim)';
  });

  const shouldPulse = $derived(percentage >= 95);

  function formatTokens(n: number): string {
    if (n >= 1000) return `${Math.round(n / 1000)}K`;
    return String(n);
  }
</script>

{#if percentage > 50}
  <div
    class="context-indicator"
    class:pulse={shouldPulse}
    title="{formatTokens(tokensUsed)} / {formatTokens(contextWindow)} tokens ({percentage}%)"
  >
    <div class="bar-track">
      <div
        class="bar-fill"
        style="width: {Math.min(percentage, 100)}%; background: {barColor()}"
      ></div>
    </div>
    <span class="bar-label" style="color: {barColor()}">{percentage}%</span>
  </div>
{/if}

<style>
  .context-indicator {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    cursor: default;
  }

  .bar-track {
    width: 2.5rem;
    height: 4px;
    background: var(--bg-tertiary);
    border-radius: 2px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.5s ease, background 0.5s ease;
  }

  .bar-label {
    font-size: 0.625rem;
    font-weight: 500;
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
  }

  .pulse .bar-fill {
    animation: contextPulse 1.5s ease-in-out infinite;
  }

  @keyframes contextPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
</style>
