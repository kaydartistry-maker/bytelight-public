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
  paragraphsOf,
  segmentsOf,
  audioDir,
  audioFileName,
  AUDIO_FILE_RE,
  readNotes,
  removeNote,
} from '../services/library.js';
import type { VoiceService } from '../services/voice.js';

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
  res.json({ books: readShelf() });
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
