// The Library — a reading room. Shelve public-domain books from Project
// Gutenberg, read them here with the bookmark kept on the house, and hand a
// passage (or just where you are) to the companions in a thread so they read
// along with you. They can be read aloud by a companion's voice, and leave
// margin notes underlined on the page — never past her bookmark, which the
// house enforces. Backed by /api/library (backend routes/library.ts).
//
// The 🔷 Story Shelf chip opens the Story Shelf (ported from Aerie): the
// choose-your-own-path books the companions write and run, backed by
// /api/story-shelf. It is a shelf in here, not an app of its own.
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Library, Search, Loader2, Plus, X, ChevronLeft, ChevronRight, List, MessageCircleHeart, Bookmark, Headphones, Play, Pause, SkipBack, SkipForward, ChevronUp, Trash2, MoreHorizontal, Upload, Highlighter } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch, sendUserMessageToThread, useThreads, useRoutingThreadId, useActiveThreadId } from '../bytelight';
import { getOwnerAvatar, useHouseRoster } from '../lib/house';
import type { RoomBubbleSettings } from './RoomBubble';
import { useBackHandler } from '../lib/use-back-handler';
import { markPage, segmentForParagraph, HIGHLIGHT_COLORS, type MarginNote, type Segment, type Highlight, type HighlightColor } from '../lib/library-reader';
import { spineLook, spineTitle } from '../lib/story-shelf';
import { useAudiobook } from '../lib/use-audiobook';
import { LibraryListening } from './LibraryListening';
import { thumbSrc } from '../lib/thumb';
import { LibraryBookClub } from './LibraryBookClub';
import { ReviewSheet, ReviewStars } from './LibraryReview';
import type { BookReview } from '../lib/library-book-club';

// The Story Shelf, loaded when its chip is tapped. Lazy so this file stays
// importable without the chat's bubble (lib/library.test.ts imports it under
// node, where MessageBubble's import.meta.env does not exist), and so the
// Library does not carry the shelf until it is opened. Its table draws the
// chat's own bubble (RoomTable.tsx), from the settings handed in here.
const StoryShelfRoom = lazy(async () => {
  const [{ StoryShelfApp }, { RoomBubbleContext }] = await Promise.all([import('./StoryShelfApp'), import('./RoomBubble')]);
  function StoryShelfRoom({ bubbles, onClose, themeConfig, themeMode }: { bubbles: RoomBubbleSettings; onClose: () => void; themeConfig: ThemeConfig; themeMode: 'light' | 'dark' }) {
    return (
      <RoomBubbleContext.Provider value={bubbles}>
        <StoryShelfApp onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} />
      </RoomBubbleContext.Provider>
    );
  }
  return { default: StoryShelfRoom };
});

interface LibraryAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

interface Progress { chapter: number; fraction: number; updatedAt: string }
type ShelfName = 'reading' | 'tbr' | 'finished' | 'dnf';
interface ShelfBook { id: number; title: string; authors: string[]; cover: string | null; chapterCount: number; addedAt: string; progress: Progress | null; shelf?: ShelfName; favorite?: boolean; spineColor?: string | null; source?: 'kindle'; review?: BookReview }
type ShelfFilter = ShelfName | 'favorites' | 'stories';
const SHELVES: Array<{ id: ShelfFilter; label: string; emoji: string }> = [
  { id: 'reading', label: 'Reading', emoji: '📖' },
  { id: 'tbr', label: 'To Be Read', emoji: '📋' },
  { id: 'finished', label: 'Finished', emoji: '✅' },
  { id: 'dnf', label: 'DNF', emoji: '🚫' },
  { id: 'favorites', label: 'Favorites', emoji: '⭐' },
  { id: 'stories', label: 'Story Shelf', emoji: '🔷' },
];
const shelfOf = (b: ShelfBook): ShelfName => b.shelf ?? (b.progress ? 'reading' : 'tbr');
const onShelf = (b: ShelfBook, f: ShelfFilter) => (f === 'stories' ? false : f === 'favorites' ? b.favorite === true : shelfOf(b) === f);
interface CatalogBook { id: number; title: string; authors: string[]; cover: string | null; languages: string[]; downloads: number }
interface BookInfo { id: number; title: string; authors: string[]; cover: string | null; chapters: Array<{ title: string; length: number }>; progress: Progress | null }
interface Chapter { index: number; title: string; text: string; count: number; paragraphs?: string[]; segments?: Segment[] }

const READER_FONT = "'Fraunces', Georgia, 'Times New Roman', serif";

// Her highlights: Kindle's four colors. The page keeps its own ink, so the
// wash under it is lighter on a dark page and a touch stronger on a light one.
const HIGHLIGHT_LABEL: Record<HighlightColor, string> = { yellow: 'Yellow', pink: 'Pink', blue: 'Blue', orange: 'Orange' };
const HIGHLIGHT_RGB: Record<HighlightColor, string> = { yellow: '250 204 21', pink: '244 114 182', blue: '56 189 248', orange: '251 146 60' };
function highlightWash(color: HighlightColor, mode: 'light' | 'dark'): string {
  return `rgb(${HIGHLIGHT_RGB[color] ?? HIGHLIGHT_RGB.yellow} / ${mode === 'dark' ? 0.3 : 0.4})`;
}

function chapterParagraphs(ch: Chapter): string[] {
  return ch.paragraphs ?? toParagraphs(ch.text);
}

function chapterSegments(ch: Chapter): Segment[] {
  if (ch.segments) return ch.segments;
  const n = chapterParagraphs(ch).length;
  return n ? [{ from: 0, to: n - 1 }] : [];
}

/** Gutenberg hard-wraps lines at ~70 columns; rejoin each paragraph. */
export function toParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

/** The message a shared passage becomes in the thread. */
export function passageMessage(book: { title: string }, chapterTitle: string, passage: string, note: string): string {
  const quote = passage.trim().split(/\n+/).map((l) => `> ${l.trim()}`).join('\n');
  return `📖 *${book.title}* — ${chapterTitle}\n\n${quote}${note.trim() ? `\n\n${note.trim()}` : ''}`;
}

export interface KindleImportResult {
  book: { id: number; title: string } | null;
  notebookTitle?: string;
  added: number;
  duplicates: number;
  unplaced: number;
  bookmarks: number;
  pending: boolean;
  /** The book isn't shelved, so the notebook stands on the shelf as a notes-only card (`book`). */
  notebookCard?: 'created' | 'updated' | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A title without its series note: "Flock (The Ravenhood Book 1)" -> "Flock". */
export function shortTitle(title: string): string {
  return title.replace(/\s*(?:\([^)]*\)|\[[^\]]*\])\s*/g, ' ').replace(/\s+/g, ' ').trim() || title.trim();
}

/** What a Kindle notebook import did, in her words. */
export function kindleResultMessage(r: KindleImportResult): string {
  if (r.notebookCard && r.book) {
    const name = shortTitle(r.notebookTitle || r.book.title);
    if (r.notebookCard === 'created') return `${name} is on your shelf as a Kindle notebook · ${r.unplaced > 0 ? plural(r.unplaced, 'highlight') : 'no highlights yet'}`;
    if (r.added > 0) return `${plural(r.added, 'new highlight')} on ${name}'s Kindle notebook · ${r.unplaced} in all`;
    return `Nothing new for ${name}'s Kindle notebook${r.duplicates > 0 ? ` · ${r.duplicates} already here` : ''}`;
  }
  if (r.pending || !r.book) {
    const title = r.notebookTitle?.trim() || 'That book';
    if (r.unplaced === 0) return 'That notebook has no highlights in it, only bookmarks (those stay on your Kindle).';
    return `${title} isn't on your shelf yet. Its ${plural(r.unplaced, 'highlight')} ${r.unplaced === 1 ? 'is' : 'are'} saved and will show up when you add the book.`;
  }
  if (r.added + r.duplicates + r.unplaced === 0) return `That notebook has no highlights for ${r.book.title}, only bookmarks (those stay on your Kindle).`;
  const parts = [r.added > 0 ? `${plural(r.added, 'highlight')} added to ${r.book.title}` : `Nothing new for ${r.book.title}`];
  if (r.duplicates > 0) parts.push(`${r.duplicates} already here`);
  if (r.unplaced > 0) parts.push(`${r.unplaced} couldn't be placed`);
  return parts.join(' · ');
}

