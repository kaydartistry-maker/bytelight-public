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

import { toSessionCard, type SessionHistoryRow, type SessionCard } from '../lib/session-rows';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatDate(ts: number | null): string {
  if (ts == null) return '';
  const diff = Date.now() - ts;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}


export function SessionsApp({ onClose, themeConfig, themeMode, embedded }: SessionsAppProps) {
  const colors = themeConfig[themeMode];
  const [sessions, setSessions] = useState<SessionCard[]>([]);
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
      setSessions(((data.sessions || []) as SessionHistoryRow[]).map(toSessionCard));
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
            <div key={s.key} className={card}>
              <div className="flex items-center justify-between gap-2">
                <span className={cn('text-sm font-medium truncate', colors.textMain)}>{s.title}</span>
                <span className={cn('text-[11px] shrink-0', colors.textMuted)}>{formatDate(s.startedMs)}</span>
              </div>
              <div className={cn('flex items-center justify-between text-[10px] mt-1', colors.textMuted)}>
                <span>
                  {s.outputTokens != null && <><span className={cn('font-semibold', colors.textMain)}>{fmtTokens(s.outputTokens)}</span>{' written · '}</>}
                  {s.turns} {s.turns === 1 ? 'turn' : 'turns'}
                  {s.costUsd != null && ` · $${s.costUsd.toFixed(2)}`}
                </span>
                {s.contextTokens != null && <span>{fmtTokens(s.contextTokens)} context</span>}
              </div>
              {s.contextPercent != null && (
                <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(127,127,127,0.2)' }}>
                  <div className="h-full rounded-full" style={{ width: `${s.contextPercent}%`, background: colors.accent }} />
                </div>
              )}
              <div className={cn('flex items-center gap-3 mt-1.5 text-[10px] font-mono', colors.textMuted)}>
                <span>{s.open ? 'open' : `ended${s.endReason ? `: ${s.endReason}` : ''}`}</span>
                {s.shortId && <span>{s.shortId}</span>}
                {s.platform && <span className="truncate">{s.platform}</span>}
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
