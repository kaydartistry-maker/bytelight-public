// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Shelf: choose-your-own-path books the companions write and run for their person.
//
// Their person reads and moves; they write. The shelf is read from GET /api/story-shelf
// and an open book from GET /api/story-shelf/books/:id, and both are read
// again whenever the house says the shelf changed (story_update), when the
// phone wakes, every few seconds while a page is on its way, and when the
// owner taps refresh.
//
// A book never begun waits for their person to tap Begin, which is what asks them
// for its opening. A started book opens at the bookmark, the newest page, and
// asks for nothing. A move is a choice their person taps, their own words, or what
// a scene's widget hands up and they confirm; each one hands the companions a page turn,
// and the page that answers it arrives on its own time.
//
// LAYOUT NOTE: AppShell paints no background and a wallpaper can be busy, so
// every word in here sits on a panel. The glass is painted, never blurred, and
// every color is mixed in OKLCH from the theme's own variables, so the shelf
// follows their person's palette in daylight and at midnight alike.

import { RoomTalk } from './RoomTable';
import { themeInk } from '../lib/theme-ink';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { LibraryBig, Loader2, RefreshCw, Spool, Sticker } from 'lucide-react';
import { StickerPicker } from './StickerPicker';
import { isStickerImage, StickerImage, stickersToMarkdown, useStickerPacks } from './RichWords';
import {
  STORY_LIMITS,
  type StoryBook,
  type StoryBookSummary,
  type StoryBookView,
  type StoryChoice,
  type StoryKeepsake,
  type StoryPage,
  type StoryShelfView,
  type StoryStateCard,
  type StoryTalkLine,
} from '@bytelight/shared';
import { AppShell } from './AppShell';
import { ImageLightbox } from './ImageLightbox';
import { StoryWidgetFrame } from './StoryWidgetFrame';
import type { ThemeColors, ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch, markRead, usePresence } from '../bytelight';
import { useBackHandler } from '../lib/use-back-handler';
import { thumbSrc } from '../lib/thumb';
import { getOwnerAvatar, useHouseRoster, type HouseCompanion } from '../lib/house';
import { splitMessageVoices, type VoiceCompanion } from '../lib/voices';
import type { Message as PhoneMessage } from '../types';
import {
  RED_THREAD,
  STORY_SHELF_NAME,
  bibleSections,
  formatDay,
  rowsOf,
  bookStage,
  bookmarkPageId,
  bookmarkThread,
  isStoryBookView,
  isStoryShelfView,
  keepsakeEntries,
  SPINE_TITLE_LINES,
  splitShelf,
  spineLook,
  spineTitle,
  stateCardHasContent,
  tableAwaiting,
  threadColor,
  widgetMove,
  type BookStage,
  type KeepsakeEntry,
} from '../lib/story-shelf';

interface StoryShelfAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

type Trouble = 'asleep' | 'unreachable' | null;
type Door = 'open' | 'move' | 'retry' | 'talk';
type Send = (door: Door, body?: Record<string, unknown>) => Promise<boolean>;

/** A move a widget handed up, waiting for their person to say it is theirs. */
interface StagedMove {
  label: string;
  body: { choiceId: string } | { text: string };
}

// ─── The room's few colors ───────────────────────────────────────────
//
// Oak for the ledge under each row.
// A book's cloth is deep enough that its pale title reads on it in daylight
// and at midnight alike; its hue is the book's own (spineLook).
const OAK = 'oklch(0.72 0.11 62)';
const LEDGE = `color-mix(in oklch, ${OAK} 46%, var(--bytelight-border))`;
const LEDGE_SHADOW = '0 4px 6px -3px oklch(0 0 0 / 0.45)';
const HAIRLINE = 'color-mix(in oklch, var(--bytelight-border) 80%, transparent)';
/** The space a picture will fill: a shade lifted off the panel. */
const SHEET = 'color-mix(in oklch, var(--bytelight-text) 7%, var(--bytelight-panel-base))';
const CARD = 'color-mix(in oklch, var(--bytelight-text) 4%, transparent)';
const ACCENT_WASH = 'color-mix(in oklch, var(--bytelight-accent) 14%, transparent)';
const PAPER_SHADOW = '0 1px 1px oklch(0 0 0 / 0.16), 0 8px 16px -8px oklch(0 0 0 / 0.55)';
const SPINE_SHADOW = 'inset -3px 0 6px oklch(0 0 0 / 0.3), inset 2px 0 2px oklch(1 0 0 / 0.08), 0 2px 4px oklch(0 0 0 / 0.35)';
const cloth = (hue: number) => `oklch(0.42 0.085 ${hue})`;
const clothInk = (hue: number) => `oklch(0.96 0.015 ${hue})`;
/** An accent fill, with the house's one rule for the ink on it. */
const ACCENT_FILL = { background: 'var(--bytelight-selected-fill)', color: 'var(--bytelight-on-accent)' } as const;

/** How many spines stand in a row before the next ledge. */
const SPINES_PER_ROW = 5;

