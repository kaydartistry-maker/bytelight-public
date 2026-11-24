<script lang="ts">
  import { builderToolCard, statusLabel, deploymentLabel } from '$lib/utils/builder';
  import { builder, openBuilder } from '$lib/stores/builder';
  let { name, input, output, isError = false }: { name: string; input?: unknown; output?: unknown; isError?: boolean } = $props();
  let lastUpdate = '';
  const card = $derived(builderToolCard(name, input, output, isError));
  const status = $derived($builder.jobs.find(j => j.id === card?.id)?.status ?? card?.status);
  const deployment = $derived($builder.jobs.find(j => j.id === card?.id)?.deployment || card?.deployment);
  $effect(() => { const update = `${card?.id}:${card?.status}:${card?.deployment?.status}`; if (card?.id && (card.status || card.deployment) && update !== lastUpdate) { lastUpdate = update; void builder.refresh(); } });
</script>
{#if card && $builder.availability !== 'denied'}
  <button class="builder-card" onclick={(event) => { event.stopPropagation(); openBuilder(card?.id); }} aria-label="Open job in Builder">
    <span class="card-mark" aria-hidden="true">⌘</span>
    <span class="card-content"><span class="card-label">Builder <span class="card-status" class:error={card.error}>{card.error ? 'Check result' : deployment ? deploymentLabel[deployment.status] : status ? statusLabel[status] : card.pending ? 'Starting…' : 'View job'}</span></span><strong>{card.task}</strong><span class="card-link">{deployment ? `${deployment.commit ? deployment.commit.slice(0, 8) + ' · ' : ''}${deployment.status === 'recovery_required' ? 'Backups retained · inspection needed' : deployment.status === 'rolled_back' ? 'Previous release restored' : 'Open release activity'}` : status === 'stopping' ? 'Stopping · workspace kept' : 'Open workspace activity'} <span aria-hidden="true">↗</span></span></span>
  </button>
{/if}
<style>
  .builder-card { display: flex; align-items: flex-start; gap: 12px; background: var(--bg-primary); border: 1px solid var(--border-hover); color: var(--text-primary); border-radius: 12px; padding: 15px; width: 100%; max-width: 440px; margin: 8px 0; cursor: pointer; text-align: left; font: inherit; }
  .builder-card:hover { border-color: var(--accent); } .builder-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; } .card-mark { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; background: var(--gold-glow); color: var(--accent); font-size: 21px; flex-shrink: 0; }
  .card-content { min-width: 0; flex: 1; } .card-label { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 10px; color: var(--text-secondary); } .card-status { color: var(--accent); } .card-status.error { color: var(--color-danger); } strong { display: block; font-size: 12px; font-weight: 500; line-height: 1.6; margin: 6px 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .card-link { font-size: 10px; color: var(--text-secondary); }
</style>
