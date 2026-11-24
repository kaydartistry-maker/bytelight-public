import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { brainRequest, describeAnswer } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { Colors, fetchFn } from './parts';

// The console's buttons. Every press waits for the brain's real answer and
// shows it: nothing is marked done until the brain says so. Anything that
// deletes asks first.

type Method = 'POST' | 'PUT' | 'DELETE';

export interface RunOptions {
  /** Asked before sending; Cancel sends nothing. */
  confirm?: string;
}

/** Sends one write. On success calls onDone with the brain's answer in a
 *  short line; on failure keeps the brain's error here to show. */
export function useBrainAction(onDone: (said: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (method: Method, path: string, body?: unknown, opts: RunOptions = {}) => {
    if (busy) return;
    if (opts.confirm && !confirm(opts.confirm)) return;
    setBusy(true);
    setError(null);
    const r = await brainRequest(fetchFn, method, path, body);
    setBusy(false);
    if (r.ok) onDone(describeAnswer(r.data));
    else setError(r.error ?? 'Something went wrong.');
  };

  return { busy, error, run, clearError: () => setError(null) };
}

export function ActionRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2 pt-1">{children}</div>;
}

export function ActionButton({ colors, onClick, busy, danger, children, disabled }: {
  colors: Colors; onClick: () => void; busy?: boolean; danger?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={cn(
        'inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-4 text-xs font-semibold transition-opacity disabled:opacity-50',
        colors.panelBorder,
        danger ? '' : colors.textMain,
      )}
      style={danger ? { color: '#e05252', borderColor: '#e0525266' } : undefined}
    >
      {busy && <Loader2 size={12} className="animate-spin" />}
      {children}
    </button>
  );
}

/** The brain's answer under the buttons: its refusal, word for word. */
export function ActionError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="text-xs leading-relaxed" style={{ color: '#e05252' }}>{error}</p>;
}

/** A line at the top of a room after a button worked. */
export function Notice({ colors, text, onClose }: { colors: Colors; text: string | null; onClose: () => void }) {
  if (!text) return null;
  return (
    <button onClick={onClose} className={cn('w-full rounded-xl border px-3 py-2 text-left text-xs font-semibold', colors.panelBorder, colors.textMain)} style={{ background: colors.accent + '22' }}>
      {text}
    </button>
  );
}

/** A box for new words, with Save and Cancel. */
export function EditBox({ colors, initial, label, busy, onSave, onCancel, rows = 6, saveLabel = 'Save' }: {
  colors: Colors; initial: string; label: string; busy?: boolean; rows?: number; saveLabel?: string;
  onSave: (text: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="space-y-2">
      <span className={cn('text-[11px] font-semibold', colors.textMuted)}>{label}</span>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={rows}
        className={cn('w-full resize-y rounded-xl border bg-transparent px-3 py-2 text-sm leading-relaxed outline-none', colors.panelBorder, colors.textMain)}
      />
      <ActionRow>
        <ActionButton colors={colors} busy={busy} onClick={() => onSave(text)}>{saveLabel}</ActionButton>
        <ActionButton colors={colors} onClick={onCancel}>Cancel</ActionButton>
      </ActionRow>
    </div>
  );
}
