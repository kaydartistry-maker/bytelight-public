// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Story Shelf — their person's door: read the shelf, walk into a book, make a move.
//
// Their person reads and moves, and never writes a scene. The companions write through
// /api/internal/story-shelf (routes/internal/story-shelf.ts). Beginning a new book, a
// move, and asking again each hand the companions' lane a page turn, which
// answers on its own time: these doors answer as soon as the move is in, and
// the phone re-reads whenever a `story_update` arrives.

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { StoryShelfError } from '../services/db/story-shelf.js';
import {
  askStoryAgain,
  makeStoryMove,
  openStoryBook,
  storyBookView,
  storyShelfView,
  talkAtStoryTable,
  type StoryLane,
} from '../services/story-shelf.js';

const router = Router();
router.use(authMiddleware);

function answerError(res: Response, error: unknown, what: string): void {
  if (error instanceof StoryShelfError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[story-shelf] could not ${what}:`, error);
  res.status(500).json({ error: `The shelf could not ${what} just now; the server log has the details.` });
}

/** The companions' lane, or a plain refusal when this house is running without one. */
function laneFor(req: Request, res: Response): StoryLane | null {
  const lane = req.app.locals.agentService as StoryLane | undefined;
  if (lane) return lane;
  res.status(503).json({ error: 'The companions’ lane is not available, so no page can be asked for just now.' });
  return null;
}

router.get('/', (_req, res) => {
  try {
    res.json(storyShelfView());
  } catch (error) {
    answerError(res, error, 'read the shelf');
  }
});

router.get('/books/:id', (req, res) => {
  try {
    const view = storyBookView(req.params.id);
    if (!view) {
      res.status(404).json({ error: 'There is no book with that id on the shelf.' });
      return;
    }
    res.json(view);
  } catch (error) {
    answerError(res, error, 'open that book');
  }
});

/** Their person opened a book. One with no opening yet (their Begin) asks the companions for it; a started book asks for nothing. */
router.post('/books/:id/open', (req, res) => {
  const lane = laneFor(req, res);
  if (!lane) return;
  try {
    res.json(openStoryBook(lane, req.params.id));
  } catch (error) {
    answerError(res, error, 'open that book');
  }
});

/** Their person's move: { choiceId } for a choice the newest scene offers, or { text } in their own words. */
router.post('/books/:id/move', (req, res) => {
  const lane = laneFor(req, res);
  if (!lane) return;
  const { choiceId, text } = req.body ?? {};
  try {
    res.status(202).json({ view: makeStoryMove(lane, req.params.id, { choiceId, text }) });
  } catch (error) {
    answerError(res, error, 'take that move');
  }
});

/** Their person's table talk: { text }, said while reading. Talk, not a move, so no page is asked for. */
router.post('/books/:id/talk', (req, res) => {
  const lane = laneFor(req, res);
  if (!lane) return;
  try {
    res.status(202).json({ view: talkAtStoryTable(lane, req.params.id, { text: req.body?.text }) });
  } catch (error) {
    answerError(res, error, 'take that');
  }
});

/** Ask again for a page turn that came back without a page. */
router.post('/books/:id/retry', (req, res) => {
  const lane = laneFor(req, res);
  if (!lane) return;
  try {
    res.status(202).json({ view: askStoryAgain(lane, req.params.id) });
  } catch (error) {
    answerError(res, error, 'ask again');
  }
});

export default router;
