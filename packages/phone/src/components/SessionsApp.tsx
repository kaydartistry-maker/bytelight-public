import React, { useEffect, useState } from 'react';
import { History, RefreshCw, Loader2 } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { Paginator, usePaged } from './Paginator';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

interface SessionsAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface SessionUsage {
  replies: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number;
  model?: string;
  /** Present only when the session ended on something other than a reply — a
   *  usage cap, a 529, a model id the CLI refused. Worth its own line: it is
   *  the difference between a session that finished and one that was stopped. */
  endedWith?: string;
  contextWindow?: number;
}

interface SessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  usage?: SessionUsage;
}

// The backend resolves each session's window from the model catalog and ships
// it as usage.contextWindow — that answer wins. This map is only the fallback
// for a backend that predates the field, mirroring the catalog's 1M models;
// anything unrecognised falls back to the old default rather than drawing a
// bar against a number nobody chose. (An opus-4-8 session once wore a pegged
// bar because a three-entry copy of this list had drifted from the catalog.)
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

function contextPercent(u: SessionUsage): number {
  const window = u.contextWindow || (u.model && CONTEXT_WINDOWS[u.model]) || DEFAULT_CONTEXT_WINDOW;
  return Math.max(0, Math.min(100, Math.round((u.contextTokens / window) * 100)));
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatDate(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function SessionsApp({ onClose, themeConfig, themeMode, embedded }: SessionsAppProps) {
  const colors = themeConfig[themeMode];
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const sessionsPage = usePaged(sessions);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/sessions?limit=50');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const card = cn('rounded-2xl border p-3', colors.panelBg, colors.panelBorder);

  return (
    <AppShell
      embedded={embedded}
      title="Agent Sessions"
      icon={History}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => load()}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      {loading ? (
        <div className={cn('text-xs py-6 text-center', colors.textMuted)}>Loading sessions…</div>
      ) : error ? (
        <div className="text-xs py-6 text-center" style={{ color: colors.accent, opacity: 0.8 }}>{error}</div>
      ) : sessions.length === 0 ? (
        <div className={cn('text-xs py-6 text-center', colors.textMuted)}>No sessions found.</div>
      ) : (
        <div className="space-y-2">
          {sessionsPage.visible.map((s) => (
            <div key={s.sessionId} className={card}>
              <div className="flex items-center justify-between gap-2">
                <span className={cn('text-sm font-medium truncate', colors.textMain)}>
                  {s.customTitle || s.summary || 'Untitled session'}
                </span>
                <span className={cn('text-[11px] shrink-0', colors.textMuted)}>{formatDate(s.lastModified)}</span>
              </div>
              {s.firstPrompt && (
                <p className={cn('text-xs mt-1 line-clamp-2', colors.textMuted)}>{s.firstPrompt}</p>
              )}
              {s.usage && (
                <div className="mt-2">
                  <div className={cn('flex items-center justify-between text-[10px] mb-1', colors.textMuted)}>
                    <span>
                      <span className={cn('font-semibold', colors.textMain)}>{fmtTokens(s.usage.outputTokens)}</span>
                      {' written · '}
                      {s.usage.replies} {s.usage.replies === 1 ? 'reply' : 'replies'}
                    </span>
                    <span>{fmtTokens(s.usage.contextTokens)} context</span>
                  </div>
                  {/*
                    Context at the moment the session stopped, against its
                    window — an endpoint, not a sum. Every turn re-sends the
                    whole conversation, so adding prompt sizes up would count
                    the same conversation once per turn.
                  */}
                  <div className={cn('h-1 rounded-full overflow-hidden', colors.panelBorder)} style={{ background: 'currentColor', opacity: 0.15 }} />
                  <div className="h-1 rounded-full -mt-1 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${contextPercent(s.usage)}%`,
                        background: colors.accent,
                      }}
                    />
                  </div>
                </div>
              )}
              {s.usage?.endedWith && (
                <p className={cn('text-[10px] mt-1.5 italic line-clamp-2', colors.textMuted)}>
                  ended: {s.usage.endedWith}
                </p>
              )}
              <div className={cn('flex items-center gap-3 mt-1.5 text-[10px] font-mono', colors.textMuted)}>
                <span>{formatSize(s.fileSize)}</span>
                <span>{s.sessionId.slice(0, 8)}</span>
                {s.usage?.model && <span className="truncate">{s.usage.model}</span>}
                {s.gitBranch && <span className="truncate">{s.gitBranch}</span>}
              </div>
            </div>
          ))}
          <Paginator
            page={sessionsPage.page}
            pageCount={sessionsPage.pageCount}
            onPage={sessionsPage.setPage}
            colors={colors}
          />
        </div>
      )}
    </AppShell>
  );
}
