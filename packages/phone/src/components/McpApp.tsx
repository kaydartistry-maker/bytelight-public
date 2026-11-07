import React, { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Power, RefreshCw, Server } from 'lucide-react';
import { AppShell } from './AppShell';
import { ManagedMcpServers } from './ManagedMcpServers';
import { ThemeConfig, ThemeColors } from '../lib/theme';
import { cn } from '../lib/utils';
import {
  useSystemStatus,
  requestStatus,
  mcpToggle,
  mcpReconnect,
  apiFetch,
  type McpServerInfo,
} from '../bytelight';

interface McpAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

// Status colors now use theme accent

export function McpApp({ onClose, themeConfig, themeMode, embedded }: McpAppProps) {
  const colors = themeConfig[themeMode];
  const status = useSystemStatus();

  useEffect(() => {
    requestStatus();
    const interval = setInterval(requestStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  const card = cn('rounded-2xl border p-4 mb-3', colors.panelBg, colors.panelBorder);
  const label = cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted);

  return (
    <AppShell
      embedded={embedded}
      title="MCP"
      icon={Server}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => requestStatus()}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
        >
          <RefreshCw size={16} />
        </button>
      }
    >
      <div className={card}>
        <div className="flex items-center gap-2 mb-2">
          <Server size={15} className={colors.textMuted} />
          <span className={label}>SDK Servers</span>
        </div>
        <p className={cn('text-[10px] mb-2 opacity-70', colors.textMuted)}>
          Auto-detected from <code className="text-[10px]">~/.claude.json</code>. Used by Anthropic SDK models.
        </p>
        {!status || status.mcpServers.length === 0 ? (
          <p className={cn('text-xs py-2 text-center italic', colors.textMuted)}>
            No SDK servers configured.
          </p>
        ) : (
          status.mcpServers.map((srv) => (
            <McpServerRow key={srv.name} server={srv} themeMode={themeMode} colors={colors} />
          ))
        )}
      </div>

      <ManagedMcpServers themeConfig={themeConfig} themeMode={themeMode} />

      <McpActivityFeed colors={colors} card={card} label={label} />
    </AppShell>
  );
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
  lastUsed: string;
  tools: Array<{ name: string; count: number; lastUsed: string }>;
}

function getPrefix(toolName: string): string {
  // mcp__notion__create-page → mcp__notion__
  // Built-in tools (Read, Bash, etc.) have no prefix; group them under
  // their bare name so they don't collapse into a single "(builtin)".
  const last = toolName.lastIndexOf('__');
  return last > 0 ? toolName.substring(0, last + 2) : toolName;
}