/** What shelving a book did with the Kindle notebook card of the same title. */
export interface KindleArrival { placed: number; waiting: number; retired: boolean }

export function kindleArrivalMessage(title: string, k: KindleArrival | null | undefined): string | null {
  if (!k) return null;
  const name = shortTitle(title);
  const moved = k.placed > 0 ? `Your ${plural(k.placed, 'Kindle highlight')} moved into ${name}` : `${name} took its Kindle notebook's place`;
  if (k.retired) return moved;
  return `${moved} · ${k.waiting} couldn't be found in this edition, so ${k.waiting === 1 ? 'it stays' : 'they stay'} on its Kindle notebook`;
}

export interface NotebookHighlight { quote: string; color: HighlightColor; note: string; chapterHint: string | null; page?: string | null; createdAt: string }
interface NotebookInfo { id: number; title: string; authors: string[]; cover: string | null; lastImportedAt: string; highlights: NotebookHighlight[] }

/** A short date, with the year only when it isn't this one: "Nov 9", "Mar 2, 2025". */
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The notebook card's line under the title. */
export function notebookLine(count: number, lastImportedAt: string, now = new Date()): string {
  const when = shortDate(lastImportedAt, now);
  return ['Read in Kindle', count > 0 ? plural(count, 'highlight') : 'no highlights yet', when ? `last exported ${when}` : ''].filter(Boolean).join(' · ');
}

/** Highlights under Kindle's chapter headings, in the order Kindle printed them.
 *  A heading that comes back later in the notebook rejoins its group. */
export function groupByChapter<T extends { chapterHint: string | null }>(list: T[]): Array<{ heading: string | null; items: T[] }> {
  const groups: Array<{ heading: string | null; items: T[] }> = [];
  for (const h of list) {
    const heading = h.chapterHint?.trim() || null;
    const g = groups.find((x) => x.heading === heading);
    if (g) g.items.push(h);
    else groups.push({ heading, items: [h] });
  }
  return groups;
}

