// The Theater — the Ear's door: the browser extension (packages/theater-ear/)
// talks to the house here. Mounted at /api/theater-ear in routes/api.ts
// BEFORE the cookie auth boundary, because the extension has no session.
// Instead:
//   POST /claim   { code }  → { token }   the one unauthenticated move:
//                 trade a one-time pairing code for the Ear's token
//                 (services/theater-ear.ts). Rate limited hard.
// and, with `Authorization: Bearer <token>` (constant-time check):
//   GET  /status            → { live, night: { id, title, season, episode } | null }
//                             live only for a computer night
//   POST /lines   { nightId?, lines: [{ text, start, end }] } (≤ 50)
//                             → heard lines onto the live computer night's cues
//   POST /clock   { nightId?, position, paused, duration? }
//                             → moves the night's clock (a resync) and the Mouth
//   POST /probe   { … }     → data/theater/ear-probe.json (overwritten, 64 KB cap)
// Nothing else answers (404). Bodies are capped; a light rate limit covers
// the lot. Her side of the Ear (pairing, revoking) is in routes/theater.ts.

import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { TheaterError, appendEarLines, earClock, liveNight, type TheaterNight } from '../services/theater.js';
import {
  EAR_LIMITS,
  claimPairingCode,
  earTokenValid,
  noteEarContact,
  readEarClock,
  readEarLines,
  saveEarProbe,
} from '../services/theater-ear.js';
import { armTheaterMouth } from '../services/theater-mouth.js';
import type { TheaterLane } from '../services/theater-couch.js';

export interface EarRouteOptions {
  /** Requests a minute from one address, for the whole door. */
  perMinute?: number;
  /** Claim attempts per 15 minutes from one address. */
  claimsPer15Min?: number;
  /** Where the theater files live (tests). */
  root?: string;
}

function answer(res: Response, err: unknown, what: string): void {
  if (err instanceof TheaterError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(`[theater-ear] could not ${what}:`, err);
  res.status(500).json({ error: `The house could not ${what} just now.` });
}

/** Refuse a body over `max` bytes (the header when there is one, the parsed body either way). */
function capBody(max: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return res.status(413).json({ error: 'That is too much at once.' });
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
    } catch {
      return res.status(400).json({ error: 'That could not be read.' });
    }
    if (size > max) return res.status(413).json({ error: 'That is too much at once.' });
    next();
  };
}

function bearer(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!earTokenValid(token)) return res.status(401).json({ error: 'The Ear is not connected. Pair it again from the Theater.' });
  noteEarContact();
  next();
}

/** The live night, when it is a computer night; a nightId the Ear names must be that night. */
function computerNight(root: string | undefined, nightId: unknown): TheaterNight {
  const night = liveNight(root);
  if (!night || night.mode !== 'computer') throw new TheaterError(409, 'No computer night is on right now.');
  if (nightId !== undefined && nightId !== null && nightId !== night.id) {
    throw new TheaterError(409, 'That night is over; another one is on now.');
  }
  return night;
}

export function createEarRoutes(opts: EarRouteOptions = {}): Router {
  const router = Router();
  const root = opts.root;
  const laneOf = (req: Request) => (req.app.locals.agentService as TheaterLane | undefined) ?? null;

  router.use(rateLimit({
    windowMs: 60_000,
    max: opts.perMinute ?? 240,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: true },
    message: { error: 'The Ear is talking too fast; it will catch up.' },
  }));

  const claimLimit = rateLimit({
    windowMs: 15 * 60_000,
    max: opts.claimsPer15Min ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    validate: { trustProxy: true },
    message: { error: 'Too many tries. Wait a little, make a new code and try again.' },
  });

  router.post('/claim', claimLimit, capBody(1024), (req, res) => {
    try {
      res.status(201).json(claimPairingCode(req.body?.code));
    } catch (err) {
      answer(res, err, 'pair the Ear');
    }
  });

  router.get('/status', bearer, (_req, res) => {
    try {
      const night = liveNight(root);
      const on = night && night.mode === 'computer' ? night : null;
      res.json({
        live: Boolean(on),
        night: on ? { id: on.id, title: on.title, season: on.season, episode: on.episode } : null,
      });
    } catch (err) {
      answer(res, err, 'read the Theater');
    }
  });

  router.post('/lines', bearer, capBody(EAR_LIMITS.bodyBytes), (req, res) => {
    try {
      const night = computerNight(root, req.body?.nightId);
      const lines = readEarLines(req.body);
      const { night: after, added } = appendEarLines(night.id, lines, root);
      // The first lines can be what the Mouth was waiting for.
      if (added > 0) armTheaterMouth(laneOf(req), root);
      res.json({ added, cueCount: after.cues.length });
    } catch (err) {
      answer(res, err, 'take those lines');
    }
  });

  router.post('/clock', bearer, capBody(1024), (req, res) => {
    try {
      const night = computerNight(root, req.body?.nightId);
      const after = earClock(night.id, readEarClock(req.body), root);
      // Exactly like her clock door: playing arms the Mouth, paused stops it.
      armTheaterMouth(laneOf(req), root);
      res.json({ ok: true, paused: after.clock.paused });
    } catch (err) {
      answer(res, err, 'move the clock');
    }
  });

  router.post('/probe', bearer, capBody(EAR_LIMITS.probeBytes), (req, res) => {
    try {
      const { bytes } = saveEarProbe(req.body, root);
      res.status(201).json({ saved: true, bytes });
    } catch (err) {
      answer(res, err, 'keep that probe');
    }
  });

  // The Ear can do the above and nothing else.
  router.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return router;
}

export default createEarRoutes;
