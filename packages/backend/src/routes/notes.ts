// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Sticky-note CRUD for the phone's Notes app.
// Companions talk to /api/internal/note(s) instead — see routes/internal-routes.ts.
//
// Ported whole from Aerie's routes/notes.ts. Only change: getDb comes from
// byte-light's services/db/init.js.

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../services/db/init.js';

const router = Router();
router.use(authMiddleware);

interface NoteRow {
  id: string;
  text: string;
  color: string;
  timestamp: string;
  sender: string | null;
}

router.get('/', (_req, res) => {
  const rows = getDb()
    .prepare('SELECT id, text, color, timestamp, sender FROM notes ORDER BY id DESC')
    .all() as NoteRow[];
  res.json(rows);
});

router.post('/:id', (req, res) => {
  const id = String(req.params.id);
  const { text, color, timestamp, sender } = req.body || {};
  if (typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }
  const ts = typeof timestamp === 'string' && timestamp ? timestamp : new Date().toISOString();
  const noteColor = typeof color === 'string' && color ? color : '#fef08a';
  const noteSender = typeof sender === 'string' && sender ? sender : null;
  getDb()
    .prepare(
      `INSERT INTO notes (id, text, color, timestamp, sender)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         text = excluded.text,
         color = excluded.color,
         timestamp = excluded.timestamp,
         sender = excluded.sender`,
    )
    .run(id, text, noteColor, ts, noteSender);
  res.json({ ok: true, id });
});

router.delete('/:id', (req, res) => {
  const id = String(req.params.id);
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.delete('/', (_req, res) => {
  getDb().prepare('DELETE FROM notes').run();
  res.json({ ok: true });
});

export default router;
