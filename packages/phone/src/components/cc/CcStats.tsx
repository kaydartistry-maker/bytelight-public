import React, { useEffect, useState } from 'react';
import { ThemeConfig } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { apiFetch } from '../../bytelight';

const CC_API = '/api/cc';

interface CcSubPageProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

function avg(arr: any[], key: string): string {
  const vals = (arr || []).map((d) => d[key]).filter((v): v is number => v !== null && v !== undefined);
  if (vals.length === 0) return '-';
  return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
}

export function CcStats({ themeConfig, themeMode }: CcSubPageProps) {
  const colors = themeConfig[themeMode];
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(14);
  const [task, setTask] = useState<any>({});
  const [care, setCare] = useState<any>({});
  const [cycle, setCycle] = useState<any>({});
  const [expense, setExpense] = useState<any>({});
  const [person, setPerson] = useState('default');

  async function load(p = person) {
    setLoading(true);
    try {
      const [t, c, cy, e] = await Promise.all([
        apiFetch(`${CC_API}/stats/tasks?days=${days}`).then((r) => r.json()),
        apiFetch(`${CC_API}/stats/care?person=${p}&days=${days}`).then((r) => r.json()),
        apiFetch(`${CC_API}/stats/cycle`).then((r) => r.json()),
        apiFetch(`${CC_API}/expenses/stats?period=month`).then((r) => r.json()),
      ]);
      setTask(t || {});
      setCare(c || {});
      setCycle(cy || {});
      setExpense(e || {});
    } catch {
      /* graceful */
    }
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`${CC_API}/config`);
        if (res.ok) {
          const cfg = await res.json();
          const p = cfg.default_person || 'default';
          setPerson(p);
          await load(p);
          return;
        }
      } catch {
        /* default */
      }
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!loading) load(); }, [days]);

  const card = cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder);
  const title = cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted);

  function miniStat(value: React.ReactNode, label: string, danger?: boolean) {
    return (
      <div className="flex flex-col items-center">
        <span className="text-lg font-bold" style={{ color: danger ? colors.accent : undefined, opacity: danger ? 0.9 : 1 }}>{value}</span>
        <span className={cn('text-[10px] uppercase tracking-wide', colors.textMuted)}>{label}</span>
      </div>
    );
  }

  function barChart(data: { label: string; value: number }[], max: number) {
    return (
      <div className="flex items-end gap-[3px] h-20 mt-3">
        {data.map((d, i) => (
          <div key={i} className="flex flex-1 flex-col items-center justify-end h-full">
            <div
              className="w-full rounded-t"
              style={{ height: `${max ? Math.round((d.value / max) * 100) : 0}%`, minHeight: 2, background: colors.accent }}
            />
            <span className={cn('text-[9px] mt-1', colors.textMuted)}>{d.label}</span>
          </div>
        ))}
      </div>
    );
  }

  function progressBar(label: string, num: number, denom: number) {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className={cn('text-xs w-24 shrink-0', colors.textMuted)}>{label}</span>
        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(127,127,127,0.2)' }}>
          <div className="h-full rounded-full" style={{ width: `${(num / (denom || 1)) * 100}%`, background: colors.accent }} />
        </div>
        <span className={cn('text-[10px] w-12 text-right', colors.textMuted)}>{num}/{denom}</span>
      </div>
    );
  }

  if (loading) {
    return <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-xs py-6 text-center', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading stats…</div>;
  }

  const perDay = task.completedPerDay || [];
  const perDayMax = Math.max(1, ...perDay.map((d: any) => d.count));
  const dailyAvgs = care.dailyAverages || [];

  return (
    <>
      <div className={cn('p-3 rounded-2xl border backdrop-blur-md mb-3 flex justify-center', colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn('rounded-lg px-3 py-1.5 text-xs font-medium border', colors.panelBorder, days !== d && colors.panelBg)}
              style={days === d ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Tasks */}
      <div className={card}>
        <div className={title}>Task completion</div>
        <div className="grid grid-cols-3 gap-2">
          {miniStat(task.completed || 0, 'done')}
          {miniStat(task.active || 0, 'active')}
          {miniStat(task.overdue || 0, 'overdue', task.overdue > 0)}
        </div>
        {perDay.length > 0 && barChart(perDay.map((d: any) => ({ label: String(d.date).slice(-2), value: d.count })), perDayMax)}
      </div>

      {/* Care */}
      <div className={card}>
        <div className={title}>Care trends ({days}d)</div>
        <div className="grid grid-cols-3 gap-2">
          {miniStat(avg(dailyAvgs, 'sleep'), 'sleep avg')}
          {miniStat(avg(dailyAvgs, 'energy'), 'energy avg')}
          {miniStat(avg(dailyAvgs, 'mood'), 'mood avg')}
        </div>
        {dailyAvgs.length > 0 && (
          <svg className="w-full h-14 mt-3" viewBox={`0 0 ${dailyAvgs.length * 20} 60`} preserveAspectRatio="none">
            {(['mood', 'energy'] as const).map((metric, mi) => (
              <polyline
                key={metric}
                fill="none"
                stroke={mi === 0 ? colors.accent : '#f59e0b'}
                strokeWidth={2}
                opacity={0.75}
                points={dailyAvgs
                  .map((d: any, i: number) => `${i * 20},${d[metric] ? 60 - (d[metric] / 5) * 50 : 55}`)
                  .join(' ')}
              />
            ))}
          </svg>
        )}
        <div className="mt-3">
          {progressBar('Meals (2+/day)', care.mealDays || 0, care.totalDays || 0)}
          {progressBar('Movement', care.movementDays || 0, care.totalDays || 0)}
        </div>
      </div>

      {/* Cycle */}
      {!cycle.noData && (
        <div className={card}>
          <div className={title}>Cycle insights</div>
          <div className="grid grid-cols-3 gap-2">
            {miniStat(cycle.avgCycleLength || '-', 'cycle days')}
            {miniStat(cycle.avgPeriodLength || '-', 'period days')}
            {miniStat(<span className="capitalize">{cycle.currentPhase || '-'}</span>, `day ${cycle.cycleDay || '-'}`)}
          </div>
        </div>
      )}

      {/* Expenses */}
      <div className={card}>
        <div className={title}>Expenses (this month)</div>
        <div className="grid grid-cols-3 gap-2">
          {miniStat(`£${(expense.total || 0).toFixed(0)}`, 'total')}
          {miniStat(`£${(expense.dailyAverage || 0).toFixed(0)}`, 'daily avg')}
          {miniStat(expense.count || 0, 'entries')}
        </div>
        {expense.byCategory?.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {expense.byCategory.map((cat: any) => (
              <div key={cat.category} className="flex items-center gap-2">
                <span className={cn('text-xs w-20 shrink-0 capitalize truncate', colors.textMain)}>{cat.category}</span>
                <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(127,127,127,0.2)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(cat.total / (expense.total || 1)) * 100}%`, background: colors.accent }}
                  />
                </div>
                <span className={cn('text-[10px] w-12 text-right', colors.textMuted)}>£{cat.total.toFixed(0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
