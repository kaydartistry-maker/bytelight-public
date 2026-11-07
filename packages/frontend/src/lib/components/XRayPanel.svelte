<script lang="ts">
  import { timeAgo } from '$lib/utils/time';
  import { api, apiFetch } from '$lib/utils/api';
  import { onMount } from 'svelte';

  interface MemoryFile {
    name: string;
    path: string;
    content: string;
  }

  interface WakePrompts {
    rawContent: string | null;
    prompts: Record<string, string>;
    path: string;
  }

  interface OrientationPart {
    label: string;
    content: string;
  }

  interface ContextInfo {
    parts: OrientationPart[];
    raw: string;
    identity: { companion_name: string; user_name: string; timezone: string };
    meta: { threadName: string; platform: string; includeStatic: boolean; generatedAt: string };
  }

  type TriggerCondition =
    | { type: 'presence_state'; state: string }
    | { type: 'presence_transition'; from: string; to: string }
    | { type: 'agent_free' }
    | { type: 'time_window'; after: string; before?: string }
    | { type: 'routine_missing'; routine: string; after_hour: number };

  interface Trigger {
    id: string;
    kind: 'impulse' | 'watcher';
    label: string;
    conditions: string;
    prompt: string | null;
    thread_id: string | null;
    cooldown_minutes: number;
    status: 'pending' | 'waiting' | 'fired' | 'cancelled';
    last_fired_at: string | null;
    fire_count: number;
    created_at: string;
    fired_at: string | null;
  }

  interface AuditEntry {
    id: string;
    session_id: string;
    thread_id: string;
    tool_name: string;
    tool_input: string | null;
    tool_output: string | null;
    triggering_message_id: string | null;
    created_at: string;
  }

  let activeSection = $state<'identity' | 'memory' | 'wakes' | 'context' | 'hooks' | 'activity'>('identity');

  // Identity state
  let identityContent = $state<string>('');
  let identityPath = $state<string>('');
  let identityEditing = $state(false);
  let identityDraft = $state('');

  // Memory state
  let memoryIndex = $state<string | null>(null);
  let memoryFiles = $state<MemoryFile[]>([]);
  let memoryDir = $state('');
  let nativeMemoryIndex = $state<string | null>(null);
  let nativeMemoryFiles = $state<MemoryFile[]>([]);
  let nativeMemoryDir = $state('');
  let expandedMemory = $state<string | null>(null);
  let memoryEditing = $state<string | null>(null);
  let memoryDraft = $state('');

  // Wakes state
  let wakesData = $state<WakePrompts | null>(null);
  let wakesEditing = $state(false);
  let wakesDraft = $state('');

  // Context state
  let contextInfo = $state<ContextInfo | null>(null);
  let contextView = $state<'structured' | 'raw'>('structured');
  let contextPlatform = $state<'web' | 'telegram' | 'discord'>('web');
  let contextStatic = $state(true); // true = first-message turn, false = mid-thread
  let contextLoading = $state(false);

  // Per-block collapse state, persisted in localStorage. Key -> explicit bool.
  // A missing key means "use the length-based smart default".
  let collapseState = $state<Record<string, boolean>>({});
  const COLLAPSE_PREFIX = 'xray:collapse:';

  function smartCollapsedDefault(content: string): boolean {
    return content.length > 150 || content.split('\n').length > 3;
  }

  function isCollapsed(key: string, content: string): boolean {
    const explicit = collapseState[key];
    return explicit === undefined ? smartCollapsedDefault(content) : explicit;
  }

  function toggleCollapse(key: string, content: string) {
    const next = !isCollapsed(key, content);
    collapseState = { ...collapseState, [key]: next };
    try {
      localStorage.setItem(COLLAPSE_PREFIX + key, next ? '1' : '0');
    } catch {}
  }

  function hydrateCollapse() {
    try {
      const next: Record<string, boolean> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(COLLAPSE_PREFIX)) {
          next[k.slice(COLLAPSE_PREFIX.length)] = localStorage.getItem(k) === '1';
        }
      }
      collapseState = next;
    } catch {}
  }

  function summaryLine(content: string): string {
    const first = content.split('\n').find((l) => l.trim().length > 0) ?? '';
    return first.length > 60 ? first.slice(0, 60) + '…' : first;
  }

  // Hooks state
  let triggers = $state<Trigger[]>([]);
  let expandedTrigger = $state<string | null>(null);
  let rawConditions = $state<Set<string>>(new Set());

  // Activity state (audit_log timeline)
  let auditEntries = $state<AuditEntry[]>([]);
  let auditLimit = $state(100);
  let auditFilter = $state<'all' | 'errors'>('all');
  let auditSearch = $state('');
  let expandedAudit = $state<string | null>(null);
  let auditLoading = $state(false);

  let loading = $state(true);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let saveMessage = $state<string | null>(null);

  function setSection(section: 'identity' | 'memory' | 'wakes' | 'context' | 'hooks' | 'activity') {
    activeSection = section;
  }

  // --- Activity helpers ---
  function auditStatus(output: string | null): 'ok' | 'error' | 'neutral' {
    if (!output || output.trim() === '') return 'neutral';
    return output.startsWith('[ERROR]') ? 'error' : 'ok';
  }

  function parseToolName(raw: string): { server: string | null; tool: string } {
    const m = raw.match(/^mcp__(.+?)__(.+)$/);
    if (m) return { server: m[1], tool: m[2] };
    return { server: null, tool: raw };
  }

  // First meaningful line of an [ERROR] output, for a strong one-line row summary.
  function errorSummary(output: string): string {
    const body = output.replace(/^\[ERROR\]\s*/, '');
    const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? body;
    const trimmed = firstLine.trim();
    return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
  }

  const filteredAudit = $derived(() => {
    const q = auditSearch.trim().toLowerCase();
    return auditEntries.filter((e) => {
      if (auditFilter === 'errors' && auditStatus(e.tool_output) !== 'error') return false;
      if (q && !e.tool_name.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  async function fetchXray(path: string) {
    const res = await apiFetch(`/api/xray/${path}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  // Re-fetch only the Context preview with the chosen fidelity (platform + mode).
  async function loadContext(platform = contextPlatform, includeStatic = contextStatic) {
    contextLoading = true;
    try {
      contextInfo = await fetchXray(`context?platform=${platform}&includeStatic=${includeStatic}`);
    } catch (e: any) {
      error = e.message;
    } finally {
      contextLoading = false;
    }
  }

  function setContextPlatform(p: 'web' | 'telegram' | 'discord') {
    contextPlatform = p;
    loadContext();
  }

  function setContextStatic(s: boolean) {
    contextStatic = s;
    loadContext();
  }

  // Activity audit log lives at /api/audit (not /api/xray/*).
  async function loadAudit(limit = auditLimit) {
    auditLoading = true;
    try {
      const res = await apiFetch(`/api/audit?limit=${limit}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`audit: ${res.status}`);
      const data = await res.json();
      auditEntries = data.entries || [];
    } catch (e: any) {
      error = e.message;
    } finally {
      auditLoading = false;
    }
  }

  function loadMoreAudit() {
    auditLimit += 100;
    loadAudit(auditLimit);
  }

  async function loadAll() {
    loading = true;
    error = null;
    try {
      const [identity, memory, wakes, context, hooks, audit] = await Promise.all([
        fetchXray('identity'),
        fetchXray('memory'),
        fetchXray('wakes'),
        fetchXray(`context?platform=${contextPlatform}&includeStatic=${contextStatic}`),
        fetchXray('hooks'),
        apiFetch(`/api/audit?limit=${auditLimit}`, { credentials: 'include' }).then((r) => r.json()),
      ]);

      identityContent = identity.content || '';
      identityPath = identity.path || '';

      memoryIndex = memory.index;
      memoryFiles = memory.files || [];
      memoryDir = memory.memoryDir || '';
      nativeMemoryIndex = memory.native?.index ?? null;
      nativeMemoryFiles = memory.native?.files || [];
      nativeMemoryDir = memory.native?.memoryDir || '';

      wakesData = wakes;

      contextInfo = context;

      triggers = hooks.triggers || [];

      auditEntries = audit.entries || [];
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  // Shared PUT-and-confirm for the three editable XRay files.
  async function saveDraft(url: string, content: string, onSaved: () => void) {
    saving = true;
    saveMessage = null;
    try {
      const res = await api.put(url, { content });
      if (!res.ok) throw new Error('Failed to save');
      onSaved();
      saveMessage = 'Saved (backup created)';
      setTimeout(() => saveMessage = null, 3000);
    } catch (e: any) {
      saveMessage = `Error: ${e.message}`;
    } finally {
      saving = false;
    }
  }

  function saveIdentity() {
    return saveDraft('/api/xray/identity', identityDraft, () => {
      identityContent = identityDraft;
      identityEditing = false;
    });
  }

  function saveMemoryFile(filename: string) {
    return saveDraft(`/api/xray/memory/${encodeURIComponent(filename)}`, memoryDraft, () => {
      memoryFiles = memoryFiles.map(f =>
        f.name === filename ? { ...f, content: memoryDraft } : f
      );
      memoryEditing = null;
    });
  }

  function saveWakes() {
    return saveDraft('/api/xray/wakes', wakesDraft, () => {
      if (wakesData) {
        wakesData.rawContent = wakesDraft;
      }
      wakesEditing = false;
    });
  }

  function startEditIdentity() {
    identityDraft = identityContent;
    identityEditing = true;
  }

  function cancelEditIdentity() {
    identityEditing = false;
  }

  function startEditMemory(file: MemoryFile) {
    memoryDraft = file.content;
    memoryEditing = file.name;
  }

  function cancelEditMemory() {
    memoryEditing = null;
  }

  function startEditWakes() {
    wakesDraft = wakesData?.rawContent || '';
    wakesEditing = true;
  }

  function cancelEditWakes() {
    wakesEditing = false;
  }

  // --- Hooks helpers ---
  function parseConditions(json: string): TriggerCondition[] {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  function describeCondition(c: TriggerCondition): string {
    switch (c.type) {
      case 'presence_state': return `presence is ${c.state}`;
      case 'presence_transition': return `presence goes ${c.from} → ${c.to}`;
      case 'agent_free': return 'agent is free';
      case 'time_window': return c.before ? `between ${c.after} and ${c.before}` : `after ${c.after}`;
      case 'routine_missing': return `routine "${c.routine}" missing after ${c.after_hour}:00`;
      default: return JSON.stringify(c);
    }
  }

  function conditionSummary(json: string): string {
    const cs = parseConditions(json);
    return cs.length ? cs.map(describeCondition).join(' AND ') : 'no conditions';
  }

  function lastFired(t: Trigger): string {
    const v = t.last_fired_at ?? t.fired_at;
    return v ? new Date(v).toLocaleString() : 'never';
  }

  function toggleRawConditions(id: string) {
    const next = new Set(rawConditions);
    if (next.has(id)) next.delete(id); else next.add(id);
    rawConditions = next;
  }

  onMount(() => {
    hydrateCollapse();
    loadAll();
  });
</script>

<!-- Reusable collapsible block: uniform chevron + summary on every long field.
     Default-collapsed by length; per-block state persisted in localStorage. -->
{#snippet collapsibleBlock(key: string, label: string, content: string)}
  {@const collapsed = isCollapsed(key, content)}
  <div class="collapse-block">
    <button type="button" class="collapse-header" onclick={() => toggleCollapse(key, content)}>
      <span class="collapse-label">{label}</span>
      <span class="collapse-right">
        {#if collapsed}
          <span class="collapse-summary">{summaryLine(content)}</span>
        {/if}
        <span class="collapse-chevron">{collapsed ? '▶' : '▼'}</span>
      </span>
    </button>
    {#if !collapsed}
      <pre class="code-block small">{content}</pre>
    {/if}
  </div>
{/snippet}

<div class="xray-panel">
  <!-- Navigation -->
  <nav class="xray-nav">
    <button type="button" class="nav-btn" class:active={activeSection === 'identity'} onclick={() => setSection('identity')}>Identity</button>
    <button type="button" class="nav-btn" class:active={activeSection === 'memory'} onclick={() => setSection('memory')}>Memory</button>
    <button type="button" class="nav-btn" class:active={activeSection === 'wakes'} onclick={() => setSection('wakes')}>Wakes</button>
    <button type="button" class="nav-btn" class:active={activeSection === 'context'} onclick={() => setSection('context')}>Context</button>
    <button type="button" class="nav-btn" class:active={activeSection === 'hooks'} onclick={() => setSection('hooks')}>Hooks</button>
    <button type="button" class="nav-btn" class:active={activeSection === 'activity'} onclick={() => setSection('activity')}>Activity</button>
  </nav>

  {#if loading}
    <div class="loading">Loading X-Ray data...</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else}
    {#if saveMessage}
      <div class="save-message" class:error={saveMessage.startsWith('Error')}>{saveMessage}</div>
    {/if}

    <!-- IDENTITY SECTION -->
    {#if activeSection === 'identity'}
      <section class="section">
        <div class="section-header">
          <h3 class="section-title">CLAUDE.md</h3>
          <span class="section-path">{identityPath}</span>
        </div>

        {#if identityEditing}
          <textarea
            class="code-editor"
            bind:value={identityDraft}
            rows="25"
          ></textarea>
          <div class="edit-actions">
            <button class="res-btn res-btn--primary" onclick={saveIdentity} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button class="res-btn res-btn--ghost" onclick={cancelEditIdentity}>Cancel</button>
          </div>
        {:else}
          <pre class="code-block">{identityContent}</pre>
          <button class="res-btn res-btn--primary" onclick={startEditIdentity}>Edit</button>
        {/if}
      </section>

    <!-- MEMORY SECTION -->
    {:else if activeSection === 'memory'}
      <section class="section">
        <div class="section-header">
          <h3 class="section-title">Native Claude Memory</h3>
          <span class="section-path">{nativeMemoryDir}</span>
        </div>

        <p class="description">This is Claude’s file-backed memory for this project. It lives outside the repository and is the memory Claude can update across native Claude sessions.</p>

        {#if nativeMemoryIndex}
          <div class="memory-index">
            <h4>MEMORY.md Index</h4>
            <pre class="code-block small">{nativeMemoryIndex}</pre>
          </div>
        {:else}
          <p class="muted">No MEMORY.md index file yet.</p>
        {/if}

        {#if nativeMemoryFiles.length === 0}
          <p class="muted">No memory files found.</p>
        {:else}
          <div class="memory-list">
            {#each nativeMemoryFiles as file}
              <div class="memory-item">
                <button
                  class="memory-header"
                  onclick={() => expandedMemory = expandedMemory === file.name ? null : file.name}
                >
                  <span class="memory-name">{file.name}</span>
                  <span class="memory-toggle">{expandedMemory === file.name ? '▼' : '▶'}</span>
                </button>

                {#if expandedMemory === file.name}
                  <div class="memory-content">
                    <pre class="code-block small">{file.content}</pre>
                    <span class="muted">Read-only view</span>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <div class="section-header" style="margin-top: 2rem">
          <h3 class="section-title">Repo / Plugin Memory</h3>
          <span class="section-path">{memoryDir}</span>
        </div>
        <p class="description">These are ByteLight’s checked-out skills and plugin memory files. They are separate from native Claude memory.</p>
        {#if memoryIndex}
          <div class="memory-index">
            <h4>MEMORY.md Index</h4>
            <pre class="code-block small">{memoryIndex}</pre>
          </div>
        {/if}
        {#each memoryFiles as file}
          <div class="memory-item">
            <button class="memory-header" onclick={() => expandedMemory = expandedMemory === `repo:${file.name}` ? null : `repo:${file.name}`}>
              <span class="memory-name">{file.name}</span>
              <span class="memory-toggle">{expandedMemory === `repo:${file.name}` ? '▼' : '▶'}</span>
            </button>
            {#if expandedMemory === `repo:${file.name}`}
              <div class="memory-content"><pre class="code-block small">{file.content}</pre><button class="res-btn res-btn--ghost res-btn--sm" onclick={() => startEditMemory(file)}>Edit</button></div>
            {/if}
          </div>
        {/each}
      </section>

    <!-- WAKES SECTION -->
    {:else if activeSection === 'wakes'}
      <section class="section">
        <div class="section-header">
          <h3 class="section-title">Wake Prompts</h3>
          <span class="section-path">{wakesData?.path}</span>
        </div>

        {#if wakesEditing}
          <textarea
            class="code-editor"
            bind:value={wakesDraft}
            rows="25"
          ></textarea>
          <div class="edit-actions">
            <button class="res-btn res-btn--primary" onclick={saveWakes} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button class="res-btn res-btn--ghost" onclick={cancelEditWakes}>Cancel</button>
          </div>
        {:else if wakesData?.rawContent}
          <pre class="code-block">{wakesData.rawContent}</pre>
          <button class="res-btn res-btn--primary" onclick={startEditWakes}>Edit</button>
        {:else}
          <p class="muted">No wake prompts file found.</p>
        {/if}

        {#if wakesData?.prompts && Object.keys(wakesData.prompts).length > 0}
          <div class="wake-sections">
            <h4>Parsed Sections</h4>
            {#each Object.entries(wakesData.prompts) as [key, value]}
              <div class="wake-item">
                <span class="wake-key">{key}</span>
                <span class="wake-preview">{value.slice(0, 100)}...</span>
              </div>
            {/each}
          </div>
        {/if}
      </section>

    <!-- CONTEXT SECTION -->
    {:else if activeSection === 'context'}
      <section class="section">
        <div class="section-header">
          <h3 class="section-title">Context Injection</h3>
          {#if contextInfo}
            <span class="section-path">live preview · "{contextInfo.meta.threadName}" · {contextInfo.meta.platform}</span>
          {/if}
        </div>

        {#if contextInfo}
          <p class="description">
            The exact <code>[Context]</code> block prepended to every message — built live from
            <code>buildOrientationContext()</code>, not a static legend. Rendered here against your most
            recent thread.
          </p>

          <div class="context-controls">
            <div class="context-view-toggle">
              <button type="button" class="nav-btn" class:active={contextView === 'structured'} onclick={() => contextView = 'structured'}>Structured</button>
              <button type="button" class="nav-btn" class:active={contextView === 'raw'} onclick={() => contextView = 'raw'}>Raw</button>
            </div>
            <div class="context-view-toggle">
              <button type="button" class="nav-btn" class:active={contextStatic} onclick={() => setContextStatic(true)}>First message</button>
              <button type="button" class="nav-btn" class:active={!contextStatic} onclick={() => setContextStatic(false)}>Mid-thread</button>
            </div>
            <select class="context-select" bind:value={contextPlatform} onchange={() => loadContext()} aria-label="Preview platform">
              <option value="web">web</option>
              <option value="telegram">telegram</option>
              <option value="discord">discord</option>
            </select>
            {#if contextLoading}<span class="muted context-updating">updating…</span>{/if}
          </div>

          {#if contextPlatform === 'telegram'}
            <p class="muted context-note">telegram has no dedicated channel block — it inherits web's framing. (The live channel-history tail is attached at send time and can't be reconstructed in a preview.)</p>
          {/if}

          {#if contextView === 'structured'}
            {#if contextInfo.parts.length === 0}
              <p class="muted">No context segments for this thread right now.</p>
            {:else}
              {#each contextInfo.parts as part}
                {@render collapsibleBlock(`context:${part.label}`, part.label, part.content)}
              {/each}
            {/if}
          {:else}
            <pre class="code-block">{contextInfo.raw}</pre>
          {/if}

          <div class="context-block">
            <h4>Current Identity</h4>
            <div class="context-list">
              <div class="context-item">
                <span class="context-key">companion_name</span>
                <span class="context-value">{contextInfo.identity.companion_name}</span>
              </div>
              <div class="context-item">
                <span class="context-key">user_name</span>
                <span class="context-value">{contextInfo.identity.user_name}</span>
              </div>
              <div class="context-item">
                <span class="context-key">timezone</span>
                <span class="context-value">{contextInfo.identity.timezone}</span>
              </div>
            </div>
          </div>
        {/if}
      </section>

    <!-- HOOKS SECTION -->
    {:else if activeSection === 'hooks'}
      <section class="section">
        <div class="section-header">
          <h3 class="section-title">Triggers & Watchers</h3>
        </div>

        {#if triggers.length === 0}
          <p class="muted">No active triggers or watchers.</p>
        {:else}
          <div class="hooks-list">
            {#each triggers as trigger}
              <div class="hook-item">
                <button
                  class="hook-header"
                  onclick={() => expandedTrigger = expandedTrigger === trigger.id ? null : trigger.id}
                >
                  <span class="hook-head-left">
                    <span class="status-dot" data-status={trigger.status} title={trigger.status}></span>
                    <span class="hook-label">{trigger.label}</span>
                    <span class="hook-type">{trigger.kind}</span>
                  </span>
                  <span class="hook-head-right">
                    <span class="hook-summary">{conditionSummary(trigger.conditions)}</span>
                    <span class="memory-toggle">{expandedTrigger === trigger.id ? '▼' : '▶'}</span>
                  </span>
                </button>

                {#if expandedTrigger === trigger.id}
                  <div class="hook-body">
                    <div class="hook-field">
                      <div class="hook-field-head">
                        <h4>Conditions</h4>
                        <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => toggleRawConditions(trigger.id)}>
                          {rawConditions.has(trigger.id) ? 'Plain' : 'Raw JSON'}
                        </button>
                      </div>
                      {#if rawConditions.has(trigger.id)}
                        <pre class="code-block small">{trigger.conditions}</pre>
                      {:else}
                        <ul class="condition-list">
                          {#each parseConditions(trigger.conditions) as c}
                            <li>{describeCondition(c)}</li>
                          {:else}
                            <li class="muted">no conditions</li>
                          {/each}
                        </ul>
                      {/if}
                    </div>

                    {@render collapsibleBlock(`hook:${trigger.id}:prompt`, 'Prompt', trigger.prompt ?? '(no prompt)')}

                    <div class="hook-meta">
                      <span>fired <strong>{trigger.fire_count}×</strong></span>
                      <span>last fired: {lastFired(trigger)}</span>
                      <span>cooldown: {trigger.cooldown_minutes}m</span>
                      <span>created: {new Date(trigger.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>

    <!-- ACTIVITY SECTION -->
    {:else if activeSection === 'activity'}
      <section class="section">
        <div class="section-header">
          <h3 class="section-title">Activity</h3>
          <span class="section-path">what the companions actually did · {filteredAudit().length} of {auditEntries.length}</span>
        </div>

        <p class="description">
          The real tool calls from <code>audit_log</code> — newest first. Outputs are capped
          at 1000 chars by the logger, and no timing is recorded (yet).
        </p>

        <div class="context-controls">
          <div class="context-view-toggle">
            <button type="button" class="nav-btn" class:active={auditFilter === 'all'} onclick={() => auditFilter = 'all'}>All</button>
            <button type="button" class="nav-btn" class:active={auditFilter === 'errors'} onclick={() => auditFilter = 'errors'}>Errors</button>
          </div>
          <input class="audit-search" type="text" placeholder="filter by tool…" bind:value={auditSearch} aria-label="Filter activity by tool name" />
          {#if auditLoading}<span class="muted context-updating">updating…</span>{/if}
        </div>

        {#if filteredAudit().length === 0}
          <p class="muted">{auditEntries.length === 0 ? 'No tool activity recorded yet.' : 'No activity matches this filter.'}</p>
        {:else}
          <div class="hooks-list">
            {#each filteredAudit() as entry (entry.id)}
              {@const parsed = parseToolName(entry.tool_name)}
              {@const status = auditStatus(entry.tool_output)}
              <div class="hook-item">
                <button
                  class="hook-header audit-row"
                  onclick={() => expandedAudit = expandedAudit === entry.id ? null : entry.id}
                >
                  <span class="status-dot" data-status={status === 'ok' ? 'fired' : status === 'error' ? 'cancelled' : 'pending'} title={status}></span>
                  <span class="audit-main">
                    <span class="audit-line1">
                      <span class="audit-tool">{parsed.tool}</span>
                      {#if parsed.server}<span class="hook-type audit-server">{parsed.server}</span>{/if}
                    </span>
                    <span class="audit-preview" class:error={status === 'error'}>
                      {status === 'error'
                        ? errorSummary(entry.tool_output ?? '')
                        : (entry.tool_input ? summaryLine(entry.tool_input) : '—')}
                    </span>
                  </span>
                  <span class="audit-meta-right">
                    <span class="audit-time">{timeAgo(entry.created_at, { dateAfterDays: 7, formatDate: (d) => d.toLocaleDateString() })}</span>
                    <span class="memory-toggle">{expandedAudit === entry.id ? '▼' : '▶'}</span>
                  </span>
                </button>

                {#if expandedAudit === entry.id}
                  <div class="hook-body audit-body">
                    <div class="audit-section">
                      <h4>Input</h4>
                      <pre class="code-block small">{entry.tool_input ?? '(no input)'}</pre>
                    </div>
                    <div class="audit-section">
                      <h4>Output</h4>
                      {#if status === 'error'}
                        <p class="audit-error-line">{errorSummary(entry.tool_output ?? '')}</p>
                      {/if}
                      <pre class="code-block small">{entry.tool_output ?? '(no output captured)'}</pre>
                    </div>
                    <div class="audit-section">
                      <h4>Metadata</h4>
                      <dl class="audit-meta-list">
                        <div><dt>when</dt><dd>{new Date(entry.created_at).toLocaleString()}</dd></div>
                        <div><dt>tool</dt><dd class="audit-meta-tool">{entry.tool_name}</dd></div>
                        <div><dt>session</dt><dd>{entry.session_id.slice(0, 8)}</dd></div>
                        <div><dt>thread</dt><dd>{entry.thread_id.slice(0, 8)}</dd></div>
                        {#if entry.triggering_message_id}<div><dt>msg</dt><dd>{entry.triggering_message_id.slice(0, 8)}</dd></div>{/if}
                      </dl>
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
          <button class="res-btn res-btn--ghost res-btn--sm audit-more" onclick={loadMoreAudit} disabled={auditLoading}>
            {auditLoading ? 'Loading…' : 'Load more'}
          </button>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .xray-panel {
    max-width: 800px;
  }

  .xray-nav {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
  }

  .nav-btn {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .nav-btn:hover {
    color: var(--text-secondary);
    border-color: var(--border-hover);
  }

  .nav-btn.active {
    color: var(--gold);
    border-color: var(--gold-dim);
    background: var(--gold-ember);
  }

  .loading, .error {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
  }

  .error {
    color: var(--color-danger);
  }

  .save-message {
    padding: 0.5rem 1rem;
    margin-bottom: 1rem;
    border-radius: var(--radius-sm);
    background: var(--gold-ember);
    color: var(--gold);
    font-size: 0.875rem;
  }

  .save-message.error {
    background: var(--color-danger-muted);
    color: var(--color-danger);
  }

  .section {
    margin-bottom: 2rem;
  }

  .section-header {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .section-title {
    font-family: var(--font-heading);
    font-size: 1rem;
    font-weight: 400;
    color: var(--text-accent);
    letter-spacing: 0.04em;
    margin: 0;
  }

  .section-path {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .description {
    color: var(--text-secondary);
    font-size: 0.875rem;
    margin-bottom: 1rem;
  }

  .muted {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
  }

  .code-block {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-secondary);
    max-height: 500px;
    overflow-y: auto;
  }

  .code-block.small {
    max-height: 300px;
    font-size: 0.75rem;
  }

  .code-editor {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--gold-dim);
    border-radius: var(--radius);
    padding: 1rem;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--text-primary);
    resize: vertical;
  }

  .code-editor:focus {
    outline: none;
    border-color: var(--gold);
    box-shadow: 0 0 0 2px var(--gold-glow);
  }

  .edit-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  /* Memory */
  .memory-index {
    margin-bottom: 1.5rem;
  }

  .memory-index h4 {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 0.5rem;
    font-weight: 500;
  }

  .memory-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .memory-item {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .memory-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--bg-tertiary);
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--text-primary);
    font-size: 0.875rem;
  }

  .memory-header:hover {
    background: var(--bg-hover);
  }

  .memory-name {
    font-family: var(--font-mono);
  }

  .memory-toggle {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .memory-content {
    padding: 1rem;
    border-top: 1px solid var(--border);
  }

  /* Wakes */
  .wake-sections {
    margin-top: 1.5rem;
  }

  .wake-sections h4 {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 0.75rem;
    font-weight: 500;
  }

  .wake-item {
    display: flex;
    gap: 1rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
    align-items: baseline;
  }

  .wake-key {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--gold);
    min-width: 120px;
  }

  .wake-preview {
    font-size: 0.75rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Context */
  .context-block {
    margin-bottom: 1.5rem;
  }

  .context-block h4 {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 0.75rem;
    font-weight: 500;
  }

  .context-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .context-item {
    display: flex;
    gap: 1rem;
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--border);
  }

  .context-key {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--gold-dim);
    min-width: 140px;
  }

  .context-value {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .context-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .context-view-toggle {
    display: flex;
    gap: 0.25rem;
  }

  .context-select {
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .context-select:focus {
    outline: none;
    border-color: var(--gold-dim);
  }

  .context-updating {
    font-size: 0.75rem;
  }

  .audit-search {
    flex: 1 1 12rem;
    min-width: 0;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-family: var(--font-mono);
    color: var(--text-primary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .audit-search:focus {
    outline: none;
    border-color: var(--gold-dim);
  }

  .audit-time {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .audit-more {
    margin-top: 1rem;
  }

  /* Activity row — grid so name/preview/time/chevron never overlap */
  .hook-header.audit-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.625rem;
  }

  .audit-main {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .audit-line1 {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }

  .audit-tool {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .audit-server {
    max-width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
  }

  .audit-preview {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .audit-preview.error {
    color: var(--color-danger);
  }

  .audit-meta-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  /* Expanded audit detail — three roomy sections */
  .audit-body {
    gap: 1.25rem;
  }

  .audit-section h4 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin: 0 0 0.5rem;
    font-weight: 600;
  }

  .audit-error-line {
    margin: 0 0 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-danger);
    font-weight: 500;
  }

  .audit-meta-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0;
  }

  .audit-meta-list > div {
    display: flex;
    gap: 0.75rem;
    font-size: 0.75rem;
  }

  .audit-meta-list dt {
    flex-shrink: 0;
    width: 4rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .audit-meta-list dd {
    margin: 0;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    word-break: break-all;
  }

  .audit-meta-tool {
    color: var(--text-primary);
  }

  .context-note {
    margin: -0.25rem 0 1rem;
    font-size: 0.75rem;
    line-height: 1.5;
  }

  /* Collapsible block — uniform control reused by Context cards + hook prompts */
  .collapse-block {
    margin-bottom: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .collapse-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.875rem;
    background: var(--bg-tertiary);
    border: none;
    cursor: pointer;
    text-align: left;
  }

  .collapse-header:hover {
    background: var(--bg-hover);
  }

  .collapse-label {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--gold-dim);
    flex-shrink: 0;
  }

  .collapse-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .collapse-summary {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collapse-chevron {
    color: var(--text-muted);
    font-size: 0.7rem;
    flex-shrink: 0;
  }

  .collapse-block .code-block {
    border: none;
    border-top: 1px solid var(--border);
    border-radius: 0;
  }

  .description code {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--gold-dim);
    background: var(--bg-input);
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius-sm);
  }

  /* Hooks */
  .hooks-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .hook-item {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .hook-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--bg-tertiary);
    border: none;
    cursor: pointer;
    text-align: left;
  }

  .hook-header:hover {
    background: var(--bg-hover);
  }

  .hook-head-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .hook-head-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-block;
    background: var(--text-muted);
  }

  .status-dot[data-status="pending"] { background: var(--text-muted); }
  .status-dot[data-status="waiting"] { background: var(--gold); }
  .status-dot[data-status="fired"] { background: #4caf50; }
  .status-dot[data-status="cancelled"] { background: var(--color-danger); }

  .hook-label {
    font-weight: 500;
    color: var(--text-primary);
  }

  .hook-type {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--gold-dim);
    padding: 0.125rem 0.5rem;
    background: var(--gold-ember);
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .hook-summary {
    font-size: 0.75rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hook-body {
    padding: 1rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .hook-field-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .hook-field h4 {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 0.5rem;
    font-weight: 500;
  }

  .hook-field-head h4 {
    margin: 0;
  }

  .condition-list {
    margin: 0;
    padding-left: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .hook-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .hook-meta strong {
    color: var(--text-secondary);
  }
</style>
