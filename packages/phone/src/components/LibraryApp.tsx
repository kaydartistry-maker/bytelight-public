// The Library — a reading room. Shelve public-domain books from Project
// Gutenberg, read them here with the bookmark kept on the house, and hand a
// passage (or just where you are) to the companions in a thread so they read
// along with you. They can be read aloud by a companion's voice, and leave
// margin notes underlined on the page — never past her bookmark, which the
// house enforces. Backed by /api/library (backend routes/library.ts).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Library, Search, Loader2, Plus, X, ChevronLeft, ChevronRight, List, MessageCircleHeart, Bookmark, Headphones, Play, Pause, SkipBack, SkipForward, Trash2 } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch, sendUserMessageToThread, useThreads, useRoutingThreadId, useActiveThreadId } from '../bytelight';
import { useHouseRoster } from '../lib/house';
import { markQuotes, segmentForParagraph, type MarginNote, type Segment } from '../lib/library-reader';

interface LibraryAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

interface Progress { chapter: number; fraction: number; updatedAt: string }
interface ShelfBook { id: number; title: string; authors: string[]; cover: string | null; chapterCount: number; addedAt: string; progress: Progress | null }
interface CatalogBook { id: number; title: string; authors: string[]; cover: string | null; languages: string[]; downloads: number }
interface BookInfo { id: number; title: string; authors: string[]; cover: string | null; chapters: Array<{ title: string; length: number }>; progress: Progress | null }
interface Chapter { index: number; title: string; text: string; count: number; paragraphs?: string[]; segments?: Segment[] }

