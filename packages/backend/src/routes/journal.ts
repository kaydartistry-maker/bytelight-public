// Companion journal — read/manage endpoints for the Journal clients.
// Companions write via /api/internal/journal (localhost) — see routes/internal-routes.ts.

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  listJournalEntries,
  getJournalEntry,
  recallJournalEntry,
  deleteJournalEntry,
  effectiveVividness,
  JournalRemoteError,
  type JournalEntry,
} from '../services/db/journal.js';

const router = Router();
router.use(authMiddleware);

function serialize(entry: JournalEntry) {
  return { ...entry, effective_vividness: effectiveVividness(entry) };
}

function sendError(res: Parameters<Parameters<typeof router.get>[1]>[1], error: unknown) {
  if (error instanceof JournalRemoteError) return res.status(502).json({ error: error.message });
  console.error('Journal route error:', error);
  return res.status(500).json({ error: 'Journal request failed' });
}

router.get('/', async (req, res) => {
  const companionId = typeof req.query.companion === 'string' ? req.query.companion : undefined;
  const entryTypeRaw = typeof req.query.type === 'string' ? req.query.type : undefined;
  const entryType = entryTypeRaw === 'journal' || entryTypeRaw === 'dream' ? entryTypeRaw : undefined;
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit), 10) || 50, 200));
  const offset = Math.max(0, parseInt(String(req.query.offset), 10) || 0);
  try {
    const { entries, total } = await listJournalEntries({ companionId, entryType, limit, offset });
    res.json({ total, entries: entries.map(serialize) });
  } catch (error) { sendError(res, error); }
});

router.get('/:id', async (req, res) => {
  try {
    const entry = await getJournalEntry(String(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json(serialize(entry));
  } catch (error) { sendError(res, error); }
});

// Reading a dream in the app counts as recalling it
router.post('/:id/recall', async (req, res) => {
  try {
    const entry = await recallJournalEntry(String(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json(serialize(entry));
  } catch (error) { sendError(res, error); }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await deleteJournalEntry(String(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  } catch (error) { sendError(res, error); }
});

export default router;
