<script lang="ts">
  import { apiFetch } from '$lib/utils/api';
  import { onMount } from 'svelte';
  import '../../../bytelight.css';
  import CcPageHeader from '$lib/components/CcPageHeader.svelte';
  import ResEmpty from '$lib/components/ResEmpty.svelte';
  import ResSkeleton from '$lib/components/ResSkeleton.svelte';
  import { CC_API } from '$lib/utils/cc';

  let expenses = $state<any[]>([]);
  let total = $state(0);
  let stats = $state<any>({});
  let loading = $state(true);
  let showAdd = $state(false);
  let newAmount = $state('');
  let newCategory = $state('other');
  let newDesc = $state('');
  let newPaidBy = $state('');
  let period = $state('month');
  let currencySymbol = $state('$');

  async function load() {
    try {
      const [eRes, sRes] = await Promise.all([
        apiFetch(`${CC_API}/expenses?limit=30`),
        apiFetch(`${CC_API}/expenses/stats?period=${period}`),
      ]);
      const eData = await eRes.json(); const sData = await sRes.json();
      expenses = eData.expenses || []; total = eData.total || 0; stats = sData;
    } catch { /* empty state */ }
    loading = false;
  }

  async function addExpense() {
    const amt = parseFloat(newAmount);
    if (isNaN(amt) || amt <= 0) return;
    await apiFetch(`${CC_API}/expenses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amt, category: newCategory, description: newDesc || undefined, paid_by: newPaidBy || undefined }),
    });
    newAmount = ''; newDesc = ''; showAdd = false; await load();
  }

  function switchPeriod(p: string) { period = p; loading = true; load(); }

  onMount(async () => {
    try {
      const res = await apiFetch(`${CC_API}/config`);
      if (res.ok) {
        const config = await res.json();
        currencySymbol = config.currency_symbol || '$';
      }
    } catch { /* use default */ }
    await load();
  });
</script>

<main class="res-page">
  <CcPageHeader title="Finances" />

  <div class="res-content">
    {#if loading}
      <ResSkeleton variant="stats" />
      <ResSkeleton variant="list" rows={5} />
    {:else}
      <!-- Period toggle -->
      <div class="res-row" style="gap: var(--space-2);">
        {#each ['week', 'month', 'year'] as p}
          <button class="res-chip" class:res-chip--active={period === p} onclick={() => switchPeriod(p)}>{p}</button>
        {/each}
      </div>

      <!-- Stats -->
      <div class="stats-row">
        <div class="res-stat">
          <span class="res-stat__value res-tabular">{currencySymbol}{(stats.total || 0).toFixed(2)}</span>
          <span class="res-stat__label">total</span>
        </div>
        <div class="res-stat">
          <span class="res-stat__value res-tabular">{currencySymbol}{(stats.dailyAverage || 0).toFixed(2)}</span>
          <span class="res-stat__label">daily avg</span>
        </div>
        <div class="res-stat">
          <span class="res-stat__value res-tabular">{stats.count || 0}</span>
          <span class="res-stat__label">entries</span>
        </div>
      </div>

      <!-- Categories -->
      {#if stats.byCategory?.length > 0}
        <div class="res-card">
          <span class="res-section-title">By category</span>
          {#each stats.byCategory as cat}
            <div class="cat-row">
              <span class="cat-name">{cat.category}</span>
              <span class="cat-total res-tabular">{currencySymbol}{cat.total.toFixed(2)}</span>
              <span class="cat-count">{cat.count}x</span>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Add -->
      <div class="res-section-header">
        <span class="res-section-title" style="margin: 0;">Recent expenses</span>
        <button class="res-btn res-btn--icon" onclick={() => showAdd = !showAdd} aria-label="Add expense">+</button>
      </div>

      {#if showAdd}
        <form class="res-form" onsubmit={(e) => { e.preventDefault(); addExpense(); }}>
          <div class="res-form-row">
            <input type="number" step="0.01" min="0" bind:value={newAmount} placeholder="Amount" class="res-input" inputmode="decimal" />
            <select bind:value={newCategory} class="res-select">
              {#each ['groceries', 'bills', 'dining', 'transport', 'entertainment', 'health', 'home', 'other'] as c}
                <option value={c}>{c}</option>
              {/each}
            </select>
          </div>
          <div class="res-form-row">
            <input type="text" bind:value={newDesc} placeholder="Description" class="res-input" />
            <input type="text" bind:value={newPaidBy} placeholder="Paid by" class="res-input" style="max-width: 8rem;" />
            <button type="submit" class="res-btn res-btn--primary">Add</button>
          </div>
        </form>
      {/if}

      {#if expenses.length === 0}
        <ResEmpty message="No expenses recorded" actionLabel="Add an expense" onaction={() => showAdd = true} />
      {:else}
        <div class="expense-list">
          {#each expenses as exp}
            <div class="expense-row">
              <div class="exp-left">
                <span class="exp-desc res-truncate">{exp.description || exp.category}</span>
                <span class="exp-meta">{exp.date} &middot; {exp.category}{exp.paid_by ? ` \u00B7 ${exp.paid_by}` : ''}</span>
              </div>
              <span class="exp-amount res-tabular">{currencySymbol}{exp.amount.toFixed(2)}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</main>

<style>
  .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); }

  .cat-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--border); font-size: var(--text-base); }
  .cat-row:last-child { border-bottom: none; }
  .cat-name { flex: 1; text-transform: capitalize; }
  .cat-total { font-weight: 600; }
  .cat-count { color: var(--text-muted); font-size: var(--text-xs); }

  .expense-list { display: flex; flex-direction: column; }
  .expense-row { display: flex; justify-content: space-between; align-items: center; padding: var(--space-3) 0; border-bottom: 1px solid var(--border); }
  .exp-left { display: flex; flex-direction: column; min-width: 0; flex: 1; margin-right: var(--space-3); }
  .exp-desc { font-size: var(--text-base); }
  .exp-meta { font-size: var(--text-xs); color: var(--text-muted); }
  .exp-amount { font-weight: 600; font-size: var(--text-base); flex-shrink: 0; }
</style>
