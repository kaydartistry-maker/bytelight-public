import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Check, Minus, Plus } from 'lucide-react';
import { ThemeConfig } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { apiFetch } from '../../bytelight';
import { todayYmd, addDays } from '../../lib/local-date';

const CC_API = '/api/cc';

interface CcSubPageProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

interface CareEntry {
  category: string;
  value: string | null;
  note: string | null;
}

interface CareConfig {
  toggles: string[];
  ratings: string[];
  counters: { name: string; max: number }[];
}

function todayStr(): string {
  return todayYmd();
}

function formatCategory(c: string): string {
  return c.replace(/_/g, ' ').replace(/^\w/, (m) => m.toUpperCase());
}

export function CcCare({ themeConfig, themeMode }: CcSubPageProps) {
  const colors = themeConfig[themeMode];
  const [config, setConfig] = useState<CareConfig>({ toggles: [], ratings: [], counters: [] });
  const [person, setPerson] = useState('');
  const [date, setDate] = useState(todayStr());
  const [entries, setEntries] = useState<CareEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);

  function value(cat: string): string | null {
    return entries.find((e) => e.category === cat)?.value ?? null;
  }

  async function loadEntries(d = date, p = person) {
    setLoading(true);
    try {
      const res = await apiFetch(`${CC_API}/care?date=${d}&person=${p}`);
      setEntries((await res.json()).entries || []);
    } catch {
      /* empty */
    }
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      let p = '';
      try {
        const res = await apiFetch(`${CC_API}/config`);
        if (res.ok) {
          const cfg = await res.json();
          p = cfg.default_person || '';
          setPerson(p);
          if (cfg.care_categories) {
            setConfig({
              toggles: cfg.care_categories.toggles || [],
              ratings: cfg.care_categories.ratings || [],
              counters: cfg.care_categories.counters || [],
            });
          }
        }
      } catch {
        /* defaults */
      }
      setReady(true);
      await loadEntries(date, p);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function upsert(category: string, val: string) {
    await apiFetch(`${CC_API}/care`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, person, category, value: val }),
    });
    await loadEntries();
  }

  function shiftDay(delta: number) {
    const next = addDays(date, delta);
    setDate(next);
    loadEntries(next);
  }

  const card = cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder);
  const title = cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted);

  return (
    <>
      <div className={cn('rounded-2xl border p-3 mb-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <div className="flex items-center justify-between">
          <input
            type="text"
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            onBlur={() => loadEntries()}
            placeholder="Person"
            className={cn('rounded-lg border px-2.5 py-1 text-sm bg-transparent w-32', colors.panelBorder, colors.textMain)}
          />
          <div className="flex items-center gap-2">
            <button onClick={() => shiftDay(-1)} className={cn('p-1', colors.textMuted)}>
              <ChevronLeft size={18} />
            </button>
            <span className={cn('text-sm font-medium', colors.textMain)}>{date === todayStr() ? 'Today' : date}</span>
            <button onClick={() => shiftDay(1)} className={cn('p-1', colors.textMuted)}>
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </div>

      {loading || !ready ? (
        <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-xs py-6 text-center', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>
      ) : (
        <>
          {config.toggles.length > 0 && (
            <div className={card}>
              <div className={title}>Basics</div>
              <div className="flex flex-wrap gap-2">
                {config.toggles.map((cat) => {
                  const on = value(cat) === 'true';
                  return (
                    <button
                      key={cat}
                      onClick={() => upsert(cat, on ? 'false' : 'true')}
                      className={cn('flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs', colors.panelBorder)}
                      style={on ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : { color: 'var(--bytelight-text)' }}
                    >
                      {on && <Check size={12} />}
                      {formatCategory(cat)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {config.ratings.length > 0 && (
            <div className={card}>
              <div className={title}>How are you?</div>
              {config.ratings.map((cat) => {
                const rating = value(cat) ? parseInt(value(cat)!, 10) : 0;
                return (
                  <div key={cat} className="flex items-center justify-between py-1.5">
                    <span className={cn('text-sm', colors.textMain)}>{formatCategory(cat)}</span>
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          onClick={() => upsert(cat, String(n))}
                          className="h-7 w-7 rounded-full border text-xs"
                          style={{
                            borderColor: n <= rating ? colors.accent : 'rgba(127,127,127,0.4)',
                            background: n <= rating ? colors.accent : 'transparent',
                            color: n <= rating ? 'var(--bytelight-on-accent)' : 'var(--bytelight-text-muted)',
                          }}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {config.counters.map((counter) => {
            const count = value(counter.name) ? parseInt(value(counter.name)!, 10) : 0;
            return (
              <div key={counter.name} className={card}>
                <div className={title}>{formatCategory(counter.name)}</div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => upsert(counter.name, String(Math.max(0, count - 1)))}
                    className={cn('rounded-full border p-1.5', colors.panelBorder, colors.textMain)}
                  >
                    <Minus size={16} />
                  </button>
                  <div className="flex flex-1 gap-[3px]">
                    {Array.from({ length: counter.max }).map((_, i) => (
                      <div
                        key={i}
                        className="h-7 flex-1 rounded border"
                        style={{
                          background: i < count ? colors.accent : 'transparent',
                          borderColor: i < count ? colors.accent : 'rgba(127,127,127,0.3)',
                        }}
                      />
                    ))}
                  </div>
                  <span className={cn('text-lg font-bold w-6 text-center', colors.textMain)}>{count}</span>
                  <button
                    onClick={() => upsert(counter.name, String(Math.min(counter.max, count + 1)))}
                    className={cn('rounded-full border p-1.5', colors.panelBorder, colors.textMain)}
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            );
          })}

          {config.toggles.length === 0 && config.ratings.length === 0 && config.counters.length === 0 && (
            <div className={cn('text-xs py-6 text-center', colors.textMuted)}>
              No care categories configured in bytelight.yaml.
            </div>
          )}
        </>
      )}
    </>
  );
}