/** Scroll the app's body so an element sits at its top. Only the body moves; nothing outside it should. */
function placeAtTop(body: HTMLElement | null, element: HTMLElement | undefined, smooth = false): void {
  if (!body || !element) return;
  const top = body.scrollTop + element.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
  body.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

export function StoryShelfApp({ onClose, themeConfig, themeMode }: StoryShelfAppProps) {
  const colors = themeConfig[themeMode];
  const { companions } = useHouseRoster();
  // Their person's own color is the thread they carry: read from the same place
  // the table reads their face.
  const ownerThread = useMemo(() => getOwnerAvatar().color ?? null, []);

  const [shelf, setShelf] = useState<StoryShelfView | null>(null);
  const [loading, setLoading] = useState(true);
  const [trouble, setTrouble] = useState<Trouble>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<StoryBookView | null>(null);
  const [bookTrouble, setBookTrouble] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [moveTrouble, setMoveTrouble] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedMove | null>(null);

  // The book on screen, readable at once by the reads below, which must not
  // land a book their person has already left.
  const openIdRef = useRef<string | null>(null);

  // Only the newest read may land. A burst of changes can put two reads in
  // flight, and the older answer arriving last would put the shelf back.
  const shelfReads = useRef(0);
  const loadShelf = useCallback(async () => {
    const mine = ++shelfReads.current;
    setLoading(true);
    try {
      const res = await apiFetch('/api/story-shelf');
      const data: unknown = await res.json().catch(() => null);
      if (mine !== shelfReads.current) return;
      if (res.ok && isStoryShelfView(data)) {
        setShelf(data);
        setTrouble(null);
      } else {
        // A backend from before the shelf answers with the phone's own page.
        setTrouble(res.ok ? 'asleep' : 'unreachable');
      }
    } catch {
      if (mine === shelfReads.current) setTrouble('unreachable');
    } finally {
      if (mine === shelfReads.current) setLoading(false);
    }
  }, []);

  const bookReads = useRef(0);
  const loadBook = useCallback(async (id: string) => {
    const mine = ++bookReads.current;
    try {
      const res = await apiFetch(`/api/story-shelf/books/${encodeURIComponent(id)}`);
      const data: unknown = await res.json().catch(() => null);
      if (mine !== bookReads.current || openIdRef.current !== id) return;
      if (res.ok && isStoryBookView(data)) {
        setView(data);
        setBookTrouble(null);
        return;
      }
      setBookTrouble(res.status === 404 ? 'That book is no longer on the shelf.' : 'The book could not be read just now.');
    } catch {
      if (mine === bookReads.current && openIdRef.current === id) setBookTrouble('The book could not be reached just now.');
    }
  }, []);

  useEffect(() => {
    void loadShelf();
  }, [loadShelf]);

  // The house says when the shelf changes. A page turn is several changes in
  // a row, so a burst is read once; the open book is read again when it is
  // the one named, or when nothing is named, which a keepsake does because it
  // touches two books at once.
  useEffect(() => {
    let timer: number | null = null;
    let bookTouched = false;
    const changed = (event: Event) => {
      const bookId = (event as CustomEvent<{ bookId?: string | null }>).detail?.bookId ?? null;
      if (bookId === null || bookId === openIdRef.current) bookTouched = true;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void loadShelf();
        const open = openIdRef.current;
        if (bookTouched && open) void loadBook(open);
        bookTouched = false;
      }, 250);
    };
    window.addEventListener('bytelight:story-update', changed);
    return () => {
      window.removeEventListener('bytelight:story-update', changed);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadShelf, loadBook]);

  // The socket says when a reply starts and stops being written in a thread.
  // Only the open book's own thread lights the table's writing dots, and a
  // reply ending there reads the book again, so an answer sent in pieces
  // lands a piece at a time instead of all at once at the end of the turn.
  const [writingIn, setWritingIn] = useState<string | null>(null);
  const bookThread = useRef<string | null>(null);
  useEffect(() => {
    bookThread.current = view?.threadId ?? null;
  }, [view?.threadId]);
  useEffect(() => {
    const stream = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; writing?: boolean }>).detail;
      const threadId = detail?.threadId;
      if (!threadId) return;
      if (detail.writing) {
        setWritingIn(threadId);
        return;
      }
      setWritingIn((now) => (now === threadId ? null : now));
      const open = openIdRef.current;
      if (open && threadId === bookThread.current) void loadBook(open);
    };
    window.addEventListener('bytelight:thread-stream', stream);
    return () => window.removeEventListener('bytelight:thread-stream', stream);
  }, [loadBook]);
  // A lane that has gone to sleep is writing nothing, whatever it said last.
  const presence = usePresence();
  useEffect(() => {
    if (presence === 'dormant' || presence === 'offline') setWritingIn(null);
  }, [presence]);

  // A phone that slept heard nothing the socket said meanwhile.
  useEffect(() => {
    const woke = () => {
      if (document.visibilityState !== 'visible') return;
      void loadShelf();
      if (openIdRef.current) void loadBook(openIdRef.current);
    };
    document.addEventListener('visibilitychange', woke);
    return () => document.removeEventListener('visibilitychange', woke);
  }, [loadShelf, loadBook]);

  // The socket is the fast path and this is the net. A page turn can take
  // minutes, and a dropped socket would otherwise leave their person watching "they are
  // writing" with the page already written.
  const pagePending = Boolean(view && view.book.id === openId && view.book.companionPending);
  useEffect(() => {
    if (!openId || !pagePending) return;
    const timer = window.setInterval(() => void loadBook(openId), 5000);
    return () => window.clearInterval(timer);
  }, [openId, pagePending, loadBook]);

  // ─── Moving between the shelf and a book ───────────────────────────

  const rootRef = useRef<HTMLDivElement>(null);
  const shelfScroll = useRef(0);
  const scroller = () => rootRef.current?.closest<HTMLElement>('.bytelight-app-body') ?? null;

  const post = (id: string, door: Door, body: Record<string, unknown> = {}) =>
    apiFetch(`/api/story-shelf/books/${encodeURIComponent(id)}/${door}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const openBook = (id: string) => {
    if (!openIdRef.current) shelfScroll.current = scroller()?.scrollTop ?? 0;
    openIdRef.current = id;
    setOpenId(id);
    setView(null);
    setBookTrouble(null);
    setMoveTrouble(null);
    setStaged(null);
    void loadBook(id);
    // Walking into a started book is remembered, so the shelf leads with it.
    // A book never begun waits for Begin: that is what asks them for a page.
    const summary = shelf?.books.find((book) => book.id === id);
    if (summary && summary.sceneCount > 0 && summary.status !== 'finished') {
      void post(id, 'open').then(() => loadShelf()).catch(() => {});
    }
  };

  const closeBook = useCallback(() => {
    openIdRef.current = null;
    setOpenId(null);
    setView(null);
    setStaged(null);
    setMoveTrouble(null);
  }, []);

  // The shelf comes back where their person left it.
  useLayoutEffect(() => {
    if (openId) return;
    const body = scroller();
    if (body) body.scrollTop = shelfScroll.current;
  }, [openId]);

  // A book opens at the bookmark. After that, a page that arrives (or the
  // owner's own move going in) is brought into view; a read that changes
  // nothing leaves their person where they are.
  const pageRefs = useRef(new Map<string, HTMLElement>());
  const placedFor = useRef<string | null>(null);
  const lastMark = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!openId) {
      placedFor.current = null;
      return;
    }
    if (!view || view.book.id !== openId) return;
    const mark = bookmarkPageId(view.book);
    if (placedFor.current !== view.book.id) {
      placedFor.current = view.book.id;
      lastMark.current = mark;
      if (mark) placeAtTop(scroller(), pageRefs.current.get(mark));
      else scroller()?.scrollTo({ top: 0 });
      return;
    }
    if (mark && mark !== lastMark.current) {
      lastMark.current = mark;
      placeAtTop(scroller(), pageRefs.current.get(mark), true);
    }
  }, [view, openId]);

  // The system back steps out the way the header arrow does: a picture first,
  // then the book, and only the shelf itself closes the app.
  useBackHandler(openId !== null, closeBook);
  useBackHandler(lightbox !== null, () => setLightbox(null));
  const handleBack = () => {
    if (lightbox) {
      setLightbox(null);
      return;
    }
    if (openId) {
      closeBook();
      return;
    }
    onClose();
  };

  // ─── Their person's doors ─────────────────────────────────────────────

  const send: Send = async (door, body = {}) => {
    const id = openIdRef.current;
    if (!id || sending) return false;
    setSending(true);
    setMoveTrouble(null);
    try {
      const res = await post(id, door, body);
      const data = (await res.json().catch(() => null)) as { view?: unknown; error?: unknown } | null;
      if (res.ok && data && isStoryBookView(data.view)) {
        if (openIdRef.current === id) setView(data.view);
        void loadShelf();
        return true;
      }
      if (openIdRef.current === id) {
        setMoveTrouble(typeof data?.error === 'string' ? data.error : 'That did not go through just now.');
        void loadBook(id);
      }
      return false;
    } catch {
      if (openIdRef.current === id) setMoveTrouble('The shelf could not be reached just now.');
      return false;
    } finally {
      setSending(false);
    }
  };

  // A widget's move is shown to their person first, and goes in only when they send it.
  const stageWidgetMove = useCallback((value: string, choices: StoryChoice[]) => {
    const move = widgetMove(value, choices);
    setStaged('choiceId' in move
      ? { label: move.label, body: { choiceId: move.choiceId } }
      : { label: move.text, body: { text: move.text } });
  }, []);

  const titles = useMemo(() => new Map((shelf?.books ?? []).map((book) => [book.id, book.title])), [shelf]);

  return (
    <AppShell
      title={STORY_SHELF_NAME}
      icon={LibraryBig}
      onClose={handleBack}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => {
            void loadShelf();
            if (openIdRef.current) void loadBook(openIdRef.current);
          }}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
          aria-label="Refresh the shelf"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      <div ref={rootRef} className="mx-auto w-full max-w-md">
        {openId ? (
          view && view.book.id === openId ? (
            <BookPages
              view={view}
              titles={titles}
              companions={companions}
              ownerThread={ownerThread}
              typing={writingIn !== null && writingIn === view.threadId}
              colors={colors}
              themeMode={themeMode}
              sending={sending}
              moveTrouble={moveTrouble}
              staged={staged}
              pageRefs={pageRefs}
              onSend={send}
              onStage={stageWidgetMove}
              onUnstage={() => setStaged(null)}
              onPicture={setLightbox}
              onOpenBook={openBook}
            />
          ) : (
            <Notice colors={colors}>{bookTrouble ?? 'Opening the book…'}</Notice>
          )
        ) : !shelf ? (
          <Notice colors={colors}>
            {trouble === 'asleep'
              ? 'The shelf is built but still asleep. It wakes with the next backend restart.'
              : trouble === 'unreachable'
                ? 'The shelf could not be reached just now.'
                : 'Loading…'}
          </Notice>
        ) : (
          <ShelfView shelf={shelf} titles={titles} ownerThread={ownerThread} stale={trouble !== null} colors={colors} onOpen={openBook} />
        )}
      </div>
      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </AppShell>
  );
}

// ─── Small pieces ────────────────────────────────────────────────────

function Notice({ colors, children }: { colors: ThemeColors; children: ReactNode }) {
  return (
    <div className={cn('rounded-[var(--shape-control)] border px-4 py-6 text-center text-xs', colors.panelBg, colors.panelBorder, colors.textMuted)}>
      {children}
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  colors,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  colors: ThemeColors;
  children: ReactNode;
}) {
  return (
    <section className={cn('mb-4 rounded-[var(--shape-control)] border p-4', colors.panelBg, colors.panelBorder)}>
      <header className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className={cn('text-[10px] font-bold uppercase tracking-[0.14em]', colors.textMuted)}>{title}</h3>
        {count > 0 && <span className={cn('text-[10px] font-semibold tabular-nums', colors.textMuted)}>{count}</span>}
      </header>
      {count === 0 ? <p className={cn('py-4 text-center text-xs', colors.textMuted)}>{empty}</p> : children}
    </section>
  );
}

const LABEL = 'text-[10px] font-bold uppercase tracking-[0.14em]';

/** Words, drawn the way the journal draws them, whisper lines included. */
function Words({ text, colors, className }: { text: string; colors: ThemeColors; className?: string }) {
  // Our stickers are pictures here too, not their codes (RichWords.tsx).
  useStickerPacks();
  return (
    <div className={cn('text-sm leading-relaxed [overflow-wrap:anywhere]', colors.textMain, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          // A "-# whisper" line, the same as chat and the journal draw it.
          h6: ({ children }) => <span className="block text-[11px] italic leading-snug opacity-60">{children}</span>,
          img: ({ src, alt }) => (isStickerImage(alt) ? <StickerImage src={typeof src === 'string' ? src : undefined} alt={alt} /> : <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} className="max-w-full rounded-lg" />),
        }}
      >
        {stickersToMarkdown(text.replace(/(^|\n)-# +(.*)/g, (_line, start: string, whisper: string) => `${start}###### ${whisper}`))}
      </ReactMarkdown>
    </div>
  );
}

