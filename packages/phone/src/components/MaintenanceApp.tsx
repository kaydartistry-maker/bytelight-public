import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock3, RefreshCw, ShieldCheck, Wrench } from 'lucide-react';
import { apiFetch } from '../bytelight';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';

type Stage = 'found' | 'fixed' | 'built' | 'waiting_for_restart' | 'verified_live' | 'blocked';
interface Entry {
  id: string; kind: string; title: string; summary: string; stage: Stage; checks: string[];
  restartRequired: boolean; commit: string | null; createdAt: string; updatedAt: string;
}

const STAGE_LABEL: Record<Stage, string> = {
  found: 'Found', fixed: 'Fixed', built: 'Built', waiting_for_restart: 'Waiting for restart',
  verified_live: 'Verified live', blocked: 'Needs attention',
};

export function MaintenanceApp({ themeConfig, themeMode }: { themeConfig: ThemeConfig; themeMode: 'light' | 'dark' }) {
  const colors = themeConfig[themeMode];
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await apiFetch('/api/maintenance');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Maintenance unavailable (${response.status})`);
      setEntries(Array.isArray(body.entries) ? body.entries : []);
    } catch (err) { setError(err instanceof Error ? err.message : 'Maintenance unavailable'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const card = cn('rounded-2xl border p-4 mb-3', colors.panelBg, colors.panelBorder);
  const latestStartup = entries.find((entry) => entry.kind === 'startup');
  const pending = entries.filter((entry) => entry.stage === 'waiting_for_restart').length;

  return <div>
    <div data-appearance-card="" className={card}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} style={{ color: colors.accent }} />
          <div>
            <div className={cn('text-sm font-semibold', colors.textMain)}>House maintenance</div>
            <div className={cn('text-xs', colors.textMuted)}>
              {latestStartup?.stage === 'verified_live' ? 'Latest startup verified' : latestStartup ? 'Latest startup needs attention' : 'Waiting for first startup verification'}
              {pending ? ` · ${pending} waiting for restart` : ''}
            </div>
          </div>
        </div>
        <button onClick={() => void load()} className={cn('rounded-full p-2', colors.textMuted)} title="Refresh maintenance">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
    </div>

    {error && <div data-appearance-card="" className={card} style={{ borderColor: colors.accent }}><p className="text-xs">{error}</p></div>}
    {!loading && !error && entries.length === 0 && <div className={cn('text-center text-xs py-8', colors.textMuted)}>No maintenance receipts yet.</div>}

    {entries.map((entry) => {
      const live = entry.stage === 'verified_live';
      return <div key={entry.id} data-appearance-card="" className={card}>
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-start gap-2 min-w-0">
            {live ? <CheckCircle2 size={16} style={{ color: colors.accent }} className="mt-0.5 shrink-0" /> : entry.stage === 'waiting_for_restart' ? <Clock3 size={16} className="mt-0.5 shrink-0" /> : <Wrench size={16} className="mt-0.5 shrink-0" />}
            <div className="min-w-0">
              <div className={cn('text-sm font-semibold', colors.textMain)}>{entry.title}</div>
              <div className={cn('text-[10px] uppercase tracking-wider mt-0.5', colors.textMuted)}>{entry.kind.replaceAll('_', ' ')} · {STAGE_LABEL[entry.stage]}</div>
            </div>
          </div>
          <time className={cn('text-[10px] shrink-0', colors.textMuted)}>{new Date(entry.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
        </div>
        <p className={cn('text-xs leading-relaxed', colors.textMain)}>{entry.summary}</p>
        {entry.checks.length > 0 && <ul className={cn('mt-2 space-y-1 text-[11px]', colors.textMuted)}>{entry.checks.map((check, index) => <li key={index}>• {check}</li>)}</ul>}
        {entry.commit && <div className={cn('mt-2 text-[10px] font-mono', colors.textMuted)}>commit {entry.commit.slice(0, 12)}</div>}
      </div>;
    })}
  </div>;
}
