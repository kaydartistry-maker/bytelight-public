import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { ThemeConfig } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { apiFetch } from '../../bytelight';
import { todayYmd, parseYmd } from '../../lib/local-date';

const CC_API = '/api/cc';

interface CcSubPageProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

interface CcEvent {
  id: string;
  title: string;
  start_date: string;
  start_time: string | null;
  category: string;
}

function todayStr(): string {
  return todayYmd();
}

function shortDate(d: string): string {
  return parseYmd(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function computeMonth(d: Date): string[][] {
  const year = d.getFullYear();
  const month = d.getMonth();
  const startDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks: string[][] = [];
  let week: string[] = [];
  for (let i = 0; i < startDay; i++) week.push('');
  for (let day = 1; day <= daysInMonth; day++) {
    week.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push('');
    weeks.push(week);
  }
  return weeks;
}

export function CcCalendar({ themeConfig, themeMode }: CcSubPageProps) {
  const colors = themeConfig[themeMode];
  const [month, setMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [events, setEvents] = useState<CcEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('');
  const [category, setCategory] = useState('default');

  const weeks = computeMonth(month);

  async function loadMonth(m = month) {
    setLoading(true);
    try {
      const y = m.getFullYear();
      const mo = m.getMonth();
      const start = `${y}-${String(mo + 1).padStart(2, '0')}-01`;
      const end = `${y}-${String(mo + 1).padStart(2, '0')}-${new Date(y, mo + 1, 0).getDate()}`;
      const res = await apiFetch(`${CC_API}/events?start_date=${start}&end_date=${end}`);
      setEvents((await res.json()).events || []);
    } catch {
      /* empty */
    }
    setLoading(false);
  }

  useEffect(() => {
    loadMonth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function shiftMonth(delta: number) {
    const next = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    setMonth(next);
    loadMonth(next);
  }

  async function addEvent() {
    if (!title.trim()) return;
    await apiFetch(`${CC_API}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), start_date: selectedDate, start_time: time || undefined, category }),
    });
    setTitle('');
    setTime('');
    setShowAdd(false);
    await loadMonth();
  }

  async function deleteEvent(id: string) {
    await apiFetch(`${CC_API}/events/${id}`, { method: 'DELETE' });
    await loadMonth();
  }

  const dayEvents = events.filter((e) => e.start_date === selectedDate);
  const input = cn('rounded-lg border px-3 py-2 text-sm bg-transparent', colors.panelBorder, colors.textMain);

  return (
    <>
      <div className={cn('rounded-2xl border p-3 mb-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => shiftMonth(-1)} className={cn('rounded-full p-2', colors.textMuted)}>
            <ChevronLeft size={18} />
          </button>
          <span className={cn('text-sm font-semibold', colors.textMain)}>
            {month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
          </span>
          <button onClick={() => shiftMonth(1)} className={cn('rounded-full p-2', colors.textMuted)}>
            <ChevronRight size={18} />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <div key={i} className={cn('text-center text-[10px] py-1', colors.textMuted)}>{d}</div>
          ))}
          {weeks.flat().map((date, i) => {
            const has = date && events.some((e) => e.start_date === date);
            const isToday = date === todayStr();
            const isSel = date === selectedDate;
            return (
              <button
                key={i}
                disabled={!date}
                onClick={() => date && setSelectedDate(date)}
                className="min-h-[40px] flex flex-col items-center justify-center gap-0.5 rounded-lg border text-sm"
                style={{
                  borderColor: isSel ? colors.accent : 'transparent',
                  color: isToday ? colors.accent : undefined,
                  fontWeight: isToday ? 700 : 400,
                }}
              >
                {date && <span className={colors.textMain}>{parseInt(date.split('-')[2], 10)}</span>}
                {has && <span className="h-1 w-1 rounded-full" style={{ background: colors.accent }} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className={cn('rounded-2xl border p-3', colors.panelBg, colors.panelBorder)}>
        <div className="flex items-center justify-between mb-2">
          <span className={cn('text-sm font-semibold', colors.textMain)}>{shortDate(selectedDate)}</span>
          <button onClick={() => setShowAdd(!showAdd)} className="rounded-full p-1.5 bytelight-on-accent" style={{ background: colors.accent }}>
            <Plus size={14} />
          </button>
        </div>

        {showAdd && (
          <div className="flex flex-col gap-2 mb-3">
            <input className={input} placeholder="Event title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <div className="flex gap-2">
              <input className={cn(input, 'flex-1')} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              <select className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="default">General</option>
                <option value="work">Work</option>
                <option value="personal">Personal</option>
                <option value="health">Health</option>
                <option value="home">Home</option>
              </select>
              <button onClick={addEvent} className="rounded-lg px-3 text-sm font-semibold bytelight-on-accent" style={{ background: colors.accent }}>
                Add
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className={cn('text-xs py-3 text-center', colors.textMuted)}>Loading…</div>
        ) : dayEvents.length === 0 ? (
          <div className={cn('text-xs py-3 text-center', colors.textMuted)}>No events this day.</div>
        ) : (
          dayEvents.map((ev) => (
            <div key={ev.id} className={cn('flex items-center gap-2 py-2 border-b last:border-0', colors.panelBorder)}>
              <span className={cn('text-xs w-16 shrink-0', colors.textMuted)}>{ev.start_time || 'All day'}</span>
              <span className={cn('flex-1 text-sm truncate', colors.textMain)}>{ev.title}</span>
              <span className={cn('text-[10px]', colors.textMuted)}>{ev.category}</span>
              <button onClick={() => deleteEvent(ev.id)} className={cn('p-1', colors.textMuted)}>
                <X size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}