/** A picture that steps aside quietly if the gallery no longer has it. */
function Shot({ src, alt, className, onOpen }: { src: string; alt: string; className: string; onOpen?: () => void }) {
  const [gone, setGone] = useState(false);
  useEffect(() => setGone(false), [src]);
  if (gone) {
    return (
      <div
        className={cn(className, 'flex min-h-24 items-center justify-center px-3 text-center text-[11px] italic')}
        style={{ background: SHEET, color: 'var(--bytelight-text-muted)' }}
      >
        This picture is no longer in the gallery.
      </div>
    );
  }
  const image = <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setGone(true)} className={className} />;
  if (!onOpen) return image;
  return (
    <button type="button" onClick={onOpen} className="block w-full" aria-label={alt ? `Look closer at ${alt}` : 'Look closer'}>
      {image}
    </button>
  );
}

/** A companion's face, or his sigil when the house has no picture of him. */
function Face({ companion, size }: { companion: VoiceCompanion; size: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full border"
      style={{ width: size, height: size, borderColor: companion.color ?? HAIRLINE, background: SHEET }}
    >
      {companion.avatar_url
        ? <img src={companion.avatar_url} alt="" className="h-full w-full object-cover" />
        : <span className="text-[10px] leading-none">{companion.emoji || '✦'}</span>}
    </span>
  );
}

