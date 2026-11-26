// The old-windows switch: whether pieces of imported chats may surface in
// your companions' turns (backend services/history-recall.ts). Shown on the
// Memory Blocks screen beside the Archivist settings, with the doors to bring
// old chats in and to read them back.
import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../bytelight';
import { cn } from '../lib/utils';
import { OldWindowsImport } from './OldWindowsImport';
import { OldWindowsReader } from './OldWindowsReader';

interface Colors { accent: string; panelBg: string; panelBorder: string; textMuted: string }
interface State { enabled: boolean; indexed: { pieces: number; builtAt: string | null } | null }

export function OldWindowsSwitch({ colors }: { colors: Colors }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [imports, setImports] = useState(0);

  const load = useCallback(() => {
    apiFetch('/api/memory/old-windows')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.enabled === 'boolean') setState(d); })
      .catch(() => { /* the switch just stays hidden */ });
  }, []);
  useEffect(load, [load]);
  // Stable, so the import panel's status poll is not rebuilt on every render.
  const imported = useCallback(() => { load(); setImports((n) => n + 1); }, [load]);

  if (!state) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/memory/old-windows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !state.enabled }),
      });
      if (res.ok) setState(await res.json());
    } finally {
      setBusy(false);
    }
  };

  const count = state.indexed?.pieces ?? 0;
  return (
    <div className={cn('mb-4 rounded-xl border px-3 py-2.5', colors.panelBorder, colors.panelBg)}>
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium">Old windows</div>
        <div className={cn('text-[10px] mt-0.5', colors.textMuted)}>
          {!state.indexed
            ? 'No imported chats are indexed yet.'
            : state.enabled
              ? `On. When you say something close to a moment in your imported chats, one piece of it can come back to your companions, in the words actually said. Never in a room a guest reads. ${count.toLocaleString()} pieces indexed.`
              : `Off. Your imported chats are kept, but nothing from them surfaces in your companions' turns. ${count.toLocaleString()} pieces indexed.`}
        </div>
      </div>
      <button
        onClick={toggle}
        disabled={busy}
        role="switch"
        aria-checked={state.enabled}
        aria-label="Let old windows surface"
        className="shrink-0 w-11 h-6 rounded-full relative transition-colors disabled:opacity-50"
        style={{ background: state.enabled ? colors.accent : 'rgba(127,127,127,0.35)' }}
      >
        <span
          className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
          style={{ transform: state.enabled ? 'translateX(20px)' : 'translateX(0)' }}
        />
      </button>
    </div>
    <OldWindowsImport colors={colors} onImported={imported} />
    <OldWindowsReader colors={colors} refreshKey={imports} />
    </div>
  );
}
