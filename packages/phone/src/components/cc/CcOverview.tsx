import React, { useEffect, useState } from 'react';
import { Plus, X, Trophy } from 'lucide-react';
import { ThemeConfig } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { apiFetch } from '../../bytelight';
import { todayYmd } from '../../lib/local-date';

const CC_API = '/api/cc';

interface CcSubPageProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

interface ScratchItem {
  type: 'note' | 'task' | 'event';
  id: string;
  text: string;
  time?: string;
}

function todayStr(): string {
  return todayYmd();
}

export function CcOverview({ themeConfig, themeMode }: CcSubPageProps) {
  const colors = themeConfig[themeMode];
  const [loading, setLoading] = useState(true);
  const [taskCount, setTaskCount] = useState(0);
  const [events, setEvents] = useState<any[]>([]);
  const [petAlerts, setPetAlerts] = useState<any[]>([]);
  const [scratch, setScratch] = useState<ScratchItem[]>([]);
  const [wins, setWins] = useState<any[]>([]);
  const [countdowns, setCountdowns] = useState<any[]>([]);

  const [note, setNote] = useState('');
  const [showCd, setShowCd] = useState(false);
  const [cdTitle, setCdTitle] = useState('');
  const [cdDate, setCdDate] = useState('');

  async function load() {
    setLoading(true);
    try {
      const today = todayStr();
      const [taskRes, eventRes, petRes, scratchRes, winRes, cdRes] = await Promise.all([
        apiFetch(`${CC_API}/tasks?status=active`).then((r) => r.json()),
        apiFetch(`${CC_API}/events?start_date=${today}&end_date=${today}`).then((r) => r.json()),
        apiFetch(`${CC_API}/pets/upcoming?days=2`).then((r) => r.json()),
        apiFetch(`${CC_API}/scratchpad`).then((r) => r.json()),
        apiFetch(`${CC_API}/wins?date=${today}`).then((r) => r.json()),
        apiFetch(`${CC_API}/countdowns`).then((r) => r.json()),
      ]);
      setTaskCount((taskRes.tasks || []).length);
      setEvents(eventRes.events || []);
      setPetAlerts((petRes.items || []).filter((p: any) => p.overdue || p.isToday));
      const items: ScratchItem[] = [
        ...(scratchRes.events || []).map((e: any) => ({ type: 'event' as const, id: e.id, text: e.title, time: e.start_time })),
        ...(scratchRes.tasks || []).map((t: any) => ({ type: 'task' as const, id: t.id, text: t.text })),
        ...(scratchRes.notes || []).map((n: any) => ({ type: 'note' as const, id: n.id, text: n.text })),
      ];
      setScratch(items);
      setWins(winRes.wins || []);
      setCountdowns((cdRes.countdowns || []).filter((c: any) => c.days_until >= 0).slice(0, 6));
    } catch {
      /* empty */
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function addNote() {
    if (!note.trim()) return;
    await apiFetch(`${CC_API}/scratchpad/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: note.trim(), created_by: 'user' }),
    });
    setNote('');
    await load();
  }

  async function deleteNote(id: string) {
    await apiFetch(`${CC_API}/scratchpad/notes/${id}`, { method: 'DELETE' });
    await load();
  }

  async function addCountdown() {
    if (!cdTitle.trim() || !cdDate) return;
    await apiFetch(`${CC_API}/countdowns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: cdTitle.trim(), target_date: cdDate }),
    });
    setCdTitle('');
    setCdDate('');
    setShowCd(false);
    await load();
  }

  async function deleteCountdown(id: string) {
    await apiFetch(`${CC_API}/countdowns/${id}`, { method: 'DELETE' });
    await load();
  }

  const card = cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder);
  const title = cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted);
  const input = cn('rounded-lg border px-3 py-2 text-sm bg-transparent', colors.panelBorder, colors.textMain);

  if (loading) return <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-xs py-6 text-center', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>;

  return (
    <>
      {/* Summary */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          [taskCount, 'tasks'],
          [events.length, 'today'],
          [petAlerts.length, 'alerts'],
        ].map(([v, l]) => (
          <div key={l} className={cn('rounded-2xl border p-2.5 text-center', colors.panelBg, colors.panelBorder)}>
            <div className={cn('text-lg font-bold', colors.textMain)}>{v as number}</div>
            <div className={cn('text-[10px] uppercase', colors.textMuted)}>{l as string}</div>
          </div>
        ))}
      </div>

      {/* Today's scratchpad */}
      <div className={card}>
        <div className={title}>Today</div>
        <div className="flex gap-2 mb-2">
          <input
            className={cn(input, 'flex-1')}
            placeholder="Quick note…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addNote()}
          />
          <button onClick={addNote} className="rounded-lg px-3 bytelight-on-accent" style={{ background: colors.accent }}>
            <Plus size={16} />
          </button>
        </div>
        {scratch.length === 0 ? (
          <div className={cn('text-xs py-2 text-center', colors.textMuted)}>Nothing yet today.</div>
        ) : (
          scratch.map((it) => (
            <div key={`${it.type}-${it.id}`} className="flex items-center gap-2 py-1.5">
              <span
                className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase shrink-0"
                style={{ background: 'rgba(127,127,127,0.15)', color: 'var(--bytelight-text-muted)' }}
              >
                {it.type}
              </span>
              {it.time && <span className={cn('text-[11px]', colors.textMuted)}>{it.time}</span>}
              <span className={cn('flex-1 text-sm truncate', colors.textMain)}>{it.text}</span>
              {it.type === 'note' && (
                <button onClick={() => deleteNote(it.id)} className={cn('p-0.5', colors.textMuted)}>
                  <X size={13} />
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* Pet alerts */}
      {petAlerts.length > 0 && (
        <div className={card} style={{ borderColor: colors.accent }}>
          <div className={title}>Pet care needed</div>
          {petAlerts.map((a, i) => (
            <div key={i} className="flex items-center gap-2 py-1">
              <span className={cn('text-sm font-semibold', colors.textMain)}>{a.pet}</span>
              <span className={cn('flex-1 text-xs truncate', colors.textMuted)}>{a.name}</span>
              <span className="text-[10px] font-semibold" style={{ color: colors.accent, opacity: 0.9 }}>
                {a.overdue ? 'Overdue' : 'Today'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Wins */}
      {wins.length > 0 && (
        <div className={card}>
          <div className={cn(title, 'flex items-center gap-1.5')}>
            <Trophy size={12} /> Wins today
          </div>
          {wins.map((w, i) => (
            <div key={i} className={cn('text-sm py-1', colors.textMain)}>
              {w.text || w.description || w.title}
            </div>
          ))}
        </div>
      )}

      {/* Countdowns */}
      <div className={card}>
        <div className="flex items-center justify-between mb-2">
          <span className={title} style={{ marginBottom: 0 }}>Countdowns</span>
          <button onClick={() => setShowCd(!showCd)} className="rounded-full p-1 bytelight-on-accent" style={{ background: colors.accent }}>
            <Plus size={13} />
          </button>
        </div>
        {showCd && (
          <div className="flex gap-2 mb-2">
            <input className={cn(input, 'flex-1')} placeholder="Title" value={cdTitle} onChange={(e) => setCdTitle(e.target.value)} />
            <input className={input} type="date" value={cdDate} onChange={(e) => setCdDate(e.target.value)} />
            <button onClick={addCountdown} className="rounded-lg px-3 text-xs font-semibold bytelight-on-accent" style={{ background: colors.accent }}>
              Add
            </button>
          </div>
        )}
        {countdowns.length === 0 ? (
          <div className={cn('text-xs py-2 text-center', colors.textMuted)}>No countdowns.</div>
        ) : (
          countdowns.map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-1.5">
              <span className={cn('flex-1 text-sm truncate', colors.textMain)}>{c.title}</span>
              <span className={cn('text-xs', colors.textMuted)}>
                {c.days_until === 0 ? 'Today' : `${c.days_until}d`}
              </span>
              <button onClick={() => deleteCountdown(c.id)} className={cn('p-0.5', colors.textMuted)}>
                <X size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}
