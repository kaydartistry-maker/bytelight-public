// The Library — authenticated routes for the phone's reading room.
// Mounted under /api/library after authMiddleware (routes/api.ts).

import { Router } from 'express';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  searchCatalog,
  fetchAndShelve,
  readShelf,
  readBook,
  removeBook,
  setProgress,
  setShelf,
  setReview,
  LibraryError,
  shelveUpload,
  fillSpineColors,
  coversDir,
  COVER_FILE_RE,
  paragraphsOf,
  segmentsOf,
  audioDir,
  audioFileName,
  AUDIO_FILE_RE,
  readNotes,
  removeNote,
  readHighlights,
  addHighlight,
  updateHighlight,
  removeHighlight,
  importKindleNotebook,
  readKindleCard,
  findKindleCover,
  shelveWaitingNotebooks,
} from '../services/library.js';
import { parseKindleNotebook, extractPdfText, KindleError, MAX_NOTEBOOK_BYTES } from '../services/library-kindle.js';
import type { VoiceService } from '../services/voice.js';
import multer from 'multer';
import { EpubError, MAX_EPUB_BYTES } from '../services/library-epub.js';

const router = Router();

function bookId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Search Project Gutenberg's catalog (via Gutendex). Plain-text books only —
// those are the ones the reader can open.
router.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) return res.json({ results: [] });
  try {
    res.json({ results: await searchCatalog(q) });
  } catch (err) {
    console.error('[library] search failed:', err);
    res.status(502).json({ error: 'The Gutenberg catalog could not be reached' });
  }
});

router.get('/shelf', (_req, res) => {
  // Once: Kindle highlights kept before notebook cards existed get their card.
  let made: Array<{ id: number }> = [];
  try {
    made = shelveWaitingNotebooks();
  } catch (err) {
    console.warn('[library] waiting Kindle notebooks could not be shelved:', err);
  }
  const books = readShelf();
  res.json({ books });
  // Their covers are looked up in the background; the next look shows them.
  if (made.length) {
    void Promise.all(made.map((c) => findKindleCover(c.id))).then(() => fillSpineColors()).catch(() => {});
  }
  // Spines without a cover color get one in the background; the next look shows it.
  if (books.some((b) => b.spineColor === undefined)) {
    fillSpineColors().catch((err) => console.warn('[library] spine colors failed:', err));
  }
});

// Shelve a Gutenberg book: fetch its text once, split it into chapters.
// Re-shelving refreshes the text and keeps the bookmark.
router.post('/shelf', async (req, res) => {
  const id = bookId(req.body?.id);
  if (!id) return res.status(400).json({ error: 'A Gutenberg book id is required' });
  try {
    res.status(201).json({ book: await fetchAndShelve(id) });
  } catch (err) {
    console.error('[library] shelve failed:', err);
    res.status(502).json({ error: err instanceof Error ? err.message : 'Could not fetch that book' });
  }
});

// Her own book: an EPUB uploaded from the phone lands on To Be Read.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_EPUB_BYTES, files: 1 } });
router.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? 'That book is too large (60 MB max)' : 'The upload did not come through' });
    }
    const file = (req as typeof req & { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: 'Pick an EPUB to upload' });
    if (/\.(pdf|mobi|azw3?|kfx)$/i.test(file.originalname)) {
      return res.status(400).json({ error: 'The Library reads EPUB files for now — PDF and Kindle formats are coming' });
    }
    try {
      res.status(201).json({ book: shelveUpload(new Uint8Array(file.buffer)) });
    } catch (e) {
      if (e instanceof EpubError) return res.status(400).json({ error: e.message });
      console.error('[library] upload failed:', e);
      res.status(500).json({ error: 'That book could not be shelved' });
    }
  });
});

router.get('/covers/:file', (req, res) => {
  const file = String(req.params.file);
  if (!COVER_FILE_RE.test(file)) return res.status(400).json({ error: 'Bad file' });
  const path = join(coversDir(), file);
  if (!existsSync(path)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path);
});

router.delete('/shelf/:id', (req, res) => {
  const id = bookId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad book id' });
  res.json({ removed: removeBook(id) });
});

