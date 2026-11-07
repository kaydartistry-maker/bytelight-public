import React, { useEffect, useState } from 'react';
import { ThemeConfig } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { apiFetch } from '../../bytelight';

const CC_API = '/api/cc';

// Cycle — translated whole from BL main's cc/cycle/+page.svelte: status card
// (phase badge, cycle day, on-period / next-period line, PMS flag), Start/End
// period + Log today, the daily log form (flow / energy / mood / notes),
// Predictions, History, Recent logs. Copy and phase colors verbatim.

interface CcSubPageProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// BL's phase-badge palette (cycle/+page.svelte <style>)
const PHASE_COLORS: Record<string, { bg: string; fg: string }> = {
  menstrual: { bg: 'rgba(224, 82, 82, 0.15)', fg: '#e05252' },
  follicular: { bg: 'rgba(110, 154, 168, 0.15)', fg: '#6e9aa8' },
  ovulation: { bg: 'rgba(212, 160, 48, 0.15)', fg: '#d4a030' },
  luteal: { bg: 'rgba(140, 120, 160, 0.15)', fg: '#8c78a0' },
};

const FLOW_OPTIONS = ['', 'none', 'spotting', 'light', 'medium', 'heavy'];

function daysLabel(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  return n === 1 ? '1 day' : `${n} days`;
}

