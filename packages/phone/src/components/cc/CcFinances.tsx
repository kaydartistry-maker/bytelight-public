import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { ThemeConfig } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { apiFetch } from '../../bytelight';

const CC_API = '/api/cc';
const CATEGORIES = ['groceries', 'bills', 'dining', 'transport', 'entertainment', 'health', 'home', 'other'];

interface CcSubPageProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

export function CcFinances({ themeConfig, themeMode }: CcSubPageProps) {
  const colors = themeConfig[themeMode];
  const [loading, setLoading] = useState(true);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({});
  const [period, setPeriod] = useState('month');
  const [currency, setCurrency] = useState('$');
  const [showAdd, setShowAdd] = useState(false);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('other');
  const [desc, setDesc] = useState('');
  const [paidBy, setPaidBy] = useState('');

  async function load(p = period) {
    setLoading(true);
    try {
      const [eRes, sRes] = await Promise.all([
        apiFetch(`${CC_API}/expenses?limit=30`),
        apiFetch(`${CC_API}/expenses/stats?period=${p}`),
      ]);
      const eData = await eRes.json();
      setExpenses(eData.expenses || []);
      setStats(await sRes.json());
    } catch {
      /* empty state */
    }
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`${CC_API}/config`);
        if (res.ok) setCurrency((await res.json()).currency_symbol || '$');
      } catch {
        /* default */
      }
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addExpense() {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return;
    await apiFetch(`${CC_API}/expenses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amt, category, description: desc || undefined, paid_by: paidBy || undefined }),
    });
    setAmount('');
    setDesc('');
    setShowAdd(false);
    await load();
  }

  const card = cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder);
  const input = cn('rounded-lg border px-3 py-2 text-sm bg-transparent', colors.panelBorder, colors.textMain);

  if (loading) return <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-xs py-6 text-center', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>;

  return (
    <>
      <div className={cn('p-3 rounded-2xl border backdrop-blur-md mb-3 flex justify-center', colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5">
          {['week', 'month', 'year'].map((p) => (
            <button
              key={p}
              onClick={() => { setPeriod(p); load(p); }}
              className={cn('rounded-lg px-3 py-1.5 text-xs font-medium capitalize border', colors.panelBorder, period !== p && colors.panelBg)}
              style={period === p ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          [`${currency}${(stats.total || 0).toFixed(2)}`, 'total'],
          [`${currency}${(stats.dailyAverage || 0).toFixed(2)}`, 'daily avg'],
          [String(stats.count || 0), 'entries'],
        ].map(([v, l]) => (
          <div key={l} className={cn('rounded-2xl border p-2.5 text-center', colors.panelBg, colors.panelBorder)}>
            <div className={cn('text-base font-semibold', colors.textMain)}>{v}</div>
            <div className={cn('text-[10px] uppercase', colors.textMuted)}>{l}</div>
          </div>
        ))}
      </div>

      {stats.byCategory?.length > 0 && (
        <div className={card}>
          <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted)}>By category</div>
          {stats.byCategory.map((cat: any) => (
            <div key={cat.category} className="flex items-center gap-2 py-1">
              <span className={cn('flex-1 text-sm capitalize', colors.textMain)}>{cat.category}</span>
              <span className={cn('text-sm font-semibold', colors.textMain)}>{currency}{cat.total.toFixed(2)}</span>
              <span className={cn('text-[10px]', colors.textMuted)}>{cat.count}×</span>
            </div>
          ))}
        </div>
      )}

      <div className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <div className="flex items-center justify-between mb-2">
          <span className={cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>Recent expenses</span>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="rounded-full p-1.5 bytelight-on-accent"
            style={{ background: colors.accent }}
          >
            <Plus size={14} />
          </button>
        </div>

        {showAdd && (
          <div className="flex flex-col gap-2 mb-3">
            <div className="flex gap-2">
              <input
                type="number"
                inputMode="decimal"
                placeholder="Amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={cn(input, 'flex-1')}
              />
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={input}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <input type="text" placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} className={input} />
            <div className="flex gap-2">
              <input type="text" placeholder="Paid by" value={paidBy} onChange={(e) => setPaidBy(e.target.value)} className={cn(input, 'flex-1')} />
              <button onClick={addExpense} className="rounded-lg px-4 py-2 text-sm font-semibold bytelight-on-accent" style={{ background: colors.accent }}>
                Add
              </button>
            </div>
          </div>
        )}

        {expenses.length === 0 ? (
          <div className={cn('text-xs py-6 text-center', colors.textMuted)}>No expenses recorded.</div>
        ) : (
          <div className="space-y-1">
            {expenses.map((exp) => (
              <div key={exp.id} className={cn('flex items-center justify-between py-2 border-b last:border-0', colors.panelBorder)}>
                <div className="min-w-0">
                  <div className={cn('text-sm truncate', colors.textMain)}>{exp.description || exp.category}</div>
                  <div className={cn('text-[11px]', colors.textMuted)}>
                    {exp.date} · {exp.category}{exp.paid_by ? ` · ${exp.paid_by}` : ''}
                  </div>
                </div>
                <span className={cn('text-sm font-semibold shrink-0', colors.textMain)}>
                  {currency}{exp.amount.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
