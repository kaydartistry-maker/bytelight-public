// Reading old chats back (backend routes/history-import-routes.ts, GET
// /memory/old-windows/chats). Every chat brought in, newest first, a page at
// a time: by app, or by searching the words in them. Open one and it reads
// top to bottom in the words actually said, with what was searched for
// marked and the first place it appears brought into view. Nothing here
// writes.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../bytelight';
import { cn } from '../lib/utils';

interface Colors { accent: string; panelBg: string; panelBorder: string; textMuted: string }

interface ChatSummary { source: string; chat: string; title: string; startedAt: string | null; messages: number; snippet?: string }
interface ChatList { total: number; page: number; pages: number; chats: ChatSummary[]; sources: { source: string; chats: number }[] }
interface ChatRead { source: string; chat: string; title: string; lines: { role: 'user' | 'assistant'; at: string | null; text: string }[] }

const APP_NAMES: Record<string, string> = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', copilot: 'Copilot', letta: 'Letta' };
const appName = (s: string) => APP_NAMES[s] ?? s;

const dayLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Undated';
const timeLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with every place `q` appears marked. */
function Marked({ text, q, accent }: { text: string; q: string; accent: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRe(q)})`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1
          ? <mark key={i} className="rounded px-0.5" style={{ background: accent, color: 'var(--bytelight-on-accent)' }}>{p}</mark>
          : <React.Fragment key={i}>{p}</React.Fragment>,
      )}
    </>
  );
}

export function OldWindowsReader({ colors, refreshKey }: { colors: Colors; refreshKey: number }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ChatList | null>(null);
  const [reading, setReading] = useState<ChatRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstHit = useRef<HTMLDivElement | null>(null);
  const top = useRef<HTMLDivElement | null>(null);

  const loadList = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (source) params.set('source', source);
      if (q) params.set('q', q);
      const res = await apiFetch(`/api/memory/old-windows/chats?${params}`);
      if (!res.ok) throw new Error('The old chats could not be read.');
      setList(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The old chats could not be read.');
    } finally {
      setBusy(false);
    }
  }, [page, source, q]);

  useEffect(() => { if (open && !reading) void loadList(); }, [open, reading, loadList, refreshKey]);

  // Bring the first marked line into view once a chat opens from a search.
  useEffect(() => {
    if (!reading) return;
    const el = q ? firstHit.current : top.current;
    el?.scrollIntoView({ block: q ? 'center' : 'start' });
  }, [reading, q]);

  const openChat = async (c: ChatSummary) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/memory/old-windows/chats/${encodeURIComponent(c.source)}/${encodeURIComponent(c.chat)}`);
      if (!res.ok) throw new Error('That chat could not be opened.');
      firstHit.current = null;
      setReading(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That chat could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  const search = () => { setPage(1); setQ(typed.trim()); };
  const pickSource = (s: string | null) => { setPage(1); setSource(s); };

  const chip = (active: boolean) => cn('shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors', colors.panelBorder, !active && colors.panelBg);
  const chipStyle = (active: boolean) => (active ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined);
  const link = 'text-[11px] font-medium';

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={cn(link, 'block mt-1.5')} style={{ color: colors.accent }}>
        Read old chats →
      </button>
    );
  }

  // ── One chat, word for word ──────────────────────────────────────────────
  if (reading) {
    const needle = q.toLowerCase();
    let lastDay = '';
    return (
      <div ref={top} className="mt-3 pt-3 border-t" style={{ borderColor: 'rgba(127,127,127,0.2)' }}>
        <button onClick={() => setReading(null)} className={link} style={{ color: colors.accent }}>← All old chats</button>
        <div className="mt-2 text-xs font-medium">{reading.title}</div>
        <div className={cn('text-[10px] mt-0.5', colors.textMuted)}>
          {appName(reading.source)} · {dayLabel(reading.lines[0]?.at ?? null)} · {reading.lines.length.toLocaleString()} messages
        </div>
        <div className="mt-3 space-y-2">
          {reading.lines.map((l, i) => {
            const day = dayLabel(l.at);
            const showDay = day !== lastDay;
            lastDay = day;
            const hit = !!needle && l.text.toLowerCase().includes(needle);
            const mine = l.role === 'user';
            return (
              <React.Fragment key={i}>
                {showDay && i > 0 && <div className={cn('text-center text-[9px] pt-1', colors.textMuted)}>{day}</div>}
                <div
                  ref={hit && !firstHit.current ? (el) => { if (el && !firstHit.current) firstHit.current = el; } : undefined}
                  className={cn('flex', mine ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn('max-w-[88%] rounded-xl border px-3 py-2', !mine && colors.panelBorder, !mine && colors.panelBg)}
                    style={mine ? { borderColor: colors.accent } : undefined}
                  >
                    <div className={cn('text-[9px] mb-0.5', colors.textMuted)}>
                      {mine ? 'You' : appName(reading.source)}{l.at ? ` · ${timeLabel(l.at)}` : ''}
                    </div>
                    <div className="text-[12px] leading-relaxed whitespace-pre-wrap break-words">
                      <Marked text={l.text} q={q} accent={colors.accent} />
                    </div>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <button onClick={() => setReading(null)} className={cn(link, 'mt-3')} style={{ color: colors.accent }}>← All old chats</button>
      </div>
    );
  }

  // ── The list ─────────────────────────────────────────────────────────────
  const nothingYet = list && list.sources.length === 0;
  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'rgba(127,127,127,0.2)' }}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] font-medium">Old chats</div>
        <button onClick={() => setOpen(false)} className={cn('text-[10px]', colors.textMuted)}>Close</button>
      </div>

      {nothingYet ? (
        <div className={cn('text-[10px] mt-1.5', colors.textMuted)}>No old chats have been brought in yet.</div>
      ) : (
        <>
          <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); search(); }}>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Find words in your old chats…"
              enterKeyHint="search"
              className={cn('flex-1 min-w-0 rounded-lg border px-2.5 py-1.5 text-[11px] bg-transparent outline-none', colors.panelBorder)}
            />
            <button
              type="submit"
              className="shrink-0 rounded-lg px-3 py-1.5 text-[11px] font-medium"
              style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
            >
              Find
            </button>
          </form>
          {q && (
            <button onClick={() => { setTyped(''); setPage(1); setQ(''); }} className={cn('text-[10px] mt-1', colors.textMuted)}>
              Showing chats with “{q}” · clear
            </button>
          )}

          {list && list.sources.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button className={chip(source === null)} style={chipStyle(source === null)} onClick={() => pickSource(null)}>All</button>
              {list.sources.map((s) => (
                <button key={s.source} className={chip(source === s.source)} style={chipStyle(source === s.source)} onClick={() => pickSource(s.source)}>
                  {appName(s.source)} <span className="opacity-60">{s.chats.toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}

          {list && (
            <div className={cn('text-[10px] mt-2', colors.textMuted)}>
              {list.total === 0
                ? q ? `No old chats hold “${q}”.` : 'No chats here.'
                : `${list.total.toLocaleString()} ${list.total === 1 ? 'chat' : 'chats'}${list.pages > 1 ? ` · page ${list.page} of ${list.pages}` : ''}`}
            </div>
          )}

          <div className={cn('mt-2 space-y-1.5', busy && 'opacity-60')}>
            {list?.chats.map((c) => (
              <button
                key={`${c.source}:${c.chat}`}
                onClick={() => void openChat(c)}
                className={cn('w-full text-left rounded-lg border px-3 py-2', colors.panelBorder, colors.panelBg)}
              >
                <div className="text-[12px] font-medium truncate">{c.title}</div>
                <div className={cn('text-[10px] mt-0.5', colors.textMuted)}>
                  {appName(c.source)} · {dayLabel(c.startedAt)} · {c.messages.toLocaleString()} {c.messages === 1 ? 'message' : 'messages'}
                </div>
                {c.snippet && (
                  <div className={cn('text-[10px] mt-1 leading-relaxed line-clamp-2', colors.textMuted)}>
                    <Marked text={c.snippet} q={q} accent={colors.accent} />
                  </div>
                )}
              </button>
            ))}
          </div>

          {list && list.pages > 1 && (
            <div className="mt-2 flex items-center justify-between">
              <button disabled={page <= 1 || busy} onClick={() => setPage(page - 1)} className={cn(link, 'disabled:opacity-30')} style={{ color: colors.accent }}>← Newer</button>
              <button disabled={page >= list.pages || busy} onClick={() => setPage(page + 1)} className={cn(link, 'disabled:opacity-30')} style={{ color: colors.accent }}>Older →</button>
            </div>
          )}
        </>
      )}

      {error && <div className="mt-2 text-[10px]" style={{ color: '#ef4444' }}>{error}</div>}
    </div>
  );
}
