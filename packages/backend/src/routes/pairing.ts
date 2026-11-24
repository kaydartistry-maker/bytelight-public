import { privateJson } from '../middleware/private-json.js';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireHttpsOrigin } from '../middleware/pairing-security.js';
import { setSessionCookie } from '../middleware/auth.js';
import { consumePairingToken } from '../services/db/owner-pairing.js';
export function createPairingRoutes() {
  const router = Router();
  router.post('/auth/pair', rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false, keyGenerator: req => { const peer = req.socket.remoteAddress || 'unknown'; return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) ? req.ip || peer : peer; }, message: { error: 'Pairing unavailable' } }), privateJson('1kb'), (req, res) => {
    try {
      requireHttpsOrigin(req);
      if (!req.is('application/json') || Object.keys(req.body || {}).join(',') !== 'token' || typeof req.body.token !== 'string' || !/^[a-f0-9]{64}$/.test(req.body.token)) throw new Error();
      const session = consumePairingToken(req.body.token);
      req.body.token = undefined;
      if (!session) throw new Error();
      setSessionCookie(req, res, session, true);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true });
    } catch { res.status(400).json({ error: 'Pairing unavailable' }); }
    finally { if (req.body && typeof req.body === 'object') delete req.body.token; }
  });
  return router;
}
