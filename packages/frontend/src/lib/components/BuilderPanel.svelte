<script lang="ts">
  import BuilderRelease from './BuilderRelease.svelte';
  import { onMount, tick } from 'svelte';
  import { builder, builderView, closeBuilder } from '$lib/stores/builder';
  import { activeBuilder, elapsedBuilder, activeDeployment, safeBuilderText, statusLabel } from '$lib/utils/builder';

  let dialog: HTMLDialogElement;
  let drawerBody: HTMLDivElement | undefined;
  let logBox: HTMLPreElement | undefined = $state();
  let cancelStop: HTMLButtonElement | undefined = $state();
  let confirmStop = $state<string | null>(null);
  let following = $state(true), copied = $state(false), copyError = $state(false), now = $state(Date.now());
  const selectedId = $derived($builder.selectedId);
  const selected = $derived($builder.jobs.find(j => j.id === $builder.selectedId));
  const activeCount = $derived($builder.jobs.filter(j => activeBuilder(j.status) || activeDeployment(j.deployment?.status)).length);
  const logText = $derived($builder.logs.events.map(e => `${new Date(e.at).toLocaleTimeString([], { hour12: false })}  ${e.message}`).join('\n'));
  const visible = $derived($builderView.open);
  onMount(() => {
    builder.start();
    const resume = () => { if (document.visibilityState === 'visible') void builder.refresh(); };
    window.addEventListener('online', resume); window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { builder.destroy(); window.removeEventListener('online', resume); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  });
  $effect(() => {
    builder.setOpen(visible);
    if (dialog) { if (visible && !dialog.open) dialog.showModal(); else if (!visible && dialog.open) dialog.close(); }
    if (!visible) confirmStop = null;
  });
  $effect(() => { if (visible && (activeCount || activeDeployment($builder.deployment?.status))) { now = Date.now(); const timer = setInterval(() => now = Date.now(), 1000); return () => clearInterval(timer); } });
  $effect(() => { selectedId; if (drawerBody) drawerBody.scrollTop = 0; following = true; copied = false; copyError = false; confirmStop = null; });
  $effect(() => { if (confirmStop) void tick().then(() => cancelStop?.focus()); });
  $effect(() => { logText; if (following && logBox) void tick().then(() => { if (logBox) logBox.scrollTop = logBox.scrollHeight; }); });
  function scrollLogs() { if (logBox) following = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 35; }
  async function copyLogs() {
    copied = false; copyError = false;
    try { await navigator.clipboard.writeText(safeBuilderText(logText)); copied = true; } catch { copyError = true; }
  }
  async function stop() { const id = confirmStop; confirmStop = null; if (id) await builder.stop(id); }
  function cancel(event: Event) { event.preventDefault(); if (confirmStop) confirmStop = null; else closeBuilder(); }
</script>

<dialog bind:this={dialog} class="builder-drawer" aria-labelledby="builder-title" oncancel={cancel} onclose={closeBuilder}>
  <div class="drawer-shell">
    <header class="builder-header">
      <div class="title-mark" aria-hidden="true">⌘</div>
      <div class="title-block"><p class="eyebrow">BOSS DADDY MODE</p><h2 id="builder-title">Builder</h2></div>
      <span class="live-label">{activeCount ? 'In progress' : 'Workspace'}</span>
      <button class="icon-button" onclick={closeBuilder} aria-label="Close Builder" title="Close Builder">×</button>
    </header>
    <div class="drawer-body" bind:this={drawerBody}>
      {#if $builder.availability === 'denied'}
        <div class="empty-state"><span aria-hidden="true">⌘</span><h3>Your owner's workspace</h3><p>Sign in with the owner account to view builder jobs.</p></div>
      {:else if $builder.availability === 'disabled'}
        <div class="empty-state"><span aria-hidden="true">⌘</span><h3>Builder is resting</h3><p>Builder is off for this app. Once enabled, coding jobs and their progress will appear here.</p><small>You can keep chatting as usual.</small></div>
      {:else if $builder.availability === 'loading'}
        <div class="empty-state" role="status"><span aria-hidden="true">⌘</span><h3>Opening the workspace…</h3><p>Checking on your latest jobs.</p></div>
      {:else}
        {#if $builder.error}<div class="notice" role="status">{$builder.error}<button onclick={() => builder.refresh()}>Retry now</button></div>{/if}
        {#if selected}
          <section class="job-summary" aria-label="Selected builder job">
            <div class="summary-top"><span class="status" data-status={selected.status}><i aria-hidden="true"></i>{statusLabel[selected.status]}</span><span class="mode-label">{selected.mode === 'inspect' ? 'Investigation' : 'Development'}</span></div>
            <h3>{selected.task}</h3>
            <div class="job-meta"><span class="branch" title={selected.branch}><span aria-hidden="true">⑂</span> {selected.branch || 'Preparing branch'}</span><span class="elapsed">{elapsedBuilder(selected, now)}</span></div>
            <div class="phase-track" aria-label={`Current phase: ${selected.currentPhase}`}>
              {#each ['Prepare', 'Develop', 'Result'] as phase, i}
                <span class:current={i === (activeBuilder(selected.status) ? selected.currentPhase === 'preparing' || selected.status === 'queued' ? 0 : 1 : 2)}><b aria-hidden="true">{i + 1}</b>{phase}</span>
              {/each}
            </div>
            {#if activeBuilder(selected.status)}
              <div class="current-work"><span class="section-label">{selected.status === 'stopping' ? 'Finishing the stop' : selected.currentPhase === 'preparing' ? 'Preparing workspace' : 'Working on your task'}</span>{#if selected.command}<code>{selected.command}</code>{/if}</div>
              {#if selected.status === 'stopping' || $builder.stoppingId === selected.id}
                <p class="stopping-note" role="status">Stopping the job and its processes. Your work will be kept.</p>
              {:else if confirmStop === selected.id}
                <div class="stop-confirm" role="group" aria-label="Confirm stop"><p>Stop this job? Changes already made will stay in its workspace.</p><div><button class="button secondary" bind:this={cancelStop} onclick={() => confirmStop = null}>Keep working</button><button class="button stop" onclick={stop}>Stop job</button></div></div>
              {:else}<button class="button stop stop-trigger" onclick={() => confirmStop = selected.id}><span aria-hidden="true">■</span> Stop job</button>{/if}
            {:else}
              <div class="result-note" data-status={selected.status}>
                <strong>{selected.status === 'succeeded' ? 'Job complete. Ready to review.' : selected.status === 'stopped' ? 'Stopped. Your changes are kept.' : selected.status === 'orphaned' ? 'This job needs a look.' : 'This job couldn’t finish.'}</strong>
                <p>The workspace and branch are retained. {selected.deployment ? 'Release progress and recovery are shown below.' : 'Release preparation is a separate step below.'}</p>
              </div>
            {/if}
          </section>
          {#if selected.status === 'succeeded'}{#key selected.id}<BuilderRelease job={selected} {now} />{/key}{/if}
          {#if selected.error}<section class="result-section"><h4>What happened</h4><pre class="report error-text">{selected.error}</pre></section>{/if}
          {#if selected.report && !activeBuilder(selected.status)}<section class="result-section"><h4>Result</h4><pre class="report">{selected.report}</pre></section>{/if}
          <details class="files-section" open={selected.changedFiles.length > 0 && selected.changedFiles.length <= 5}>
            <summary>Changed files <span>{selected.changedFiles.length}</span></summary>
            {#if selected.changedFiles.length}<ul>{#each selected.changedFiles as file}<li><span aria-hidden="true">↳</span><code>{file}</code></li>{/each}</ul>{:else}<p>Files will appear as the job reports its results.</p>{/if}
          </details>
          <details class="logs-section" open>
            <summary>Coding log <span>{$builder.logs.events.length ? `${$builder.logs.events.length} lines` : 'Waiting for activity'}</span></summary>
            <div class="log-toolbar"><span>{following ? 'Following latest' : 'Scroll paused'}</span><div>{#if !following}<button onclick={() => { following = true; if (logBox) logBox.scrollTop = logBox.scrollHeight; }}>Jump to latest ↓</button>{/if}<button onclick={copyLogs} disabled={!logText}>{copied ? 'Copied ✓' : 'Copy log'}</button></div></div>
            {#if $builder.logs.truncated}<p class="log-note">Showing the latest activity. Earlier lines remain in the job log.</p>{/if}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll and select the log.) -->
            <pre class="log-output" bind:this={logBox} onscroll={scrollLogs} tabindex="0" role="region" aria-label="Builder activity log">{logText || 'No activity yet.'}</pre>
            {#if copyError}<p class="log-note" role="status">Copy is unavailable here. Select the log text to copy it.</p>{/if}
          </details>
        {:else if $builder.availability === 'ready'}
          <div class="empty-state"><span aria-hidden="true">⌘</span><h3>Room to build</h3><p>Ask your companion to start a builder job in chat. Follow its progress here while you keep talking.</p><small>Code · Dependencies · Tests · Builds</small></div>
        {/if}
        {#if $builder.jobs.length}
          <section class="recent-section"><div class="section-heading"><h3>Recent jobs</h3><span>{$builder.jobs.length}</span></div><div class="recent-list">
            {#each $builder.jobs as job (job.id)}<button class="recent-job" class:selected={job.id === $builder.selectedId} aria-pressed={job.id === $builder.selectedId} onclick={() => builder.select(job.id)}><span class="recent-dot" data-status={job.status} aria-hidden="true"></span><span class="recent-text"><strong>{job.task}</strong><small>{statusLabel[job.status]} · {new Date(job.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span><span aria-hidden="true">↗</span></button>{/each}
          </div></section>
        {/if}
      {/if}
    </div>
    <footer><span class="footer-dot" aria-hidden="true"></span>{activeCount ? 'Work continues when you close this panel.' : 'Your code. Your workspace.'}<span class="footer-key">Esc to close</span></footer>
  </div>
</dialog>

<style>
  .builder-drawer { padding: 0; margin: 0 0 0 auto; width: min(620px, 100%); max-width: 100vw; height: 100dvh; max-height: 100dvh; border: 0; border-left: 1px solid var(--border); color: var(--text-primary); background: var(--bg-secondary); box-shadow: -16px 0 70px var(--shadow); }
  .builder-drawer::backdrop { background: rgb(0 0 0 / .42); backdrop-filter: blur(3px); }
  .drawer-shell { display: flex; flex-direction: column; height: 100%; }
  .builder-header { display: flex; align-items: center; gap: 12px; padding: 25px 26px 22px; border-bottom: 1px solid var(--border); background: var(--bg-primary); }
  .title-mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 13px; border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); background: var(--gold-glow); color: var(--accent); font-size: 25px; }
  .title-block { flex: 1; } .eyebrow { margin: 0 0 3px; font-size: 9px; letter-spacing: .16em; color: var(--text-secondary); } h2 { margin: 0; font-size: 23px; letter-spacing: -.035em; font-weight: 600; }
  .live-label { color: var(--text-secondary); font-size: 11px; } .icon-button { border: 0; background: transparent; color: var(--text-secondary); font-size: 28px; width: 40px; height: 40px; cursor: pointer; border-radius: 10px; }
  button:hover { filter: brightness(1.08); } button:focus-visible, summary:focus-visible, pre:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; } .icon-button:hover { background: var(--bg-hover); }
  .drawer-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 26px; } .job-summary { border: 1px solid var(--border-hover); border-radius: 17px; padding: 22px; background: var(--bg-primary); }
  .summary-top { display: flex; justify-content: space-between; gap: 10px; align-items: center; } .status { display: inline-flex; align-items: center; gap: 7px; color: var(--accent); font-size: 11px; font-weight: 600; background: var(--gold-glow); border-radius: 20px; padding: 6px 10px; }
  .status i, .recent-dot, .footer-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; } [data-status="failed"], [data-status="orphaned"] { color: var(--color-danger, #e26775); } [data-status="stopped"], [data-status="queued"] { color: var(--text-secondary); }
  .mode-label, .section-label { color: var(--text-secondary); font-size: 11px; } .job-summary h3 { font-size: 19px; line-height: 1.45; letter-spacing: -.025em; font-weight: 550; margin: 18px 0 14px; overflow-wrap: anywhere; }
  .job-meta { display: flex; gap: 14px; align-items: center; color: var(--text-secondary); font-size: 11px; } .branch { font-family: var(--font-mono); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; } .branch span { color: var(--accent); font-size: 17px; } .elapsed { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .phase-track { display: flex; margin: 22px 0 18px; border-top: 1px solid var(--border); padding-top: 17px; gap: 10px; } .phase-track > span { flex: 1; display: flex; align-items: center; gap: 7px; color: var(--text-secondary); font-size: 11px; } .phase-track b { font-size: 9px; font-weight: 500; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; border: 1px solid var(--border-hover); } .phase-track .current { color: var(--accent); } .current b { background: var(--gold-glow); border-color: var(--accent); }
  .current-work { display: flex; flex-direction: column; gap: 7px; } code { font-family: var(--font-mono); font-size: 11px; overflow-wrap: anywhere; } .current-work code { color: var(--text-primary); }
  .button { border-radius: 8px; padding: 9px 13px; border: 1px solid var(--border-hover); font: inherit; font-size: 12px; cursor: pointer; background: var(--bg-surface); color: var(--text-primary); } .button.stop { color: var(--color-danger, #e26775); background: transparent; border-color: color-mix(in srgb, var(--color-danger, #e26775) 30%, transparent); } .stop-trigger { margin-top: 18px; } .stop-trigger span { margin-right: 6px; font-size: 9px; }
  .stopping-note, .stop-confirm p { font-size: 12px; color: var(--text-secondary); line-height: 1.6; } .stop-confirm { margin-top: 16px; border-top: 1px solid var(--border); } .stop-confirm > div { display: flex; gap: 9px; justify-content: flex-end; }
  .result-note { margin-top: 8px; font-size: 12px; line-height: 1.6; } .result-note strong { font-weight: 550; } .result-note p { color: var(--text-secondary); margin-bottom: 0; }
  .result-section, .files-section, .logs-section { margin-top: 24px; } h4 { font-size: 12px; font-weight: 600; margin: 0 0 10px; } .report { font: 12px/1.7 var(--font-mono); color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; margin: 0; } .error-text { color: var(--color-danger, #e26775); }
  summary { cursor: pointer; color: var(--text-primary); font-size: 12px; font-weight: 550; padding: 4px 0; } summary > span { color: var(--text-secondary); font-size: 10px; font-weight: 400; margin-left: 8px; } .files-section ul { list-style: none; padding: 8px 0 0; margin: 0; max-height: 230px; overflow: auto; } .files-section li { display: flex; gap: 10px; padding: 5px 0; color: var(--text-secondary); } .files-section li > span { color: var(--accent); } .files-section p { color: var(--text-secondary); font-size: 12px; }
  .log-toolbar { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-top: 12px; font-size: 10px; color: var(--text-secondary); } .log-toolbar > div { display: flex; gap: 12px; } .log-toolbar button, .notice button { padding: 5px 0; background: none; border: 0; color: var(--accent); font: inherit; cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
  .log-output { margin: 5px 0 0; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); padding: 15px; font: 11px/1.8 var(--font-mono); min-height: 120px; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; overscroll-behavior: contain; color: var(--text-secondary); } .log-note { color: var(--text-secondary); font-size: 10px; line-height: 1.6; }
  .recent-section { margin-top: 30px; } .section-heading { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; } .section-heading h3 { font-size: 12px; font-weight: 550; margin: 0; } .section-heading > span { color: var(--text-secondary); font-size: 10px; } .recent-list { display: flex; flex-direction: column; gap: 5px; }
  .recent-job { display: flex; width: 100%; align-items: center; gap: 12px; text-align: left; border-radius: 11px; padding: 12px; background: transparent; color: var(--text-secondary); border: 1px solid transparent; cursor: pointer; } .recent-job.selected { background: var(--bg-primary); border-color: var(--border); } .recent-job:hover { background: var(--bg-hover); } .recent-text { min-width: 0; flex: 1; } .recent-text strong { display: block; font-size: 12px; color: var(--text-primary); font-weight: 450; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .recent-text small { display: block; font-size: 10px; margin-top: 5px; } .recent-dot { color: var(--accent); }
  .empty-state { min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 32px 18px; } .empty-state > span { color: var(--accent); font-size: 40px; margin-bottom: 20px; } .empty-state h3 { font-size: 21px; font-weight: 500; letter-spacing: -.03em; margin: 0 0 12px; } .empty-state p { max-width: 330px; font-size: 13px; line-height: 1.8; color: var(--text-secondary); margin: 0; } .empty-state small { color: var(--text-secondary); font-size: 11px; margin-top: 20px; }
  .notice { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; font-size: 12px; color: var(--text-secondary); line-height: 1.6; padding: 12px; border: 1px solid var(--border); border-radius: 9px; margin-bottom: 18px; }
  footer { border-top: 1px solid var(--border); padding: 16px 26px max(16px, env(safe-area-inset-bottom)); display: flex; gap: 8px; align-items: center; font-size: 10px; color: var(--text-secondary); background: var(--bg-primary); } .footer-dot { color: var(--accent); width: 4px; height: 4px; } .footer-key { margin-left: auto; font-size: 9px; }
  @media (max-width: 600px) { .builder-header { padding: max(18px, env(safe-area-inset-top)) 18px 18px; } .drawer-body { padding: 18px; } .job-summary { padding: 18px; } .live-label, .footer-key { display: none; } footer { padding-left: 18px; padding-right: 18px; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
</style>