const READER_FONT = "'Fraunces', Georgia, 'Times New Roman', serif";
const VOICE_KEY = 'bytelight.library.voice';

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

  const loadShelf = useCallback(async () => {
    try {
      const res = await apiFetch('/api/library/shelf');
      const data = res.ok ? await res.json() : { books: [] };
      setShelf(Array.isArray(data.books) ? data.books : []);
    } catch {
      setShelf([]);
    }
  }, []);

  useEffect(() => { void loadShelf(); }, [loadShelf]);

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
    <AppShell title="Library" icon={Library} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
      <div className={cn('p-3 rounded-2xl border backdrop-blur-md mb-4 flex justify-center', colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5">
          {(['shelf', 'find'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn('rounded-lg px-4 py-1.5 text-xs font-medium border capitalize', colors.panelBorder, tab !== t && cn(colors.panelBg, colors.textMain))}
              style={tab === t ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
            >
              {t === 'shelf' ? 'Shelf' : 'Find a book'}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mb-3 text-xs" style={{ color: colors.accent }}>{error}</p>}

      {tab === 'shelf' && (
        <ShelfView
          shelf={shelf}
          onOpen={setReading}
          onFind={() => setTab('find')}
          onRemove={async (id) => {
            if (!window.confirm('Take this book off the shelf? Your bookmark goes with it.')) return;
            await apiFetch(`/api/library/shelf/${id}`, { method: 'DELETE' });
            void loadShelf();
          }}
          themeConfig={themeConfig}
          themeMode={themeMode}
        />
      )}
      {tab === 'find' && (
        <FindView
          shelvedIds={new Set((shelf ?? []).map((b) => b.id))}
          onShelved={async (id) => { await loadShelf(); setReading(id); }}
          onError={setError}
          themeConfig={themeConfig}
          themeMode={themeMode}
        />
      )}
    </AppShell>
  );
}

function ShelfView({ shelf, onOpen, onFind, onRemove, themeConfig, themeMode }: {
  shelf: ShelfBook[] | null;
  onOpen: (id: number) => void;
  onFind: () => void;
  onRemove: (id: number) => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  if (shelf === null) {
    return <div className={cn('flex items-center justify-center gap-2 py-10 text-xs', colors.textMuted)}><Loader2 size={14} className="animate-spin" /> Opening the shelf…</div>;
  }
  if (shelf.length === 0) {
    return (
      <div className={cn('rounded-2xl border p-6 text-center backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <p className={cn('mb-1 text-sm font-semibold', colors.textMain)} style={{ fontFamily: READER_FONT }}>An empty shelf.</p>
        <p className={cn('mb-4 text-xs', colors.textMuted)}>Tens of thousands of public-domain classics are free to read together.</p>
        <button onClick={onFind} className="rounded-lg px-4 py-2 text-xs font-semibold" style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}>
          Find a book
        </button>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-3">
      {shelf.map((b) => (
        <div key={b.id} className="group relative">
          <button onClick={() => onOpen(b.id)} className="block w-full text-left">
            <BookCover book={b} className="aspect-[2/3] w-full rounded-lg shadow-lg" />
            <div className={cn('mt-1.5 line-clamp-2 text-[11px] font-semibold leading-tight', colors.textMain)}>{b.title}</div>
            <div className={cn('text-[10px]', colors.textMuted)}>
              {b.progress ? `Ch. ${b.progress.chapter + 1} of ${b.chapterCount}` : 'Not started'}
            </div>
          </button>
          <button
            onClick={() => onRemove(b.id)}
            className="absolute right-1 top-1 rounded-full bg-black/50 p-1 text-white opacity-70 hover:opacity-100"
            aria-label={`Remove ${b.title}`}
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

function FindView({ shelvedIds, onShelved, onError, themeConfig, themeMode }: {
  shelvedIds: Set<number>;
  onShelved: (id: number) => void;
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
      onShelved(id);
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

  // Read-aloud: one ~1200-character piece at a time, rendered by the house in
  // the chosen companion's voice and cached there.
  const [playerOpen, setPlayerOpen] = useState(false);
  const [voice, setVoice] = useState<string>(() => {
    try { return localStorage.getItem(VOICE_KEY) || ''; } catch { return ''; }
  });
  const [playing, setPlaying] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [segIndex, setSegIndex] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playToken = useRef(0);
  const chapterRef = useRef<Chapter | null>(null);
  const voiceRef = useRef(voice);
  const keepReading = useRef(false);
  chapterRef.current = chapter;
  voiceRef.current = voice;

  const stopReading = useCallback(() => {
    playToken.current++;
    audioRef.current?.pause();
    setPlaying(false);
    setRendering(false);
  }, []);

  useEffect(() => () => { playToken.current++; audioRef.current?.pause(); }, []);

  // Someone to read: keep her pick if they still live here, else the first.
  useEffect(() => {
    if (companions.length && !companions.some((c) => c.slug === voice)) setVoice(companions[0].slug);
  }, [companions, voice]);

  const openChapter = useCallback(async (n: number, fraction = 0) => {
    if (!keepReading.current) stopReading();
    setSegIndex(null);
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
  }, [bookId, stopReading]);

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

  const notesByParagraph = useMemo(() => {
    const map = new Map<number, MarginNote[]>();
    for (const note of notes) map.set(note.paragraph, [...(map.get(note.paragraph) ?? []), note]);
    return map;
  }, [notes]);

  async function deleteNote(note: MarginNote) {
    if (!window.confirm('Rub this note out of the margin?')) return;
    await apiFetch(`/api/library/books/${bookId}/notes/${encodeURIComponent(note.id)}`, { method: 'DELETE' }).catch(() => null);
    setOpenNote(null);
    setNotes((prev) => prev.filter((n) => n.id !== note.id));
  }

  // ── read-aloud ──
  async function renderPiece(ch: number, s: number): Promise<string> {
    const res = await apiFetch(`/api/library/books/${bookId}/chapters/${ch}/segments/${s}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: voiceRef.current }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error === 'voice_unavailable' ? 'Read-aloud needs a voice set up on the house.' : data.error || 'Read-aloud failed');
    }
    return data.url as string;
  }

  async function playPiece(s: number) {
    const ch = chapterRef.current;
    if (!ch || !voiceRef.current) return;
    const segs = chapterSegments(ch);
    if (s >= segs.length) {
      // The chapter's done — turn the page and keep going.
      if (ch.index < ch.count - 1) {
        keepReading.current = true;
        saveProgress(ch.index + 1, 0);
        void openChapter(ch.index + 1);
      } else {
        stopReading();
        flash('The end.');
      }
      return;
    }
    const token = ++playToken.current;
    setSegIndex(s);
    setPlaying(true);
    setRendering(true);
    try {
      const url = await renderPiece(ch.index, s);
      if (token !== playToken.current) return;
      const audio = audioRef.current ?? (audioRef.current = new Audio());
      audio.src = url;
      audio.onended = () => { if (token === playToken.current) void playPiece(s + 1); };
      await audio.play();
      setRendering(false);
      // Have the next piece ready before this one ends.
      if (s + 1 < segs.length) void renderPiece(ch.index, s + 1).catch(() => {});
    } catch (err) {
      if (token !== playToken.current) return;
      stopReading();
      flash(err instanceof Error ? err.message : 'Read-aloud failed');
    }
  }

  // After an auto page-turn, pick the voice back up at the top.
  useEffect(() => {
    if (chapter && keepReading.current) {
      keepReading.current = false;
      void playPiece(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter]);

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

  function togglePlay() {
    const audio = audioRef.current;
    if (playing) {
      if (rendering) { stopReading(); return; }
      audio?.pause();
      setPlaying(false);
      return;
    }
    if (audio && segIndex !== null && audio.src && !audio.ended) {
      setPlaying(true);
      void audio.play().catch(() => setPlaying(false));
      return;
    }
    void playPiece(segmentForParagraph(segments, firstVisibleParagraph()));
  }

  function chooseVoice(slug: string) {
    setVoice(slug);
    voiceRef.current = slug;
    try { localStorage.setItem(VOICE_KEY, slug); } catch { /* a convenience only */ }
    // Swap readers mid-page: the new voice picks up the same piece.
    if (playing && segIndex !== null) void playPiece(segIndex);
    else if (audioRef.current) audioRef.current.removeAttribute('src');
  }

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
          <button
            onClick={() => { if (playerOpen) stopReading(); setPlayerOpen((v) => !v); }}
            className={cn('rounded-full p-2', colors.textMuted)}
            style={playerOpen ? { color: colors.accent } : undefined}
            title="Read aloud"
            aria-label="Read aloud"
          >
            <Headphones size={17} />
          </button>
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
                  {markQuotes(p, notesByParagraph.get(i) ?? []).map((piece, k) => (piece.note ? (
                    <span key={k} role="button" onClick={() => setOpenNote(piece.note!)} className="cursor-pointer">
                      <span style={{ textDecorationLine: 'underline', textDecorationColor: colors.accent, textDecorationThickness: '2px', textUnderlineOffset: '4px' }}>
                        {piece.text}
                      </span>
                      <sup className="ml-0.5 select-none text-[10px]" aria-label={`Note from ${labelOf(piece.note.author)}`}>{sigilOf(piece.note.author)}</sup>
                    </span>
                  ) : (
                    <React.Fragment key={k}>{piece.text}</React.Fragment>
                  )))}
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

      {playerOpen && (
        <div className={cn('absolute inset-x-3 bottom-4 z-30 flex items-center gap-2 rounded-2xl border px-3 py-2 shadow-xl backdrop-blur-xl', colors.panelBg, colors.panelBorder)}>
          <select
            value={voice}
            onChange={(e) => chooseVoice(e.target.value)}
            aria-label="Who reads"
            className={cn('min-w-0 max-w-[7.5rem] flex-1 rounded-lg border bg-transparent px-2 py-1.5 text-xs', colors.panelBorder, colors.textMain)}
          >
            {companions.map((c) => <option key={c.slug} value={c.slug}>{c.display_name || c.slug}</option>)}
          </select>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => void playPiece(Math.max(0, (segIndex ?? 0) - 1))}
              disabled={!voice || segIndex === null || segIndex === 0}
              className={cn('rounded-full p-2 disabled:opacity-30', colors.textMain)}
              aria-label="Back a piece"
            >
              <SkipBack size={16} />
            </button>
            <button
              onClick={togglePlay}
              disabled={!voice}
              className="rounded-full p-2.5 disabled:opacity-40"
              style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
              aria-label={playing ? 'Pause' : 'Read to me'}
            >
              {rendering ? <Loader2 size={16} className="animate-spin" /> : playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button
              onClick={() => void playPiece((segIndex ?? -1) + 1)}
              disabled={!voice || segIndex === null}
              className={cn('rounded-full p-2 disabled:opacity-30', colors.textMain)}
              aria-label="On a piece"
            >
              <SkipForward size={16} />
            </button>
          </div>
          <span className={cn('w-10 text-right text-[10px] tabular-nums', colors.textMuted)}>
            {segIndex !== null ? `${segIndex + 1}/${segments.length}` : `${segments.length}`}
          </span>
        </div>
      )}

      {openNote && (
        <div className="absolute inset-0 z-40 flex items-end bg-black/40" onClick={() => setOpenNote(null)}>
          <div className={cn('w-full rounded-t-3xl border-t p-4 pb-8 shadow-2xl', colors.panelBg, colors.panelBorder)} onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className={cn('text-sm font-semibold', colors.textMain)}>{sigilOf(openNote.author)} {labelOf(openNote.author)}, in the margin</span>
              <button onClick={() => setOpenNote(null)} className={cn('rounded-full p-1', colors.textMuted)} aria-label="Close"><X size={16} /></button>
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

      {selection && !sharing && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setSharing({ passage: selection })}
          className={cn('absolute left-1/2 z-30 flex -translate-x-1/2', playerOpen ? 'bottom-20' : 'bottom-6', ' items-center gap-2 rounded-full px-4 py-2.5 text-xs font-semibold shadow-xl')}
          style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
        >
          <MessageCircleHeart size={15} /> Share with them
        </button>
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
