// Bringing old chats in (backend routes/history-import-routes.ts).
//
// Pick an export (or name one already on the house's machine), see what is
// in it before anything is written, choose all of it or a single month, then
// watch it come in. Leaving the screen does not stop an import; coming back
// picks the progress up again.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../bytelight';
import { cn } from '../lib/utils';

interface Colors { accent: string; panelBg: string; panelBorder: string; textMuted: string }

interface MonthCount { chats: number; messages: number; dropped: number }
interface Preview {
  sourceLabel: string;
  readable: boolean;
  chats: number;
  messages: number;
  dropped: number;
  months: Record<string, MonthCount>;
  sample: { title: string; startedAt: string | null; messages: number }[];
}
interface Status {
  state: 'idle' | 'reading' | 'indexing' | 'done' | 'failed';
  sourceLabel: string | null;
  month: string | null;
  chats: number;
  stored: number;
  dropped: number;
  indexed: number;
  toIndex: number;
  pieces: number;
  error: string | null;
}

type Chosen = { upload: string; label: string } | { path: string; label: string };

/** Pieces the house fingerprints a second, roughly, on a small machine. */
const PIECES_PER_SECOND = 6;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => (m === 'undated' ? 'Undated' : `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`);

function roughTime(messages: number): string {
  const minutes = Math.ceil(messages / PIECES_PER_SECOND / 60);
  if (minutes <= 1) return 'about a minute';
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 30) / 2;
  return `about ${hours} hours`;
}

const running = (s: Status | null) => !!s && (s.state === 'reading' || s.state === 'indexing');

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}));
  return (d && typeof d.error === 'string' && d.error) || fallback;
}