function buildGroups(entries: AuditEntry[]): ToolGroup[] {
  const map = new Map<string, ToolGroup>();
  for (const entry of entries) {
    const prefix = getPrefix(entry.tool_name);
    let group = map.get(prefix);
    if (!group) {
      group = { prefix, count: 0, lastUsed: entry.created_at, tools: [] };
      map.set(prefix, group);
    }
    group.count++;
    if (entry.created_at > group.lastUsed) group.lastUsed = entry.created_at;
    const tool = group.tools.find((t) => t.name === entry.tool_name);
    if (tool) {
      tool.count++;
      if (entry.created_at > tool.lastUsed) tool.lastUsed = entry.created_at;
    } else {
      group.tools.push({ name: entry.tool_name, count: 1, lastUsed: entry.created_at });
    }
  }
  for (const g of map.values()) g.tools.sort((a, b) => b.count - a.count);
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function McpActivityFeed({
  colors,
  card,
  label,
}: {
  colors: ThemeColors;
  card: string;
  label: string;
}) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  const groups = useMemo(() => buildGroups(entries), [entries]);

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/audit?limit=200');
      if (res.ok) {
        const data = await res.json();
        setEntries(Array.isArray(data.entries) ? data.entries : []);
      }
    } catch {
      /* leave entries empty on failure */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Refresh on focus too — useful when the activity panel sits open
    // while the agent is working in another tab.
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return (
    <div className={card}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Server size={15} className={colors.textMuted} />
          <span className={label}>Activity</span>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className={cn('rounded-md p-1', colors.textMuted, 'hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50')}
          title="Refresh activity"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <p className={cn('text-[10px] mb-2 opacity-70', colors.textMuted)}>
        Most recent 200 tool invocations across all MCP servers, grouped by tool prefix.
      </p>
      {loading && entries.length === 0 ? (
        <p className={cn('text-xs py-2 text-center italic', colors.textMuted)}>Loading…</p>
      ) : groups.length === 0 ? (
        <p className={cn('text-xs py-2 text-center italic', colors.textMuted)}>
          No tool activity yet.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {groups.map((g) => {
            const isOpen = openGroup === g.prefix;
            return (
              <li key={g.prefix} className="border-t first:border-t-0 border-current/10">
                <button
                  onClick={() => setOpenGroup(isOpen ? null : g.prefix)}
                  className={cn('w-full flex items-center gap-2 py-1.5 text-left', colors.textMain)}
                >
                  <ChevronRight
                    size={12}
                    className={cn('shrink-0 transition-transform', colors.textMuted, isOpen && 'rotate-90')}
                  />
                  <span className="font-mono text-xs truncate flex-1">{g.prefix}</span>
                  <span className={cn('text-[10px]', colors.textMuted)}>
                    {g.count} · {formatRelative(g.lastUsed)}
                  </span>
                </button>
                {isOpen && (
                  <ul className="ml-5 mb-1.5 space-y-0.5">
                    {g.tools.map((t) => (
                      <li
                        key={t.name}
                        className={cn('flex items-center justify-between text-[10px] font-mono', colors.textMuted)}
                      >
                        <span className="truncate flex-1">{t.name.slice(g.prefix.length) || t.name}</span>
                        <span className="shrink-0 pl-2">
                          {t.count}× · {formatRelative(t.lastUsed)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface McpServerRowProps {
  server: McpServerInfo;
  themeMode: 'light' | 'dark';
  colors: ThemeColors;
}

function McpServerRow({ server, themeMode: _themeMode, colors }: McpServerRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isDisabled = server.status === 'disabled';
  const isFailed = server.status === 'failed';

  return (
    <div className="py-1.5 border-t first:border-t-0 border-current/10">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className={cn('flex flex-1 items-center gap-2 text-left min-w-0', colors.textMain)}
        >
          <ChevronRight
            size={12}
            className={cn('shrink-0 transition-transform', colors.textMuted, expanded && 'rotate-90')}
          />
          <span
            className="h-2 w-2 rounded-full shrink-0"
            style={{ background: colors.accent, opacity: server.status === 'connected' ? 1 : 0.4 }}
          />
          <span className={cn('truncate text-xs', isDisabled && 'opacity-60')}>{server.name}</span>
        </button>
        <span className={cn('text-[10px] shrink-0', colors.textMuted)}>
          {server.toolCount} tool{server.toolCount === 1 ? '' : 's'}
        </span>
        {isFailed && (
          <button
            onClick={() => mcpReconnect(server.name)}
            className={cn('rounded-md p-1', colors.textMuted, 'hover:bg-black/5 dark:hover:bg-white/5')}
            title="Reconnect"
          >
            <RefreshCw size={12} />
          </button>
        )}
        <button
          onClick={() => mcpToggle(server.name, isDisabled)}
          className={cn('rounded-md p-1', colors.textMuted, 'hover:bg-black/5 dark:hover:bg-white/5')}
          style={{ color: isDisabled ? undefined : colors.accent }}
          title={isDisabled ? 'Enable' : 'Disable'}
        >
          <Power size={12} />
        </button>
      </div>
      {server.error && (
        <p className={cn('mt-1 ml-5 text-[10px]', colors.textMuted)} style={{ color: colors.accent }}>
          {server.error}
        </p>
      )}
      {expanded && server.tools && server.tools.length > 0 && (
        <ul className="mt-1.5 ml-5 space-y-0.5">
          {server.tools.map((t) => (
            <li key={t.name} className={cn('text-[10px] truncate', colors.textMuted)}>
              <span className="font-mono">{t.name}</span>
              {t.description && <span className="opacity-70"> — {t.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {expanded && (!server.tools || server.tools.length === 0) && (
        <p className={cn('mt-1 ml-5 text-[10px] italic', colors.textMuted)}>
          {isDisabled ? 'Disabled — enable to discover tools.' : 'No tools exposed.'}
        </p>
      )}
    </div>
  );
}
