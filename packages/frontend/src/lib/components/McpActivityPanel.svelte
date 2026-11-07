<script lang="ts">
  import { timeAgo } from '$lib/utils/time';
  import { onMount } from 'svelte';
  import type { SystemStatus, McpServerInfo } from '@bytelight/shared';
  import { sendMcpReconnect, sendMcpToggle } from '$lib/stores/websocket.svelte';
  import { api, apiFetch } from '$lib/utils/api';

  let { status }: { status: SystemStatus | null } = $props();

  // ─── Managed servers (DB registry — add/test/toggle/delete) ───
  interface ManagedServer {
    id: number;
    name: string;
    url: string;
    hasApiKey: boolean;
    enabled: boolean;
    toolCount: number;
    lastDiscovered: string | null;
    createdAt: string;
  }

  let managed = $state<ManagedServer[]>([]);
  let managedLoaded = $state(false);
  let managedError = $state<string | null>(null);
  let managedNames = $derived(new Set(managed.map((m) => m.name)));

  // Add-server form (collapsed by default)
  let showAddForm = $state(false);
  let formName = $state('');
  let formUrl = $state('');
  let formApiKey = $state('');
  let formBusy = $state(false);
  let formError = $state<string | null>(null);
  let testResult = $state<{ ok: boolean; text: string } | null>(null);
  let testBusy = $state(false);
  let canSave = $derived(formName.trim().length > 0 && /^https?:\/\/\S+/.test(formUrl.trim()));

  // Per-row action state
  let rowBusy = $state<number | null>(null);
  let confirmDeleteId = $state<number | null>(null);

  async function loadManaged() {
    try {
      const res = await api.get('/api/mcp-servers');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      managed = await res.json();
      managedError = null;
    } catch (err) {
      managedError = err instanceof Error ? err.message : String(err);
    } finally {
      managedLoaded = true;
    }
  }

  function resetForm() {
    formName = '';
    formUrl = '';
    formApiKey = '';
    formError = null;
    testResult = null;
  }

  async function testConnection() {
    testBusy = true;
    testResult = null;
    try {
      const res = await api.post('/api/mcp-servers/test', {
        url: formUrl.trim(),
        apiKey: formApiKey.trim() || undefined,
      });
      const data = await res.json();
      testResult = data.ok
        ? { ok: true, text: `Reachable — ${data.toolCount} tool${data.toolCount === 1 ? '' : 's'} discovered` }
        : { ok: false, text: data.error || 'Connection failed' };
    } catch (err) {
      testResult = { ok: false, text: err instanceof Error ? err.message : String(err) };
    } finally {
      testBusy = false;
    }
  }

  async function saveServer() {
    if (!canSave || formBusy) return;
    formBusy = true;
    formError = null;
    try {
      const res = await api.post('/api/mcp-servers', {
        name: formName.trim(),
        url: formUrl.trim(),
        api_key: formApiKey.trim() || undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const created: ManagedServer = await res.json();
      resetForm();
      showAddForm = false;
      await loadManaged();
      // Kick discovery so the row shows a real tool count right away (best-effort)
      rowBusy = created.id;
      try {
        await api.post(`/api/mcp-servers/${created.id}/discover`);
      } catch { /* row simply shows 0 tools until refreshed */ }
      rowBusy = null;
      await loadManaged();
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    } finally {
      formBusy = false;
    }
  }

  async function toggleManaged(server: ManagedServer) {
    if (rowBusy !== null) return;
    rowBusy = server.id;
    try {
      const res = await api.put(`/api/mcp-servers/${server.id}/toggle`, { enabled: !server.enabled });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadManaged();
    } catch (err) {
      managedError = err instanceof Error ? err.message : String(err);
    } finally {
      rowBusy = null;
    }
  }

  async function rediscover(server: ManagedServer) {
    if (rowBusy !== null) return;
    rowBusy = server.id;
    managedError = null;
    try {
      const res = await api.post(`/api/mcp-servers/${server.id}/discover`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await loadManaged();
    } catch (err) {
      managedError = err instanceof Error ? err.message : String(err);
    } finally {
      rowBusy = null;
    }
  }

  async function deleteManaged(id: number) {
    if (rowBusy !== null) return;
    rowBusy = id;
    try {
      const res = await api.delete(`/api/mcp-servers/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      confirmDeleteId = null;
      await loadManaged();
    } catch (err) {
      managedError = err instanceof Error ? err.message : String(err);
    } finally {
      rowBusy = null;
    }
  }

  interface AuditEntry {
    id: string;
    tool_name: string;
    tool_input: string | null;
    tool_output: string | null;
    created_at: string;
  }

  interface ToolGroup {
    prefix: string;
    count: number;
    tools: Map<string, { count: number; lastUsed: string }>;
    lastUsed: string;
  }

  let entries = $state<AuditEntry[]>([]);
  let groups = $state<ToolGroup[]>([]);
  let auditLoading = $state(true);
  let expandedServer = $state<string | null>(null);
  let expandedGroup = $state<string | null>(null);
  let showAudit = $state(false);

  function formatRelative(iso: string | null | undefined): string {
    if (!iso) return 'never';
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + 'h ago';
    return Math.round(hr / 24) + 'd ago';
  }

  function statusColor(s: McpServerInfo['status']): string {
    switch (s) {
      case 'connected': return 'var(--status-active)';
      case 'pending': return 'var(--status-waking)';
      case 'disabled': return 'var(--text-muted)';
      case 'failed': return 'var(--status-error, var(--color-error))';
      case 'needs-auth': return 'var(--status-warning, #f59e0b)';
      default: return 'var(--text-muted)';
    }
  }

  function statusLabel(s: McpServerInfo['status']): string {
    switch (s) {
      case 'connected': return 'Connected';
      case 'pending': return 'Connecting...';
      case 'disabled': return 'Disabled';
      case 'failed': return 'Failed';
      case 'needs-auth': return 'Auth Required';
      default: return s;
    }
  }

  function getPrefix(toolName: string): string {
    const idx = toolName.indexOf('_');
    return idx > 0 ? toolName.substring(0, idx) : toolName;
  }

  function buildGroups(entries: AuditEntry[]): ToolGroup[] {
    const groupMap = new Map<string, ToolGroup>();

    for (const entry of entries) {
      const prefix = getPrefix(entry.tool_name);

      if (!groupMap.has(prefix)) {
        groupMap.set(prefix, { prefix, count: 0, tools: new Map(), lastUsed: entry.created_at });
      }

      const group = groupMap.get(prefix)!;
      group.count++;

      if (entry.created_at > group.lastUsed) {
        group.lastUsed = entry.created_at;
      }

      const tool = group.tools.get(entry.tool_name);
      if (tool) {
        tool.count++;
        if (entry.created_at > tool.lastUsed) tool.lastUsed = entry.created_at;
      } else {
        group.tools.set(entry.tool_name, { count: 1, lastUsed: entry.created_at });
      }
    }

    return Array.from(groupMap.values()).sort((a, b) => b.count - a.count);
  }

  function formatTime(iso: string): string {
    const date = new Date(iso);
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  onMount(async () => {
    loadManaged();
    try {
      const res = await apiFetch('/api/audit?limit=200', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        entries = data.entries || [];
        groups = buildGroups(entries);
      }
    } catch (err) {
      console.error('Failed to load audit entries:', err);
    } finally {
      auditLoading = false;
    }
  });
</script>

<div class="panel">
  <div class="panel-header">
    <h2 class="panel-title">MCP Servers</h2>
    <span class="last-refresh" title={status?.mcpStatusUpdatedAt || ""}>Last refreshed {formatRelative(status?.mcpStatusUpdatedAt)}</span>
  </div>

  {#if !status?.mcpServers || status.mcpServers.length === 0}
    <div class="empty-note">No MCP server data yet. Status refreshes on each agent query.</div>
  {:else}
    <div class="server-list">
      {#each status.mcpServers as server}
        <div class="server-card">
          <button class="server-header" onclick={() => expandedServer = expandedServer === server.name ? null : server.name}>
            <span class="status-dot" style="background: {statusColor(server.status)}"></span>
            <span class="server-name">{server.name}</span>
            {#if managedNames.has(server.name)}
              <span class="managed-chip" title="Managed server — stored in the database, editable below">managed</span>
            {/if}
            <span class="server-status" style="color: {statusColor(server.status)}">{statusLabel(server.status)}</span>
            <span class="tool-count">{server.toolCount} tools</span>
            {#if server.tools && server.tools.length > 0}
              <span class="expand-icon" class:expanded={expandedServer === server.name}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 5l3 3 3-3"/>
                </svg>
              </span>
            {/if}
          </button>

          {#if server.error}
            <div class="server-error">{server.error}</div>
          {/if}

          <div class="server-actions">
            {#if server.status === 'failed'}
              <button class="res-btn res-btn--danger res-btn--sm" onclick={() => sendMcpReconnect(server.name)}>
                Reconnect
              </button>
            {/if}
            <button
              class="res-btn res-btn--ghost res-btn--sm"
              onclick={() => sendMcpToggle(server.name, server.status === 'disabled')}
            >
              {server.status === 'disabled' ? 'Enable' : 'Disable'}
            </button>
          </div>

          {#if expandedServer === server.name && server.tools && server.tools.length > 0}
            <div class="tool-list">
              {#each server.tools as tool}
                <div class="tool-row">
                  <span class="tool-name">{tool.name}</span>
                  {#if tool.description}
                    <span class="tool-desc">{tool.description}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Managed servers (DB registry) -->
  <div class="managed-section">
    <div class="managed-header">
      <div class="managed-title-wrap">
        <span class="managed-title">Managed Servers</span>
        <span class="managed-sub">Added here, stored in the database — tools join every conversation</span>
      </div>
      {#if !showAddForm}
        <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => { showAddForm = true; formError = null; }}>
          + Add server
        </button>
      {/if}
    </div>

    {#if managedError}
      <div class="managed-error">{managedError}</div>
    {/if}

    {#if showAddForm}
      <div class="add-form">
        <div class="field">
          <label class="field-label" for="mcp-add-name">Name</label>
          <input id="mcp-add-name" type="text" class="field-input" bind:value={formName} placeholder="command-center" autocomplete="off" />
        </div>
        <div class="field">
          <label class="field-label" for="mcp-add-url">URL</label>
          <input id="mcp-add-url" type="text" class="field-input" bind:value={formUrl} placeholder="http://localhost:3002/mcp/cc" autocomplete="off" />
        </div>
        <div class="field">
          <label class="field-label" for="mcp-add-key">API key <span class="field-optional">optional</span></label>
          <input id="mcp-add-key" type="password" class="field-input" bind:value={formApiKey} placeholder="Bearer token, if the server needs one" autocomplete="new-password" />
        </div>

        {#if testResult}
          <div class="test-result" class:ok={testResult.ok} class:fail={!testResult.ok}>
            {testResult.ok ? '✓' : '✕'} {testResult.text}
          </div>
        {/if}
        {#if formError}
          <div class="managed-error">{formError}</div>
        {/if}

        <div class="form-actions">
          <button
            class="res-btn res-btn--ghost res-btn--sm"
            disabled={!/^https?:\/\/\S+/.test(formUrl.trim()) || testBusy}
            onclick={testConnection}
          >
            {testBusy ? 'Testing…' : 'Test'}
          </button>
          <div class="form-actions-right">
            <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => { showAddForm = false; resetForm(); }}>
              Cancel
            </button>
            <button class="res-btn res-btn--primary res-btn--sm" disabled={!canSave || formBusy} onclick={saveServer}>
              {formBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    {/if}

    {#if !managedLoaded}
      <div class="loading">Loading managed servers...</div>
    {:else if managed.length === 0 && !showAddForm}
      <div class="empty-note">No managed servers yet. Config-file servers above are read-only — add one here to manage it from the UI.</div>
    {:else if managed.length > 0}
      <div class="server-list">
        {#each managed as server (server.id)}
          <div class="server-card" class:managed-disabled={!server.enabled}>
            <div class="managed-row">
              <span class="status-dot" style="background: {server.enabled ? 'var(--status-active)' : 'var(--text-muted)'}"></span>
              <span class="server-name">{server.name}</span>
              {#if server.hasApiKey}
                <span class="key-chip" title="API key stored — never displayed">key ••••</span>
              {/if}
              <span class="tool-count">{server.toolCount} tools</span>
            </div>
            <div class="managed-meta">
              <span class="managed-url" title={server.url}>{server.url}</span>
              {#if server.lastDiscovered}
                <span class="managed-discovered">discovered {timeAgo(server.lastDiscovered, { dateAfterDays: 1 })}</span>
              {:else}
                <span class="managed-discovered">not discovered yet</span>
              {/if}
            </div>
            <div class="server-actions">
              {#if confirmDeleteId === server.id}
                <span class="confirm-text">Delete {server.name}?</span>
                <button class="res-btn res-btn--danger res-btn--sm" disabled={rowBusy !== null} onclick={() => deleteManaged(server.id)}>
                  {rowBusy === server.id ? 'Deleting…' : 'Delete'}
                </button>
                <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => confirmDeleteId = null}>Cancel</button>
              {:else}
                <button class="res-btn res-btn--ghost res-btn--sm" disabled={rowBusy !== null} onclick={() => rediscover(server)}>
                  {rowBusy === server.id ? 'Refreshing…' : 'Refresh'}
                </button>
                <button class="res-btn res-btn--ghost res-btn--sm" disabled={rowBusy !== null} onclick={() => toggleManaged(server)}>
                  {server.enabled ? 'Disable' : 'Enable'}
                </button>
                <button class="res-btn res-btn--danger res-btn--sm" disabled={rowBusy !== null} onclick={() => confirmDeleteId = server.id}>
                  Delete
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Audit log section -->
  <div class="audit-section">
    <button class="audit-toggle" onclick={() => showAudit = !showAudit}>
      <span>Recent Activity</span>
      <span class="expand-icon" class:expanded={showAudit}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 5l3 3 3-3"/>
        </svg>
      </span>
    </button>

    {#if showAudit}
      {#if auditLoading}
        <div class="loading">Loading audit log...</div>
      {:else if groups.length === 0}
        <div class="empty-note">No tool usage recorded yet.</div>
      {:else}
        <div class="group-list">
          {#each groups as group}
            <div class="group">
              <button class="group-header" onclick={() => expandedGroup = expandedGroup === group.prefix ? null : group.prefix}>
                <span class="group-prefix">{group.prefix}_*</span>
                <span class="group-count">{group.count} calls</span>
                <span class="group-last">Last: {timeAgo(group.lastUsed, { dateAfterDays: 1 })}</span>
                <span class="expand-icon" class:expanded={expandedGroup === group.prefix}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 5l3 3 3-3"/>
                  </svg>
                </span>
              </button>

              {#if expandedGroup === group.prefix}
                <div class="tool-details">
                  {#each [...group.tools.entries()].sort((a, b) => b[1].count - a[1].count) as [toolName, info]}
                    <div class="audit-tool-row">
                      <span class="tool-name">{toolName}</span>
                      <span class="tool-count">{info.count}x</span>
                      <span class="tool-last">{formatTime(info.lastUsed)}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .panel-header { display: flex; justify-content: space-between; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
  .last-refresh { font-size: 0.75rem; color: var(--text-muted); font-style: italic; }

  .panel-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .empty-note {
    color: var(--text-muted);
    font-size: 0.8rem;
    font-style: italic;
  }

  .loading {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
  }

  /* Server list */
  .server-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .server-card {
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .server-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    width: 100%;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;
  }

  .server-header:hover {
    background: var(--bg-surface);
  }

  .status-dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .server-name {
    font-size: 0.8rem;
    font-family: var(--font-mono);
    color: var(--text-primary);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .server-status {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .tool-count {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .server-error {
    padding: 0.375rem 0.75rem 0.5rem;
    font-size: 0.7rem;
    color: var(--status-error, var(--color-error));
    font-family: var(--font-mono);
  }

  .server-actions {
    display: flex;
    gap: 0.375rem;
    padding: 0.25rem 0.75rem 0.5rem;
  }


  .tool-list {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border);
    max-height: 200px;
    overflow-y: auto;
  }

  .tool-row {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.375rem 0.75rem 0.375rem 1.5rem;
    font-size: 0.7rem;
  }

  .tool-row:not(:last-child) {
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  }

  .tool-name {
    font-family: var(--font-mono);
    color: var(--text-secondary);
  }

  .tool-desc {
    font-size: 0.65rem;
    color: var(--text-muted);
    line-height: 1.3;
  }

  /* Managed servers section */
  .managed-section {
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .managed-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .managed-title-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .managed-title {
    font-size: 0.875rem;
    color: var(--text-secondary);
  }

  .managed-sub {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .managed-chip {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
    opacity: 0.75;
    flex-shrink: 0;
  }

  .key-chip {
    font-size: 0.6rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
    flex-shrink: 0;
  }

  .managed-error {
    font-size: 0.7rem;
    color: var(--status-error, var(--color-error));
    font-family: var(--font-mono);
  }

  .managed-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem 0.125rem;
  }

  .managed-meta {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0 0.75rem 0.25rem 1.75rem;
    min-width: 0;
  }

  .managed-url {
    font-size: 0.65rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .managed-discovered {
    font-size: 0.65rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .managed-disabled {
    opacity: 0.6;
  }

  .confirm-text {
    font-size: 0.7rem;
    color: var(--text-secondary);
    align-self: center;
    margin-right: 0.125rem;
  }

  /* Add-server form */
  .add-form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.75rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .field-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .field-optional {
    text-transform: none;
    letter-spacing: normal;
    opacity: 0.7;
  }

  .field-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-size: 0.8rem;
    font-family: var(--font-mono);
    color: var(--text-primary);
    background: var(--bg-input, var(--bg-surface));
    border: 1px solid var(--border);
    border-radius: 6px;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .field-input:focus {
    outline: none;
    border-color: var(--gold-dim, var(--accent));
    box-shadow: 0 0 0 2px rgba(196, 168, 114, 0.08);
  }

  .test-result {
    font-size: 0.7rem;
    font-family: var(--font-mono);
  }

  .test-result.ok {
    color: var(--status-active);
  }

  .test-result.fail {
    color: var(--status-error, var(--color-error));
  }

  .form-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.375rem;
  }

  .form-actions-right {
    display: flex;
    gap: 0.375rem;
  }

  /* Audit section */
  .audit-section {
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
  }

  .audit-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.375rem 0;
    font-size: 0.875rem;
    color: var(--text-secondary);
    cursor: pointer;
    text-align: left;
  }

  .audit-toggle:hover {
    color: var(--text-primary);
  }

  .expand-icon {
    color: var(--text-muted);
    transition: transform 0.2s;
    display: flex;
  }

  .expand-icon.expanded {
    transform: rotate(180deg);
  }

  /* Audit groups */
  .group-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.5rem;
  }

  .group {
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    width: 100%;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;
  }

  .group-header:hover {
    background: var(--bg-surface);
  }

  .group-prefix {
    font-size: 0.8rem;
    font-family: var(--font-mono);
    color: var(--accent);
    flex: 1;
  }

  .group-count {
    font-size: 0.7rem;
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }

  .group-last {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .tool-details {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border);
  }

  .audit-tool-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.375rem 0.75rem 0.375rem 1.5rem;
    font-size: 0.7rem;
  }

  .audit-tool-row:not(:last-child) {
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  }

  .audit-tool-row .tool-name {
    flex: 1;
  }

  .tool-count {
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .tool-last {
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  @media (max-width: 768px) {
    .server-name {
      max-width: 120px;
    }
  }
</style>
