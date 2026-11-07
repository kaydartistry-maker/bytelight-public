<script lang="ts">
  import { apiFetch } from '$lib/utils/api';
  import { onMount } from 'svelte';
  import '../../../bytelight.css';
  import CcPageHeader from '$lib/components/CcPageHeader.svelte';
  import ResCheckbox from '$lib/components/ResCheckbox.svelte';
  import ResRating from '$lib/components/ResRating.svelte';
  import ResSkeleton from '$lib/components/ResSkeleton.svelte';
  import { CC_API, todayStr, formatCategory, shortDate } from '$lib/utils/cc';

  interface CareEntry { id: string; date: string; person: string; category: string; value: string | null; note: string | null; }
  interface CareConfig {
    toggles: string[];
    ratings: string[];
    counters: { name: string; max: number }[];
  }

  let careCategories = $state<CareConfig>({ toggles: [], ratings: [], counters: [] });
  let selectedDate = $state(todayStr());
  let person = $state('');
  let entries = $state<CareEntry[]>([]);
  let loading = $state(true);
  let configLoaded = $state(false);
  let editingNote = $state<string | null>(null);
  let noteText = $state('');

  function getValue(category: string): string | null {
    return entries.find(e => e.category === category)?.value ?? null;
  }

  function getNote(category: string): string | null {
    return entries.find(e => e.category === category)?.note ?? null;
  }

  function isToggled(cat: string): boolean { return getValue(cat) === 'true'; }
  function getRating(cat: string): number { const v = getValue(cat); return v ? parseInt(v) : 0; }
  function getCounter(cat: string): number { const v = getValue(cat); return v ? parseInt(v) : 0; }

  async function loadEntries() {
    loading = true;
    try {
      const res = await apiFetch(`${CC_API}/care?date=${selectedDate}&person=${person}`);
      const data = await res.json();
      entries = data.entries || [];
    } catch { /* empty */ }
    loading = false;
  }

  async function upsertEntry(category: string, value?: string, note?: string) {
    await apiFetch(`${CC_API}/care`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: selectedDate, person, category, value, note }),
    });
    await loadEntries();
  }

  async function toggleCategory(cat: string) { await upsertEntry(cat, isToggled(cat) ? 'false' : 'true'); }
  async function setRating(cat: string, val: number) { await upsertEntry(cat, String(val)); }
  async function adjustCounter(cat: string, delta: number, max: number) {
    await upsertEntry(cat, String(Math.max(0, Math.min(max, getCounter(cat) + delta))));
  }

  async function saveNote(cat: string) {
    if (!noteText.trim()) return;
    const existing = entries.find(e => e.category === cat);
    let notes: Array<{ t: string; text: string }> = [];
    if (existing?.note) { try { notes = JSON.parse(existing.note); } catch { notes = [{ t: '', text: existing.note }]; } }
    notes.push({ t: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), text: noteText.trim() });
    await upsertEntry(cat, existing?.value || undefined, JSON.stringify(notes));
    editingNote = null; noteText = '';
  }

  function parseNotes(n: string | null): Array<{ t: string; text: string }> {
    if (!n) return [];
    try { return JSON.parse(n); } catch { return [{ t: '', text: n }]; }
  }

  function prevDay() { const d = new Date(selectedDate); d.setDate(d.getDate() - 1); selectedDate = d.toISOString().split('T')[0]; loadEntries(); }
  function nextDay() { const d = new Date(selectedDate); d.setDate(d.getDate() + 1); selectedDate = d.toISOString().split('T')[0]; loadEntries(); }

  function switchPerson() {
    loadEntries();
  }

  onMount(async () => {
    try {
      const res = await apiFetch(`${CC_API}/config`);
      if (res.ok) {
        const config = await res.json();
        person = config.default_person || '';
        if (config.care_categories) {
          careCategories = {
            toggles: config.care_categories.toggles || [],
            ratings: config.care_categories.ratings || [],
            counters: config.care_categories.counters || [],
          };
        }
      }
    } catch { /* use defaults */ }
    configLoaded = true;
    await loadEntries();
  });
</script>

