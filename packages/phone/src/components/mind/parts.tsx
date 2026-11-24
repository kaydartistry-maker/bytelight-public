import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Loader2, RefreshCw } from 'lucide-react';
import type { ThemeColors } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { apiFetch } from '../../bytelight';
import { brainGet, type FetchFn } from '../../lib/mind-console';
import { useBackHandler } from '../../lib/use-back-handler';

// The small pieces every Mind room is made of: the glass card, the quiet
// label, the loading / empty / error lines, and a hook that loads one brain
// door when a room opens (and only then).

export const fetchFn: FetchFn = (url, init) => apiFetch(url, init);

export type Colors = ThemeColors;

export function cardClass(colors: Colors, extra?: string) {
  return cn('rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder, extra);
}

export function Label({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return <span className={cn('text-[10px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>{children}</span>;
}

export function Loading({ colors, what }: { colors: Colors; what?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-xs', colors.textMuted)}>
      <Loader2 size={16} className="animate-spin" /> {what ? `Opening ${what}…` : 'Opening…'}
    </div>
  );
}

export function Empty({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return <div className={cn('py-8 text-center text-xs leading-relaxed', colors.textMuted)}>{children}</div>;
}

export function ErrorNote({ colors, error, onRetry }: { colors: Colors; error: string; onRetry?: () => void }) {
  return (
    <div className={cardClass(colors, 'text-xs leading-relaxed')}>
      <p style={{ color: '#e05252' }}>{error}</p>
      {onRetry && (
        <button onClick={onRetry} className={cn('mt-2 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold', colors.panelBorder, colors.textMain)}>
          <RefreshCw size={12} /> Try again
        </button>
      )}
    </div>
  );
}

export type Loaded<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T }
  | { state: 'error'; error: string };

/** Loads one brain door while the room is open. `path` null means "not yet"
 *  (a search box with nothing typed). Late answers from an older path are
 *  dropped, so a fast typist never sees stale results. */
export function useBrain<T>(path: string | null, normalize: (raw: unknown) => T): Loaded<T> & { reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  const norm = useRef(normalize);
  norm.current = normalize;

  useEffect(() => {
    if (path === null) return;
    let live = true;
    setLoaded({ state: 'loading' });
    brainGet(fetchFn, path).then((r) => {
      if (!live) return;
      setLoaded(r.ok ? { state: 'ready', data: norm.current(r.data) } : { state: 'error', error: r.error ?? '' });
    });
    return () => { live = false; };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...loaded, reload };
}

/** Long text that starts folded and opens on a tap. */
export function Folded({ text, colors, lines = 4, className }: { text: string; colors: Colors; lines?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 70 || text.split('\n').length > lines;
  return (
    <div className={className}>
      <p
        className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', colors.textMain)}
        style={!open && long ? { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : undefined}
      >
        {text}
      </p>
      {long && (
        <button onClick={() => setOpen(!open)} className={cn('mt-1 text-[11px] font-semibold', colors.textMuted)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** A small pill of text: an emotion, a weight, a status. */
export function Chip({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', colors.panelBorder, colors.textMuted)}>{children}</span>;
}

/** The small "back to the list" link at the top of a detail view. */
export function BackTo({ colors, onBack, children }: { colors: Colors; onBack: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onBack} className={cn('inline-flex min-h-[36px] items-center gap-1 text-xs font-semibold', colors.textMuted)}>
      <ChevronLeft size={14} /> {children}
    </button>
  );
}

/** Which item of a list is open. Back (the phone's own, too) closes it. */
export function useSelected<T>(): [T | null, (v: T | null) => void] {
  const [sel, setSel] = useState<T | null>(null);
  useBackHandler(sel !== null, () => setSel(null));
  return [sel, setSel];
}

/** One tappable row in a room's list: a small line of marks, then the
 *  text cut to a few lines. The full text is in the detail view. */
export function RowCard({ colors, onClick, title, marks, text, side }: {
  colors: Colors; onClick: () => void; title?: string; marks?: React.ReactNode; text: string; side?: string;
}) {
  return (
    <button onClick={onClick} className={cardClass(colors, 'block w-full text-left active:scale-[0.99] transition-transform')}>
      {(title || marks || side) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {title && <span className={cn('min-w-0 break-words text-xs font-semibold', colors.textMain)}>{title}</span>}
          {marks}
          {side && <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{side}</span>}
        </div>
      )}
      <p
        className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', colors.textMain)}
        style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
      >
        {text || 'Empty'}
      </p>
    </button>
  );
}

/** A row of pills to pick one of a few filters. */
export function Pills<T extends string>({ colors, value, options, onChange }: {
  colors: Colors; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cn('min-h-[38px] rounded-full border px-3.5 text-[11px] font-semibold', colors.panelBorder, value === o.id ? '' : cn(colors.panelBg, colors.textMuted))}
          style={value === o.id ? { background: colors.accent, borderColor: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A text box that asks on Enter or the button, not on every letter. */
export function AskBox({ colors, placeholder, initial = '', onAsk }: {
  colors: Colors; placeholder: string; initial?: string; onAsk: (q: string) => void;
}) {
  const [text, setText] = useState(initial);
  const ask = () => { if (text.trim()) onAsk(text.trim()); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="flex gap-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        enterKeyHint="search"
        className={cn('min-w-0 flex-1 rounded-xl border bg-transparent px-3 py-2.5 text-sm outline-none', colors.panelBorder, colors.textMain)}
      />
      <button type="submit" className="min-h-[44px] shrink-0 rounded-xl px-4 text-xs font-semibold" style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}>
        Look
      </button>
    </form>
  );
}

/** The full text of an item, with its marks, for a detail view. */
export function Detail({ colors, title, marks, text, children }: {
  colors: Colors; title?: string; marks?: React.ReactNode; text: string; children?: React.ReactNode;
}) {
  return (
    <div className={cardClass(colors, 'space-y-3')}>
      {title && <div className={cn('break-words text-base font-semibold', colors.textMain)}>{title}</div>}
      {marks && <div className="flex flex-wrap items-center gap-1.5">{marks}</div>}
      <p className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', colors.textMain)}>{text || 'Empty'}</p>
      {children}
    </div>
  );
}
