import React, { useEffect, useState } from 'react';
import { Plus, Loader2, Trash2, Power, Zap } from 'lucide-react';
import { cn, withAlpha } from '../lib/utils';
import { apiFetch } from '../bytelight';
import type { ThemeConfig, ThemeColors } from '../lib/theme';
import { SecretInput } from './SecretInput';

// Editor for the "managed" (HTTP-backed) MCP servers — the ones router
// providers (OpenRouter / OpenAI / Groq / etc.) need configured manually,
// since they don't auto-detect from Claude.ai's config file.

interface ManagedMcpServer {
  id: number;
  name: string;
  url: string;
  hasApiKey: boolean;
  enabled: boolean;
  toolCount: number;
  lastDiscovered: string | null;
  createdAt: string;
}

interface ManagedMcpServersProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

export function ManagedMcpServers({ themeConfig, themeMode }: ManagedMcpServersProps) {
  const colors: ThemeColors = themeConfig[themeMode];
  const [servers, setServers] = useState<ManagedMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftKey, setDraftKey] = useState('');
  const [adding, setAdding] = useState(false);
  // Test-before-add state. Lets the user verify the URL responds and
  // reports tools before committing the row to the DB.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: true; toolCount: number } | { ok: false; error: string }>(null);

  async function testConnection() {
    const url = draftUrl.trim();
    if (!url) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch('/api/mcp-servers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, apiKey: draftKey || undefined }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setTestResult({ ok: true, toolCount: data.toolCount ?? 0 });
      } else {
        setTestResult({ ok: false, error: data.error || `Test failed (${res.status})` });
      }
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setTesting(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/mcp-servers');
      if (!res.ok) throw new Error(`Load failed: ${res.status}`);
      setServers((await res.json()) as ManagedMcpServer[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function add() {
    const name = draftName.trim();
    const url = draftUrl.trim();
    if (!name || !url) {
      setError('Name and URL are required.');
      return;
    }
    setAdding(true);
    try {
      const res = await apiFetch('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url, api_key: draftKey || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Add failed: ${res.status}`);
      }
      const server = (await res.json()) as ManagedMcpServer;
      setServers((prev) => [...prev, server]);
      setDraftName('');
      setDraftUrl('');
      setDraftKey('');
      setShowAdd(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Add failed');
    } finally {
      setAdding(false);
    }
  }

  async function toggle(server: ManagedMcpServer) {
    setBusyId(server.id);
    try {
      const res = await apiFetch(`/api/mcp-servers/${server.id}/toggle`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      if (!res.ok) throw new Error(`Toggle failed: ${res.status}`);
      setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled: !server.enabled } : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed');
    } finally {
      setBusyId(null);
    }
  }

  async function discover(server: ManagedMcpServer) {
    setBusyId(server.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/mcp-servers/${server.id}/discover`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Discover failed: ${res.status}`);
      setServers((prev) =>
        prev.map((s) =>
          s.id === server.id ? { ...s, toolCount: data.toolCount ?? s.toolCount, lastDiscovered: new Date().toISOString() } : s,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discover failed');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(server: ManagedMcpServer) {
    setBusyId(server.id);
    try {
      const res = await apiFetch(`/api/mcp-servers/${server.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      setServers((prev) => prev.filter((s) => s.id !== server.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  }

  const card = cn('rounded-2xl border p-4 mb-3', colors.panelBg, colors.panelBorder);

  return (
    <div className={card}>
      <div className="flex items-center justify-between mb-2">
        <span className={cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>
          Managed Servers (HTTP)
        </span>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className={cn('rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border', colors.panelBorder)}
          style={{ color: colors.accent }}
        >
          {showAdd ? 'Cancel' : '+ Add'}
        </button>
      </div>

      <p className={cn('text-[10px] mb-2 opacity-70', colors.textMuted)}>
        Router providers (OpenRouter, OpenAI, etc.) use these. Claude Code servers above sync from <code className="text-[10px]">~/.claude.json</code>.
      </p>

      {showAdd && (
        <div className="space-y-1.5 mb-3">
          <input
            type="text"
            placeholder="Name (e.g. github-mcp)"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            className={cn('w-full rounded-lg border px-2.5 py-1.5 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
          />
          <input
            type="text"
            placeholder="URL (https://…/mcp)"
            value={draftUrl}
            onChange={(e) => { setDraftUrl(e.target.value); setTestResult(null); }}
            className={cn('w-full rounded-lg border px-2.5 py-1.5 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
          />
          <SecretInput
            placeholder="API key (optional)"
            value={draftKey}
            onChange={(e) => { setDraftKey(e.target.value); setTestResult(null); }}
            className={cn('w-full rounded-lg border px-2.5 py-1.5 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
          />
          {testResult?.ok === true && (
            <p className="text-[10px]" style={{ color: colors.accent }}>
              Reachable — found {testResult.toolCount} tool{testResult.toolCount === 1 ? '' : 's'}.
            </p>
          )}
          {testResult?.ok === false && (
            <p className="text-[10px]" style={{ color: colors.accent, opacity: 0.8 }}>
              Failed: {testResult.error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={testConnection}
              disabled={testing || !draftUrl.trim()}
              className={cn('flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50', colors.panelBorder)}
              style={{ color: colors.accent, borderColor: colors.accent }}
            >
              {testing ? <Loader2 size={12} className="animate-spin" /> : 'Test'}
            </button>
            <button
              onClick={add}
              disabled={adding || !draftName.trim() || !draftUrl.trim()}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
            >
              {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Add server
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-[10px] mb-2" style={{ color: colors.accent }}>
          {error}
        </p>
      )}

      {loading ? (
        <p className={cn('text-xs py-2 text-center', colors.textMuted)}>Loading…</p>
      ) : servers.length === 0 ? (
        <p className={cn('text-xs py-2 text-center italic', colors.textMuted)}>
          No managed servers configured.
        </p>
      ) : (
        <ul className="space-y-2">
          {servers.map((s) => {
            const busy = busyId === s.id;
            const dim = !s.enabled;
            return (
              <li
                key={s.id}
                className="rounded-lg border px-2.5 py-2"
                style={{
                  borderColor: dim ? undefined : withAlpha(colors.accent, 0.30),
                  background: dim ? undefined : withAlpha(colors.accent, 0.05),
                }}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className={cn('truncate text-xs font-semibold', colors.textMain, dim && 'opacity-60')}>
                      {s.name}
                    </div>
                    <div className={cn('truncate text-[10px]', colors.textMuted)}>{s.url}</div>
                  </div>
                  <span className={cn('text-[10px] shrink-0', colors.textMuted)}>
                    {s.toolCount} tool{s.toolCount === 1 ? '' : 's'}
                  </span>
                  <button
                    onClick={() => discover(s)}
                    disabled={busy}
                    className={cn('rounded-md p-1', colors.textMuted, 'hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40')}
                    title="Test connection"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                  </button>
                  <button
                    onClick={() => toggle(s)}
                    disabled={busy}
                    className={cn('rounded-md p-1', colors.textMuted, 'hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40')}
                    style={{ color: s.enabled ? colors.accent : undefined }}
                    title={s.enabled ? 'Disable' : 'Enable'}
                  >
                    <Power size={12} />
                  </button>
                  <button
                    onClick={() => remove(s)}
                    disabled={busy}
                    className={cn('rounded-md p-1', colors.textMuted, 'hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40')}
                    style={{ color: colors.accent }}
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                {s.lastDiscovered && (
                  <p className={cn('text-[10px] mt-1 opacity-60', colors.textMuted)}>
                    Last checked {new Date(s.lastDiscovered).toLocaleString()}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