function BookCover({ book, className }: { book: { title: string; authors: string[]; cover: string | null }; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (book.cover && !failed) {
    return <img src={book.cover} alt={book.title} onError={() => setFailed(true)} className={cn('object-cover', className)} loading="lazy" />;
  }
  return (
    <div className={cn('flex flex-col justify-between bg-gradient-to-br from-stone-700 to-stone-900 p-2 text-left text-stone-100', className)}>
      <span className="line-clamp-4 text-[11px] font-semibold leading-tight" style={{ fontFamily: READER_FONT }}>{book.title}</span>
      <span className="line-clamp-2 text-[9px] opacity-70">{book.authors.join(', ')}</span>
    </div>
  );
}

export function LibraryApp({ onClose, themeConfig, themeMode }: LibraryAppProps) {
  const colors = themeConfig[themeMode];
  const [tab, setTab] = useState<'shelf' | 'find'>('shelf');
  const [shelf, setShelf] = useState<ShelfBook[] | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [stories, setStories] = useState(false);
  const [club, setClub] = useState(false);
  const [storyBooks, setStoryBooks] = useState<StorySpine[]>([]);
  // Back from the Story Shelf's own front page comes back to the Library.
  useBackHandler(stories, () => setStories(false));
  const roomBubbles = useMemo<RoomBubbleSettings>(() => {
    const owner = getOwnerAvatar();
    return { themeConfig, themeMode, userAvatar: owner.url, userAvatarColor: owner.color };
  }, [themeConfig, themeMode]);

  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const kindleRef = useRef<HTMLInputElement>(null);

  // A Kindle notebook (the PDF the Kindle app's Export Notebook sends): its
  // highlights land on the matching book, or wait until that book is added.
  async function importKindle(file: File) {
    setError(null);
    setNotice(null);
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch('/api/library/kindle-import', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Those highlights could not be brought in (${res.status}). Try again?`);
      setNotice(kindleResultMessage(data as KindleImportResult));
      // A notebook for an unshelved book stands on the shelf now as its card.
      if ((data as KindleImportResult).notebookCard) void loadShelf();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Those highlights could not be brought in. Try again?');
    } finally {
      setImporting(false);
      if (kindleRef.current) kindleRef.current.value = '';
    }
  }

  // Her own book: an EPUB from the phone lands on To Be Read and opens.
  async function uploadBook(file: File) {
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch('/api/library/upload', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      setTab('shelf');
      setNotice(kindleArrivalMessage(data.book?.title ?? '', data.book?.kindle));
      await loadShelf();
      if (data.book?.id) setReading(data.book.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That book could not be uploaded');
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  }

  const loadShelf = useCallback(async () => {
    try {
      const res = await apiFetch('/api/library/shelf');
      const data = res.ok ? await res.json() : { books: [] };
      setShelf(Array.isArray(data.books) ? data.books : []);
    } catch {
      setShelf([]);
    }
    // The Story Shelf's books stand on the bookcase's bottom plank.
    try {
      const res = await apiFetch('/api/story-shelf');
      const data = res.ok ? await res.json() : null;
      const list: unknown[] = Array.isArray(data?.books) ? data.books : [];
      setStoryBooks(list.flatMap((b) => {
        const r = b as { id?: unknown; title?: unknown; spicy?: unknown; coverUrl?: unknown };
        return typeof r.id === 'string' && typeof r.title === 'string'
          ? [{ id: r.id, title: r.title, spicy: r.spicy === true, coverUrl: typeof r.coverUrl === 'string' && r.coverUrl ? r.coverUrl : null }]
          : [];
      }));
    } catch {
      setStoryBooks([]);
    }
  }, []);

  // Coming back from the Story Shelf re-reads both, so a new story stands at once.
  useEffect(() => { if (!stories) void loadShelf(); }, [loadShelf, stories]);

  if (stories) {
    return (
      <Suspense fallback={null}>
        <StoryShelfRoom bubbles={roomBubbles} onClose={() => setStories(false)} themeConfig={themeConfig} themeMode={themeMode} />
      </Suspense>
    );
  }

  if (reading !== null && shelf?.find((b) => b.id === reading)?.source === 'kindle') {
    return (
      <KindleNotebook
        bookId={reading}
        onBack={() => { setReading(null); void loadShelf(); }}
        themeConfig={themeConfig}
        themeMode={themeMode}
      />
    );
  }

  if (reading !== null) {
    return (
      <Reader
        bookId={reading}
        onBack={() => { setReading(null); void loadShelf(); }}
        themeConfig={themeConfig}
        themeMode={themeMode}
      />
    );
  }

  return (
    <AppShell title="Reading Nook" icon={Library} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
      <div className={cn('p-3 rounded-2xl border backdrop-blur-md mb-4 flex justify-center', colors.panelBg, colors.panelBorder)}>
        <div className="flex flex-wrap justify-center gap-1.5">
          {(['shelf', 'find'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setClub(false); }}
              className={cn('rounded-lg px-4 py-1.5 text-xs font-medium border capitalize', colors.panelBorder, (club || tab !== t) && cn(colors.panelBg, colors.textMain))}
              style={!club && tab === t ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
            >
              {t === 'shelf' ? 'Shelf' : 'Find a book'}
            </button>
          ))}
          <button
            onClick={() => setClub(true)}
            className={cn('rounded-lg px-3 py-1.5 text-xs font-medium border', colors.panelBorder, !club && cn(colors.panelBg, colors.textMain))}
            style={club ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
          >
            Book Club
          </button>
          <button
            onClick={() => uploadRef.current?.click()}
            disabled={uploading}
            className={cn('flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium border', colors.panelBorder, colors.panelBg, colors.textMain, uploading && 'opacity-60')}
          >
            {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
            {uploading ? 'Shelving…' : 'Upload'}
          </button>
          <input
            ref={uploadRef}
            type="file"
            accept=".epub,application/epub+zip"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadBook(f); }}
          />
          <button
            onClick={() => kindleRef.current?.click()}
            disabled={importing}
            title="Bring in highlights from a Kindle notebook (the PDF from Export Notebook)"
            className={cn('flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium border', colors.panelBorder, colors.panelBg, colors.textMain, importing && 'opacity-60')}
          >
            {importing ? <Loader2 size={12} className="animate-spin" /> : <Highlighter size={12} />}
            {importing ? 'Reading…' : 'Kindle'}
          </button>
          <input
            ref={kindleRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importKindle(f); }}
          />
        </div>
      </div>

      {error && <p className="mb-3 text-xs" style={{ color: colors.accent }}>{error}</p>}
      {notice && (
        <div className={cn('mb-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMain)}>
          <Highlighter size={13} className="mt-px shrink-0" style={{ color: colors.accent }} />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className={cn('shrink-0', colors.textMuted)} aria-label="Dismiss"><X size={13} /></button>
        </div>
      )}

      {club && (
        <LibraryBookClub
          shelf={shelf ?? []}
          onBack={() => setClub(false)}
          onOpenBook={(id) => { setClub(false); setReading(id); }}
          onShelfChanged={() => void loadShelf()}
          themeConfig={themeConfig}
          themeMode={themeMode}
        />
      )}
      {!club && tab === 'shelf' && (
        <ShelfView
          shelf={shelf}
          storyBooks={storyBooks}
          onOpen={setReading}
          onFind={() => setTab('find')}
          onStories={() => setStories(true)}
          onRemove={async (id) => {
            const card = shelf?.find((b) => b.id === id)?.source === 'kindle';
            if (!window.confirm(card ? 'Take this Kindle notebook off the shelf? Its highlights go with it (they stay in your Kindle app).' : 'Take this book off the shelf? Your bookmark goes with it.')) return;
            await apiFetch(`/api/library/shelf/${id}`, { method: 'DELETE' });
            void loadShelf();
          }}
          onReviewed={(id, review) => setShelf((cur) => cur && cur.map((b) => (b.id === id ? { ...b, review: review ?? undefined } : b)))}
          onMove={async (id, change) => {
            // Optimistic: the book moves at once; the house answer replaces it.
            setShelf((cur) => cur && cur.map((b) => (b.id === id ? { ...b, ...change } : b)));
            try {
              const res = await apiFetch(`/api/library/books/${id}/shelf`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(change),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch {
              setError('That book could not be moved. Try again?');
              void loadShelf();
            }
          }}
          themeConfig={themeConfig}
          themeMode={themeMode}
        />
      )}
      {!club && tab === 'find' && (
        <FindView
          shelvedIds={new Set((shelf ?? []).map((b) => b.id))}
          onShelved={async (id, book) => {
            if (book) setNotice(kindleArrivalMessage(book.title, book.kindle));
            await loadShelf();
            setReading(id);
          }}
          onError={setError}
          themeConfig={themeConfig}
          themeMode={themeMode}
        />
      )}
    </AppShell>
  );
}

function ShelfView({ shelf, storyBooks, onOpen, onFind, onStories, onRemove, onMove, onReviewed, themeConfig, themeMode }: {
  shelf: ShelfBook[] | null;
  /** The Story Shelf's books, standing on the bottom plank. */
  storyBooks: StorySpine[];
  onOpen: (id: number) => void;
  onFind: () => void;
  onStories: () => void;
  onRemove: (id: number) => void;
  onMove: (id: number, change: { shelf?: ShelfName; favorite?: boolean }) => void;
  onReviewed: (id: number, review: BookReview | null) => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  const [filter, setFilter] = useState<ShelfFilter | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  // The review sheet: from "Rate & review", or offered (prompted) on moving a book to Finished.
  const [reviewFor, setReviewFor] = useState<{ id: number; prompted: boolean } | null>(null);
  const reviewBook = reviewFor ? shelf?.find((b) => b.id === reviewFor.id) ?? null : null;
  // Back from an opened shelf returns to the bookcase, not out of the Library.
  useBackHandler(filter !== null, () => setFilter(null));
  if (shelf === null) {
    return <div className={cn('flex items-center justify-center gap-2 py-10 text-xs', colors.textMuted)}><Loader2 size={14} className="animate-spin" /> Opening the shelf…</div>;
  }
  if (shelf.length === 0 && storyBooks.length === 0) {
    return (
      <div className={cn('rounded-2xl border p-6 text-center backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <p className={cn('mb-1 text-sm font-semibold', colors.textMain)} style={{ fontFamily: READER_FONT }}>An empty shelf.</p>
        <p className={cn('mb-4 text-xs', colors.textMuted)}>Tens of thousands of public-domain classics are free to read together — or upload your own EPUB.</p>
        <button onClick={onFind} className="rounded-lg px-4 py-2 text-xs font-semibold" style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}>
          Find a book
        </button>
        <button onClick={onStories} className={cn('mt-2 block w-full text-xs font-semibold', colors.textMuted)}>
          🔷 Story Shelf
        </button>
      </div>
    );
  }
  const count = (f: ShelfFilter) => shelf.filter((b) => onShelf(b, f)).length;
  const menuBook = menuFor !== null ? shelf.find((b) => b.id === menuFor) ?? null : null;
  const openLabel = SHELVES.find((x) => x.id === filter);
  const books = filter ? shelf.filter((b) => onShelf(b, filter)) : [];

  return (
    <>
      {filter === null ? (
        // The bookcase: one plank per shelf, books standing as spines.
        <div className="flex flex-col gap-3">
          {SHELVES.filter((x) => x.id !== 'favorites' || count('favorites') > 0).map((x) => (
            <Plank
              key={x.id}
              label={`${x.emoji} ${x.label}`}
              count={x.id === 'stories' ? storyBooks.length : count(x.id)}
              onOpenShelf={() => (x.id === 'stories' ? onStories() : setFilter(x.id))}
              themeConfig={themeConfig}
              themeMode={themeMode}
            >
              {x.id === 'stories'
                ? storyBooks.map((st) => (
                    <BookSpine key={st.id} spineId={st.id} title={st.title} spicy={st.spicy} cover={st.coverUrl} onOpen={onStories} />
                  ))
                : shelf.filter((b) => onShelf(b, x.id)).map((b) => (
                    <BookSpine key={b.id} spineId={String(b.id)} title={b.title} favorite={b.favorite} color={b.spineColor} cover={b.cover} onOpen={() => onOpen(b.id)} />
                  ))}
            </Plank>
          ))}
        </div>
      ) : (
        <>
          <button onClick={() => setFilter(null)} className={cn('mb-3 flex items-center gap-1 text-xs font-semibold', colors.textMuted)}>
            <ChevronLeft size={14} /> Shelves
            <span className={cn('ml-2 text-sm', colors.textMain)} style={{ fontFamily: READER_FONT }}>{openLabel?.emoji} {openLabel?.label}</span>
          </button>
          {books.length === 0 ? (
            <p className={cn('py-8 text-center text-xs', colors.textMuted)} style={{ fontFamily: READER_FONT }}>
              Nothing on this shelf yet.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {books.map((b) => (
                <div key={b.id} className="group relative">
                  <button onClick={() => onOpen(b.id)} className="block w-full text-left">
                    <BookCover book={b} className="aspect-[2/3] w-full rounded-lg shadow-lg" />
                    <div className={cn('mt-1.5 line-clamp-2 text-[11px] font-semibold leading-tight', colors.textMain)}>{b.title}</div>
                    <div className={cn('text-[10px]', colors.textMuted)}>
                      {b.source === 'kindle' ? 'Kindle notebook' : shelfOf(b) === 'finished' ? 'Finished' : b.progress ? `Ch. ${b.progress.chapter + 1} of ${b.chapterCount}` : 'Not started'}
                    </div>
                    <ReviewStars review={b.review} className="block" />
                  </button>
                  {b.favorite && <span className="pointer-events-none absolute left-1 top-1 text-[13px] drop-shadow">⭐</span>}
                  <button
                    onClick={() => setMenuFor(b.id)}
                    className="absolute right-1 top-1 rounded-full bg-black/50 p-1 text-white opacity-80 hover:opacity-100"
                    aria-label={`Move ${b.title}`}
                  >
                    <MoreHorizontal size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {menuBook && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setMenuFor(null)}>
          <div
            className={cn('w-full max-w-md rounded-t-2xl border p-4 pb-6 backdrop-blur-md', colors.panelBg, colors.panelBorder)}
            style={{ background: 'var(--bytelight-surface-strong)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className={cn('mb-3 line-clamp-1 text-sm font-semibold', colors.textMain)} style={{ fontFamily: READER_FONT }}>{menuBook.title}</p>
            <div className="mb-3 grid grid-cols-2 gap-2">
              {SHELVES.filter((x) => x.id !== 'favorites' && x.id !== 'stories').map((x) => {
                const here = shelfOf(menuBook) === x.id;
                return (
                  <button
                    key={x.id}
                    onClick={() => {
                      onMove(menuBook.id, { shelf: x.id as ShelfName });
                      setMenuFor(null);
                      if (x.id === 'finished' && !here && !menuBook.review) setReviewFor({ id: menuBook.id, prompted: true });
                    }}
                    className={cn('rounded-xl border px-3 py-2 text-left text-xs font-semibold', colors.panelBorder, !here && colors.textMain)}
                    style={here ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
                  >
                    {x.emoji} {x.label}
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => onMove(menuBook.id, { favorite: !menuBook.favorite })}
              className={cn('mb-2 w-full rounded-xl border px-3 py-2 text-left text-xs font-semibold', colors.panelBorder, colors.textMain)}
            >
              {menuBook.favorite ? '☆ Take off Favorites' : '⭐ Add to Favorites'}
            </button>
            <button
              onClick={() => { setReviewFor({ id: menuBook.id, prompted: false }); setMenuFor(null); }}
              className={cn('mb-2 w-full rounded-xl border px-3 py-2 text-left text-xs font-semibold', colors.panelBorder, colors.textMain)}
            >
              {menuBook.review ? `★ Rate & review · ${menuBook.review.stars} of 5` : '★ Rate & review'}
            </button>
            <button
              onClick={() => { const id = menuBook.id; setMenuFor(null); onRemove(id); }}
              className={cn('flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-semibold', colors.panelBorder, colors.textMuted)}
            >
              <Trash2 size={12} /> Take off the shelf
            </button>
          </div>
        </div>
      )}

      {reviewFor && reviewBook && (
        <ReviewSheet
          book={reviewBook}
          prompted={reviewFor.prompted}
          onSaved={(review) => onReviewed(reviewBook.id, review)}
          onClose={() => setReviewFor(null)}
          themeConfig={themeConfig}
          themeMode={themeMode}
        />
      )}
    </>
  );
}

// ─── The bookcase ────────────────────────────────────────────────────
// The Library opens as a bookcase, one plank per shelf, books standing as
// spines. The look matches the Story Shelf's (a book's cloth hue and size come
// from spineLook, its title from spineTitle, both in lib/story-shelf), drawn
// smaller so a whole shelf fits on one plank.

interface StorySpine { id: string; title: string; spicy: boolean; coverUrl: string | null }

const SPINE_SCALE = 0.6;
const PLANK_LEDGE = 'color-mix(in oklch, oklch(0.72 0.11 62) 46%, var(--bytelight-border))';
const BOOK_SHADOW = 'inset -3px 0 6px oklch(0 0 0 / 0.3), inset 2px 0 2px oklch(1 0 0 / 0.08), 0 2px 4px oklch(0 0 0 / 0.35)';
const RED_THREAD = 'oklch(0.58 0.2 25)';
// A little window of the real cover at the head of a spine (the Story Shelf's,
// scaled down): its square plus the gap under it come off the title's run.
const SPINE_COVER = 24;
const SPINE_COVER_RUN = SPINE_COVER + 6;

function Plank({ label, count, onOpenShelf, children, themeConfig, themeMode }: {
  label: string;
  count: number;
  onOpenShelf: () => void;
  children: React.ReactNode;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  return (
    <section className={cn('rounded-2xl border px-3 pt-2.5 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
      <button onClick={onOpenShelf} className="flex w-full items-baseline justify-between gap-2 text-left">
        <span className={cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMain)}>{label}</span>
        <span className="text-[11px] font-semibold" style={{ color: colors.accent }}>{count > 0 ? `${count} · open ›` : 'open ›'}</span>
      </button>
      <div className="-mx-1 flex min-h-[64px] snap-x snap-proximity items-end gap-1.5 overflow-x-auto overscroll-x-contain px-1 pt-2 scrollbar-hide [touch-action:pan-x_pan-y] [&>*]:snap-start">
        {count === 0
          ? <span className={cn('mx-auto self-center pb-3 text-[11px] italic', colors.textMuted)} style={{ fontFamily: READER_FONT }}>Nothing here yet</span>
          : children}
      </div>
      <div aria-hidden className="h-[3px] rounded-full" style={{ background: PLANK_LEDGE, boxShadow: '0 4px 6px -3px oklch(0 0 0 / 0.45)' }} />
      <div className="h-2.5" />
    </section>
  );
}

/** Dark ink on a light cover color, pale ink on a dark one. */
function inkFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? '#1b1712' : '#f6f2ec';
}

function BookSpine({ spineId, title, spicy = false, favorite = false, color = null, cover = null, onOpen }: {
  spineId: string;
  title: string;
  spicy?: boolean;
  favorite?: boolean;
  /** The cover's own color (#rrggbb). Without one the spine wears its fixed cloth. */
  color?: string | null;
  /** The book's cover, shown as a small window at the head of the spine. */
  cover?: string | null;
  onOpen: () => void;
}) {
  const [coverGone, setCoverGone] = useState(false);
  const covered = Boolean(cover) && !coverGone;
  const look = spineLook({ id: spineId });
  const height = Math.round(look.height * SPINE_SCALE);
  const width = Math.round(look.width * SPINE_SCALE);
  const coverHex = color && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
  const ink = coverHex ? inkFor(coverHex) : `oklch(0.96 0.015 ${look.hue})`;
  const cloth = coverHex ?? `oklch(0.42 0.085 ${look.hue})`;
  // Room for the title: the spine less its head band, foot padding and star.
  const fit = spineTitle(title, height - 18 - (favorite ? 14 : 0) - (covered ? SPINE_COVER_RUN : 0));
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${title}${spicy ? ', spicy' : ''}${favorite ? ', favorite' : ''}`}
      className="relative flex shrink-0 flex-col items-center rounded-[3px] px-0.5 pb-1.5 pt-3 transition-transform active:translate-y-px"
      style={{ height, width, background: cloth, color: ink, boxShadow: BOOK_SHADOW }}
    >
      <span aria-hidden className="absolute inset-x-0 top-1 h-[2px]" style={{ background: spicy ? RED_THREAD : `color-mix(in oklch, ${ink} 28%, transparent)` }} />
      {covered && (
        <img
          src={thumbSrc(cover!, 256)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setCoverGone(true)}
          className="shrink-0 rounded-[2px] object-cover"
          style={{ width: SPINE_COVER, height: SPINE_COVER, marginBottom: SPINE_COVER_RUN - SPINE_COVER, outline: `1px solid color-mix(in oklch, ${ink} 30%, transparent)`, outlineOffset: 1 }}
        />
      )}
      <span
        className="min-h-0 flex-1 overflow-hidden font-semibold leading-[1.15] [overflow-wrap:break-word] [text-orientation:sideways] [writing-mode:vertical-rl]"
        style={{ fontSize: fit.size * 0.85, maxWidth: '2.3em' }}
      >
        {fit.text}
      </span>
      {favorite && <span aria-hidden className="mt-0.5 text-[9px] leading-none">⭐</span>}
    </button>
  );
}

function FindView({ shelvedIds, onShelved, onError, themeConfig, themeMode }: {
  shelvedIds: Set<number>;
  /** `book` is the house's answer when it was just shelved (it says what became of a Kindle notebook card). */
  onShelved: (id: number, book?: { title: string; kindle?: KindleArrival }) => void;
  onError: (msg: string | null) => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogBook[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    onError(null);
    try {
      const res = await apiFetch(`/api/library/search?q=${encodeURIComponent(q)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setResults(Array.isArray(data.results) ? data.results : []);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  async function shelve(id: number) {
    setAdding(id);
    onError(null);
    try {
      const res = await apiFetch('/api/library/shelf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not shelve that book');
      onShelved(id, data.book);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not shelve that book');
    } finally {
      setAdding(null);
    }
  }

  return (
    <div>
      <form onSubmit={search} className="mb-3 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Dracula, Jane Eyre, Brontë…"
          className={cn('min-w-0 flex-1 rounded-xl border bg-transparent px-3 py-2 text-sm', colors.panelBorder, colors.textMain)}
        />
        <button type="submit" disabled={searching} className="rounded-xl px-3 text-xs font-semibold disabled:opacity-60" style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}>
          {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
        </button>
      </form>
      <p className={cn('mb-3 text-[11px]', colors.textMuted)}>From Project Gutenberg — free, public-domain books.</p>

      {results && results.length === 0 && <p className={cn('py-6 text-center text-xs', colors.textMuted)}>Nothing found under that.</p>}
      <div className="flex flex-col gap-2">
        {(results ?? []).map((b) => {
          const shelved = shelvedIds.has(b.id);
          return (
            <div key={b.id} className={cn('flex gap-3 rounded-2xl border p-2.5 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
              <BookCover book={b} className="h-20 w-14 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1">
                <div className={cn('line-clamp-2 text-sm font-semibold leading-tight', colors.textMain)} style={{ fontFamily: READER_FONT }}>{b.title}</div>
                <div className={cn('mt-0.5 line-clamp-1 text-[11px]', colors.textMuted)}>{b.authors.join(', ') || 'Anonymous'}</div>
                <div className={cn('mt-0.5 text-[10px] opacity-60', colors.textMuted)}>{b.languages.join(', ').toUpperCase()}</div>
              </div>
              <button
                onClick={() => (shelved ? onShelved(b.id) : void shelve(b.id))}
                disabled={adding !== null}
                className="self-center rounded-lg px-3 py-1.5 text-[11px] font-semibold disabled:opacity-60"
                style={shelved ? { border: `1px solid ${colors.accent}`, color: colors.accent } : { background: colors.accent, color: 'var(--bytelight-on-accent)' }}
              >
                {adding === b.id ? <Loader2 size={12} className="animate-spin" /> : shelved ? 'Read' : <span className="flex items-center gap-1"><Plus size={11} /> Shelve</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── A Kindle notebook card ──────────────────────────────────────────
// A book she reads in the Kindle app (store books can't come over), shown as
// its notebook: her highlights under Kindle's chapter headings. No text here,
// so no reader; when the real book is shelved its highlights move onto it.

function KindleNotebook({ bookId, onBack, themeConfig, themeMode }: {
  bookId: number;
  onBack: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  const [info, setInfo] = useState<NotebookInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/library/books/${bookId}/notebook`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as NotebookInfo;
        if (!stale) setInfo({ ...data, highlights: Array.isArray(data.highlights) ? data.highlights : [] });
      } catch {
        if (!stale) setFailed(true);
      }
    })();
    return () => { stale = true; };
  }, [bookId]);

  const groups = useMemo(() => groupByChapter(info?.highlights ?? []), [info]);

  return (
    <AppShell title={info ? shortTitle(info.title) : 'Kindle notebook'} onClose={onBack} themeConfig={themeConfig} themeMode={themeMode}>
      {!info && !failed && (
        <div className={cn('flex items-center justify-center gap-2 py-16 text-xs', colors.textMuted)}><Loader2 size={14} className="animate-spin" /> Opening the notebook…</div>
      )}
      {failed && <p className={cn('py-16 text-center text-xs', colors.textMuted)}>This notebook couldn't be opened. Try again in a moment?</p>}
      {info && (
        <div className="mx-auto max-w-prose pb-16">
          <header className="mb-5 flex gap-4">
            <BookCover book={info} className="h-32 w-[5.25rem] shrink-0 rounded-md shadow-lg" />
            <div className="min-w-0 self-end">
              <h2 className={cn('text-lg font-semibold leading-snug', colors.textMain)} style={{ fontFamily: READER_FONT }}>{info.title}</h2>
              {info.authors.length > 0 && <p className={cn('mt-0.5 text-xs', colors.textMuted)}>{info.authors.join(', ')}</p>}
              <p className={cn('mt-2 flex items-center gap-1 text-[11px]', colors.textMuted)}>
                <Highlighter size={11} className="shrink-0" style={{ color: colors.accent }} />
                {notebookLine(info.highlights.length, info.lastImportedAt)}
              </p>
            </div>
          </header>

          {info.highlights.length === 0 ? (
            <div className={cn('rounded-2xl border p-5 text-center backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
              <p className={cn('mb-1 text-sm font-semibold', colors.textMain)} style={{ fontFamily: READER_FONT }}>No highlights here yet.</p>
              <p className={cn('text-xs leading-relaxed', colors.textMuted)}>
                In the Kindle app, open this book, tap Notebook, then Export, and send yourself the PDF. Bring it in with the Kindle button on the Library's front page, and your highlights land here.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {groups.map((g, gi) => (
                <section key={gi}>
                  {g.heading && (
                    <h3 className={cn('mb-2.5 text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>{g.heading}</h3>
                  )}
                  <div className="flex flex-col gap-3">
                    {g.items.map((h, i) => (
                      <article key={i} className={cn('flex gap-3 rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
                        <span
                          aria-label={`${HIGHLIGHT_LABEL[h.color] ?? 'Yellow'} highlight`}
                          className="w-1 shrink-0 self-stretch rounded-full"
                          style={{ background: `rgb(${HIGHLIGHT_RGB[h.color] ?? HIGHLIGHT_RGB.yellow})` }}
                        />
                        <div className="min-w-0 flex-1">
                          <blockquote className={cn('text-[15px] leading-relaxed', colors.textMain)} style={{ fontFamily: READER_FONT }}>
                            <span className="rounded-sm px-0.5 [box-decoration-break:clone]" style={{ background: highlightWash(h.color, themeMode) }}>{h.quote}</span>
                          </blockquote>
                          {h.note && (
                            <p className={cn('mt-2 whitespace-pre-line border-l-2 pl-2 text-xs leading-relaxed', colors.textMain)} style={{ borderColor: `rgb(${HIGHLIGHT_RGB[h.color] ?? HIGHLIGHT_RGB.yellow})` }}>
                              {h.note}
                            </p>
                          )}
                          <p className={cn('mt-1.5 text-[10px]', colors.textMuted)}>
                            {[h.page ? `Page ${h.page}` : '', shortDate(h.createdAt)].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
              <p className={cn('text-center text-[11px] leading-relaxed', colors.textMuted)}>
                Highlighted more? Export the notebook again and bring it in with the Kindle button; only the new ones are added.
              </p>
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}

function Reader({ bookId, onBack, themeConfig, themeMode }: {
  bookId: number;
  onBack: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  const [book, setBook] = useState<BookInfo | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [loading, setLoading] = useState(true);
  const [showContents, setShowContents] = useState(false);
  const [selection, setSelection] = useState('');
  const [sharing, setSharing] = useState<{ passage: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoreFraction = useRef<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { companions, labelOf, sigilOf } = useHouseRoster();

  // Margin notes the companions left on this chapter.
  const [notes, setNotes] = useState<MarginNote[]>([]);
  const [openNote, setOpenNote] = useState<MarginNote | null>(null);
  // Her highlight under the note she tapped, so the note sheet can reach it.
  const [noteHighlight, setNoteHighlight] = useState<Highlight | null>(null);

  // Her own highlights on this chapter, and the sheet that makes or changes one.
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [marking, setMarking] = useState<{ quote: string; highlight?: Highlight } | null>(null);

  // Read-aloud is audiobook mode (slice 5): one ~1200-character piece at a
  // time, rendered by the house in the chosen voice and cached there, played
  // on through the chapters on one <audio> element (lib/use-audiobook.ts).
  const [playerOpen, setPlayerOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const chapterRef = useRef<Chapter | null>(null);
  chapterRef.current = chapter;
  const companionSlugs = useMemo(() => companions.map((c) => c.slug), [companions]);
  const audiobookBook = useMemo(
    () => (book ? { id: book.id, title: book.title, cover: book.cover, chapterCount: book.chapters.length } : null),
    [book],
  );
  const loadAudioChapter = useCallback(async (n: number) => {
    const res = await apiFetch(`/api/library/books/${bookId}/chapters/${n}`);
    if (!res.ok) throw new Error('That chapter could not be opened.');
    const ch = (await res.json()) as Chapter;
    return { index: ch.index, title: ch.title, paragraphs: chapterParagraphs(ch), segments: chapterSegments(ch) };
  }, [bookId]);
  const saveProgressRef = useRef<(n: number, fraction: number) => void>(() => {});
  const ab = useAudiobook({
    book: audiobookBook,
    voices: companionSlugs,
    labelOf,
    loadChapter: loadAudioChapter,
    saveProgress: (n, fraction) => saveProgressRef.current(n, fraction),
    onMessage: (msg) => flash(msg),
  });
  const abRef = useRef(ab);
  abRef.current = ab;
  const playing = ab.playing;
  // The piece being read, when it's on the page she has open.
  const segIndex = ab.pos && chapter && ab.pos.chapter === chapter.index ? ab.pos.seg : null;
  useBackHandler(listening, () => setListening(false));

  /** `follow`: the voice turned the page, so keep it reading. */
  const openChapter = useCallback(async (n: number, fraction = 0, follow = false) => {
    if (!follow) abRef.current.stop();
    setLoading(true);
    try {
      const res = await apiFetch(`/api/library/books/${bookId}/chapters/${n}`);
      if (!res.ok) throw new Error(String(res.status));
      restoreFraction.current = fraction;
      setChapter(await res.json());
      setShowContents(false);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    let stale = false;
    (async () => {
      const res = await apiFetch(`/api/library/books/${bookId}`);
      if (!res.ok || stale) return;
      const info = (await res.json()) as BookInfo;
      setBook(info);
      await openChapter(info.progress?.chapter ?? 0, info.progress?.fraction ?? 0);
    })();
    return () => { stale = true; };
  }, [bookId, openChapter]);

  // Land where she left off once the chapter has painted.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !chapter || restoreFraction.current === null) return;
    const fraction = restoreFraction.current;
    restoreFraction.current = null;
    requestAnimationFrame(() => {
      el.scrollTop = fraction * Math.max(0, el.scrollHeight - el.clientHeight);
    });
  }, [chapter]);

  const saveProgress = useCallback((n: number, fraction: number) => {
    void apiFetch(`/api/library/books/${bookId}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter: n, fraction }),
    });
  }, [bookId]);
  saveProgressRef.current = saveProgress;

  // The bookmark follows the page, a moment after scrolling stops.
  function onScroll() {
    const el = scrollRef.current;
    if (!el || !chapter) return;
    const fraction = el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveProgress(chapter.index, fraction), 800);
  }

  useEffect(() => {
    const onSelect = () => {
      const sel = window.getSelection();
      const el = scrollRef.current;
      if (!sel || !el || sel.isCollapsed || !el.contains(sel.anchorNode)) { setSelection(''); return; }
      setSelection(sel.toString().trim());
    };
    document.addEventListener('selectionchange', onSelect);
    return () => document.removeEventListener('selectionchange', onSelect);
  }, []);

  const paragraphs = useMemo(() => (chapter ? chapterParagraphs(chapter) : []), [chapter]);
  const segments = useMemo(() => (chapter ? chapterSegments(chapter) : []), [chapter]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  // ── margin notes ──
  const loadNotes = useCallback(async (n: number) => {
    try {
      const res = await apiFetch(`/api/library/books/${bookId}/notes?chapter=${n}`);
      if (!res.ok) return;
      const data = await res.json();
      if (chapterRef.current?.index !== n) return;
      setNotes(Array.isArray(data.notes) ? data.notes : []);
    } catch { /* the page reads fine without them */ }
  }, [bookId]);

  // Fetched as the chapter opens, then looked in on now and then — a
  // companion may be writing in the margin while she reads.
  useEffect(() => {
    if (!chapter) return;
    setNotes([]);
    void loadNotes(chapter.index);
    const t = setInterval(() => void loadNotes(chapter.index), 30_000);
    return () => clearInterval(t);
  }, [chapter, loadNotes]);

  // ── her highlights ──
  useEffect(() => {
    if (!chapter) return;
    let stale = false;
    setHighlights([]);
    (async () => {
      try {
        const res = await apiFetch(`/api/library/books/${bookId}/highlights?chapter=${chapter.index}`);
        if (!res.ok || stale) return;
        const data = await res.json();
        if (!stale) setHighlights(Array.isArray(data.highlights) ? data.highlights : []);
      } catch { /* the page reads fine without them */ }
    })();
    return () => { stale = true; };
  }, [chapter, bookId]);

  const pages = useMemo(() => markPage(paragraphs, notes, highlights), [paragraphs, notes, highlights]);

  async function saveHighlight(change: { color: HighlightColor; note: string }) {
    if (!marking || !chapter) return;
    const editing = marking.highlight;
    try {
      const res = editing
        ? await apiFetch(`/api/library/books/${bookId}/highlights/${encodeURIComponent(editing.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(change),
          })
        : await apiFetch(`/api/library/books/${bookId}/highlights`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chapter: chapter.index, quote: marking.quote, ...change }),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'That highlight could not be saved. Try again?');
      const saved = data.highlight as Highlight;
      setHighlights((prev) => (editing ? prev.map((h) => (h.id === saved.id ? saved : h)) : [...prev, saved]));
      setMarking(null);
      if (!editing) window.getSelection()?.removeAllRanges();
    } catch (err) {
      setMarking(null);
      flash(err instanceof Error ? err.message : 'That highlight could not be saved. Try again?');
    }
  }

  async function eraseHighlight(h: Highlight) {
    try {
      const res = await apiFetch(`/api/library/books/${bookId}/highlights/${encodeURIComponent(h.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      setHighlights((prev) => prev.filter((x) => x.id !== h.id));
      setMarking(null);
    } catch {
      setMarking(null);
      flash('That highlight could not be erased. Try again?');
    }
  }

  async function deleteNote(note: MarginNote) {
    if (!window.confirm('Rub this note out of the margin?')) return;
    await apiFetch(`/api/library/books/${bookId}/notes/${encodeURIComponent(note.id)}`, { method: 'DELETE' }).catch(() => null);
    setOpenNote(null);
    setNotes((prev) => prev.filter((n) => n.id !== note.id));
  }

  // ── read-aloud (audiobook mode) ──
  // The chapter on the page is handed over, so the voice never fetches it twice.
  useEffect(() => {
    if (chapter) ab.seed({ index: chapter.index, title: chapter.title, paragraphs, segments });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter, paragraphs, segments]);

  // The page follows the voice: when it turns into the next chapter, so does
  // the reader (unless she's in the middle of opening one herself).
  useEffect(() => {
    if (!ab.pos || !chapter || loading || !(ab.playing || ab.rendering)) return;
    if (ab.pos.chapter !== chapter.index) void openChapter(ab.pos.chapter, 0, true);
  }, [ab.pos, ab.playing, ab.rendering, chapter, loading, openChapter]);

  // The page follows the voice; the scroll carries the bookmark with it.
  useEffect(() => {
    if (segIndex === null || !playing) return;
    const from = segments[segIndex]?.from;
    if (from === undefined) return;
    scrollRef.current?.querySelector(`[data-p="${from}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [segIndex, playing, segments]);

  function firstVisibleParagraph(): number {
    const el = scrollRef.current;
    if (!el) return 0;
    const top = el.getBoundingClientRect().top + 8;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-p]'));
    const hit = nodes.find((n) => n.getBoundingClientRect().bottom > top);
    return hit ? Number(hit.dataset.p) : 0;
  }

  /** Play/pause; with nothing queued, begin at the piece on screen. */
  function togglePlay() {
    if (!chapter) return;
    ab.toggle({ chapter: chapter.index, seg: segmentForParagraph(segments, firstVisibleParagraph()) });
  }

  function closePlayer() {
    ab.stop({ save: true });
    setListening(false);
    setPlayerOpen(false);
  }

  // Notes-only Kindle cards have no chapters, so no audiobook.
  const canListen = (book?.chapters.length ?? 0) > 0;

  const reading = playerOpen && segIndex !== null ? segments[segIndex] : null;

  return (
    <AppShell
      title={book?.title ?? 'Reading'}
      onClose={onBack}
      themeConfig={themeConfig}
      themeMode={themeMode}
      bodyClassName="p-0 overflow-hidden flex flex-col"
      headerRight={
        <>
          {canListen && (
            <button
              onClick={() => { setListening((v) => (playerOpen ? !v : true)); setPlayerOpen(true); }}
              className={cn('rounded-full p-2', colors.textMuted)}
              style={playerOpen ? { color: colors.accent } : undefined}
              title="Listen"
              aria-label="Listen"
            >
              <Headphones size={17} />
            </button>
          )}
          <button
            onClick={() => setSharing({ passage: '' })}
            className={cn('rounded-full p-2', colors.textMuted)}
            title="Tell them where you are"
            aria-label="Tell them where you are"
          >
            <Bookmark size={17} />
          </button>
          <button onClick={() => setShowContents((v) => !v)} className={cn('rounded-full p-2', colors.textMuted)} title="Contents" aria-label="Contents">
            <List size={18} />
          </button>
        </>
      }
    >
      {showContents && book && (
        <div className={cn('absolute inset-x-3 top-16 z-30 max-h-[65vh] overflow-y-auto rounded-2xl border p-2 shadow-xl backdrop-blur-xl', colors.panelBg, colors.panelBorder)}>
          {book.chapters.map((c, i) => (
            <button
              key={i}
              onClick={() => void openChapter(i)}
              className={cn('block w-full rounded-lg px-3 py-2 text-left text-xs', colors.textMain)}
              style={chapter?.index === i ? { color: colors.accent, fontWeight: 600 } : undefined}
            >
              {c.title}
            </button>
          ))}
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 pb-24 pt-4">
        {loading && !chapter && (
          <div className={cn('flex items-center justify-center gap-2 py-16 text-xs', colors.textMuted)}><Loader2 size={14} className="animate-spin" /> Opening the book…</div>
        )}
        {chapter && (
          <article
            className={cn('mx-auto max-w-prose select-text', colors.textMain)}
            style={{ fontFamily: READER_FONT, WebkitUserSelect: 'text', userSelect: 'text' }}
          >
            {/* The phone is select-none app-wide; the page is the one place
                she highlights, so the reader opts back in (iOS needs the prefix). */}
            <h2 className="mb-6 mt-2 text-center text-lg font-semibold leading-snug">{chapter.title}</h2>
            {paragraphs.map((p, i) => {
              const aloud = reading !== null && i >= reading.from && i <= reading.to;
              return (
                <p
                  key={i}
                  data-p={i}
                  className="-mx-2 mb-4 rounded-md px-2 text-[17px] leading-[1.75] transition-colors"
                  style={aloud ? { background: `color-mix(in srgb, ${colors.accent} 13%, transparent)` } : undefined}
                >
                  {/* Her highlights wash the words in their color; the companions'
                      notes underline theirs. Where both fall on the same words,
                      both show, and a tap opens the note (which links to her
                      highlight); the rest of the highlight opens it directly. */}
                  {(pages[i] ?? [{ text: p }]).map((piece, k) => {
                    const wash = piece.highlight
                      ? { background: highlightWash(piece.highlight.color, themeMode), borderRadius: 3, boxDecorationBreak: 'clone' as const, WebkitBoxDecorationBreak: 'clone' as const }
                      : undefined;
                    if (piece.note) {
                      const note = piece.note;
                      const under = piece.highlight ?? null;
                      return (
                        <span key={k} role="button" onClick={() => { setOpenNote(note); setNoteHighlight(under); }} className="cursor-pointer">
                          <span style={{ ...wash, textDecorationLine: 'underline', textDecorationColor: colors.accent, textDecorationThickness: '2px', textUnderlineOffset: '4px' }}>
                            {piece.text}
                          </span>
                          {piece.noteEnd && <sup className="ml-0.5 select-none text-[10px]" aria-label={`Note from ${labelOf(note.author)}`}>{sigilOf(note.author)}</sup>}
                        </span>
                      );
                    }
                    if (piece.highlight) {
                      const h = piece.highlight;
                      return (
                        <span
                          key={k}
                          role="button"
                          // A tap opens it; a drag that selects words doesn't.
                          onClick={() => { if (!window.getSelection()?.toString()) setMarking({ quote: h.quote, highlight: h }); }}
                          className="cursor-pointer"
                          style={wash}
                        >
                          {piece.text}
                        </span>
                      );
                    }
                    return <React.Fragment key={k}>{piece.text}</React.Fragment>;
                  })}
                </p>
              );
            })}
            <div className="mt-10 flex items-center justify-between gap-3">
              <button
                disabled={chapter.index === 0}
                onClick={() => void openChapter(chapter.index - 1)}
                className={cn('flex items-center gap-1 rounded-lg border px-3 py-2 text-xs disabled:opacity-30', colors.panelBorder)}
              >
                <ChevronLeft size={14} /> Previous
              </button>
              <span className={cn('text-[11px]', colors.textMuted)}>{chapter.index + 1} / {chapter.count}</span>
              <button
                disabled={chapter.index >= chapter.count - 1}
                onClick={() => { saveProgress(chapter.index + 1, 0); void openChapter(chapter.index + 1); }}
                className={cn('flex items-center gap-1 rounded-lg border px-3 py-2 text-xs disabled:opacity-30', colors.panelBorder)}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </article>
        )}
      </div>

      {playerOpen && !listening && (
        <div className={cn('absolute inset-x-3 bottom-4 z-30 flex items-center gap-2 rounded-2xl border px-3 py-2 shadow-xl backdrop-blur-xl', colors.panelBg, colors.panelBorder)}>
          <button
            onClick={() => setListening(true)}
            className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-left', colors.textMain)}
            aria-label="Open the player"
          >
            <ChevronUp size={15} className={cn('shrink-0', colors.textMuted)} />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{ab.readBy || 'Listen'}</span>
              <span className={cn('block truncate text-[10px]', colors.textMuted)}>
                {ab.pos ? `${ab.chapterTitle || `Chapter ${ab.pos.chapter + 1}`} · ${ab.pos.seg + 1}/${ab.segCount}` : `${segments.length} pieces in this chapter`}
              </span>
            </span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={ab.prevPieceNow}
              disabled={!ab.pos || (ab.pos.chapter === 0 && ab.pos.seg === 0)}
              className={cn('rounded-full p-2 disabled:opacity-30', colors.textMain)}
              aria-label="Back a piece"
            >
              <SkipBack size={16} />
            </button>
            <button
              onClick={togglePlay}
              disabled={!ab.pick}
              className="rounded-full p-2.5 disabled:opacity-40"
              style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
              aria-label={playing ? 'Pause' : 'Read to me'}
            >
              {ab.rendering ? <Loader2 size={16} className="animate-spin" /> : playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button
              onClick={ab.nextPieceNow}
              disabled={!ab.pos}
              className={cn('rounded-full p-2 disabled:opacity-30', colors.textMain)}
              aria-label="On a piece"
            >
              <SkipForward size={16} />
            </button>
            <button onClick={closePlayer} className={cn('rounded-full p-2', colors.textMuted)} aria-label="Stop and close">
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {playerOpen && listening && book && (
        <LibraryListening
          ab={ab}
          bookTitle={book.title}
          chapterCount={book.chapters.length}
          cover={<BookCover book={book} className="h-full w-full" />}
          companions={companions}
          onToggle={togglePlay}
          onCollapse={() => setListening(false)}
          onClose={closePlayer}
          themeConfig={themeConfig}
          themeMode={themeMode}
        />
      )}

      {openNote && (
        <div className="absolute inset-0 z-40 flex items-end bg-black/40" onClick={() => { setOpenNote(null); setNoteHighlight(null); }}>
          <div className={cn('w-full rounded-t-3xl border-t p-4 pb-8 shadow-2xl', colors.panelBg, colors.panelBorder)} onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className={cn('text-sm font-semibold', colors.textMain)}>{sigilOf(openNote.author)} {labelOf(openNote.author)}, in the margin</span>
              <button onClick={() => { setOpenNote(null); setNoteHighlight(null); }} className={cn('rounded-full p-1', colors.textMuted)} aria-label="Close"><X size={16} /></button>
            </div>
            <blockquote
              className={cn('mb-3 border-l-2 pl-3 text-sm italic leading-relaxed opacity-80', colors.textMain)}
              style={{ borderColor: colors.accent, fontFamily: READER_FONT }}
            >
              {openNote.quote}
            </blockquote>
            <p className={cn('mb-4 whitespace-pre-wrap text-sm leading-relaxed', colors.textMain)}>{openNote.note}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void deleteNote(openNote)}
                className={cn('flex items-center gap-1 rounded-xl border px-3 py-2 text-xs', colors.panelBorder, colors.textMuted)}
              >
                <Trash2 size={13} /> Rub out
              </button>
              {noteHighlight && (
                <button
                  onClick={() => { const h = noteHighlight; setOpenNote(null); setNoteHighlight(null); setMarking({ quote: h.quote, highlight: h }); }}
                  className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs', colors.panelBorder, colors.textMain)}
                >
                  <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: `rgb(${HIGHLIGHT_RGB[noteHighlight.color] ?? HIGHLIGHT_RGB.yellow})` }} />
                  Your highlight
                </button>
              )}
              <button
                onClick={() => { const quote = openNote.quote; setOpenNote(null); setSharing({ passage: quote }); }}
                className="ml-auto flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold"
                style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
              >
                <MessageCircleHeart size={14} /> Answer in a thread
              </button>
            </div>
          </div>
        </div>
      )}

      {selection && !sharing && !marking && (
        <div className={cn('absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-2', playerOpen ? 'bottom-20' : 'bottom-6')}>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMarking({ quote: selection })}
            className={cn('flex items-center gap-2 whitespace-nowrap rounded-full border px-4 py-2.5 text-xs font-semibold shadow-xl', colors.panelBorder, colors.textMain)}
            style={{ background: 'var(--bytelight-surface-strong)' }}
          >
            <Highlighter size={15} /> Highlight
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setSharing({ passage: selection })}
            className="flex items-center gap-2 whitespace-nowrap rounded-full px-4 py-2.5 text-xs font-semibold shadow-xl"
            style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
          >
            <MessageCircleHeart size={15} /> Share with them
          </button>
        </div>
      )}

      {marking && (
        <HighlightSheet
          key={marking.highlight?.id ?? 'new'}
          quote={marking.quote}
          highlight={marking.highlight ?? null}
          onSave={(change) => saveHighlight(change)}
          onErase={marking.highlight ? () => eraseHighlight(marking.highlight!) : undefined}
          onShare={() => { const quote = marking.quote; setMarking(null); setSharing({ passage: quote }); }}
          onClose={() => setMarking(null)}
          themeConfig={themeConfig}
          themeMode={themeMode}
        />
      )}

      {toast && (
        <div className={cn('absolute left-1/2 z-30 -translate-x-1/2 rounded-full px-4 py-2 text-xs font-medium shadow-xl', playerOpen ? 'bottom-20' : 'bottom-6')} style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}>
          {toast}
        </div>
      )}

      {sharing && book && chapter && (
        <ShareSheet
          book={book}
          chapter={chapter}
          passage={sharing.passage}
          onClose={() => setSharing(null)}
          onSent={(threadName) => { setSharing(null); window.getSelection()?.removeAllRanges(); flash(`Sent to ${threadName}`); }}
          themeConfig={themeConfig}
          themeMode={themeMode}
        />
      )}
    </AppShell>
  );
}

function HighlightSheet({ quote, highlight, onSave, onErase, onShare, onClose, themeConfig, themeMode }: {
  quote: string;
  /** The highlight being changed; null when making a new one. */
  highlight: Highlight | null;
  onSave: (change: { color: HighlightColor; note: string }) => Promise<void>;
  onErase?: () => Promise<void>;
  onShare: () => void;
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  const [color, setColor] = useState<HighlightColor>(highlight?.color ?? 'yellow');
  const [note, setNote] = useState(highlight?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);

  async function run(job: () => Promise<void>) {
    setBusy(true);
    try { await job(); } finally { setBusy(false); }
  }

  return (
    <div className="absolute inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
      <div className={cn('w-full rounded-t-3xl border-t p-4 pb-8 shadow-2xl', colors.panelBg, colors.panelBorder)} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <span className={cn('text-sm font-semibold', colors.textMain)}>
            {highlight ? (highlight.source === 'kindle' ? 'Your highlight, from Kindle' : 'Your highlight') : 'Highlight this'}
          </span>
          <button onClick={onClose} className={cn('rounded-full p-1', colors.textMuted)} aria-label="Close"><X size={16} /></button>
        </div>
        <blockquote
          className={cn('mb-3 max-h-32 overflow-y-auto rounded-md px-2 py-1 text-sm leading-relaxed', colors.textMain)}
          style={{ background: highlightWash(color, themeMode), fontFamily: READER_FONT }}
        >
          {quote}
        </blockquote>
        <div className="mb-3 flex items-center gap-3" role="radiogroup" aria-label="Color">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={color === c}
              aria-label={HIGHLIGHT_LABEL[c]}
              onClick={() => setColor(c)}
              className="h-8 w-8 rounded-full border-2 transition-transform"
              style={{
                background: `rgb(${HIGHLIGHT_RGB[c]})`,
                borderColor: color === c ? colors.accent : 'transparent',
                transform: color === c ? 'scale(1.1)' : undefined,
              }}
            />
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="A note for yourself (optional)"
          className={cn('mb-3 w-full rounded-xl border bg-transparent px-3 py-2 text-sm', colors.panelBorder, colors.textMain)}
        />
        <div className="flex flex-wrap items-center gap-2">
          {onErase && (
            <button
              onClick={() => (confirmErase ? void run(onErase) : setConfirmErase(true))}
              disabled={busy}
              className={cn('flex items-center gap-1 rounded-xl border px-3 py-2 text-xs disabled:opacity-50', colors.panelBorder, confirmErase ? colors.textMain : colors.textMuted)}
            >
              <Trash2 size={13} /> {confirmErase ? 'Tap again to erase' : 'Erase'}
            </button>
          )}
          <button
            onClick={onShare}
            className={cn('flex items-center gap-1 rounded-xl border px-3 py-2 text-xs', colors.panelBorder, colors.textMain)}
          >
            <MessageCircleHeart size={13} /> Share with them
          </button>
          <button
            onClick={() => void run(() => onSave({ color, note }))}
            disabled={busy}
            className="ml-auto flex items-center gap-1 rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-50"
            style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
          >
            {busy && <Loader2 size={12} className="animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ShareSheet({ book, chapter, passage, onClose, onSent, themeConfig, themeMode }: {
  book: BookInfo;
  chapter: Chapter;
  passage: string;
  onClose: () => void;
  onSent: (threadName: string) => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  const threads = useThreads();
  const home = useRoutingThreadId();
  const active = useActiveThreadId();
  const [threadId, setThreadId] = useState<string>(home || active || threads[0]?.id || '');
  const [note, setNote] = useState('');
  const isPlace = !passage;

  function send() {
    if (!threadId) return;
    const where = `Chapter ${chapter.index + 1} of ${chapter.count}${chapter.title ? ` (${chapter.title})` : ''}`;
    const content = isPlace
      ? `📖 I'm reading *${book.title}*${book.authors.length ? ` by ${book.authors.join(', ')}` : ''} — ${where}.${note.trim() ? `\n\n${note.trim()}` : ''}`
      : passageMessage(book, chapter.title, passage, note);
    sendUserMessageToThread(threadId, content, 'text', {
      library: { bookId: book.id, title: book.title, chapter: chapter.index, chapterTitle: chapter.title, kind: isPlace ? 'place' : 'passage' },
    });
    onSent(threads.find((t) => t.id === threadId)?.name ?? 'the thread');
  }

  return (
    <div className="absolute inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
      <div
        className={cn('w-full rounded-t-3xl border-t p-4 pb-8 shadow-2xl', colors.panelBg, colors.panelBorder)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className={cn('text-sm font-semibold', colors.textMain)}>{isPlace ? 'Tell them where you are' : 'Share this passage'}</span>
          <button onClick={onClose} className={cn('rounded-full p-1', colors.textMuted)}><X size={16} /></button>
        </div>
        {!isPlace && (
          <blockquote
            className={cn('mb-3 max-h-40 overflow-y-auto border-l-2 pl-3 text-sm italic leading-relaxed', colors.textMain)}
            style={{ borderColor: colors.accent, fontFamily: READER_FONT }}
          >
            {passage}
          </blockquote>
        )}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder={isPlace ? 'Anything to add? (optional)' : 'Your thoughts… (optional)'}
          className={cn('mb-3 w-full rounded-xl border bg-transparent px-3 py-2 text-sm', colors.panelBorder, colors.textMain)}
        />
        <div className="flex items-center gap-2">
          <select
            value={threadId}
            onChange={(e) => setThreadId(e.target.value)}
            className={cn('min-w-0 flex-1 rounded-xl border bg-transparent px-3 py-2 text-xs', colors.panelBorder, colors.textMain)}
          >
            {threads.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.id === home ? ' (Home)' : ''}</option>
            ))}
          </select>
          <button
            onClick={send}
            disabled={!threadId}
            className="rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-50"
            style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
