// Her rating and review of a book: stars on the cover, and a small sheet to
// write them (from the ⋯ menu's "Rate & review", or offered gently when a
// book moves to Finished). Saved with the book's shelf entry
// (PUT /api/library/books/:id/review).

import React, { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import { starLine, type BookReview } from '../lib/library-book-club';

const READER_FONT = "'Fraunces', Georgia, 'Times New Roman', serif";

/** The small star line under a cover. Nothing when unrated. */
export function ReviewStars({ review, className }: { review?: BookReview | null; className?: string }) {
  if (!review) return null;
  return (
    <span className={cn('text-[10px] tracking-[0.05em]', className)} aria-label={`${review.stars} of 5 stars`} style={{ color: 'oklch(0.75 0.15 75)' }}>
      {starLine(review.stars)}
    </span>
  );
}

export function ReviewSheet({ book, prompted = false, onSaved, onClose, themeConfig, themeMode }: {
  book: { id: number; title: string; review?: BookReview | null };
  /** Offered after moving the book to Finished: worded as an invitation, easy to wave off. */
  prompted?: boolean;
  onSaved: (review: BookReview | null) => void;
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  const [stars, setStars] = useState(book.review?.stars ?? 0);
  const [text, setText] = useState(book.review?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: { stars: number | null; text?: string }) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/library/books/${book.id}/review`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'That review could not be saved. Try again?');
      onSaved(data.book?.review ?? null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That review could not be saved. Try again?');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className={cn('w-full max-w-md rounded-t-2xl border p-4 pb-6 backdrop-blur-md', colors.panelBg, colors.panelBorder)}
        style={{ background: 'var(--bytelight-surface-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start gap-2">
          <p className={cn('flex-1 line-clamp-2 text-sm font-semibold', colors.textMain)} style={{ fontFamily: READER_FONT }}>
            {prompted ? `Finished “${book.title}”` : book.title}
          </p>
          <button onClick={onClose} className={colors.textMuted} aria-label="Close"><X size={16} /></button>
        </div>
        <p className={cn('mb-3 text-xs', colors.textMuted)}>
          {prompted ? 'How was it? Rate it if you like — or skip.' : 'Your rating and a few words, if you want them.'}
        </p>

        <div className="mb-3 flex justify-center gap-1" role="radiogroup" aria-label="Stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={stars === n}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              onClick={() => setStars(n)}
              className="px-1 text-3xl leading-none transition-transform active:scale-90"
              style={{ color: n <= stars ? 'oklch(0.75 0.15 75)' : 'color-mix(in oklch, currentColor 30%, transparent)' }}
            >
              {n <= stars ? '★' : '☆'}
            </button>
          ))}
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What stayed with you? (optional)"
          maxLength={4000}
          rows={4}
          className={cn('mb-3 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm outline-none', colors.panelBorder, colors.textMain)}
        />

        {error && <p className="mb-2 text-xs" style={{ color: colors.accent }}>{error}</p>}

        <div className="flex gap-2">
          {book.review && !prompted && (
            <button
              onClick={() => void save({ stars: null })}
              disabled={busy}
              className={cn('rounded-xl border px-3 py-2 text-xs font-semibold', colors.panelBorder, colors.textMuted)}
            >
              Clear
            </button>
          )}
          {prompted && (
            <button onClick={onClose} className={cn('rounded-xl border px-3 py-2 text-xs font-semibold', colors.panelBorder, colors.textMuted)}>
              Not now
            </button>
          )}
          <button
            onClick={() => void save({ stars, text })}
            disabled={busy || stars === 0}
            className={cn('flex flex-1 items-center justify-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold', (busy || stars === 0) && 'opacity-50')}
            style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {stars === 0 ? 'Pick your stars' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
