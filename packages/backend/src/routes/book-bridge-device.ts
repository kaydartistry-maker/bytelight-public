/** BOOX/KOReader's bearer-token door, mounted before the owner session wall. */
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  BookBridgeError,
  ackBookBridgeNotes,
  bookBridgeTokenValid,
  bookBridgeView,
  claimBookBridgePairingCode,
  ingestBookBridgeEvent,
  pendingBookBridgeNotes,
} from '../services/book-bridge.js';

function answer(res: Response, error: unknown): void {
  if (error instanceof BookBridgeError) { res.status(error.status).json({ error: error.message }); return; }
  console.error('[book-bridge] device request failed:', error);
  res.status(500).json({ error: 'The Book Bridge could not answer just now.' });
}

function cap(max: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return res.status(413).json({ error: 'That page update is too large.' });
    const bytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
    if (bytes > max) return res.status(413).json({ error: 'That page update is too large.' });
    next();
  };
}

function bearer(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!bookBridgeTokenValid(token)) return res.status(401).json({ error: 'This BOOX is not paired with the Library.' });
  next();
}

export function createBookBridgeDeviceRoutes(opts: { perMinute?: number; claimsPer15Min?: number; root?: string } = {}): Router {
  const router = Router();
  router.use(rateLimit({
    windowMs: 60_000, max: opts.perMinute ?? 180, standardHeaders: true,
    legacyHeaders: false, validate: { trustProxy: true },
    message: { error: 'The reader is sending too quickly; queued pages will catch up.' },
  }));
  const claims = rateLimit({
    windowMs: 15 * 60_000, max: opts.claimsPer15Min ?? 10, skipSuccessfulRequests: true,
    standardHeaders: true, legacyHeaders: false, validate: { trustProxy: true },
    message: { error: 'Too many pairing attempts. Make a fresh code later.' },
  });

  router.post('/claim', claims, cap(1024), (req, res) => {
    try { res.status(201).json(claimBookBridgePairingCode(req.body?.code)); }
    catch (error) { answer(res, error); }
  });

  router.use(bearer);

  router.get('/status', (_req, res) => res.json(bookBridgeView(opts.root)));

  router.post('/events', cap(48 * 1024), (req, res) => {
    try { res.status(202).json(ingestBookBridgeEvent(req.body, opts.root)); }
    catch (error) { answer(res, error); }
  });

  router.get('/outbox/:bookId', (req, res) => {
    const bookId = Number(req.params.bookId);
    if (!Number.isInteger(bookId) || bookId <= 0) return res.status(400).json({ error: 'Bad book id.' });
    res.json({ notes: pendingBookBridgeNotes(bookId, opts.root) });
  });

  router.post('/outbox/ack', cap(8 * 1024), (req, res) => {
    try { res.json({ acknowledged: ackBookBridgeNotes(req.body?.ids, opts.root) }); }
    catch (error) { answer(res, error); }
  });

  router.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return router;
}

export default createBookBridgeDeviceRoutes;
