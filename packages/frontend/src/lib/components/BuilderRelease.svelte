<script lang="ts">
  import { tick } from 'svelte';
  import { builder } from '$lib/stores/builder';
  import { activeDeployment, deploymentElapsed, deploymentLabel, releaseActionAllowed, releaseConfirmation, safeReleaseText, type BuilderJob, type ReleaseAction } from '$lib/utils/builder';
  let { job, now }: { job: BuilderJob; now: number } = $props();
  const release = $derived($builder.deployment?.jobId === job.id ? $builder.deployment : null);
  const pending = $derived($builder.releasePending?.id === job.id ? $builder.releasePending.action : null);
  let confirmation = $state<{ action: ReleaseAction; key: string; title: string; message: string } | null>(null);
  let container: HTMLElement | undefined = $state();
  let cancelButton: HTMLButtonElement | undefined = $state();
  let logBox: HTMLPreElement | undefined = $state();
  let following = $state(true), copied = $state(false), copyError = $state(false);
  const logText = $derived($builder.deploymentLogs.events.map(e => `${new Date(e.at).toLocaleTimeString([], { hour12: false })}  ${e.message}`).join('\n'));
  const ready = $derived($builder.deploymentAvailability === 'ready' && !$builder.releasePending);
  $effect(() => {
    if (confirmation && (!ready || !releaseActionAllowed(job, release, confirmation.action) || releaseConfirmation(job, release, confirmation.action).key !== confirmation.key)) confirmation = null;
  });
  $effect(() => { if (confirmation) void tick().then(() => cancelButton?.focus()); });
  const logIdentity = $derived(`${job.id}:${release?.id || ''}`);
  $effect(() => { logIdentity; following = true; copied = false; copyError = false; });
  $effect(() => { logText; if (following && logBox) void tick().then(() => { if (logBox) logBox.scrollTop = logBox.scrollHeight; }); });
  function ask(action: ReleaseAction) { if (ready && releaseActionAllowed(job, release, action)) confirmation = { action, ...releaseConfirmation(job, release, action) }; }
  async function execute() { const request = confirmation; confirmation = null; if (request) await builder.release(request.action, job.id, request.key); }
  async function copy() { copied = false; copyError = false; try { await navigator.clipboard.writeText(safeReleaseText(logText)); copied = true; } catch { copyError = true; } }
  function dismiss() { confirmation = null; void tick().then(() => container?.querySelector<HTMLButtonElement>('.release-actions button')?.focus()); }
  function cancel(event: KeyboardEvent) { if (event.key === 'Escape' && confirmation) { event.preventDefault(); event.stopPropagation(); dismiss(); } }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape dismisses the inline confirmation before the enclosing dialog.) -->
