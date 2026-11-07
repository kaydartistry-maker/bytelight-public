<script lang="ts">
  import { apiFetch } from '$lib/utils/api';
  import { onMount } from 'svelte';
  import '../../../bytelight.css';
  import CcPageHeader from '$lib/components/CcPageHeader.svelte';
  import ResEmpty from '$lib/components/ResEmpty.svelte';
  import ResSkeleton from '$lib/components/ResSkeleton.svelte';
  import { CC_API, todayStr, shortDate } from '$lib/utils/cc';

  interface ValeEvent {
    id: string; title: string; start_date: string; start_time: string | null;
    end_date: string | null; category: string; description: string | null;
  }

  let selectedDate = $state(todayStr());
  let events = $state<ValeEvent[]>([]);
  let monthDates = $state<string[][]>([]);
  let currentMonth = $state(new Date());
  let loading = $state(true);
  let showAdd = $state(false);
  let newTitle = $state('');
  let newTime = $state('');
  let newCategory = $state('default');
  let newRecurrence = $state('');

  function computeMonth(d: Date): string[][] {
    const year = d.getFullYear(), month = d.getMonth();
    const first = new Date(year, month, 1);
    const startDay = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const weeks: string[][] = [];
    let week: string[] = [];
    for (let i = 0; i < startDay; i++) week.push('');
    for (let day = 1; day <= daysInMonth; day++) {
      week.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      if (week.length === 7) { weeks.push(week); week = []; }
    }
    if (week.length > 0) { while (week.length < 7) week.push(''); weeks.push(week); }
    return weeks;
  }

  function monthLabel(): string { return currentMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }
  function prevMonth() { currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1); monthDates = computeMonth(currentMonth); loadMonth(); }
  function nextMonth() { currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1); monthDates = computeMonth(currentMonth); loadMonth(); }
  function eventsOnDate(date: string): ValeEvent[] { return events.filter(e => e.start_date === date); }

  async function loadMonth() {
    loading = true;
    try {
      const y = currentMonth.getFullYear(), m = currentMonth.getMonth();
      const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const end = `${y}-${String(m + 1).padStart(2, '0')}-${new Date(y, m + 1, 0).getDate()}`;
      const res = await apiFetch(`${CC_API}/events?start_date=${start}&end_date=${end}`);
      const data = await res.json();
      events = data.events || [];
    } catch { /* empty */ }
    loading = false;
  }

  async function addEvent() {
    if (!newTitle.trim()) return;
    await apiFetch(`${CC_API}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newTitle.trim(), start_date: selectedDate, start_time: newTime || undefined,
        category: newCategory,
        recurrence: newRecurrence ? JSON.stringify({ type: newRecurrence, interval: 1 }) : undefined,
      }),
    });
    newTitle = ''; newTime = ''; newRecurrence = ''; showAdd = false; await loadMonth();
  }

  async function deleteEvent(id: string) {
    await apiFetch(`${CC_API}/events/${id}`, { method: 'DELETE' });
    await loadMonth();
  }

  onMount(() => { monthDates = computeMonth(currentMonth); loadMonth(); });
</script>

<main class="res-page">
  <CcPageHeader title="Calendar" />

  <!-- Month nav -->
  <div class="month-nav">
    <button class="res-btn res-btn--icon" onclick={prevMonth} aria-label="Previous month">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <span class="month-label">{monthLabel()}</span>
    <button class="res-btn res-btn--icon" onclick={nextMonth} aria-label="Next month">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
    </button>
  </div>

  <div class="res-content" style="gap: var(--space-3);">
    {#if loading}
      <ResSkeleton variant="calendar" />
    {:else}
      <!-- Calendar grid -->
      <div class="cal-grid">
        {#each ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as day}
          <div class="cal-header">{day}</div>
        {/each}
        {#each monthDates as week}
          {#each week as date}
            <button
              class="cal-cell"
              class:empty={!date}
              class:today={date === todayStr()}
              class:selected={date === selectedDate}
              class:has-events={date && eventsOnDate(date).length > 0}
              onclick={() => { if (date) selectedDate = date; }}
              disabled={!date}
              aria-label={date ? shortDate(date) : undefined}
            >
              {#if date}
                <span class="cal-day">{parseInt(date.split('-')[2])}</span>
                {#if eventsOnDate(date).length > 0}
                  <span class="cal-dot"></span>
                {/if}
              {/if}
            </button>
          {/each}
        {/each}
      </div>

      <!-- Day detail -->
      <div class="res-card">
        <div class="res-section-header">
          <span class="res-section-title" style="margin: 0;">{shortDate(selectedDate)}</span>
          <button class="res-btn res-btn--icon" onclick={() => showAdd = !showAdd} aria-label="Add event">+</button>
        </div>

        {#if showAdd}
          <form class="res-form" style="margin-bottom: var(--space-3);" onsubmit={(e) => { e.preventDefault(); addEvent(); }}>
            <input type="text" bind:value={newTitle} placeholder="Event title" class="res-input" style="width: 100%;" />
            <div class="res-form-row">
              <input type="time" bind:value={newTime} class="res-input" />
              <select bind:value={newCategory} class="res-select">
                <option value="default">General</option>
                <option value="work">Work</option>
                <option value="personal">Personal</option>
                <option value="health">Health</option>
                <option value="home">Home</option>
              </select>
            </div>
            <div class="res-form-row">
              <select bind:value={newRecurrence} class="res-select">
                <option value="">No repeat</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
              <button type="submit" class="res-btn res-btn--primary">Add</button>
            </div>
          </form>
        {/if}

        {#if eventsOnDate(selectedDate).length === 0}
          <ResEmpty message="No events this day" actionLabel="Add an event" onaction={() => showAdd = true} />
        {:else}
          {#each eventsOnDate(selectedDate) as event}
            <div class="event-row">
              <span class="ev-time">{event.start_time || 'All day'}</span>
              <span class="ev-title res-truncate">{event.title}</span>
              <span class="ev-cat">{event.category}</span>
              <button class="res-btn res-btn--icon del-btn" onclick={() => deleteEvent(event.id)} aria-label="Delete event">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
</main>

<style>
  .month-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border);
  }
  .month-label { font-weight: 600; font-size: var(--text-md); }

  .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .cal-header { text-align: center; font-size: var(--text-xs); color: var(--text-muted); padding: var(--space-2); font-weight: 500; }

  .cal-cell {
    min-height: 44px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: none;
    border: 1px solid transparent;
    border-radius: 10px;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: var(--text-base);
    gap: 3px;
    transition: all var(--transition);
    -webkit-tap-highlight-color: transparent;
  }
  .cal-cell:hover:not(.empty) { background: var(--bg-hover); }
  .cal-cell:active:not(.empty) { transform: scale(0.93); }
  .cal-cell.empty { cursor: default; }
  .cal-cell.today .cal-day { color: var(--accent); font-weight: 700; }
  .cal-cell.selected { border-color: var(--accent); background: var(--bg-surface); }
  .cal-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }

  .event-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--border);
    min-height: 44px;
  }
  .event-row:last-child { border-bottom: none; }
  .ev-time { font-size: var(--text-sm); color: var(--text-muted); min-width: 4rem; flex-shrink: 0; }
  .ev-title { flex: 1; font-size: var(--text-base); }
  .ev-cat { font-size: var(--text-xs); color: var(--text-muted); flex-shrink: 0; }
  .del-btn { width: 36px; height: 36px; min-width: 36px; min-height: 36px; color: var(--text-muted); flex-shrink: 0; }
  .del-btn:hover { color: var(--color-danger); }
</style>