export function CcCycle({ themeConfig, themeMode }: CcSubPageProps) {
  const colors = themeConfig[themeMode];
  const [status, setStatus] = useState<any>({});
  const [predict, setPredict] = useState<any>({});
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [logFlow, setLogFlow] = useState('');
  const [logMood, setLogMood] = useState('');
  const [logEnergy, setLogEnergy] = useState(0);
  const [logNotes, setLogNotes] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [sRes, pRes, hRes] = await Promise.all([
        apiFetch(`${CC_API}/cycle/status`),
        apiFetch(`${CC_API}/cycle/predict`),
        apiFetch(`${CC_API}/cycle/history`),
      ]);
      setStatus(await sRes.json());
      setPredict(await pRes.json());
      const hData = await hRes.json();
      setHistory(hData.cycles || []);
    } catch {
      /* quiet */
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startPeriod() {
    await apiFetch(`${CC_API}/cycle/period/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await load();
  }
  async function endPeriod() {
    await apiFetch(`${CC_API}/cycle/period/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await load();
  }
  async function logDaily() {
    await apiFetch(`${CC_API}/cycle/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flow: logFlow || undefined,
        mood: logMood || undefined,
        energy: logEnergy || undefined,
        notes: logNotes || undefined,
      }),
    });
    setShowLog(false);
    setLogFlow('');
    setLogMood('');
    setLogEnergy(0);
    setLogNotes('');
    await load();
  }

  const card = cn('rounded-2xl border p-4 space-y-3', colors.panelBg, colors.panelBorder);
  const sectionTitle = cn('text-[10px] font-bold uppercase tracking-[0.12em]', colors.textMuted);
  const input = cn('flex-1 rounded-lg border px-3 py-2 text-sm bg-transparent', colors.panelBorder, colors.textMain);
  const phase = PHASE_COLORS[status.phase] || { bg: 'rgba(127,127,127,0.15)', fg: undefined as unknown as string };
  const st = status.data ?? status; // route wraps in { ok, ... } sometimes

  if (loading) {
    return <div className={cn('py-10 text-center text-xs', colors.textMuted)}>Loading…</div>;
  }

  if (status.noData || st.noData) {
    return (
      <div className={cn('flex flex-col items-center gap-3 py-10 text-center', colors.textMuted)}>
        <p className="text-sm">No cycle data yet</p>
        <button onClick={startPeriod} className="bytelight-on-accent rounded-full px-4 py-2 text-xs font-bold" style={{ background: colors.accent }}>
          Log period start
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Status */}
      <div className={card}>
        <div className="flex items-center gap-4">
          <span
            className="flex min-h-[36px] shrink-0 items-center rounded-[22px] px-4 py-2 text-sm font-semibold capitalize"
            style={{ background: phase.bg, color: phase.fg }}
          >
            {status.phase}
          </span>
          <div className="flex flex-col">
            <span className={cn('text-xl font-bold', colors.textMain)}>Day {status.cycleDay}</span>
            <span className={cn('text-sm', colors.textMuted)}>
              {status.onPeriod
                ? <>On period (started {status.periodStarted})</>
                : <>Next period in ~{daysLabel(status.daysUntilPeriod)}</>}
            </span>
            {status.inPMSWindow && (
              <span className="mt-0.5 text-xs font-semibold" style={{ color: '#e05252' }}>PMS window</span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {status.onPeriod ? (
            <button onClick={endPeriod} className="bytelight-on-accent rounded-full px-4 py-2 text-xs font-bold" style={{ background: colors.accent }}>
              End period
            </button>
          ) : (
            <button onClick={startPeriod} className="bytelight-on-accent rounded-full px-4 py-2 text-xs font-bold" style={{ background: colors.accent }}>
              Start period
            </button>
          )}
          <button
            onClick={() => setShowLog(!showLog)}
            className={cn('rounded-full border px-4 py-2 text-xs font-bold', colors.panelBorder, colors.textMain)}
          >
            Log today
          </button>
        </div>
      </div>

      {/* Daily log form */}
      {showLog && (
        <div className={card}>
          <label className="flex items-center gap-3">
            <span className={cn('min-w-[4rem] shrink-0 text-sm', colors.textMuted)}>Flow</span>
            <select value={logFlow} onChange={(e) => setLogFlow(e.target.value)} className={input}>
              {FLOW_OPTIONS.map((f) => (
                <option key={f} value={f}>{f === '' ? '--' : f.charAt(0).toUpperCase() + f.slice(1)}</option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-3">
            <span className={cn('min-w-[4rem] shrink-0 text-sm', colors.textMuted)}>Energy</span>
            <div className="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setLogEnergy(logEnergy === n ? 0 : n)}
                  className={cn('h-7 w-7 rounded-full border text-xs font-bold transition-all', colors.panelBorder, n <= logEnergy ? 'bytelight-on-accent' : colors.textMuted)}
                  style={n <= logEnergy ? { background: colors.accent } : undefined}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-3">
            <span className={cn('min-w-[4rem] shrink-0 text-sm', colors.textMuted)}>Mood</span>
            <input type="text" value={logMood} onChange={(e) => setLogMood(e.target.value)} className={input} placeholder="How are you feeling?" />
          </label>
          <label className="flex items-center gap-3">
            <span className={cn('min-w-[4rem] shrink-0 text-sm', colors.textMuted)}>Notes</span>
            <input type="text" value={logNotes} onChange={(e) => setLogNotes(e.target.value)} className={input} placeholder="Anything else..." />
          </label>
          <div className="flex justify-end">
            <button onClick={logDaily} className="bytelight-on-accent rounded-full px-4 py-2 text-xs font-bold" style={{ background: colors.accent }}>
              Save
            </button>
          </div>
        </div>
      )}

      {/* Predictions */}
      {predict.nextPeriod && (
        <div className={card}>
          <span className={sectionTitle}>Predictions</span>
          <div className="grid grid-cols-2 gap-2">
            {[
              ['Next period', predict.nextPeriod],
              ['Ovulation', predict.ovulation],
              ['Fertile window', predict.fertileWindow ? `${predict.fertileWindow.start} - ${predict.fertileWindow.end}` : '—'],
              ['PMS window', predict.pmsWindow ? `${predict.pmsWindow.start} - ${predict.pmsWindow.end}` : '—'],
            ].map(([label, value]) => (
              <div key={label as string} className={cn('flex flex-col rounded-lg border p-3 text-sm', colors.panelBorder)}>
                <span className={cn('mb-1 text-[10px] uppercase', colors.textMuted)}>{label}</span>
                <span className={colors.textMain}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className={card}>
          <span className={sectionTitle}>History</span>
          {history.map((cycle, i) => (
            <div key={i} className={cn('flex justify-between border-b py-2 text-sm last:border-b-0', colors.panelBorder, colors.textMain)}>
              <span>{cycle.start_date} - {cycle.end_date || 'ongoing'}</span>
              {cycle.end_date && (
                <span className={cn('text-sm', colors.textMuted)}>
                  {Math.round((new Date(cycle.end_date).getTime() - new Date(cycle.start_date).getTime()) / 86400000) + 1}d
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Recent logs */}
      {status.recentLogs?.length > 0 && (
        <div className={card}>
          <span className={sectionTitle}>Recent logs</span>
          {status.recentLogs.map((log: any, i: number) => (
            <div key={i} className="flex items-center gap-3 py-2 text-sm">
              <span className={cn('min-w-[5.5rem] shrink-0', colors.textMuted)}>{log.date}</span>
              {log.flow && (
                <span className={cn('rounded-full border px-2 py-0.5 text-xs', colors.panelBorder, colors.textMain)}>{log.flow}</span>
              )}
              {log.energy ? <span className={cn('rounded px-2 py-0.5 text-xs', colors.textMuted)}>energy: {log.energy}</span> : null}
              {log.mood && <span className={cn('rounded px-2 py-0.5 text-xs', colors.textMuted)}>{log.mood}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
