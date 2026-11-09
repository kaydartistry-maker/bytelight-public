// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { Router, type Response } from 'express';
import { requireLocalhost } from '../../middleware/localhost.js';
import { createStoryBook, createStoryKeepsake, finishStoryBook, weaveStoryKeepsake } from '../../services/db/story-shelf.js';
import { hangStoryScenePicture, notifyStory, setStoryCoverFromGallery, storyBookView, storyShelfView, summaryOf, writeStoryScene } from '../../services/story-shelf.js';

import { StoryShelfError } from '../../services/db/story-shelf.js';

const router = Router();

// ─── The Story Shelf ───────────────────────────────────────
// Choose-your-own-path books the companions write and run. They shelve books,
// write scenes, hang pictures, finish books and tie keepsakes between them
// here; their person reads and makes the moves through /api/story-shelf
// (routes/story-shelf.ts), which hands this lane a page turn. The rules live
// in services/db/story-shelf.ts and the page turns and gallery lookups in
// services/story-shelf.ts. Every write tells the phone with `story_update`.
// A write answers with the book as the shelf lists it, not the whole book, so
// a long book is not read back into the lane after every page.
//
// byte-light adaptation (ported from Aerie): each route carries byte-light's
// requireLocalhost middleware in place of Aerie's inline isLocalhost(req)
// check (byte-light's isLocalhost takes an address, not a request); the
// refusal is the same 403 { error: 'Localhost only' }. Mounted inside
// createInternalRoutes() (routes/internal-routes.ts), ahead of the auth
// boundary in api.ts, like every other /api/internal route here. With the
// middleware in the chain express types req.params.id as string | string[],
// so it is read through String(), as routes/notes.ts does.

function answerStoryError(res: Response, error: unknown, what: string): void {
  if (error instanceof StoryShelfError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[story-shelf] could not ${what}:`, error);
  res.status(500).json({ error: `Something went wrong on the shelf while trying to ${what}; the server log has the details.` });
}

router.get('/internal/story-shelf', requireLocalhost, (req, res) => {
  try {
    res.json(storyShelfView());
  } catch (error) {
    answerStoryError(res, error, 'read the shelf');
  }
});

/** One book, whole: its bible, every page, its keepsakes and the talk on its newest page turn. */
router.get('/internal/story-shelf/books/:id', requireLocalhost, (req, res) => {
  try {
    const view = storyBookView(String(req.params.id));
    if (!view) {
      res.status(404).json({ error: 'There is no book with that id on the shelf.' });
      return;
    }
    res.json(view);
  } catch (error) {
    answerStoryError(res, error, 'read the book');
  }
});

/** Put a new book on the shelf. Its opening is asked for when their person begins it. */
router.post('/internal/story-shelf/books', requireLocalhost, (req, res) => {
  const { maker, title, genre, spicy, blurb, bible } = req.body ?? {};
  try {
    const book = createStoryBook({ maker, title, genre, spicy, blurb, bible });
    notifyStory(book.id);
    res.status(201).json({ book: summaryOf(book) });
  } catch (error) {
    answerStoryError(res, error, 'shelve the book');
  }
});

/** Hang a cover from the Studio gallery. */
router.post('/internal/story-shelf/books/:id/cover', requireLocalhost, async (req, res) => {
  const { maker, filename } = req.body ?? {};
  try {
    res.json({ book: await setStoryCoverFromGallery({ maker, bookId: String(req.params.id), filename }) });
  } catch (error) {
    answerStoryError(res, error, 'hang the cover');
  }
});

/** Write a scene: its words, and optionally choices, a state card, a widget and a picture from the gallery. */
router.post('/internal/story-shelf/books/:id/pages', requireLocalhost, async (req, res) => {
  const { maker, text, picture, state, choices, widget } = req.body ?? {};
  try {
    res.status(201).json(await writeStoryScene({ maker, bookId: String(req.params.id), text, picture, state, choices, widget }));
  } catch (error) {
    answerStoryError(res, error, 'write the scene');
  }
});

/** Put a picture from the gallery on a scene already written. */
router.post('/internal/story-shelf/pages/:id/picture', requireLocalhost, async (req, res) => {
  const { maker, filename } = req.body ?? {};
  try {
    res.json(await hangStoryScenePicture({ maker, pageId: String(req.params.id), filename }));
  } catch (error) {
    answerStoryError(res, error, 'hang the picture');
  }
});

/** Close a book. It stays on the shelf, finished. */
router.post('/internal/story-shelf/books/:id/finish', requireLocalhost, (req, res) => {
  const { maker } = req.body ?? {};
  try {
    const book = finishStoryBook(String(req.params.id), { maker });
    notifyStory(book.id);
    res.json({ book: summaryOf(book) });
  } catch (error) {
    answerStoryError(res, error, 'finish the book');
  }
});

/** Tie a keepsake found in one book; give toBookId to weave it into another at once. */
router.post('/internal/story-shelf/keepsakes', requireLocalhost, (req, res) => {
  const { maker, fromBookId, item, note, toBookId } = req.body ?? {};
  try {
    const keepsake = createStoryKeepsake({ maker, fromBookId, item, note, toBookId });
    notifyStory(null);
    res.status(201).json({ keepsake });
  } catch (error) {
    answerStoryError(res, error, 'tie the keepsake');
  }
});

/** The keepsake turns up in a second book. */
router.post('/internal/story-shelf/keepsakes/:id/weave', requireLocalhost, (req, res) => {
  const { maker, toBookId, note } = req.body ?? {};
  try {
    const keepsake = weaveStoryKeepsake(String(req.params.id), { maker, toBookId, note });
    notifyStory(null);
    res.json({ keepsake });
  } catch (error) {
    answerStoryError(res, error, 'weave the keepsake');
  }
});

export default router;