// A book's table of contents and bookmark — chapter text is fetched one
// chapter at a time so a long novel never ships whole to the phone.
router.get('/books/:id', (req, res) => {
  const id = bookId(req.params.id);
  const book = id ? readBook(id) : null;
  if (!book) return res.status(404).json({ error: 'Not on the shelf' });
  const entry = readShelf().find((e) => e.id === book.id) ?? null;
  res.json({
    id: book.id,
    title: book.title,
    authors: book.authors,
    cover: book.cover,
    chapters: book.chapters.map((c) => ({ title: c.title, length: c.text.length })),
    progress: entry?.progress ?? null,
  });
});

router.get('/books/:id/chapters/:n', (req, res) => {
  const id = bookId(req.params.id);
  const book = id ? readBook(id) : null;
  const n = Number(req.params.n);
  if (!book || !Number.isInteger(n) || n < 0 || n >= book.chapters.length) {
    return res.status(404).json({ error: 'No such chapter' });
  }
  const paragraphs = paragraphsOf(book.chapters[n].text);
  res.json({
    index: n,
    title: book.chapters[n].title,
    text: book.chapters[n].text,
    count: book.chapters.length,
    // The one paragraph count every side shares — the reader, read-aloud,
    // and the companions' reach and notes all index into this.
    paragraphs,
    segments: segmentsOf(paragraphs),
  });
});

// Read one piece of a chapter aloud in a companion's voice. Rendered once,
// then cached beside the shelf, so turning back costs nothing.
const inFlight = new Map<string, Promise<void>>();

router.post('/books/:id/chapters/:n/segments/:s/tts', async (req, res) => {
  const id = bookId(req.params.id);
  const book = id ? readBook(id) : null;
  const n = Number(req.params.n);
  const segIndex = Number(req.params.s);
  const voice = typeof req.body?.voice === 'string' ? req.body.voice.trim().toLowerCase() : '';
  if (!book || !Number.isInteger(n) || n < 0 || n >= book.chapters.length) return res.status(404).json({ error: 'No such chapter' });
  if (!/^[a-z0-9_-]{1,32}$/.test(voice)) return res.status(400).json({ error: 'Pick who reads (a companion slug)' });
  const paragraphs = paragraphsOf(book.chapters[n].text);
  const segments = segmentsOf(paragraphs);
  if (!Number.isInteger(segIndex) || segIndex < 0 || segIndex >= segments.length) return res.status(404).json({ error: 'No such piece' });

  const name = audioFileName(book.id, n, segIndex, voice);
  const dir = audioDir();
  const path = join(dir, name);
  const url = `/api/library/audio/${name}`;
  if (existsSync(path)) return res.json({ url, cached: true });

  const voiceService = req.app.locals.voiceService as VoiceService | undefined;
  if (!voiceService?.canTTS) return res.status(503).json({ error: 'voice_unavailable' });

  try {
    // Two taps (or a prefetch racing a tap) render once.
    let job = inFlight.get(name);
    if (!job) {
      const { from, to } = segments[segIndex];
      const text = paragraphs.slice(from, to + 1).join('\n\n');
      job = voiceService.generateTTS(text, voice).then((buffer) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, buffer);
      }).finally(() => inFlight.delete(name));
      inFlight.set(name, job);
    }
    await job;
    res.json({ url, cached: false });
  } catch (err) {
    console.error('[library] read-aloud failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Read-aloud failed' });
  }
});

