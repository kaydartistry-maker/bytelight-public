<script lang="ts">
  import { apiFetch } from '$lib/utils/api';
  import { onMount } from 'svelte';
  import '../../../bytelight.css';
  import CcPageHeader from '$lib/components/CcPageHeader.svelte';
  import ResSkeleton from '$lib/components/ResSkeleton.svelte';
  import { CC_API } from '$lib/utils/cc';

  let loading = $state(true);
  let days = $state(14);
  let taskStats = $state<any>({});
  let careStats = $state<any>({});
  let cycleStats = $state<any>({});
  let expenseStats = $state<any>({});
  let defaultPerson = $state('');

  async function load() {
    loading = true;
    try {
      const person = defaultPerson || 'default';
      const [tRes, cRes, cyRes, eRes] = await Promise.all([
        apiFetch(`${CC_API}/stats/tasks?days=${days}`),
        apiFetch(`${CC_API}/stats/care?person=${person}&days=${days}`),
        apiFetch(`${CC_API}/stats/cycle`),
        apiFetch(`${CC_API}/expenses/stats?period=month`),
      ]);
      taskStats = await tRes.json();
      careStats = await cRes.json();
      cycleStats = await cyRes.json();
      expenseStats = await eRes.json();
    } catch { /* graceful */ }
    loading = false;
  }

  function switchPeriod(d: number) { days = d; load(); }

  function barHeight(val: number | null, max: number): string {
    if (!val || !max) return '0%';
    return `${Math.round((val / max) * 100)}%`;
  }

  function avgNotNull(arr: any[], key: string): string {
    const vals = arr.map(d => d[key]).filter((v): v is number => v !== null);
    if (vals.length === 0) return '-';
    return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  }

  onMount(async () => {
    try {
      const res = await apiFetch(`${CC_API}/config`);
      if (res.ok) {
        const config = await res.json();
        defaultPerson = config.default_person || '';
      }
    } catch { /* use empty default */ }
    await load();
  });
</script>