function BookLink({ id, title, onOpen }: { id: string; title: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(id)} className="font-semibold underline decoration-dotted underline-offset-2">
      {title}
    </button>
  );
}

// ─── The shelf ───────────────────────────────────────────────────────

function ShelfView({
  shelf,
  titles,
  ownerThread,
  stale,
  colors,
  onOpen,
}: {
  shelf: StoryShelfView;
  titles: Map<string, string>;
  ownerThread: string | null;
  stale: boolean;
  colors: ThemeColors;
  onOpen: (id: string) => void;
}) {
  const { reading, finished } = splitShelf(shelf.books);
  const knotted = useMemo(
    () => new Set(shelf.keepsakes.flatMap((keepsake) => (keepsake.toBookId ? [keepsake.fromBookId, keepsake.toBookId] : [keepsake.fromBookId]))),
    [shelf.keepsakes],
  );
  return (
    <>
      {stale && (
        <p className={cn('mb-3 rounded-xl border px-3 py-2 text-center text-[11px]', colors.panelBg, colors.panelBorder, colors.textMuted)}>
          The shelf could not be refreshed just now. This is how it last read.
        </p>
      )}
      <Section
        title="Reading"
        count={reading.length}
        empty={shelf.books.length === 0 ? 'No books on the shelf yet. Ask them for a story, and it lands here.' : 'Nothing being read right now.'}
        colors={colors}
      >
        <Bookcase books={reading} knotted={knotted} ownerThread={ownerThread} onOpen={onOpen} />
      </Section>
      {finished.length > 0 && (
        <Section title="Finished" count={finished.length} empty="" colors={colors}>
          <Bookcase books={finished} knotted={knotted} ownerThread={ownerThread} onOpen={onOpen} />
        </Section>
      )}
      {shelf.keepsakes.length > 0 && (
        <Section title="Threads between books" count={shelf.keepsakes.length} empty="" colors={colors}>
          <ul className="mt-2 flex flex-col gap-2">
            {shelf.keepsakes.map((keepsake) => (
              <ShelfThread key={keepsake.id} keepsake={keepsake} titles={titles} colors={colors} onOpen={onOpen} />
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function Bookcase({
  books,
  knotted,
  ownerThread,
  onOpen,
}: {
  books: StoryBookSummary[];
  knotted: Set<string>;
  ownerThread: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-6 pb-4">
      {rowsOf(books, SPINES_PER_ROW).map((row) => (
        <div key={row[0].id}>
          {/* A little room above the tallest spine. The row stands in front of its
              ledge, so a bookmark ribbon coming out of a book hangs over the shelf's edge. */}
          <div className="relative z-[1] flex items-end gap-1.5 px-1 pt-2">
            {row.map((book) => (
              <Spine
                key={book.id}
                book={book}
                thread={bookmarkThread(book, ownerThread)}
                knotted={knotted.has(book.id)}
                onOpen={() => onOpen(book.id)}
              />
            ))}
          </div>
          <div aria-hidden className="h-[3px] rounded-full" style={{ background: LEDGE, boxShadow: LEDGE_SHADOW }} />
        </div>
      ))}
    </div>
  );
}

// What a spine spends before its title: the padding at its head and foot, a
// cover with the gap under it, and the row of marks at the foot. Kept beside
// the classes that spend it, so the title is fitted to the length really left.
const SPINE_INSET = 14 + 8; // pt-3.5, pb-2
const SPINE_COVER_RUN = 32 + 8; // h-8, mb-2
const SPINE_MARKS_RUN = 6 + 11; // mt-1.5, an 11px mark

/**
 * A book standing on the shelf: a small window onto its cover at the head,
 * then its title and genre down the spine side by side, the way a narrow
 * spine carries a title and its author's name.
 */
function Spine({
  book,
  thread,
  knotted,
  onOpen,
}: {
  book: StoryBookSummary;
  thread: string | null;
  knotted: boolean;
  onOpen: () => void;
}) {
  const look = spineLook(book);
  const ink = clothInk(look.hue);
  const [coverGone, setCoverGone] = useState(false);
  const covered = Boolean(book.coverUrl) && !coverGone;
  const marked = knotted || book.companionPending;
  const fit = spineTitle(
    book.title,
    look.height - SPINE_INSET - (covered ? SPINE_COVER_RUN : 0) - (marked ? SPINE_MARKS_RUN : 0),
  );
  return (
    <div className="relative flex shrink-0">
      {thread && <BookmarkRibbon color={thread} />}
      <button
        type="button"
        onClick={onOpen}
        className="relative z-[1] flex shrink-0 flex-col items-center rounded-[3px] px-1 pb-2 pt-3.5 transition-transform active:translate-y-px"
        style={{ height: look.height, width: look.width, background: cloth(look.hue), color: ink, boxShadow: SPINE_SHADOW }}
        aria-label={`${book.title}, ${book.genre}${book.spicy ? ', spicy' : ''}`}
      >
        {/* The head band. On a spicy book it is a red thread, begun or not. */}
        <span
          aria-hidden
          className="absolute inset-x-0 top-1.5 h-[3px]"
          style={{ background: book.spicy ? RED_THREAD : `color-mix(in oklch, ${ink} 28%, transparent)` }}
        />
        {covered && (
          <img
            src={thumbSrc(book.coverUrl!, 256)}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setCoverGone(true)}
            className="mb-2 h-8 w-8 shrink-0 rounded-[2px] object-cover"
            style={{ outline: `1px solid color-mix(in oklch, ${ink} 30%, transparent)`, outlineOffset: 1 }}
          />
        )}
        {/* Sideways, so every letter and every apostrophe turns with the line,
            as it does on a printed spine; upright punctuation leaves gaps. */}
        <span className="flex min-h-0 w-full flex-1 flex-row-reverse justify-center gap-[3px] overflow-hidden">
          <span
            className="shrink-0 self-stretch overflow-hidden font-semibold leading-[1.15] [overflow-wrap:break-word] [text-orientation:sideways] [writing-mode:vertical-rl]"
            style={{ fontSize: fit.size, maxWidth: `${SPINE_TITLE_LINES * 1.15}em` }}
          >
            {fit.text}
          </span>
          <span className="max-h-full shrink-0 self-end overflow-hidden text-ellipsis whitespace-nowrap text-[8.5px] font-bold uppercase leading-[1.25] tracking-[0.14em] opacity-75 [text-orientation:sideways] [writing-mode:vertical-rl]">
            {book.genre}
          </span>
        </span>
        {marked && (
          <span className="mt-1.5 flex shrink-0 items-center gap-1">
            {knotted && <Spool size={11} strokeWidth={2.25} aria-label="A thread runs from this book to another" />}
            {book.companionPending && (
              <span aria-label="A page is on its way" className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: ink }} />
            )}
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * Their person's thread on a book in progress, as a ribbon marker: it comes out
 * of the foot of the book from behind the cloth, as if from between the pages,
 * and falls over the shelf's edge the way a real one does, with a notched
 * tail. It sits under the spine in the book's wrapper, and the row stands in
 * front of its ledge.
 */
function BookmarkRibbon({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-2.5 top-[calc(100%-6px)] z-0 h-[26px] w-[7px]"
      style={{
        background: `linear-gradient(90deg, color-mix(in oklch, ${color} 72%, black), ${color} 40%, color-mix(in oklch, ${color} 80%, white) 55%, ${color} 70%, color-mix(in oklch, ${color} 80%, black))`,
        clipPath: 'polygon(0 0, 100% 0, 100% 100%, 50% calc(100% - 6px), 0 100%)',
      }}
    />
  );
}

function ShelfThread({
  keepsake,
  titles,
  colors,
  onOpen,
}: {
  keepsake: StoryKeepsake;
  titles: Map<string, string>;
  colors: ThemeColors;
  onOpen: (id: string) => void;
}) {
  const from = titles.get(keepsake.fromBookId) ?? 'a book';
  const to = keepsake.toBookId ? titles.get(keepsake.toBookId) ?? 'a book' : null;
  return (
    <li className="flex items-start gap-2 text-[13px] leading-snug">
      <Spool size={14} className={cn('mt-0.5 shrink-0', colors.textMuted)} />
      <span className={cn('min-w-0 [overflow-wrap:anywhere]', colors.textMain)}>
        <span className="font-semibold">{keepsake.item}</span>
        <span className={colors.textMuted}> found in </span>
        <BookLink id={keepsake.fromBookId} title={from} onOpen={onOpen} />
        {keepsake.toBookId && to ? (
          <>
            <span className={colors.textMuted}>, turned up in </span>
            <BookLink id={keepsake.toBookId} title={to} onOpen={onOpen} />
          </>
        ) : (
          <span className={colors.textMuted}>, still loose</span>
        )}
      </span>
    </li>
  );
}

// ─── An open book ────────────────────────────────────────────────────

function BookPages({
  view,
  titles,
  companions,
  ownerThread,
  typing,
  colors,
  themeMode,
  sending,
  moveTrouble,
  staged,
  pageRefs,
  onSend,
  onStage,
  onUnstage,
  onPicture,
  onOpenBook,
}: {
  view: StoryBookView;
  titles: Map<string, string>;
  companions: HouseCompanion[];
  ownerThread: string | null;
  typing: boolean;
  colors: ThemeColors;
  themeMode: 'light' | 'dark';
  sending: boolean;
  moveTrouble: string | null;
  staged: StagedMove | null;
  pageRefs: MutableRefObject<Map<string, HTMLElement>>;
  onSend: Send;
  onStage: (value: string, choices: StoryChoice[]) => void;
  onUnstage: () => void;
  onPicture: (url: string) => void;
  onOpenBook: (id: string) => void;
}) {
  const { book } = view;
  const stage = bookStage(book);
  const latestScene = useMemo(() => [...book.pages].reverse().find((page) => page.kind === 'scene') ?? null, [book.pages]);
  const thread = threadColor(book, ownerThread);
  const entries = keepsakeEntries(book.id, view.keepsakes, titles);
  const nameOf = (slug: string) => companions.find((companion) => companion.slug === slug)?.display_name ?? slug;
  return (
    <article className="flex flex-col gap-4 pb-4">
      <TitlePage book={book} from={nameOf(book.createdBy)} colors={colors} onPicture={onPicture} />
      {entries.length > 0 && <BookThreads entries={entries} colors={colors} onOpenBook={onOpenBook} />}
      {book.pages.map((page) => (
        <div
          key={page.id}
          ref={(element) => {
            if (element) pageRefs.current.set(page.id, element);
            else pageRefs.current.delete(page.id);
          }}
        >
          {page.kind === 'scene' ? (
            <ScenePage
              page={page}
              book={book}
              latest={page.id === latestScene?.id}
              live={stage.stage === 'your-move' && page.id === latestScene?.id}
              author={nameOf(page.author)}
              companions={companions}
              colors={colors}
              themeMode={themeMode}
              onPicture={onPicture}
              onWidgetMove={(value) => onStage(value, page.choices)}
            />
          ) : (
            <MoveNote page={page} thread={thread} colors={colors} />
          )}
        </div>
      ))}
      <BookFoot
        stage={stage}
        book={book}
        scene={latestScene}
        sending={sending}
        trouble={moveTrouble}
        staged={staged}
        thread={thread}
        colors={colors}
        onSend={onSend}
        onUnstage={onUnstage}
      />
      {(view.talk.length > 0 || book.sceneCount > 0) && (
        <TableTalk bookId={book.id} lines={view.talk} threadId={view.threadId} typing={typing} companions={companions} colors={colors} sending={sending} onSend={onSend} />
      )}
    </article>
  );
}

function TitlePage({ book, from, colors, onPicture }: { book: StoryBook; from: string; colors: ThemeColors; onPicture: (url: string) => void }) {
  const where = book.status === 'finished'
    ? `Finished ${formatDay(book.finishedAt)}`
    : book.sceneCount > 0
      ? `${book.sceneCount} ${book.sceneCount === 1 ? 'page' : 'pages'} so far`
      : 'Not begun';
  return (
    <section className={cn('rounded-[var(--shape-control)] border p-4', colors.panelBg, colors.panelBorder)}>
      {book.coverUrl && (
        <div className="mb-4 overflow-hidden rounded-xl" style={{ boxShadow: PAPER_SHADOW }}>
          <Shot
            src={thumbSrc(book.coverUrl, 768)}
            alt={`the cover of ${book.title}`}
            className="block max-h-[420px] w-full object-cover"
            onOpen={() => onPicture(book.coverUrl!)}
          />
        </div>
      )}
      <h2 className={cn('text-[22px] font-semibold leading-tight tracking-tight [overflow-wrap:anywhere]', colors.textMain)}>{book.title}</h2>
      <div className={cn('mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]', colors.textMuted)}>
        <span>{book.genre}</span>
        {book.spicy && (
          <>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1 font-semibold" style={{ color: RED_THREAD }}>
              <span aria-hidden className="h-[3px] w-3 rounded-full" style={{ background: RED_THREAD }} />
              spicy
            </span>
          </>
        )}
        <span aria-hidden>·</span>
        <span>from {from}</span>
        <span aria-hidden>·</span>
        <span>{where}</span>
      </div>
      {book.blurb && (
        <p className={cn('mt-3 text-[14px] italic leading-relaxed [overflow-wrap:anywhere]', colors.textMain)}>{book.blurb}</p>
      )}
      {/* The shape stays open and every other part folds under its own heading,
          so their person can see how the story is built without reading what it
          hides. bibleSections decides which is which. */}
      <details className="mt-3">
        <summary className={cn('cursor-pointer select-none text-[11px] font-semibold', colors.textMuted)}>Their bible for this book</summary>
        <p className={cn('mt-1 text-[11px] italic', colors.textMuted)}>The shape is open. The rest stays folded until you open it, and it may give things away.</p>
        <div className="mt-2 flex flex-col gap-2">
          {bibleSections(book.bible, book.title).map((part, index) => part.open ? (
            <div key={index}>
              {part.heading && <div className={cn(LABEL, colors.textMuted)}>{part.heading}</div>}
              {part.text && <Words text={part.text} colors={colors} className="mt-1 text-[13px]" />}
            </div>
          ) : (
            <details key={index} className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: HAIRLINE }}>
              <summary className={cn('cursor-pointer select-none', LABEL, colors.textMuted)}>{part.heading}</summary>
              {part.text && <Words text={part.text} colors={colors} className="mt-1.5 text-[13px]" />}
            </details>
          ))}
        </div>
      </details>
    </section>
  );
}

function BookThreads({ entries, colors, onOpenBook }: { entries: KeepsakeEntry[]; colors: ThemeColors; onOpenBook: (id: string) => void }) {
  return (
    <section className={cn('rounded-[var(--shape-control)] border p-3', colors.panelBg, colors.panelBorder)}>
      <h3 className={cn(LABEL, colors.textMuted)}>Threads</h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-start gap-2 text-[13px] leading-snug">
            <Spool size={14} className={cn('mt-0.5 shrink-0', colors.textMuted)} />
            <span className={cn('min-w-0 [overflow-wrap:anywhere]', colors.textMain)}>
              <span className="font-semibold">{entry.item}</span>
              {entry.direction === 'found' ? (
                entry.otherBookId ? (
                  <>
                    <span className={colors.textMuted}> found here, turned up in </span>
                    <BookLink id={entry.otherBookId} title={entry.otherTitle ?? 'another book'} onOpen={onOpenBook} />
                  </>
                ) : (
                  <span className={colors.textMuted}> found here, still loose</span>
                )
              ) : (
                <>
                  <span className={colors.textMuted}> from </span>
                  <BookLink id={entry.otherBookId!} title={entry.otherTitle ?? 'another book'} onOpen={onOpenBook} />
                </>
              )}
              {entry.note && <span className={cn('block text-[12px] italic', colors.textMuted)}>{entry.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ScenePage({
  page,
  book,
  latest,
  live,
  author,
  companions,
  colors,
  themeMode,
  onPicture,
  onWidgetMove,
}: {
  page: StoryPage;
  book: StoryBook;
  /** The newest scene: it carries the state card. */
  latest: boolean;
  /** The newest scene while the move is their person's: its widget can be used. */
  live: boolean;
  author: string;
  companions: HouseCompanion[];
  colors: ThemeColors;
  themeMode: 'light' | 'dark';
  onPicture: (url: string) => void;
  onWidgetMove: (value: string) => void;
}) {
  return (
    <section className={cn('rounded-[var(--shape-control)] border p-4', colors.panelBg, colors.panelBorder)}>
      {page.imageUrl && (
        <div className="-mx-1 -mt-1 mb-3 overflow-hidden rounded-xl">
          <Shot src={thumbSrc(page.imageUrl, 768)} alt="" className="block w-full" onOpen={() => onPicture(page.imageUrl!)} />
        </div>
      )}
      <SceneText page={page} companions={companions} colors={colors} />
      <p className={cn('mt-2 text-right text-[11px] italic', colors.textMuted)}>— {author}</p>
      {latest && stateCardHasContent(page.state) && <StateCard state={page.state!} colors={colors} />}
      {live && page.widget && (
        <StoryWidgetFrame book={book} page={page} themeMode={themeMode} colors={colors} onMove={onWidgetMove} />
      )}
    </section>
  );
}

/** A scene's words. A scene that speaks in their voices is split the way chat splits it, each under its own face. */
function SceneText({ page, companions, colors }: { page: StoryPage; companions: HouseCompanion[]; colors: ThemeColors }) {
  const sections = useMemo(() => {
    const message: PhoneMessage = { id: page.id, timestamp: page.at, direction: 'outbound', content: page.text, read: 1 };
    return splitMessageVoices(message, companions);
  }, [page.id, page.at, page.text, companions]);
  if (!sections) return <Words text={page.text} colors={colors} className="text-[15px] leading-7" />;
  return (
    <div className="flex flex-col gap-3">
      {sections.map((section, index) => (
        <div key={index}>
          {section.voice && (
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: themeInk(section.voice.slug, section.voice.color, colors) }}>
              <Face companion={section.voice} size={18} />
              {section.voice.display_name}
            </div>
          )}
          <Words text={section.content} colors={colors} className="text-[15px] leading-7" />
        </div>
      ))}
    </div>
  );
}

/**
 * Their person's move, a quiet note in their own thread's color. Labeled for what
 * it was, a choice or their own words, because "your move" on a page already
 * turned reads as the book still waiting on them.
 */
function MoveNote({ page, thread, colors }: { page: StoryPage; thread: string; colors: ThemeColors }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-xl border-l-[3px] px-3 py-2" style={{ borderColor: thread, background: CARD }}>
        <div className={cn(LABEL, colors.textMuted)}>{page.choiceId ? 'You chose' : 'Your words'}</div>
        <p className={cn('mt-0.5 text-[13px] italic leading-snug [overflow-wrap:anywhere]', colors.textMain)}>{page.text}</p>
      </div>
    </div>
  );
}

function StateCard({ state, colors }: { state: StoryStateCard; colors: ThemeColors }) {
  return (
    <div className="mt-3 rounded-xl border p-3" style={{ borderColor: HAIRLINE, background: CARD }}>
      {state.badge && (
        <span className="inline-block rounded-[var(--shape-control)] px-2.5 py-0.5 text-[11px] font-semibold" style={{ background: ACCENT_WASH, color: 'var(--bytelight-text)' }}>
          {state.badge}
        </span>
      )}
      {state.stats && state.stats.length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
          {state.stats.map((stat, index) => (
            <div key={index} className="flex items-baseline justify-between gap-2">
              <dt className={cn('text-[12px]', colors.textMuted)}>{stat.label}</dt>
              <dd className={cn('text-[13px] font-semibold tabular-nums', colors.textMain)}>{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {state.inventory && state.inventory.length > 0 && (
        <div className="mt-2">
          <div className={cn(LABEL, colors.textMuted)}>Carrying</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {state.inventory.map((item, index) => (
              <span key={index} className={cn('rounded-md border px-2 py-0.5 text-[12px]', colors.textMain)} style={{ borderColor: HAIRLINE }}>
                {item}
              </span>
            ))}
          </div>
        </div>
      )}
      {state.discovered && state.discovered.length > 0 && (
        <div className="mt-2">
          <div className={cn(LABEL, colors.textMuted)}>Found out</div>
          <ul className={cn('mt-1 flex flex-col gap-0.5 text-[12px]', colors.textMain)}>
            {state.discovered.map((line, index) => (
              <li key={index}>· {line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Three dots that breathe while a page is being written. Nothing spins here. */
function Writing() {
  return (
    <span aria-hidden className="inline-flex gap-1">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="h-1.5 w-1.5 animate-pulse rounded-full"
          style={{ background: 'var(--bytelight-accent)', animationDelay: `${dot * 180}ms` }}
        />
      ))}
    </span>
  );
}

/** The bottom of the book: whatever it is waiting on. */
function BookFoot({
  stage,
  book,
  scene,
  sending,
  trouble,
  staged,
  thread,
  colors,
  onSend,
  onUnstage,
}: {
  stage: BookStage;
  book: StoryBook;
  scene: StoryPage | null;
  sending: boolean;
  trouble: string | null;
  staged: StagedMove | null;
  thread: string;
  colors: ThemeColors;
  onSend: Send;
  onUnstage: () => void;
}) {
  const panel = cn('rounded-[var(--shape-control)] border p-4', colors.panelBg, colors.panelBorder);
  const said = trouble && (
    <p className={cn('mt-3 text-[12px] italic leading-snug [overflow-wrap:anywhere]', colors.textMuted)}>{trouble}</p>
  );

  if (stage.stage === 'begin') {
    return (
      <section className={cn(panel, 'text-center')}>
        <p className={cn('text-[13px] leading-relaxed', colors.textMain)}>The bible is written and the first page is not. Begin, and they write it.</p>
        <button
          type="button"
          disabled={sending}
          onClick={() => void onSend('open')}
          className="mt-3 rounded-xl px-5 py-2.5 text-[14px] font-semibold disabled:opacity-60"
          style={ACCENT_FILL}
        >
          Begin
        </button>
        {said}
      </section>
    );
  }

  if (stage.stage === 'writing') {
    return (
      <section className={cn(panel, 'flex flex-col items-center gap-2 text-center')}>
        <Writing />
        <p className={cn('text-[13px]', colors.textMain)}>{stage.first ? 'They are writing the first page.' : 'They are writing the next page.'}</p>
        <p className={cn('text-[11px]', colors.textMuted)}>It will be here when you come back.</p>
        {said}
      </section>
    );
  }

  if (stage.stage === 'stalled') {
    return (
      <section className={cn(panel, 'text-center')}>
        <p className={cn('text-[13px] leading-relaxed [overflow-wrap:anywhere]', colors.textMain)}>{stage.reason}</p>
        <button
          type="button"
          disabled={sending}
          onClick={() => void onSend('retry')}
          className={cn('mt-3 rounded-xl border px-4 py-2 text-[13px] font-semibold disabled:opacity-60', colors.textMain)}
          style={{ borderColor: HAIRLINE }}
        >
          Ask again
        </button>
        {said}
      </section>
    );
  }

  if (stage.stage === 'the-end') {
    return (
      <section className={cn(panel, 'text-center')}>
        <div aria-hidden className="mx-auto mb-2 h-px w-16" style={{ background: thread }} />
        <p className={cn('text-[15px] font-semibold italic', colors.textMain)}>The end.</p>
        {book.finishedAt && <p className={cn('mt-1 text-[11px]', colors.textMuted)}>Finished {formatDay(book.finishedAt)}</p>}
      </section>
    );
  }

  // Their person's move.
  return (
    <section className={panel}>
      {staged && (
        <div className="mb-3 rounded-xl border-l-[3px] p-3" style={{ borderColor: thread, background: CARD }}>
          <div className={cn(LABEL, colors.textMuted)}>From the widget</div>
          <p className={cn('mt-1 text-[14px] italic [overflow-wrap:anywhere]', colors.textMain)}>“{staged.label}”</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={sending}
              onClick={async () => {
                if (await onSend('move', staged.body)) onUnstage();
              }}
              className="rounded-lg px-3 py-1.5 text-[13px] font-semibold disabled:opacity-60"
              style={ACCENT_FILL}
            >
              Send it
            </button>
            <button
              type="button"
              onClick={onUnstage}
              className={cn('rounded-lg border px-3 py-1.5 text-[13px]', colors.textMuted)}
              style={{ borderColor: HAIRLINE }}
            >
              Not yet
            </button>
          </div>
        </div>
      )}
      {scene && scene.choices.length > 0 && (
        <div className="flex flex-col gap-2">
          {scene.choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              disabled={sending}
              onClick={() => void onSend('move', { choiceId: choice.id })}
              className="rounded-xl border px-3.5 py-2.5 text-left transition-colors hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/5"
              style={{ borderColor: HAIRLINE, background: CARD }}
            >
              <div className={cn('text-[14px] font-semibold leading-snug [overflow-wrap:anywhere]', colors.textMain)}>{choice.label}</div>
              {choice.hint && <div className={cn('mt-0.5 text-[12px] leading-snug', colors.textMuted)}>{choice.hint}</div>}
            </button>
          ))}
        </div>
      )}
      <OwnWords draftKey={`bytelight_move_draft_${book.id}`} sending={sending} colors={colors} onSend={onSend} />
      {stage.finishing && (
        <p className={cn('mt-2 text-[11px] italic', colors.textMuted)}>They are still finishing up at the table. Your move waits its turn.</p>
      )}
      {said}
    </section>
  );
}

/**
 * A box that keeps what their person was typing, the way the chat's composer does: the
 * draft lives in localStorage under its own key, so leaving the book, the app
 * going to the background, or the page coming back from the house does not
 * cost them the sentence. Sending it clears it.
 */
function useKeptDraft(key: string): [string, (value: string) => void] {
  const read = (from: string) => {
    try {
      return localStorage.getItem(from) ?? '';
    } catch {
      return '';
    }
  };
  const [draft, setDraft] = useState(() => read(key));
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    setDraft(read(key));
  }, [key]);
  const keep = useCallback((value: string) => {
    setDraft(value);
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* storage full or unavailable: the box still works, it just forgets */
    }
  }, [key]);
  return [draft, keep];
}

/** Grow a box with what is in it, like the chat's composer, up to a cap. */
function useGrowingBox(value: string, floor: number, cap: number) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.max(floor, Math.min(box.scrollHeight, cap))}px`;
  }, [value, floor, cap]);
  return ref;
}

function OwnWords({ draftKey, sending, colors, onSend }: { draftKey: string; sending: boolean; colors: ThemeColors; onSend: Send }) {
  const [draft, setDraft] = useKeptDraft(draftKey);
  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await onSend('move', { text })) setDraft('');
  };
  return (
    <div className="mt-3 flex items-end gap-2">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={STORY_LIMITS.moveText}
        rows={2}
        placeholder="Or write your own move…"
        aria-label="Your own move"
        className={cn('min-h-[44px] flex-1 resize-none rounded-xl border bg-transparent px-3 py-2 text-[14px] outline-none', colors.panelBorder, colors.textMain)}
      />
      <button
        type="button"
        disabled={sending || !draft.trim()}
        onClick={() => void submit()}
        className="rounded-xl px-3.5 py-2.5 text-[13px] font-semibold disabled:opacity-50"
        style={ACCENT_FILL}
      >
        Send
      </button>
    </div>
  );
}

/**
 * The rail: what their person says at the table while reading. It is talk, not a
 * move, so it never turns the page; they answer it here, under the page.
 */
function TableRail({ draftKey, sending, colors, onSend }: { draftKey: string; sending: boolean; colors: ThemeColors; onSend: Send }) {
  const [draft, setDraft] = useKeptDraft(draftKey);
  const box = useGrowingBox(draft, 40, 132);
  // A sticker at the table, the same tray as chat, on a line of its own
  // (their person's ask, Oct 26 2026). Enter is already a new line here; Say it sends.
  const [stickers, setStickers] = useState(false);
  const addSticker = (code: string) => {
    setDraft(draft.trim() ? `${draft.replace(/\s+$/, '')}\n${code}\n` : `${code}\n`);
    setStickers(false);
    window.setTimeout(() => box.current?.focus(), 50);
  };
  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await onSend('talk', { text })) setDraft('');
  };
  return (
    <div className="mt-2 flex items-end gap-2">
      <textarea
        ref={box}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={STORY_LIMITS.moveText}
        rows={1}
        placeholder="Say something at the table…"
        aria-label="Say something at the table"
        className={cn('min-h-[40px] flex-1 resize-none rounded-xl border bg-transparent px-3 py-2 text-[13px] outline-none', colors.panelBorder, colors.textMain)}
      />
      <button
        type="button"
        onClick={() => setStickers(true)}
        aria-label="Add a sticker"
        title="Add a sticker"
        className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border', colors.panelBorder, colors.textMuted)}
      >
        <Sticker size={16} />
      </button>
      {stickers && <StickerPicker colors={colors} onSelect={(code) => addSticker(code)} onClose={() => setStickers(false)} />}
      <button
        type="button"
        disabled={sending || !draft.trim()}
        onClick={() => void submit()}
        className="rounded-xl px-3 py-2 text-[13px] font-semibold disabled:opacity-50"
        style={ACCENT_FILL}
      >
        Say it
      </button>
    </div>
  );
}

function TableTalk({
  bookId,
  lines,
  threadId,
  typing,
  companions,
  colors,
  sending,
  onSend,
}: {
  bookId: string;
  lines: StoryTalkLine[];
  threadId: string | null;
  typing: boolean;
  companions: HouseCompanion[];
  colors: ThemeColors;
  sending: boolean;
  onSend: Send;
}) {
  // Reading the talk here is reading it. Only the chat screen ever marked a
  // thread read, so every other room that shows one left a badge behind.
  const latestId = lines.length > 0 ? lines[lines.length - 1].id : null;
  useEffect(() => {
    if (!threadId || !latestId) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    markRead(threadId, latestId);
  }, [threadId, latestId]);
  // The table holds its height and scrolls inside itself, newest at the
  // bottom, the way a chat window does, so a long evening of talk never
  // pushes the rail down the page.
  const talkBox = useRef<HTMLDivElement>(null);
  // The dots show while somebody is writing here, and while their line is the
  // newest at the table, because a line said during a page turn waits for
  // the turn to finish before anybody starts on it (their ask, Oct 9 2026: so I
  // know that you're reading and responding to my message).
  const showTyping = typing || tableAwaiting(lines);
  useLayoutEffect(() => {
    const box = talkBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [latestId, showTyping]);
  return (
    <section className={cn('rounded-[var(--shape-control)] border p-3', colors.panelBg, colors.panelBorder)}>
      <h3 className={cn(LABEL, colors.textMuted)}>At the table</h3>
      {/* The house's one table (components/RoomTable.tsx; theirs, Oct 28 2026:
          one frame every room draws from). */}
      <RoomTalk scrollRef={talkBox} className="mt-2 max-h-[42vh]" lines={lines} companions={companions} typing={showTyping} />
      <TableRail draftKey={`bytelight_table_draft_${bookId}`} sending={sending} colors={colors} onSend={onSend} />
    </section>
  );
}
