<script lang="ts">
  import { timeAgo } from '$lib/utils/time';
  import { onMount } from 'svelte';
  import DaemonGremlin from '$lib/components/DaemonGremlin.svelte';
  import { getPresence } from '$lib/stores/websocket.svelte';
  import { apiFetch } from '$lib/utils/api';

  let presence = $derived(getPresence());

  interface Entity {
    id: number;
    name: string;
    entity_type: string;
    context: string;
    salience: string;
    observation_count?: number;
    created_at: string;
  }

  interface Observation {
    id: number;
    content: string;
    emotion?: string;
    weight: string;
    certainty: string;
    source: string;
    created_at: string;
    entity_name?: string;
  }

  interface Journal {
    id: number;
    entry?: string;      // journal format
    content?: string;    // observation format (from search)
    emotion?: string;
    tags?: string[];
    weight?: string;
    created_at: string;
  }

  let healthRaw = $state<string>('');
  let entities = $state<Entity[]>([]);
  let journals = $state<Journal[]>([]);
  let recentObs = $state<Observation[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let activeSection = $state<'overview' | 'entities' | 'journals' | 'recent'>('overview');

  let debugTaps = $state(0);

  function setSection(section: 'overview' | 'entities' | 'journals' | 'recent') {
    debugTaps++;
    console.log('[MindPanel] Setting section to:', section, 'taps:', debugTaps);
    activeSection = section;
  }
  let expandedEntity = $state<string | null>(null);
  let entityDetails = $state<Record<string, any>>({});

  async function fetchMind(path: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await apiFetch(`/api/mind/${path}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loadAll() {
    loading = true;
    error = null;
    try {
      const results = await Promise.allSettled([
        fetchMind('health'),
        fetchMind('entities'),
        fetchMind('journals'),
        fetchMind('recent'),
      ]);
      const [healthRes, entitiesRes, journalsRes, recentRes] = results;
      if (healthRes.status === 'fulfilled') healthRaw = healthRes.value.output || JSON.stringify(healthRes.value);
      if (entitiesRes.status === 'fulfilled') entities = entitiesRes.value.entities || entitiesRes.value || [];
      if (journalsRes.status === 'fulfilled') {
        // Search results may come back as .results, .observations, .journals, or raw array
        const jr = journalsRes.value;
        journals = jr.results || jr.observations || jr.journals || (Array.isArray(jr) ? jr : []);
      }
      if (recentRes.status === 'fulfilled') recentObs = recentRes.value.observations || recentRes.value || [];
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length === results.length) {
        error = (failures[0] as PromiseRejectedResult).reason?.message || 'All Mind Bridge requests failed';
      } else if (failures.length > 0) {
        error = null; // partial data is fine, show what we got
      }
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function loadEntity(id: number, name: string) {
    if (expandedEntity === name) {
      expandedEntity = null;
      return;
    }
    try {
      const data = await fetchMind(`entities/${id}`);
      entityDetails[name] = data;
      expandedEntity = name;
    } catch {
      // silent
    }
  }

  function parseHealth(raw: string): { overall: string; sections: { title: string; status: string; lines: string[] }[] } {
    const sections: { title: string; status: string; lines: string[] }[] = [];
    let overall = '';
    const lines = raw.split('\n');
    let current: { title: string; status: string; lines: string[] } | null = null;

    for (const line of lines) {
      if (line.includes('Overall:')) {
        overall = line.trim();
      } else if (line.match(/^[^\s].*[🟢🟡🔴]/) || line.match(/^.*[🧠📊🧵📔🪞📝🌊👥🖼].*[🟢🟡🔴]/)) {
        if (current) sections.push(current);
        const statusMatch = line.match(/[🟢🟡🔴]/);
        current = {
          title: line.replace(/[─🟢🟡🔴]/g, '').trim(),
          status: statusMatch ? statusMatch[0] : '',
          lines: [],
        };
      } else if (current && line.trim() && !line.match(/^[─═]+$/)) {
        current.lines.push(line.trim());
      }
    }
    if (current) sections.push(current);
    return { overall, sections };
  }

  function weightColor(w: string): string {
    if (w === 'heavy') return 'var(--status-error, var(--color-error))';
    if (w === 'medium') return 'var(--status-waking)';
    return 'var(--text-muted)';
  }

  onMount(loadAll);
</script>

<div class="mind-panel">
  <!-- Daemon gremlin — always visible -->
  <div class="daemon-display">
    <DaemonGremlin status={presence} size={72} />
    <div class="daemon-info">
      <span class="daemon-label">Daemon</span>
      <span class="daemon-status">{presence}</span>
    </div>
  </div>

  {#if loading}
    <p class="loading-text">Connecting to Mind Bridge...</p>
  {:else if error}
    <div class="error-box">
      <p class="error-title">Mind Bridge unavailable</p>
      <p class="error-detail">{error}</p>
      <button class="res-btn res-btn--ghost res-btn--sm" onclick={loadAll}>Retry</button>
    </div>
  {:else}
    <!-- Section nav -->
    <div class="section-nav">
      <button type="button" class="res-chip" class:res-chip--active={activeSection === 'overview'} onclick={() => setSection('overview')}>Overview</button>
      <button type="button" class="res-chip" class:res-chip--active={activeSection === 'journals'} onclick={() => setSection('journals')}>Journals</button>
      <button type="button" class="res-chip" class:res-chip--active={activeSection === 'entities'} onclick={() => setSection('entities')}>Entities</button>
      <button type="button" class="res-chip" class:res-chip--active={activeSection === 'recent'} onclick={() => setSection('recent')}>Recent</button>
      <span style="font-size: 10px; color: var(--text-muted);">taps: {debugTaps}</span>
    </div>

    {#if activeSection === 'overview'}
      <!-- Health overview -->
      {@const health = parseHealth(healthRaw)}
      <div class="health-overview">
        {#if health.overall}
          <div class="overall-bar">
            <span class="overall-label">Mind Health</span>
            <span class="overall-value">{health.overall.replace('Overall:', '').trim()}</span>
          </div>
        {/if}

        <div class="health-grid">
          {#each health.sections as section}
            <div class="health-card">
              <div class="card-header">
                <span class="card-status">{section.status}</span>
                <span class="card-title">{section.title}</span>
              </div>
              <div class="card-body">
                {#each section.lines as line}
                  <div class="card-line">{line}</div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </div>

    {:else if activeSection === 'entities'}
      <div class="entities-list">
        {#if entities.length === 0}
          <p class="empty-text">No entities yet</p>
        {:else}
          {#each entities as entity}
            <button class="entity-row" class:expanded={expandedEntity === entity.name} onclick={() => loadEntity(entity.id, entity.name)}>
              <div class="entity-header">
                <span class="entity-name">{entity.name}</span>
                <span class="entity-type">{entity.entity_type}</span>
                <span class="entity-context">{entity.context}</span>
                {#if entity.salience && entity.salience !== 'active'}
                  <span class="entity-salience {entity.salience}">{entity.salience}</span>
                {/if}
              </div>
            </button>
            {#if expandedEntity === entity.name && entityDetails[entity.name]}
              {@const detail = entityDetails[entity.name]}
              <div class="entity-detail">
                {#if detail.observations?.length}
                  <div class="detail-section">
                    <h4 class="detail-title">Observations ({detail.observations.length})</h4>
                    {#each detail.observations as obs}
                      <div class="observation-item">
                        <span class="obs-weight" style="color: {weightColor(obs.weight)}">
                          {obs.weight === 'heavy' ? '***' : obs.weight === 'medium' ? '**' : '*'}
                        </span>
                        <span class="obs-content">{obs.content}</span>
                        {#if obs.emotion}
                          <span class="obs-emotion">{obs.emotion}</span>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
                {#if detail.relations?.length}
                  <div class="detail-section">
                    <h4 class="detail-title">Relations</h4>
                    {#each detail.relations as rel}
                      <div class="relation-item">
                        {rel.from_entity} <span class="rel-type">{rel.relation_type}</span> {rel.to_entity}
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
        {/if}
      </div>

    {:else if activeSection === 'journals'}
      <div class="journals-list">
        {#if journals.length === 0}
          <p class="empty-text">No journals yet</p>
        {:else}
          {#each journals as journal}
            <div class="journal-entry">
              <div class="journal-meta">
                <span class="journal-time">{timeAgo(journal.created_at)}</span>
                {#if journal.weight}
                  <span class="journal-weight" style="color: {weightColor(journal.weight)}">{journal.weight}</span>
                {/if}
                {#if journal.emotion}
                  <span class="journal-emotion">{journal.emotion}</span>
                {/if}
                {#if journal.tags?.length}
                  <span class="journal-tags">{journal.tags.join(', ')}</span>
                {/if}
              </div>
              <div class="journal-text">{journal.entry || journal.content}</div>
            </div>
          {/each}
        {/if}
      </div>

    {:else if activeSection === 'recent'}
      <div class="recent-list">
        {#if recentObs.length === 0}
          <p class="empty-text">No recent observations</p>
        {:else}
          {#each recentObs as obs}
            <div class="recent-item">
              <div class="recent-meta">
                {#if obs.entity_name}
                  <span class="recent-entity">{obs.entity_name}</span>
                {/if}
                <span class="recent-weight" style="color: {weightColor(obs.weight)}">{obs.weight}</span>
                <span class="recent-time">{timeAgo(obs.created_at)}</span>
              </div>
              <div class="recent-content">{obs.content}</div>
              {#if obs.emotion}
                <span class="recent-emotion">{obs.emotion}</span>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <button class="res-btn res-btn--ghost res-btn--sm refresh-btn" onclick={loadAll}>Refresh</button>
  {/if}
</div>

<style>
  .mind-panel {
    max-width: 640px;
  }

  .daemon-display {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.25rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 1.25rem;
  }

  .daemon-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .daemon-label {
    font-family: var(--font-heading);
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-primary);
    letter-spacing: 0.02em;
  }

  .daemon-status {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: capitalize;
  }

  .loading-text {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    padding: 2rem 0;
  }

  .error-box {
    padding: 1.5rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .error-title {
    color: var(--text-primary);
    font-weight: 500;
    margin: 0 0 0.5rem;
  }

  .error-detail {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin: 0 0 1rem;
  }

  /* Layout utility only — visuals from .res-btn */
  .refresh-btn {
    margin-top: 1.5rem;
  }

  .section-nav {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
    position: relative;
    z-index: 100;
    overflow: visible;
  }

  /* Health overview */
  .overall-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 1rem;
  }

  .overall-label {
    font-family: var(--font-heading);
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-primary);
    letter-spacing: 0.02em;
  }

  .overall-value {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    color: var(--accent);
  }

  .health-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 0.75rem;
  }

  .health-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.875rem;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .card-status {
    font-size: 0.875rem;
  }

  .card-title {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-primary);
    letter-spacing: 0.02em;
  }

  .card-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .card-line {
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    line-height: 1.5;
  }

  /* Entities */
  .entity-row {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 0.375rem;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .entity-row:hover {
    border-color: var(--border-hover);
  }

  .entity-row.expanded {
    border-color: var(--accent);
  }

  .entity-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .entity-name {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-primary);
  }

  .entity-type {
    font-size: 0.6875rem;
    color: var(--accent);
    padding: 0.125rem 0.375rem;
    background: var(--bg-hover);
    border-radius: 2rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .entity-context {
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .entity-salience {
    font-size: 0.6875rem;
    padding: 0.125rem 0.375rem;
    border-radius: 2rem;
  }

  .entity-salience.foundational {
    color: var(--accent);
    background: var(--bg-active);
  }

  .entity-salience.background {
    color: var(--text-muted);
    background: var(--bg-hover);
  }

  .entity-salience.archive {
    color: var(--text-muted);
    opacity: 0.5;
  }

  .entity-detail {
    padding: 0.75rem;
    margin: -0.25rem 0 0.375rem 1rem;
    border-left: 2px solid var(--accent);
  }

  .detail-title {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin: 0 0 0.5rem;
  }

  .detail-section {
    margin-bottom: 1rem;
  }

  .observation-item {
    display: flex;
    align-items: flex-start;
    gap: 0.375rem;
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.8125rem;
  }

  .observation-item:last-child {
    border-bottom: none;
  }

  .obs-weight {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    flex-shrink: 0;
    width: 1.5rem;
  }

  .obs-content {
    color: var(--text-primary);
    flex: 1;
    line-height: 1.5;
  }

  .obs-emotion {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-style: italic;
    flex-shrink: 0;
  }

  .relation-item {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    padding: 0.25rem 0;
  }

  .rel-type {
    color: var(--accent);
    font-weight: 500;
  }

  /* Journals */
  .journal-entry {
    padding: 1rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 0.75rem;
  }

  .journal-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .journal-time {
    font-size: 0.6875rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
  }

  .journal-weight {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .journal-emotion {
    font-size: 0.6875rem;
    color: var(--accent);
    font-style: italic;
  }

  .journal-tags {
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .journal-text {
    font-size: 0.8125rem;
    color: var(--text-primary);
    line-height: 1.6;
    white-space: pre-wrap;
  }

  /* Recent */
  .recent-item {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .recent-item:last-child {
    border-bottom: none;
  }

  .recent-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .recent-entity {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--accent);
  }

  .recent-weight {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .recent-time {
    font-size: 0.6875rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    margin-left: auto;
  }

  .recent-content {
    font-size: 0.8125rem;
    color: var(--text-primary);
    line-height: 1.5;
  }

  .recent-emotion {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-style: italic;
    display: inline-block;
    margin-top: 0.25rem;
  }

  .empty-text {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    padding: 2rem 0;
    text-align: center;
  }

  @media (max-width: 480px) {
    .health-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
