import React, { useEffect, useState } from 'react';
import { Cpu, RefreshCw, Loader2 } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

interface RuntimeAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface RuntimeLane {
  id: string;
  label: string;
  model: string;
  requestedRouting: string | null;
  effectiveRouting: string | null;
  corrected: boolean;
  reason: string | null;
  laneLabel: string;
}

interface RuntimeReport {
  lanes: RuntimeLane[];
  identityFile: string | null;
  wakePromptsPath: string;
  agentCwd: string;
  timezone: string;
  orchestratorEnabled: boolean;
}

// Read-only view of what actually runs where, resolved from live config on
// every request — whichever model is picked, this shows the lane it lands on.
export function RuntimeApp({ onClose, themeConfig, themeMode, embedded }: RuntimeAppProps) {
  const colors = themeConfig[themeMode];
  const [report, setReport] = useState<RuntimeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/orchestrator/runtime');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReport(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load runtime report');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const card = cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder);

  return (
    <AppShell
      embedded={embedded}
      title="Runtime"
      icon={Cpu}
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
      {loading && !report ? (
        <div className={cn(card, 'text-xs py-6 text-center', colors.textMuted)}>Loading…</div>
      ) : error ? (
        <div className={cn(card, 'text-xs py-6 text-center')} style={{ color: colors.accent, opacity: 0.8 }}>{error}</div>
      ) : report ? (
        <>
          <div className="space-y-2">
            {report.lanes.map((lane) => (
              <div key={lane.id} className={card}>
                <div className="flex items-center justify-between gap-2">
                  <span className={cn('text-sm font-medium', colors.textMain)}>{lane.label}</span>
                  <span className={cn('text-[11px] font-mono shrink-0', colors.textMuted)}>{lane.model}</span>
                </div>
                <div className={cn('text-xs mt-1', colors.textMuted)}>{lane.laneLabel}</div>
                {lane.corrected && lane.reason && (
                  <div className="mt-1.5 rounded-lg px-2 py-1 text-[10px]" style={{ background: 'rgba(127,127,127,0.15)', color: colors.accent }}>
                    Auto-corrected: {lane.reason}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className={cn(card, 'mt-3')}>
            <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted)}>Paths</div>
            {[
              ['Identity file', report.identityFile || 'not found'],
              ['Wake prompts', report.wakePromptsPath],
              ['Agent cwd', report.agentCwd],
            ].map(([label, value]) => (
              <div key={label} className="py-1">
                <div className={cn('text-[10px] uppercase tracking-wide', colors.textMuted)}>{label}</div>
                <div className={cn('text-[11px] font-mono break-all', colors.textMain)}>{value}</div>
              </div>
            ))}
            <div className="flex items-center justify-between py-1">
              <span className={cn('text-[10px] uppercase tracking-wide', colors.textMuted)}>Timezone</span>
              <span className={cn('text-[11px] font-mono', colors.textMain)}>{report.timezone}</span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span className={cn('text-[10px] uppercase tracking-wide', colors.textMuted)}>Orchestrator</span>
              <span className={cn('text-[11px] font-mono', colors.textMain)}>{report.orchestratorEnabled ? 'enabled' : 'disabled'}</span>
            </div>
          </div>
        </>
      ) : null}
    </AppShell>
  );
}
