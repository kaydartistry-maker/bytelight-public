// Permanent Letters — the vault's phone lane (the owner's side).
// Companions write via /api/internal/letters (localhost) — see routes/internal.ts.
//
// Deliberately absent: PATCH and DELETE. The missing routes are the
// contract — there is no code path to un-write a letter.

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { sealLetter, listLetters, getLetterView, openLetter, LetterError } from '../services/db/letters.js';

const OPERATOR_SLUG = 'user';

const router = Router();
router.use(authMiddleware);

router.get('/', (_req, res) => {
  res.json({ letters: listLetters(OPERATOR_SLUG) });
});

router.get('/:id', (req, res) => {
  const letter = getLetterView(String(req.params.id), OPERATOR_SLUG);
  if (!letter) return res.status(404).json({ error: 'No such letter' });
  res.json(letter);
});

router.post('/', (req, res) => {
  try {
    const { recipients, kind, title, content, seal, openAt, hidden } = req.body ?? {};
    const letter = sealLetter({
      author: OPERATOR_SLUG,
      recipients: Array.isArray(recipients) ? recipients : [],
      kind: kind ?? 'letter',
      title: title ?? null,
      content: content ?? '',
      seal: seal ?? 'open',
      openAt: openAt ?? null,
      hidden: hidden === true,
    });
    res.status(201).json(letter);
  } catch (err) {
    if (err instanceof LetterError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

router.post('/:id/open', (req, res) => {
  try {
    res.json(openLetter(String(req.params.id), OPERATOR_SLUG));
  } catch (err) {
    if (err instanceof LetterError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

export default router;