export function OldWindowsImport({ colors, onImported }: { colors: Colors; onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [pathText, setPathText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<'upload' | 'read' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const wasRunning = useRef(false);

  const poll = useCallback(async () => {
    const res = await apiFetch('/api/memory/old-windows/import').catch(() => null);
    if (!res?.ok) return;
    const s = (await res.json()) as Status;
    setStatus(s);
    if (running(s)) { wasRunning.current = true; setOpen(true); }
    else if (wasRunning.current) { wasRunning.current = false; onImported(); }
  }, [onImported]);

  // An import already under way (started before this screen opened) shows itself.
  useEffect(() => { void poll(); }, [poll]);
  useEffect(() => {
    if (!running(status)) return;
    const t = setInterval(() => { void poll(); }, 2000);
    return () => clearInterval(t);
  }, [status, poll]);

  const readIt = async (c: Chosen) => {
    setChosen(c);
    setPreview(null);
    setMonth(null);
    setError(null);
    setBusy('read');
    try {
      const res = await apiFetch('/api/memory/old-windows/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('upload' in c ? { upload: c.upload } : { path: c.path }),
      });
      if (!res.ok) throw new Error(await readError(res, 'That export could not be read.'));
      setPreview(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That export could not be read.');
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPreview(null);
    setBusy('upload');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch('/api/memory/old-windows/upload', { method: 'POST', body: form });
      if (!res.ok) {
        throw new Error(res.status === 413
          ? 'That file is too big to send from here. Put it on the house\'s machine and give its path below.'
          : await readError(res, 'The upload did not come through.'));
      }
      const d = await res.json();
      setBusy(null);
      await readIt({ upload: d.upload, label: file.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The upload did not come through.');
      setBusy(null);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const start = async () => {
    if (!chosen) return;
    setBusy('start');
    setError(null);
    try {
      const body = { ...('upload' in chosen ? { upload: chosen.upload } : { path: chosen.path }), ...(month ? { month } : {}) };
      const res = await apiFetch('/api/memory/old-windows/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res, 'The import could not start.'));
      wasRunning.current = true;
      setStatus(await res.json());
      setPreview(null);
      setChosen(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import could not start.');
    } finally {
      setBusy(null);
    }
  };

  const reset = () => { setChosen(null); setPreview(null); setMonth(null); setError(null); setPathText(''); };

  const pick = month && preview ? preview.months[month] : preview ? { chats: preview.chats, messages: preview.messages, dropped: preview.dropped } : null;
  const months = preview ? Object.keys(preview.months).sort((a, b) => b.localeCompare(a)) : [];
  const chip = (active: boolean) => cn('shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors', colors.panelBorder, !active && colors.panelBg);
  const chipStyle = (active: boolean) => (active ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined);
  const primary = 'w-full rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50 transition-opacity';

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-2.5 text-[11px] font-medium" style={{ color: colors.accent }}>
        Bring in old chats →
      </button>
    );
  }

  // ── An import under way, or just finished ────────────────────────────────
  if (status && status.state !== 'idle' && !preview && !chosen && busy !== 'read') {
    const pct = status.state === 'indexing' && status.toIndex > 0 ? Math.min(100, Math.round((status.indexed / status.toIndex) * 100)) : status.state === 'done' ? 100 : null;
    const left = status.state === 'indexing' ? Math.max(0, status.toIndex - status.indexed) : 0;
    return (
      <div className="mt-3 pt-3 border-t" style={{ borderColor: 'rgba(127,127,127,0.2)' }}>
        <div className="text-[11px] font-medium">
          {status.state === 'reading' && `Reading the ${status.sourceLabel ?? ''} export…`}
          {status.state === 'indexing' && 'Indexing, so the old words can be found by meaning'}
          {status.state === 'done' && 'Old chats are in'}
          {status.state === 'failed' && 'The import stopped'}
          {status.month && status.state !== 'failed' ? ` · ${monthLabel(status.month)}` : ''}
        </div>
        {pct !== null && (
          <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(127,127,127,0.2)' }}>
            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: colors.accent }} />
          </div>
        )}
        <div className={cn('text-[10px] mt-1.5', colors.textMuted)}>
          {status.state === 'reading' && `${status.chats.toLocaleString()} chats read, ${status.stored.toLocaleString()} new messages kept.`}
          {status.state === 'indexing' && `${status.indexed.toLocaleString()} of ${status.toIndex.toLocaleString()} messages · ${roughTime(left)} left. You can leave this screen; it keeps going.`}
          {status.state === 'done' && (status.stored
            ? `${status.stored.toLocaleString()} messages from ${status.chats.toLocaleString()} chats, word for word. ${status.dropped.toLocaleString()} abandoned drafts left out. ${status.pieces.toLocaleString()} new pieces indexed.`
            : status.pieces
              ? `Those chats were already kept; ${status.pieces.toLocaleString()} pieces of them are now indexed.`
              : 'Everything in that export was already here, so nothing new was added.')}
          {status.state === 'failed' && (status.error ?? 'Something went wrong.')}
        </div>
        {!running(status) && (
          <button onClick={() => { setStatus({ ...status, state: 'idle' }); reset(); }} className="mt-2 text-[11px] font-medium" style={{ color: colors.accent }}>
            {status.state === 'failed' ? 'Try again' : 'Bring in another'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'rgba(127,127,127,0.2)' }}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] font-medium">Bring in old chats</div>
        <button onClick={() => { reset(); setOpen(false); }} className={cn('text-[10px]', colors.textMuted)}>Close</button>
      </div>

      {!preview && (
        <>
          <div className={cn('text-[10px] mt-1 leading-relaxed', colors.textMuted)}>
            Your data export, as it was emailed to you (the zip), or the conversations.json inside it. Claude exports can be read today. Nothing is written until you have seen what is inside.
          </div>
          <input ref={fileInput} type="file" accept=".zip,.json,application/zip,application/json" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          <button
            onClick={() => fileInput.current?.click()}
            disabled={!!busy}
            className={cn(primary, 'mt-2.5')}
            style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
          >
            {busy === 'upload' ? 'Sending it to the house…' : busy === 'read' ? 'Reading what is inside…' : 'Choose the export'}
          </button>
          <div className={cn('text-[10px] mt-3', colors.textMuted)}>Too big to send from here? Put it on the house's machine and give its full path:</div>
          <div className="mt-1.5 flex gap-2">
            <input
              value={pathText}
              onChange={(e) => setPathText(e.target.value)}
              placeholder="/home/you/conversations.zip"
              spellCheck={false}
              autoCapitalize="off"
              className={cn('flex-1 min-w-0 rounded-lg border px-2.5 py-1.5 text-[11px] bg-transparent outline-none', colors.panelBorder)}
            />
            <button
              onClick={() => pathText.trim() && void readIt({ path: pathText.trim(), label: pathText.trim().split('/').pop() || 'export' })}
              disabled={!!busy || !pathText.trim()}
              className={cn('shrink-0 rounded-lg border px-3 py-1.5 text-[11px] font-medium disabled:opacity-50', colors.panelBorder)}
            >
              Read it
            </button>
          </div>
        </>
      )}

      {preview && !preview.readable && (
        <div className={cn('mt-2 rounded-lg border px-3 py-2.5 text-[11px]', colors.panelBorder)}>
          This looks like an export from <span className="font-medium">{preview.sourceLabel}</span>. This house cannot read those yet, so nothing was written.
          <button onClick={reset} className="block mt-2 text-[11px] font-medium" style={{ color: colors.accent }}>Choose another</button>
        </div>
      )}

      {preview && preview.readable && pick && (
        <div className="mt-2">
          <div className={cn('rounded-lg border px-3 py-2.5', colors.panelBorder)}>
            <div className="text-[11px]">
              <span className="font-medium">{preview.sourceLabel} export</span>
              <span className={colors.textMuted}> · {chosen?.label}</span>
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-2 text-center">
              {[['chats', pick.chats], ['messages', pick.messages], ['drafts left out', pick.dropped]].map(([label, n]) => (
                <div key={label as string}>
                  <div className="text-sm font-semibold tabular-nums">{(n as number).toLocaleString()}</div>
                  <div className={cn('text-[9px]', colors.textMuted)}>{label}</div>
                </div>
              ))}
            </div>
            {!month && preview.sample.length > 0 && (
              <div className={cn('mt-2 text-[10px] leading-relaxed', colors.textMuted)}>
                Newest: {preview.sample.slice(0, 3).map((s) => `“${s.title}”`).join(', ')}
              </div>
            )}
          </div>

          {months.length > 1 && (
            <>
              <div className={cn('text-[10px] mt-2.5', colors.textMuted)}>All of it, or one month to try first:</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <button className={chip(month === null)} style={chipStyle(month === null)} onClick={() => setMonth(null)}>All</button>
                {months.map((m) => (
                  <button key={m} className={chip(month === m)} style={chipStyle(month === m)} onClick={() => setMonth(m)}>
                    {monthLabel(m)} <span className="opacity-60">{preview.months[m].chats}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className={cn('text-[10px] mt-2.5 leading-relaxed', colors.textMuted)}>
            Kept word for word on this machine. Abandoned edits and regenerations are left out. Indexing takes {roughTime(pick.messages)}, in the background. Chats already here are skipped.
          </div>
          <button
            onClick={() => void start()}
            disabled={!!busy || pick.messages === 0}
            className={cn(primary, 'mt-2')}
            style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
          >
            {busy === 'start' ? 'Starting…' : `Bring in ${pick.chats.toLocaleString()} ${pick.chats === 1 ? 'chat' : 'chats'}`}
          </button>
          <button onClick={reset} className={cn('w-full mt-1.5 text-[10px] py-1', colors.textMuted)}>Choose a different export</button>
        </div>
      )}

      {error && <div className="mt-2 text-[10px] text-red-400">{error}</div>}
    </div>
  );
}