<main class="res-page">
  <CcPageHeader title="Care" />

  <!-- Controls -->
  <div class="controls">
    <div class="person-row">
      <input
        type="text"
        class="res-input person-input"
        bind:value={person}
        onchange={switchPerson}
        placeholder="Person"
      />
    </div>
    <div class="res-date-nav">
      <button onclick={prevDay} aria-label="Previous day">&lsaquo;</button>
      <span class="res-date-nav__label">{selectedDate === todayStr() ? 'Today' : shortDate(selectedDate)}</span>
      <button onclick={nextDay} aria-label="Next day">&rsaquo;</button>
    </div>
  </div>

  <div class="res-content">
    {#if loading || !configLoaded}
      <ResSkeleton variant="form" />
    {:else}
      <!-- Toggles -->
      {#if careCategories.toggles.length > 0}
        <div class="res-card">
          <span class="res-section-title">Basics</span>
          <div class="toggle-grid">
            {#each careCategories.toggles as cat}
              <button class="res-chip" class:res-chip--active={isToggled(cat)} onclick={() => toggleCategory(cat)}>
                {#if isToggled(cat)}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
                {/if}
                {formatCategory(cat)}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Ratings -->
      {#if careCategories.ratings.length > 0}
        <div class="res-card">
          <span class="res-section-title">How are you?</span>
          {#each careCategories.ratings as cat}
            <div class="rating-wrap">
              <ResRating label={formatCategory(cat)} value={getRating(cat)} onchange={(n) => setRating(cat, n)} />
              <button class="note-toggle" onclick={() => { editingNote = editingNote === cat ? null : cat; noteText = ''; }} aria-label="Add note">
                {#if getNote(cat)}{parseNotes(getNote(cat)).length} notes{:else}+{/if}
              </button>
            </div>
            {#if editingNote === cat}
              <form class="note-form" onsubmit={(e) => { e.preventDefault(); saveNote(cat); }}>
                <input type="text" bind:value={noteText} placeholder="Add a note..." class="res-input" />
                <button type="submit" class="res-btn res-btn--primary" style="padding: 0 var(--space-3);">Save</button>
              </form>
            {/if}
            {#if getNote(cat)}
              <div class="note-list">
                {#each parseNotes(getNote(cat)) as note}
                  <span class="note-entry">{#if note.t}<span class="note-time">{note.t}</span>{/if}{note.text}</span>
                {/each}
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      <!-- Counters -->
      {#if careCategories.counters.length > 0}
        {#each careCategories.counters as counter}
          <div class="res-card">
            <span class="res-section-title">{formatCategory(counter.name)}</span>
            <div class="counter-row">
              <button class="res-btn res-btn--icon" onclick={() => adjustCounter(counter.name, -1, counter.max)} aria-label="Decrease {counter.name}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <div class="counter-bar">
                {#each Array(counter.max) as _, i}
                  <div class="counter-seg" class:filled={i < getCounter(counter.name)}></div>
                {/each}
              </div>
              <span class="counter-num res-tabular">{getCounter(counter.name)}</span>
              <button class="res-btn res-btn--icon" onclick={() => adjustCounter(counter.name, 1, counter.max)} aria-label="Increase {counter.name}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
            </div>
          </div>
        {/each}
      {/if}
    {/if}
  </div>
</main>

<style>
  .controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .person-row { display: flex; gap: var(--space-2); }

  .person-input {
    max-width: 10rem;
    font-size: var(--text-sm);
  }

  .toggle-grid { display: flex; flex-wrap: wrap; gap: var(--space-2); }

  .rating-wrap { display: flex; align-items: center; gap: var(--space-2); }

  .note-toggle {
    min-width: 44px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
    padding: 0 var(--space-2);
    transition: all var(--transition);
    flex-shrink: 0;
  }
  .note-toggle:hover { color: var(--text-primary); border-color: var(--border-hover); }
  .note-toggle:active { transform: scale(0.95); }

  .note-form { display: flex; gap: var(--space-2); margin: var(--space-2) 0 var(--space-3); }

  .note-list { display: flex; flex-direction: column; gap: var(--space-1); margin-bottom: var(--space-3); padding-left: var(--space-2); }
  .note-entry { font-size: var(--text-sm); color: var(--text-muted); line-height: 1.5; }
  .note-time { color: var(--accent-muted); font-size: var(--text-xs); margin-right: var(--space-2); }

  .counter-row { display: flex; align-items: center; gap: var(--space-3); }
  .counter-bar { display: flex; gap: 3px; flex: 1; }
  .counter-seg {
    flex: 1;
    height: 28px;
    border-radius: 4px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    transition: background var(--transition);
  }
  .counter-seg.filled { background: var(--accent); border-color: var(--accent); }
  .counter-num { font-size: var(--text-lg); font-weight: 700; min-width: 1.5rem; text-align: center; }

  @media (max-width: 480px) {
    .controls { flex-wrap: wrap; gap: var(--space-2); }
  }
</style>