<section bind:this={container} class="release-section" aria-labelledby="release-title" onkeydown={cancel}>
  <div class="release-heading"><div><p class="eyebrow">FROM WORKSPACE TO LIVE</p><h3 id="release-title">Release</h3></div>{#if release}<span class="release-status" data-status={release.status}>{deploymentLabel[release.status]}</span>{/if}</div>
  {#if $builder.deploymentAvailability === 'disabled'}
    <p class="quiet"><strong>Deployment is off.</strong> Builder can still code, test and commit. Release controls appear once deployment is enabled for this app.</p>
  {:else if $builder.deploymentAvailability === 'loading' && !release}
    <p class="quiet" role="status">Checking release status…</p>
  {:else}
    {#if release?.status === 'recovery_required'}
      <div class="recovery" role="status"><strong>Manual inspection needed</strong>{#if release.commit}<p>Release <code>{release.commit.slice(0, 8)}</code></p>{/if}<p>Backups and the deployment lock are preserved. An operator needs to inspect the retained state before another release can run.</p><small>Your work is kept. There is no automatic retry or clear-lock control.</small></div>
    {:else if !release || release.status === 'not_prepared'}
      <p class="quiet">Coding is complete. Prepare a release to check the clean commit, install dependencies and run checks, tests and builds. Production stays unchanged.</p>
    {:else}
      <div class="release-meta">{#if release.commit}<span>Commit <code>{release.commit.slice(0, 8)}</code></span>{/if}<span>{deploymentElapsed(release, now)}</span></div>
      <p class="phase" role="status">{pending ? pending === 'prepare' ? 'Requesting preparation…' : pending === 'deploy' ? 'Requesting deployment…' : 'Requesting rollback…' : release.phase.replace(/[-_]/g, ' ') || deploymentLabel[release.status]}</p>
      {#if release.healthy}<p class="health"><span aria-hidden="true">✓</span> Last verification: three health checks passed · stable app process</p>{/if}
      {#if release.status === 'prepared'}<p class="quiet">Prepared and ready. Deploy briefly stops the app for its final backup and promotion.</p>{/if}
      {#if release.status === 'deployed'}<p class="quiet">Previous release retained. Rollback is available for the latest live release; the server verifies this before making changes.</p>{/if}
      {#if release.rollback}<p class="rollback-result">{release.rollback}</p>{/if}
      {#if release.database}<p class="quiet database-note">{release.database}</p>{/if}
    {/if}
    {#if release?.error}<div class="release-error"><strong>{release.status === 'rolled_back' ? 'New release did not stay healthy' : 'Release details'}</strong><p>{release.error}</p></div>{/if}
    {#if $builder.deploymentError}<p class="release-error" role="status">{$builder.deploymentError}<button class="text-button" onclick={() => builder.refreshRelease()}>Refresh release status</button></p>{/if}
    {#if $builder.releaseError}<p class="release-error" role="status">{$builder.releaseError}</p>{/if}
    {#if confirmation}
      <div class="release-confirm" role="group" aria-label={confirmation.title}><strong>{confirmation.title}</strong><p>{confirmation.message}</p><div><button class="button" bind:this={cancelButton} onclick={dismiss}>Cancel</button><button class="button primary" onclick={execute}>Confirm {confirmation.action === 'prepare' ? 'preparation' : confirmation.action === 'deploy' ? 'deployment' : 'rollback'}</button></div></div>
    {:else if release?.status !== 'recovery_required'}
      <div class="release-actions">
        {#if releaseActionAllowed(job, release, 'prepare')}<button class="button primary" disabled={!ready} onclick={() => ask('prepare')}>Prepare release</button>{/if}
        {#if releaseActionAllowed(job, release, 'deploy')}<button class="button primary" disabled={!ready} onclick={() => ask('deploy')}>Deploy prepared release</button>{/if}
        {#if releaseActionAllowed(job, release, 'rollback')}<button class="button" disabled={!ready} onclick={() => ask('rollback')}>Roll back previous release</button>{/if}
        {#if pending || activeDeployment(release?.status)}<p class="quiet" role="status">{pending ? 'Sending request…' : 'Working in the background. You can keep chatting.'}</p>{/if}
      </div>
    {/if}
    {#if release?.id}
      <details class="deployment-logs" open={activeDeployment(release.status) || release.status === 'recovery_required'}>
        <summary>Deployment log <span>{$builder.deploymentLogs.events.length} lines</span></summary>
        <div class="log-toolbar"><span>{following ? 'Following latest' : 'Scroll paused'}</span><div>{#if !following}<button class="text-button" onclick={() => { following = true; if (logBox) logBox.scrollTop = logBox.scrollHeight; }}>Latest ↓</button>{/if}<button class="text-button" disabled={!logText} onclick={copy}>{copied ? 'Copied ✓' : 'Copy log'}</button></div></div>
        {#if $builder.deploymentLogs.truncated}<p class="quiet">Latest activity shown. Earlier lines remain in the retained deployment log.</p>{/if}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users scroll and select logs.) -->
        <pre class="log-output" bind:this={logBox} tabindex="0" role="region" aria-label="Deployment activity log" onscroll={() => { if (logBox) following = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 35; }}>{logText || 'Waiting for deployment activity…'}</pre>
        {#if copyError}<p class="quiet" role="status">Copy unavailable. Select the log text to copy it.</p>{/if}
      </details>
    {/if}
  {/if}
</section>

<style>
  .release-section { margin-top: 24px; padding: 20px; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); border-radius: 15px; background: var(--bg-primary); overflow-wrap: anywhere; }
  .release-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; } .eyebrow { margin: 0 0 5px; font-size: 9px; letter-spacing: .12em; color: var(--text-secondary); } h3 { margin: 0; font-size: 18px; font-weight: 550; letter-spacing: -.02em; }
  .release-status { color: var(--accent); background: var(--gold-glow); padding: 6px 9px; border-radius: 20px; font-size: 10px; } [data-status="failed"], [data-status="recovery_required"] { color: var(--color-danger, #c74758); }
  .quiet, .phase, .health, .rollback-result, .release-error, .release-confirm p, .recovery p { font-size: 12px; line-height: 1.7; } .quiet { color: var(--text-secondary); } .quiet strong { color: var(--text-primary); font-weight: 550; } .release-meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 18px; font-size: 11px; color: var(--text-secondary); } code { font-family: var(--font-mono); color: var(--text-primary); } .phase { text-transform: capitalize; margin-bottom: 6px; } .health { color: var(--accent); } .database-note { font-size: 11px; } .rollback-result { color: var(--text-primary); }
  .release-error { padding: 11px; border: 1px solid var(--border); border-radius: 9px; color: var(--text-secondary); } .release-error strong { color: var(--text-primary); font-size: 11px; } .release-error p { margin: 5px 0 0; white-space: pre-wrap; } .release-error .text-button { display: block; }
  .recovery { margin-top: 16px; padding: 14px; border-left: 3px solid var(--accent); background: var(--bg-secondary); border-radius: 6px; } .recovery strong { font-size: 13px; font-weight: 550; } .recovery p { color: var(--text-secondary); margin: 7px 0; } .recovery small { color: var(--text-secondary); font-size: 11px; line-height: 1.6; display: block; }
  .release-actions { display: flex; gap: 9px; flex-wrap: wrap; margin-top: 16px; } .button { font: inherit; font-size: 12px; padding: 10px 13px; border: 1px solid var(--border-hover); border-radius: 8px; background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; } .button.primary { background: var(--gold-glow); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); color: var(--accent); } button:disabled { opacity: .5; cursor: default; } button:focus-visible, summary:focus-visible, pre:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .release-confirm { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 16px; } .release-confirm strong { font-size: 13px; font-weight: 550; } .release-confirm p { color: var(--text-secondary); } .release-confirm > div { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .deployment-logs { margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--border); } summary { cursor: pointer; font-size: 12px; } summary span { margin-left: 7px; font-size: 10px; color: var(--text-secondary); } .log-toolbar { display: flex; justify-content: space-between; gap: 8px; margin: 12px 0 6px; align-items: center; font-size: 10px; color: var(--text-secondary); } .log-toolbar > div { display: flex; gap: 12px; } .text-button { font: inherit; font-size: 11px; padding: 5px 0; border: 0; color: var(--accent); background: transparent; cursor: pointer; }
  .log-output { margin: 0; padding: 13px; max-height: 260px; min-height: 95px; overflow: auto; overscroll-behavior: contain; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-secondary); color: var(--text-secondary); font: 11px/1.8 var(--font-mono); }
  @media(max-width: 600px) { .release-section { padding: 16px; } .release-actions .button { width: 100%; } }
  @media(prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
</style>
