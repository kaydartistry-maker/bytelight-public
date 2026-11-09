// The Book Club — her door (authenticated, mounted at /api/library/book-club
// in routes/api.ts after authMiddleware). She starts a round, pitches, votes,
// picks the winner and finishes the round. Starting a round, and asking again,
// wake the companions with one queued turn (services/library-book-club-turns.ts);
// they pitch and vote through /api/internal/library/book-club
// (routes/internal/library-book-club.ts). These doors answer at once; the
// phone re-reads while a turn is out.

import { Router, type Request, type Response } from 'express';
import {
  BookClubError,
  OWNER_SEAT,
  addPitch,
  bookClubView,
  castVote,
  finishRound,
  pickWinner,
  startRound,
} from '../services/library-book-club.js';
import { bookClubSeats, ownerName, queueBookClubTurn, type BookClubLane } from '../services/library-book-club-turns.js';

const router = Router();

function answer(res: Response, err: unknown, what: string): void {
  if (err instanceof BookClubError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(`[book-club] could not ${what}:`, err);
  res.status(500).json({ error: `The book club could not ${what} just now.` });
}

function view() {
  return bookClubView(bookClubSeats(), ownerName());
}

function laneOf(req: Request): BookClubLane | null {
  return (req.app.locals.agentService as BookClubLane | undefined) ?? null;
}

router.get('/', (_req, res) => {
  try {
    res.json(view());
  } catch (err) {
    answer(res, err, 'open');
  }
});

/** Start a round (optionally with her own pitch) and wake the companions to pitch. */
router.post('/rounds', (req, res) => {
  try {
    const mine = req.body?.pitch;
    const round = startRound();
    if (mine && typeof mine === 'object' && typeof mine.title === 'string' && mine.title.trim()) {
      addPitch(round.id, { ...mine, by: OWNER_SEAT }, bookClubSeats());
    }
    const lane = laneOf(req);
    if (lane) queueBookClubTurn(lane, round.id, { retry: false });
    res.status(201).json({ ...view(), woke: Boolean(lane) });
  } catch (err) {
    answer(res, err, 'start a round');
  }
});

router.post('/rounds/:id/pitches', (req, res) => {
  try {
    const { title, author, pitch, gutenbergId, bookId } = req.body ?? {};
    addPitch(String(req.params.id), { by: OWNER_SEAT, title, author, pitch, gutenbergId, bookId }, bookClubSeats());
    res.status(201).json(view());
  } catch (err) {
    answer(res, err, 'add your pitch');
  }
});

router.post('/rounds/:id/votes', (req, res) => {
  try {
    castVote(String(req.params.id), { voter: OWNER_SEAT, pitchId: req.body?.pitchId }, bookClubSeats());
    res.json(view());
  } catch (err) {
    answer(res, err, 'count your vote');
  }
});

/** Wake them again: to pitch if they haven't, or to look at the round (a pitch of hers, say) and vote. */
router.post('/rounds/:id/ask', (req, res) => {
  const lane = laneOf(req);
  if (!lane) return res.status(503).json({ error: 'The companions are not reachable just now.' });
  try {
    queueBookClubTurn(lane, String(req.params.id), { retry: true });
    res.json(view());
  } catch (err) {
    answer(res, err, 'ask them');
  }
});

/** She picks the winner: { pitchId } breaks a tie. */
router.post('/rounds/:id/pick', async (req, res) => {
  try {
    await pickWinner(String(req.params.id), { pitchId: req.body?.pitchId });
    res.json(view());
  } catch (err) {
    answer(res, err, 'pick the winner');
  }
});

router.post('/rounds/:id/finish', (req, res) => {
  try {
    finishRound(String(req.params.id));
    res.json(view());
  } catch (err) {
    answer(res, err, 'finish the round');
  }
});

export default router;