router.get('/audio/:file', (req, res) => {
  const file = String(req.params.file);
  if (!AUDIO_FILE_RE.test(file)) return res.status(400).json({ error: 'Bad file' });
  const path = join(audioDir(), file);
  if (!existsSync(path)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.type('audio/mpeg').sendFile(path);
});

// Margin notes the companions left (they write through /api/internal/library).
router.get('/books/:id/notes', (req, res) => {
  const id = bookId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad book id' });
  const chapter = req.query.chapter !== undefined ? Number(req.query.chapter) : null;
  const notes = readNotes(id);
  res.json({ notes: chapter === null ? notes : notes.filter((note) => note.chapter === chapter) });
});

router.delete('/books/:id/notes/:noteId', (req, res) => {
  const id = bookId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad book id' });
  res.json({ removed: removeNote(id, String(req.params.noteId)) });
});

// Her own highlights (made in the reader, or brought in from Kindle).
router.get('/books/:id/highlights', (req, res) => {
  const id = bookId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad book id' });
  const chapter = req.query.chapter !== undefined ? Number(req.query.chapter) : null;
  const list = readHighlights(id);
  res.json({ highlights: chapter === null ? list : list.filter((h) => h.chapter === chapter) });
});

router.post('/books/:id/highlights', (req, res) => {
  const id = bookId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad book id' });
  try {
    res.status(201).json({ highlight: addHighlight(id, req.body ?? {}) });
  } catch (err) {
    if (err instanceof LibraryError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

router.patch('/books/:id/highlights/:hid', (req, res) => {
  const id = bookId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad book id' });
  try {
    const h = updateHighlight(id, String(req.params.hid), { color: req.body?.color, note: req.body?.note });
    if (!h) return res.status(404).json({ error: 'That highlight is gone' });
    res.json({ highlight: h });
  } catch (err) {
    if (err instanceof LibraryError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

router.delete('/books/:id/highlights/:hid', (req, res) => {
  const id = bookId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad book id' });
  res.json({ removed: removeHighlight(id, String(req.params.hid)) });
});

// A Kindle notebook (the PDF "Export Notebook" sends): its highlights go
// onto the matching book, or wait for it to be shelved.
const notebookUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_NOTEBOOK_BYTES, files: 1 } });
router.post('/kindle-import', (req, res) => {
  notebookUpload.single('file')(req, res, async (err: unknown) => {
    if (err) {
      const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? 'That PDF is too large for a notebook (10 MB max)' : 'The upload did not come through. Try again?' });
    }
    const file = (req as typeof req & { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: 'Pick the notebook PDF the Kindle app sent you' });
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(400).json({ error: 'That isn\'t a PDF. In the Kindle app, open the book\'s notebook, tap Export, and pick the PDF it sends.' });
    }
    try {
      const notebook = parseKindleNotebook(await extractPdfText(new Uint8Array(file.buffer)));
      const result = importKindleNotebook(notebook);
      // A new notebook card gets a cover if Open Library has one (short
      // timeouts; none found is fine).
      if (result.notebookCard && result.book) await findKindleCover(result.book.id);
      res.json({
        book: result.book,
        notebookTitle: result.notebookTitle,
        added: result.added,
        duplicates: result.duplicates,
        unplaced: result.unplaced,
        bookmarks: result.bookmarks,
        pending: result.pending,
        notebookCard: result.notebookCard ?? null,
      });
    } catch (e) {
      if (e instanceof KindleError) return res.status(400).json({ error: e.message });
      console.error('[library] Kindle import failed:', e);
      res.status(500).json({ error: 'Those highlights could not be brought in. Try again?' });
    }
  });
});

// A Kindle notebook card's page: the highlights from its notebook, waiting
// for the real text. 404 for books that have text (they open in the reader).
router.get('/books/:id/notebook', (req, res) => {
  const id = bookId(req.params.id);
  const card = id ? readKindleCard(id) : null;
  if (!card) return res.status(404).json({ error: 'Not a Kindle notebook on the shelf' });
  res.json(card);
});

// Move a book between shelves (reading / tbr / finished / dnf) and/or star it.
router.put('/books/:id/shelf', (req, res) => {
  const id = bookId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad book id' });
  try {
    const entry = setShelf(id, { shelf: req.body?.shelf, favorite: req.body?.favorite });
    if (!entry) return res.status(404).json({ error: 'Not on the shelf' });
    res.json({ book: entry });
  } catch (err) {
    if (err instanceof LibraryError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// Her rating and review: { stars: 1-5, text? }, or { stars: null } to clear it.
router.put('/books/:id/review', (req, res) => {
  const id = bookId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad book id' });
  try {
    const entry = setReview(id, { stars: req.body?.stars, text: req.body?.text });
    if (!entry) return res.status(404).json({ error: 'Not on the shelf' });
    res.json({ book: entry });
  } catch (err) {
    if (err instanceof LibraryError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

router.put('/books/:id/progress', (req, res) => {
  const id = bookId(req.params.id);
  const chapter = Number(req.body?.chapter);
  const fraction = Number(req.body?.fraction ?? 0);
  if (!id || !Number.isFinite(chapter) || !Number.isFinite(fraction)) {
    return res.status(400).json({ error: 'chapter and fraction are required' });
  }
  const entry = setProgress(id, chapter, fraction);
  if (!entry) return res.status(404).json({ error: 'Not on the shelf' });
  res.json({ progress: entry.progress });
});

export default router;
