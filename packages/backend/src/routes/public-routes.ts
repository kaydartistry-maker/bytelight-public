import { createPairingRoutes } from './pairing.js';
import { Router } from 'express';
import {
  loginHandler,
  logoutHandler,
  sessionCheckHandler,
} from '../middleware/auth.js';
import { getBytelightConfig } from '../config.js';
import type { PushService } from '../services/push.js';

/**
 * Public routes (no auth required)
 * These must be mounted BEFORE authMiddleware
 */
export function createPublicRoutes(): Router {
  const router = Router();
  router.use(createPairingRoutes());

  // Health check (public — minimal response)
  router.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      memoryUsage: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      connections: req.app.locals.agentService ? 0 : 0,
    });
  });

  // Auth endpoints
  router.get('/auth/check', sessionCheckHandler);
  router.post('/auth/login', loginHandler);
  router.post('/auth/logout', logoutHandler);

  // Push VAPID public key (no auth — needed before subscription)
  router.get('/push/vapid-public', (req, res) => {
    const pushService = req.app.locals.pushService as PushService | undefined;
    const publicKey = pushService?.getVapidPublicKey() || null;
    res.json({ publicKey });
  });

  // Identity endpoint — companion/user names and timezone for frontend personalization
  router.get('/identity', (req, res) => {
    const config = getBytelightConfig();
    res.json({
      companion_name: config.identity.companion_name,
      user_name: config.identity.user_name,
      timezone: config.identity.timezone,
    });
  });

  return router;
}