<main class="res-page">
  <CcPageHeader title="Stats" />

  <div class="res-content">
    <!-- Period toggle -->
    <div class="res-row" style="gap: var(--space-2);">
      {#each [7, 14, 30] as d}
        <button class="res-chip" class:res-chip--active={days === d} onclick={() => switchPeriod(d)}>{d}d</button>
      {/each}
    </div>

    {#if loading}
      <ResSkeleton variant="stats" />
      <ResSkeleton variant="cards" rows={3} />
    {:else}
      <!-- Task Completion -->
      <div class="res-card">
        <span class="res-section-title">Task completion</span>
        <div class="stat-row-3">
          <div class="mini-stat"><span class="mini-val">{taskStats.completed || 0}</span><span class="mini-label">done</span></div>
          <div class="mini-stat"><span class="mini-val">{taskStats.active || 0}</span><span class="mini-label">active</span></div>
          <div class="mini-stat" class:danger={taskStats.overdue > 0}><span class="mini-val">{taskStats.overdue || 0}</span><span class="mini-label">overdue</span></div>
        </div>

        {#if taskStats.completedPerDay?.length > 0}
          <div class="bar-chart" style="margin-top: var(--space-4);">
            {#each taskStats.completedPerDay as day}
              <div class="bar-col">
                <div class="bar" style:height={barHeight(day.count, Math.max(...taskStats.completedPerDay.map((d: any) => d.count)))}></div>
                <span class="bar-label">{day.date.slice(-2)}</span>
              </div>
            {/each}
          </div>
        {/if}

        {#if taskStats.byProject?.filter((p: any) => p.active > 0 || p.completed > 0).length > 0}
          <div class="project-bars" style="margin-top: var(--space-4);">
            <span class="res-section-title">By project</span>
            {#each taskStats.byProject.filter((p: any) => p.active > 0 || p.completed > 0) as proj}
              <div class="proj-bar-row">
                <span class="proj-name res-truncate">{proj.name}</span>
                <div class="proj-bar">
                  <div class="proj-fill done" style:width="{proj.completed ? (proj.completed / (proj.active + proj.completed) * 100) : 0}%"></div>
                </div>
                <span class="proj-nums">{proj.completed}/{proj.active + proj.completed}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Care Trends -->
      <div class="res-card">
        <span class="res-section-title">Care trends ({days}d)</span>
        <div class="stat-row-3">
          <div class="mini-stat"><span class="mini-val">{avgNotNull(careStats.dailyAverages || [], 'sleep')}</span><span class="mini-label">sleep avg</span></div>
          <div class="mini-stat"><span class="mini-val">{avgNotNull(careStats.dailyAverages || [], 'energy')}</span><span class="mini-label">energy avg</span></div>
          <div class="mini-stat"><span class="mini-val">{avgNotNull(careStats.dailyAverages || [], 'mood')}</span><span class="mini-label">mood avg</span></div>
        </div>

        <!-- Sparkline for mood/energy -->
        {#if careStats.dailyAverages?.length > 0}
          <div class="sparkline-wrap" style="margin-top: var(--space-4);">
            <svg class="sparkline" viewBox="0 0 {careStats.dailyAverages.length * 20} 60" preserveAspectRatio="none">
              {#each ['mood', 'energy'] as metric, mi}
                {@const points = careStats.dailyAverages.map((d: any, i: number) => `${i * 20},${d[metric] ? 60 - (d[metric] / 5) * 50 : 55}`).join(' ')}
                <polyline fill="none" stroke={mi === 0 ? 'var(--accent)' : 'var(--color-warning)'} stroke-width="2" points={points} opacity="0.7" />
              {/each}
            </svg>
            <div class="sparkline-legend">
              <span style="color: var(--accent);">Mood</span>
              <span style="color: var(--color-warning);">Energy</span>
            </div>
          </div>
        {/if}

        <div class="progress-bars" style="margin-top: var(--space-4);">
          <div class="progress-row">
            <span class="prog-label">Meals (2+/day)</span>
            <div class="prog-bar"><div class="prog-fill" style:width="{(careStats.mealDays || 0) / (careStats.totalDays || 1) * 100}%"></div></div>
            <span class="prog-val">{careStats.mealDays || 0}/{careStats.totalDays || 0}</span>
          </div>
          <div class="progress-row">
            <span class="prog-label">Movement</span>
            <div class="prog-bar"><div class="prog-fill" style:width="{(careStats.movementDays || 0) / (careStats.totalDays || 1) * 100}%"></div></div>
            <span class="prog-val">{careStats.movementDays || 0}/{careStats.totalDays || 0}</span>
          </div>
        </div>
      </div>

      <!-- Cycle Insights -->
      {#if !cycleStats.noData}
        <div class="res-card">
          <span class="res-section-title">Cycle insights</span>
          <div class="stat-row-3">
            <div class="mini-stat"><span class="mini-val">{cycleStats.avgCycleLength || '-'}</span><span class="mini-label">cycle days</span></div>
            <div class="mini-stat"><span class="mini-val">{cycleStats.avgPeriodLength || '-'}</span><span class="mini-label">period days</span></div>
            <div class="mini-stat"><span class="mini-val capitalize">{cycleStats.currentPhase || '-'}</span><span class="mini-label">day {cycleStats.cycleDay || '-'}</span></div>
          </div>

          {#if cycleStats.energyByDay?.length > 0}
            <div class="bar-chart" style="margin-top: var(--space-4);">
              <span class="res-section-title">Energy by cycle day</span>
              {#each cycleStats.energyByDay as d}
                <div class="bar-col">
                  <div class="bar" style:height={barHeight(d.avgEnergy, 5)}></div>
                  <span class="bar-label">{d.cycleDay}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Expenses -->
      <div class="res-card">
        <span class="res-section-title">Expenses (this month)</span>
        <div class="stat-row-3">
          <div class="mini-stat"><span class="mini-val res-tabular">&pound;{(expenseStats.total || 0).toFixed(0)}</span><span class="mini-label">total</span></div>
          <div class="mini-stat"><span class="mini-val res-tabular">&pound;{(expenseStats.dailyAverage || 0).toFixed(0)}</span><span class="mini-label">daily avg</span></div>
          <div class="mini-stat"><span class="mini-val res-tabular">{expenseStats.count || 0}</span><span class="mini-label">entries</span></div>
        </div>

        {#if expenseStats.byCategory?.length > 0}
          <div class="project-bars" style="margin-top: var(--space-4);">
            {#each expenseStats.byCategory as cat}
              <div class="proj-bar-row">
                <span class="proj-name res-truncate" style="text-transform: capitalize;">{cat.category}</span>
                <div class="proj-bar"><div class="proj-fill" style:width="{cat.total / (expenseStats.total || 1) * 100}%"></div></div>
                <span class="proj-nums res-tabular">&pound;{cat.total.toFixed(0)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</main>

<style>
  .stat-row-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); }
  .mini-stat { display: flex; flex-direction: column; align-items: center; padding: var(--space-2); }
  .mini-val { font-size: var(--text-xl); font-weight: 700; }
  .mini-label { font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .mini-stat.danger .mini-val { color: var(--color-error); }
  .capitalize { text-transform: capitalize; }

  /* Bar chart */
  .bar-chart { display: flex; align-items: flex-end; gap: 3px; height: 80px; }
  .bar-col { display: flex; flex-direction: column; align-items: center; flex: 1; height: 100%; justify-content: flex-end; }
  .bar {
    width: 100%; min-height: 2px; background: var(--accent); border-radius: 3px 3px 0 0;
    transition: height 300ms ease-out;
  }
  .bar-label { font-size: 9px; color: var(--text-muted); margin-top: 4px; }

  /* Project completion bars */
  .project-bars { display: flex; flex-direction: column; gap: var(--space-2); }
  .proj-bar-row { display: flex; align-items: center; gap: var(--space-3); }
  .proj-name { font-size: var(--text-sm); min-width: 5rem; flex-shrink: 0; }
  .proj-bar { flex: 1; height: 8px; background: var(--bg-tertiary); border-radius: 4px; overflow: hidden; }
  .proj-fill { height: 100%; border-radius: 4px; transition: width 300ms ease-out; }
  .proj-fill.done { background: var(--color-success); }
  .proj-fill:not(.done) { background: var(--accent); }
  .proj-nums { font-size: var(--text-xs); color: var(--text-muted); min-width: 2.5rem; text-align: right; }

  /* Sparkline */
  .sparkline-wrap { position: relative; }
  .sparkline { width: 100%; height: 60px; }
  .sparkline-legend { display: flex; gap: var(--space-4); font-size: var(--text-xs); margin-top: var(--space-1); }

  /* Progress bars */
  .progress-bars { display: flex; flex-direction: column; gap: var(--space-3); }
  .progress-row { display: flex; align-items: center; gap: var(--space-3); }
  .prog-label { font-size: var(--text-sm); color: var(--text-secondary); min-width: 6rem; flex-shrink: 0; }
  .prog-bar { flex: 1; height: 8px; background: var(--bg-tertiary); border-radius: 4px; overflow: hidden; }
  .prog-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 300ms ease-out; }
  .prog-val { font-size: var(--text-xs); color: var(--text-muted); min-width: 2.5rem; text-align: right; }
</style>
