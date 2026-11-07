<script lang="ts">
  import { onMount } from 'svelte';
  import type { OrchestratorTaskStatus, TriggerStatus } from '@bytelight/shared';
  import {
    toggleTask,
    rescheduleTask,
    updateFailsafe,
    getFailsafe,
    cancelTriggerById,
    loadWakePrompts,
    createTriggerApi,
  } from '$lib/stores/settings.svelte';
  import WakePromptEditor from './WakePromptEditor.svelte';

  let { tasks = [], triggers = [] }: { tasks: OrchestratorTaskStatus[]; triggers: TriggerStatus[] } = $props();

  onMount(loadWakePrompts);

  let failsafe = $derived(getFailsafe());
  let editingTask = $state<string | null>(null);
  let editCronValue = $state('');

  // Group tasks by category
  let nightWakes = $derived(tasks.filter(t => t.category === 'wake'));
  let checkinTasks = $derived(tasks.filter(t => t.category === 'checkin'));
  let handoffTasks = $derived(tasks.filter(t => t.category === 'handoff'));

  function cronToTime(cron: string): string {
    // Parse simple cron like "0 1 * * *" -> "01:00"
    const parts = cron.split(' ');
    if (parts.length >= 2) {
      const min = parts[0].padStart(2, '0');
      const hour = parts[1].padStart(2, '0');
      return `${hour}:${min}`;
    }
    return cron;
  }

  function timeToCron(time: string): string {
    const [hour, min] = time.split(':');
    return `${parseInt(min)} ${parseInt(hour)} * * *`;
  }

  async function handleToggle(wakeType: string, current: boolean) {
    await toggleTask(wakeType, !current);
  }

  function startEdit(wakeType: string, cronExpr: string) {
    editingTask = wakeType;
    editCronValue = cronToTime(cronExpr);
  }

  async function saveEdit(wakeType: string) {
    const newCron = timeToCron(editCronValue);
    await rescheduleTask(wakeType, newCron);
    editingTask = null;
  }

  function cancelEdit() {
    editingTask = null;
  }

  async function handleFailsafeToggle() {
    await updateFailsafe({ enabled: !failsafe.enabled });
  }

  async function handleFailsafeThreshold(field: 'gentle' | 'concerned' | 'emergency', value: string) {
    const num = parseInt(value);
    if (!isNaN(num) && num > 0) {
      await updateFailsafe({ [field]: num });
    }
  }

  // Triggers
  let impulses = $derived(triggers.filter(t => t.kind === 'impulse'));
  let watchers = $derived(triggers.filter(t => t.kind === 'watcher'));

  function renderConditions(conditionsJson: string): string {
    try {
      const conditions = JSON.parse(conditionsJson) as Array<Record<string, unknown>>;
      return conditions.map(c => {
        switch (c.type) {
          case 'presence_state':
            return c.state === 'active' ? 'User is active'
              : c.state === 'idle' ? 'User is idle'
              : c.state === 'offline' ? 'User is offline'
              : `Presence: ${c.state}`;
          case 'presence_transition':
            return `User goes ${c.from} → ${c.to}`;
          case 'agent_free':
            return 'Bytelight is free';
          case 'time_window': {
            const after = c.after as string;
            const before = c.before as string | undefined;
            return before ? `${after}–${before}` : `After ${after}`;
          }
          case 'routine_missing':
            return `${(c.routine as string).charAt(0).toUpperCase() + (c.routine as string).slice(1)} missing after ${c.after_hour}:00`;
          default:
            return JSON.stringify(c);
        }
      }).join(' + ');
    } catch {
      return conditionsJson;
    }
  }

  function formatTime(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  async function handleCancelTrigger(id: string) {
    await cancelTriggerById(id);
  }

  // --- New trigger form ---
  type ConditionDraft = {
    type: 'presence_state' | 'presence_transition' | 'agent_free' | 'time_window' | 'routine_missing';
    state: string;
    from: string;
    to: string;
    after: string;
    before: string;
    routine: string;
    after_hour: number;
  };

  const emptyCondition = (): ConditionDraft => ({
    type: 'presence_state', state: 'active', from: 'offline', to: 'active',
    after: '09:00', before: '', routine: '', after_hour: 12,
  });

  let showCreateForm = $state(false);
  let newKind = $state<'impulse' | 'watcher'>('impulse');
  let newLabel = $state('');
  let newPrompt = $state('');
  let newCooldown = $state(120);
  let newConditions = $state<ConditionDraft[]>([emptyCondition()]);
  let createError = $state<string | null>(null);
  let creating = $state(false);

  function addCondition() {
    newConditions = [...newConditions, emptyCondition()];
  }

  function removeCondition(index: number) {
    newConditions = newConditions.filter((_, i) => i !== index);
  }

  function serializeConditions(): Array<Record<string, unknown>> {
    return newConditions.map(c => {
      switch (c.type) {
        case 'presence_state': return { type: c.type, state: c.state };
        case 'presence_transition': return { type: c.type, from: c.from, to: c.to };
        case 'agent_free': return { type: c.type };
        case 'time_window': return c.before ? { type: c.type, after: c.after, before: c.before } : { type: c.type, after: c.after };
        case 'routine_missing': return { type: c.type, routine: c.routine, after_hour: c.after_hour };
      }
    });
  }

  async function handleCreateTrigger() {
    createError = null;
    if (!newLabel.trim()) { createError = 'Label is required'; return; }
    if (newConditions.length === 0) { createError = 'At least one condition is required'; return; }
    creating = true;
    const result = await createTriggerApi({
      kind: newKind,
      label: newLabel.trim(),
      conditions: serializeConditions(),
      prompt: newPrompt.trim() || undefined,
      cooldownMinutes: newKind === 'watcher' ? newCooldown : undefined,
    });
    creating = false;
    if (result.ok) {
      showCreateForm = false;
      newLabel = '';
      newPrompt = '';
      newCooldown = 120;
      newConditions = [emptyCondition()];
    } else {
      createError = result.error ?? 'Failed to create trigger';
    }
  }
</script>

<div class="panel">
  <h2 class="panel-title">Orchestrator</h2>

  <!-- Night Wakes -->
  {#if nightWakes.length > 0}
  <div class="section">
    <h3 class="section-title">Night Wakes</h3>
    <div class="task-list">
      {#each nightWakes as task}
        <div class="task-row" class:disabled={!task.enabled}>
          <div class="task-info">
            <span class="task-label">{task.label}</span>
            {#if editingTask === task.wakeType}
              <div class="edit-row">
                <input
                  type="time"
                  class="time-input"
                  bind:value={editCronValue}
                  onkeydown={(e) => { if (e.key === 'Enter') saveEdit(task.wakeType); if (e.key === 'Escape') cancelEdit(); }}
                />
                <button class="res-btn res-btn--primary res-btn--sm" onclick={() => saveEdit(task.wakeType)}>Save</button>
                <button class="res-btn res-btn--ghost res-btn--sm" onclick={cancelEdit}>Cancel</button>
              </div>
            {:else}
              <button class="task-time" onclick={() => startEdit(task.wakeType, task.cronExpr)}>
                {cronToTime(task.cronExpr)}
              </button>
            {/if}
            <WakePromptEditor wakeType={task.wakeType} />
          </div>
          <div class="task-controls">
            <span class="status-dot" class:active={task.enabled}></span>
            <button
              class="toggle-btn"
              class:on={task.enabled}
              onclick={() => handleToggle(task.wakeType, task.enabled)}
              aria-label={task.enabled ? 'Disable' : 'Enable'}
            >
              <span class="toggle-slider"></span>
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>
  {/if}

  <!-- Check-ins -->
  {#if checkinTasks.length > 0}
  <div class="section">
    <h3 class="section-title">Check-ins</h3>
    <div class="task-list">
      {#each checkinTasks as task}
        <div class="task-row" class:disabled={!task.enabled}>
          <div class="task-info">
            <span class="task-label">{task.label}</span>
            {#if editingTask === task.wakeType}
              <div class="edit-row">
                <input
                  type="time"
                  class="time-input"
                  bind:value={editCronValue}
                  onkeydown={(e) => { if (e.key === 'Enter') saveEdit(task.wakeType); if (e.key === 'Escape') cancelEdit(); }}
                />
                <button class="res-btn res-btn--primary res-btn--sm" onclick={() => saveEdit(task.wakeType)}>Save</button>
                <button class="res-btn res-btn--ghost res-btn--sm" onclick={cancelEdit}>Cancel</button>
              </div>
            {:else}
              <button class="task-time" onclick={() => startEdit(task.wakeType, task.cronExpr)}>
                {cronToTime(task.cronExpr)}
              </button>
            {/if}
            <WakePromptEditor wakeType={task.wakeType} />
          </div>
          <div class="task-controls">
            <span class="status-dot" class:active={task.enabled}></span>
            <button
              class="toggle-btn"
              class:on={task.enabled}
              onclick={() => handleToggle(task.wakeType, task.enabled)}
              aria-label={task.enabled ? 'Disable' : 'Enable'}
            >
              <span class="toggle-slider"></span>
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>
  {/if}

  <!-- Handoff -->
  <div class="section">
    <h3 class="section-title">Handoff</h3>
    <div class="task-list">
      {#each handoffTasks as task}
        <div class="task-row" class:disabled={!task.enabled}>
          <div class="task-info">
            <span class="task-label">{task.label}</span>
            {#if editingTask === task.wakeType}
              <div class="edit-row">
                <input
                  type="time"
                  class="time-input"
                  bind:value={editCronValue}
                  onkeydown={(e) => { if (e.key === 'Enter') saveEdit(task.wakeType); if (e.key === 'Escape') cancelEdit(); }}
                />
                <button class="res-btn res-btn--primary res-btn--sm" onclick={() => saveEdit(task.wakeType)}>Save</button>
                <button class="res-btn res-btn--ghost res-btn--sm" onclick={cancelEdit}>Cancel</button>
              </div>
            {:else}
              <button class="task-time" onclick={() => startEdit(task.wakeType, task.cronExpr)}>
                {cronToTime(task.cronExpr)}
              </button>
            {/if}
            <WakePromptEditor wakeType={task.wakeType} />
          </div>
          <div class="task-controls">
            <span class="status-dot" class:active={task.enabled}></span>
            <button
              class="toggle-btn"
              class:on={task.enabled}
              onclick={() => handleToggle(task.wakeType, task.enabled)}
              aria-label={task.enabled ? 'Disable' : 'Enable'}
            >
              <span class="toggle-slider"></span>
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- Failsafe -->
  <div class="section">
    <h3 class="section-title">
      Failsafe
      <button
        class="toggle-btn"
        class:on={failsafe.enabled}
        onclick={handleFailsafeToggle}
        aria-label={failsafe.enabled ? 'Disable failsafe' : 'Enable failsafe'}
      >
        <span class="toggle-slider"></span>
      </button>
    </h3>
    {#if failsafe.enabled}
      <div class="threshold-grid">
        <label class="threshold-label">
          <span>Gentle</span>
          <div class="threshold-input-row">
            <input
              type="number"
              class="threshold-input"
              value={failsafe.gentle}
              min="30"
              onchange={(e) => handleFailsafeThreshold('gentle', (e.target as HTMLInputElement).value)}
            />
            <span class="threshold-unit">min</span>
          </div>
        </label>
        <label class="threshold-label">
          <span>Concerned</span>
          <div class="threshold-input-row">
            <input
              type="number"
              class="threshold-input"
              value={failsafe.concerned}
              min="60"
              onchange={(e) => handleFailsafeThreshold('concerned', (e.target as HTMLInputElement).value)}
            />
            <span class="threshold-unit">min</span>
          </div>
        </label>
        <label class="threshold-label">
          <span>Emergency</span>
          <div class="threshold-input-row">
            <input
              type="number"
              class="threshold-input"
              value={failsafe.emergency}
              min="120"
              onchange={(e) => handleFailsafeThreshold('emergency', (e.target as HTMLInputElement).value)}
            />
            <span class="threshold-unit">min</span>
          </div>
        </label>
      </div>
    {/if}
  </div>

  <!-- Triggers -->
  <div class="section">
    <h3 class="section-title">
      Triggers
      <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => { showCreateForm = !showCreateForm; createError = null; }}>
        {showCreateForm ? 'Close' : '+ New'}
      </button>
    </h3>

    {#if showCreateForm}
      <div class="create-form">
        <div class="form-row">
          <label class="form-label">
            <span>Kind</span>
            <select class="form-select" bind:value={newKind}>
              <option value="impulse">Impulse — fires once, then done</option>
              <option value="watcher">Watcher — recurring, with cooldown</option>
            </select>
          </label>
          <label class="form-label">
            <span>Label</span>
            <input type="text" class="form-input" bind:value={newLabel} placeholder="e.g. Greet when back online" />
          </label>
        </div>

        <div class="conditions-builder">
          <span class="trigger-group-label">Conditions (all must match)</span>
          {#each newConditions as cond, i}
            <div class="condition-row">
              <select class="form-select" bind:value={cond.type}>
                <option value="presence_state">Presence is…</option>
                <option value="presence_transition">Presence changes…</option>
                <option value="agent_free">Agent is free</option>
                <option value="time_window">Time window</option>
                <option value="routine_missing">Routine missing</option>
              </select>
              {#if cond.type === 'presence_state'}
                <select class="form-select" bind:value={cond.state}>
                  <option value="active">active</option>
                  <option value="idle">idle</option>
                  <option value="offline">offline</option>
                </select>
              {:else if cond.type === 'presence_transition'}
                <select class="form-select" bind:value={cond.from}>
                  <option value="active">from active</option>
                  <option value="idle">from idle</option>
                  <option value="offline">from offline</option>
                </select>
                <select class="form-select" bind:value={cond.to}>
                  <option value="active">to active</option>
                  <option value="idle">to idle</option>
                  <option value="offline">to offline</option>
                </select>
              {:else if cond.type === 'time_window'}
                <input type="time" class="form-input form-input--time" bind:value={cond.after} title="After" />
                <input type="time" class="form-input form-input--time" bind:value={cond.before} title="Before (optional)" />
              {:else if cond.type === 'routine_missing'}
                <input type="text" class="form-input" bind:value={cond.routine} placeholder="routine name" />
                <input type="number" class="form-input form-input--num" bind:value={cond.after_hour} min="0" max="23" title="After hour" />
              {/if}
              {#if newConditions.length > 1}
                <button class="cancel-btn" onclick={() => removeCondition(i)} aria-label="Remove condition" title="Remove">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              {/if}
            </div>
          {/each}
          <button class="res-btn res-btn--ghost res-btn--sm add-condition-btn" onclick={addCondition}>+ Condition</button>
        </div>

        <label class="form-label">
          <span>Prompt (what should happen when it fires)</span>
          <textarea class="form-input form-textarea" bind:value={newPrompt} rows="2" placeholder="e.g. The operator just came back online — say hi."></textarea>
        </label>

        {#if newKind === 'watcher'}
          <label class="form-label form-label--inline">
            <span>Cooldown</span>
            <input type="number" class="form-input form-input--num" bind:value={newCooldown} min="1" />
            <span class="threshold-unit">min</span>
          </label>
        {/if}

        {#if createError}
          <p class="create-error">{createError}</p>
        {/if}

        <button class="res-btn res-btn--primary res-btn--sm" onclick={handleCreateTrigger} disabled={creating}>
          {creating ? 'Creating…' : `Create ${newKind}`}
        </button>
      </div>
    {/if}

    {#if impulses.length === 0 && watchers.length === 0}
      <p class="empty-text">No active triggers</p>
    {:else}
      {#if impulses.length > 0}
        <div class="trigger-group">
          <span class="trigger-group-label">Impulses</span>
          <div class="task-list">
            {#each impulses as trigger}
              <div class="task-row">
                <div class="task-info">
                  <span class="task-label">{trigger.label}</span>
                  <span class="trigger-conditions">{renderConditions(trigger.conditions)}</span>
                </div>
                <div class="task-controls">
                  <span class="trigger-badge" class:pending={trigger.status === 'pending'} class:waiting={trigger.status === 'waiting'} class:fired={trigger.status === 'fired'}>
                    {trigger.status}
                  </span>
                  {#if trigger.status === 'pending' || trigger.status === 'waiting'}
                    <button class="cancel-btn" onclick={() => handleCancelTrigger(trigger.id)} aria-label="Cancel trigger" title="Cancel">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                      </svg>
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if watchers.length > 0}
        <div class="trigger-group">
          <span class="trigger-group-label">Watchers</span>
          <div class="task-list">
            {#each watchers as trigger}
              <div class="task-row">
                <div class="task-info">
                  <span class="task-label">{trigger.label}</span>
                  <span class="trigger-conditions">{renderConditions(trigger.conditions)}</span>
                  <span class="trigger-meta">
                    Fired {trigger.fire_count}x
                    {#if trigger.last_fired_at} · Last: {formatTime(trigger.last_fired_at)}{/if}
                    · Cooldown: {trigger.cooldown_minutes}min
                  </span>
                </div>
                <div class="task-controls">
                  <span class="trigger-badge" class:pending={trigger.status === 'pending'} class:waiting={trigger.status === 'waiting'}>
                    {trigger.status}
                  </span>
                  {#if trigger.status === 'pending' || trigger.status === 'waiting'}
                    <button class="cancel-btn" onclick={() => handleCancelTrigger(trigger.id)} aria-label="Cancel trigger" title="Cancel">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                      </svg>
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .panel-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-title {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .task-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .task-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    transition: opacity 0.2s;
  }

  .task-row.disabled {
    opacity: 0.5;
  }

  .task-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .task-label {
    font-size: 0.875rem;
    color: var(--text-primary);
  }

  .task-time {
    font-size: 0.75rem;
    color: var(--accent);
    font-family: var(--font-mono);
    cursor: pointer;
    padding: 0;
    text-align: left;
  }

  .task-time:hover {
    text-decoration: underline;
  }

  .task-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .status-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--status-dormant);
  }

  .status-dot.active {
    background: var(--status-active);
  }

  .toggle-btn {
    position: relative;
    width: 2.5rem;
    height: 1.375rem;
    background: var(--bg-surface);
    border-radius: 1rem;
    border: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.2s;
    padding: 0;
  }

  .toggle-btn.on {
    background: var(--accent);
    border-color: var(--accent);
  }

  .toggle-slider {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 1rem;
    height: 1rem;
    background: var(--text-secondary);
    border-radius: 50%;
    transition: transform 0.2s, background 0.2s;
  }

  .toggle-btn.on .toggle-slider {
    transform: translateX(1.125rem);
    background: white;
  }

  .edit-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .time-input {
    width: 7rem;
    font-size: 0.875rem;
    padding: 0.25rem 0.5rem;
  }

  .threshold-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
  }

  .threshold-label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }

  .threshold-input-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .threshold-input {
    width: 5rem;
    font-size: 0.875rem;
    padding: 0.25rem 0.5rem;
  }

  .threshold-unit {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .empty-text {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .trigger-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .trigger-group-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .trigger-conditions {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .trigger-meta {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .trigger-badge {
    font-size: 0.6875rem;
    padding: 0.125rem 0.5rem;
    border-radius: 1rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .trigger-badge.pending {
    background: var(--bg-surface);
    color: var(--text-muted);
  }

  .trigger-badge.waiting {
    background: var(--gold-ember);
    color: var(--gold);
    animation: pulse-glow 2s ease-in-out infinite;
  }

  .trigger-badge.fired {
    background: var(--gold-ember);
    color: var(--gold);
  }

  @keyframes pulse-glow {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .cancel-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s;
    padding: 0;
    background: transparent;
    border: none;
  }

  .cancel-btn:hover {
    color: var(--color-danger);
    background: var(--color-danger-muted);
  }

  .create-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .form-label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .form-label--inline {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }

  .form-input,
  .form-select {
    font-size: 0.8125rem;
    padding: 0.375rem 0.5rem;
    color: var(--text-primary);
    background: var(--bg-input, var(--bg-surface));
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .form-input--time {
    width: 6.5rem;
  }

  .form-input--num {
    width: 4.5rem;
  }

  .form-textarea {
    resize: vertical;
    font-family: inherit;
  }

  .conditions-builder {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .condition-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .add-condition-btn {
    align-self: flex-start;
  }

  .create-error {
    font-size: 0.75rem;
    color: var(--color-danger, #d04040);
    margin: 0;
  }

  @media (max-width: 768px) {
    .threshold-grid {
      grid-template-columns: 1fr;
    }

    .form-row {
      grid-template-columns: 1fr;
    }
  }
</style>
