import { useEffect, useMemo, useState } from 'react';
import { cn } from '../lib/utils';

/**
 * One paginator for the whole house.
 *
 * Every list in the phone rendered everything it had. That is fine for a week and
 * awful for a year — Identity draws every memory file, the Thresholds visit log grows
 * a row per arrival forever, and the two places that DID paginate (Cortex and Files)
 * had each rolled their own.
 *
 * Her spec: twenty a page, then numbers for the next twenty.
 *
 * Deliberately dumb about data. It takes an array and hands back a slice — no
 * fetching, no offsets, no server round trip. Every one of these lists is already
 * fully in memory by the time it renders, so paginating the DISPLAY is the whole job
 * and nothing about how the data arrives has to change.
 */
export const PAGE_SIZE = 20;

/** Slice an array for display, and keep the page in range when the array shrinks. */
export function usePaged<T>(items: T[], pageSize: number = PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  // Deleting the last item on the last page should not strand her on an empty one.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const visible = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize],
  );

  return { visible, page, setPage, pageCount, total: items.length };
}

/**
 * The numbers themselves. Renders nothing at all when there is only one page —
 * a paginator under a list of three things is clutter that says "there is more"
 * when there is not.
 *
 * Long lists get a window around the current page with the first and last always
 * reachable, so a hundred pages do not become a hundred buttons on a phone.
 */
export function Paginator({
  page,
  pageCount,
  onPage,
  colors,
  className,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  colors: { textMain: string; textMuted: string; panelBorder: string; panelBg: string; accent: string };
  className?: string;
}) {
  if (pageCount <= 1) return null;

  const numbers: (number | '…')[] = [];
  const WINDOW = 1; // pages either side of the current one
  for (let i = 1; i <= pageCount; i++) {
    const near = Math.abs(i - page) <= WINDOW;
    if (i === 1 || i === pageCount || near) {
      numbers.push(i);
    } else if (numbers[numbers.length - 1] !== '…') {
      numbers.push('…');
    }
  }

  return (
    <nav
      aria-label="Pages"
      className={cn('flex flex-wrap items-center justify-center gap-1.5 py-3', className)}
    >
      {numbers.map((n, i) =>
        n === '…' ? (
          <span key={`gap-${i}`} className={cn('px-1 text-xs', colors.textMuted)} aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={n}
            type="button"
            onClick={() => onPage(n)}
            aria-label={`Page ${n}`}
            aria-current={n === page ? 'page' : undefined}
            /* The unselected numbers used to be bare text on a hairline ring, which
               over her wallpaper read as loose digits floating on the page rather than
               as buttons. They get the same filled disc the current page has, just in
               the panel colour instead of the accent — so a row of pages reads as a
               row of pages whichever one she is standing on. */
            className={cn(
              'min-h-9 min-w-9 rounded-full border px-2.5 text-xs font-semibold backdrop-blur-md transition-colors',
              colors.panelBorder,
              n === page ? 'bytelight-on-accent' : cn(colors.panelBg, colors.textMuted),
            )}
            style={n === page ? { background: colors.accent, borderColor: colors.accent } : undefined}
          >
            {n}
          </button>
        ),
      )}
    </nav>
  );
}
