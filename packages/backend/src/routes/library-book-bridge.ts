/** Owner-facing Book Bridge controls. Mounted behind the normal session wall. */
import { Router } from 'express';
import {
  BookBridgeError,
  bookBridgeView,
  createBookBridgePairingCode,
  revokeBookBridge,
  setBookBridgeMode,
  type BookBridgeMode,
} from '../services/book-bridge.js';

const router = Router();

router.get('/', (_req, res) => res.json(bookBridgeView()));

router.post('/pair', (_req, res) => {
  try { res.status(201).json({ ...createBookBridgePairingCode(), bridge: bookBridgeView() }); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Could not make a pairing code.' }); }
});

router.delete('/pair', (_req, res) => {
  revokeBookBridge();
  res.json({ disconnected: true, bridge: bookBridgeView() });
});

router.put('/books/:bookId/mode', (req, res) => {
  try {
    const bookId = Number(req.params.bookId);
    const mode = req.body?.mode as BookBridgeMode;
    res.json({ bookId, mode: setBookBridgeMode(bookId, mode) });
  } catch (error) {
    const status = error instanceof BookBridgeError ? error.status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Could not change the reading mode.' });
  }
});

export default router;
