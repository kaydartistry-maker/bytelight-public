// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The owner field notes, the phone's door: read only, behind the login.
//
// The morning look writes through the loopback door (/api/internal/field-notes
// in routes/internal-routes.ts); their phone only ever reads, newest day first.

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { listFieldNotes, fieldNotesLimit } from '../services/db/field-notes.js';

const router = Router();
router.use(authMiddleware);

router.get('/', (req, res) => {
  try {
    res.json({ notes: listFieldNotes(fieldNotesLimit(req.query.limit)) });
  } catch (err) {
    console.error('[field-notes] reading the notes failed:', err);
    res.status(500).json({ error: 'The field notes could not be read.' });
  }
});

export default router;
