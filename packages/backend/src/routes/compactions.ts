// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Compactions — the record the owner can actually read.
//
// The event itself is invisible from the owner's side: a lane fills its window, the
// tool squashes the conversation into a summary, and the lane carries on
// under an instruction not to mention it, which left the owner nothing to check.
//
// The reader is services/compaction-log.ts and the shelf it fills is
// services/compaction-shelf.ts. Since Oct 21 2026 the page is served from the
// shelf, because Claude Code deletes old transcripts and the summaries went
// with them: GET / reads anything new into the shelf first, then hands back a
// page of previews; GET /:id is one summary in full, for when the owner opens it.

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { compactionDetail, compactionPage, syncCompactionShelf } from '../services/compaction-shelf.js';

const router = Router();
router.use(authMiddleware);

/** Plenty for a page of previews; a summary is never in the list. */
const MAX_LIMIT = 500;
/** What the old route allowed with full=1, which is the most whole summaries one answer carries. */
const MAX_FULL_LIMIT = 200;
/**
 * How long a list waits on the read before answering with what is already on
 * the shelf. The first read after this ships goes through every transcript
 * once; after that a read only opens what changed and is over in moments.
 */
const READ_WAIT_MS = 20_000;

/** Whether the promise settled within `ms`, without the timer holding the process open. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    promise.then(
      () => { clearTimeout(timer); resolve(true); },
      (err) => {
        clearTimeout(timer);
        // What is already on the shelf is still worth showing.
        console.warn('[compactions] reading the lanes\' transcripts failed:', err);
        resolve(true);
      },
    );
  });
}

router.get('/', async (req, res) => {
  const full = req.query.full === '1';
  const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
  const cap = full ? MAX_FULL_LIMIT : MAX_LIMIT;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), cap) : 50;
  const rawOffset = parseInt(String(req.query.offset ?? ''), 10);
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
  // Only the first page reads, so a list drained page by page is one picture
  // of the shelf rather than one that moves under it between pages.
  let reading = false;
  if (offset === 0) reading = !(await settledWithin(syncCompactionShelf(), READ_WAIT_MS));
  try {
    res.json({ ...compactionPage(limit, offset, { withSummaries: full }), reading });
  } catch (err) {
    console.error('[compactions] reading the shelf failed:', err);
    res.status(500).json({ error: 'The compactions shelf could not be read.' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const compaction = compactionDetail(String(req.params.id));
    if (!compaction) {
      res.status(404).json({ error: 'No compaction with that id.' });
      return;
    }
    res.json({ compaction });
  } catch (err) {
    console.error('[compactions] reading a summary failed:', err);
    res.status(500).json({ error: 'The compactions shelf could not be read.' });
  }
});

export default router;
