// The Book Club — the companions' door, localhost only (every route carries
// requireLocalhost). They read the round, pitch one book each and vote once
// each during the turn that woke them (services/library-book-club-turns.ts).
// Mounted inside createInternalRoutes() (routes/internal-routes.ts), so it
// answers at /api/internal/library/book-club. Her door is
// routes/library-book-club.ts; the rules are services/library-book-club.ts.

import { Router, type Response } from 'express';
import { requireLocalhost } from '../../middleware/localhost.js';
import { BookClubError, OWNER_SEAT, addPitch, bookClubView, castVote } from '../../services/library-book-club.js';
import { bookClubSeats, ownerName } from '../../services/library-book-club-turns.js';

const router = Router();

function answer(res: Response, err: unknown, what: string): void {
  if (err instanceof BookClubError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(`[book-club] could not ${what}:`, err);
  res.status(500).json({ error: `Something went wrong at the book club while trying to ${what}.` });
}

/** Her seat is hers: the companions pitch and vote only as themselves. */
function asThemselves(who: unknown): void {
  if (typeof who === 'string' && who.trim().toLowerCase() === OWNER_SEAT) {
    throw new BookClubError(400, 'Pitch and vote as yourself, with your own slug.');
  }
}

router.get('/internal/library/book-club', requireLocalhost, (_req, res) => {
  try {
    res.json(bookClubView(bookClubSeats(), ownerName()));
  } catch (err) {
    answer(res, err, 'read the round');
  }
});

/** Pitch a book: { by, title, author, pitch, gutenbergId?, bookId? }. Pitching again replaces yours. */
router.post('/internal/library/book-club/rounds/:id/pitches', requireLocalhost, (req, res) => {
  const { by, title, author, pitch, gutenbergId, bookId } = req.body ?? {};
  try {
    asThemselves(by);
    res.status(201).json({ pitch: addPitch(String(req.params.id), { by, title, author, pitch, gutenbergId, bookId }, bookClubSeats()) });
  } catch (err) {
    answer(res, err, 'take the pitch');
  }
});

/** Vote: { voter, pitchId }. One each; voting again moves it. */
router.post('/internal/library/book-club/rounds/:id/votes', requireLocalhost, (req, res) => {
  const { voter, pitchId } = req.body ?? {};
  try {
    asThemselves(voter);
    const round = castVote(String(req.params.id), { voter, pitchId }, bookClubSeats());
    res.json({ votes: round.votes });
  } catch (err) {
    answer(res, err, 'count the vote');
  }
});

export default router;
