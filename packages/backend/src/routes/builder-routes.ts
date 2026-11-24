import { Router, type Request, type RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { parse } from 'cookie';
import { getBytelightConfig } from '../config.js';
import { getWebSession } from '../services/db.js';
import { getCookieName } from '../middleware/auth.js';
import { builderAction, type BuilderOwner } from '../services/builder-jobs.js';
import { redact } from '../services/builder-job-io.js';

export function builderRestOwner(req: Request): BuilderOwner {
  // The shared auth middleware deliberately allows passwordless local apps.
  // Builder REST requires an actual owner session even in that configuration.
  if (!getBytelightConfig().auth.password) throw new Error('Builder REST requires configured owner authentication');
  const token = parse(req.headers.cookie || '')[getCookieName()];
  if (!token) throw new Error("Owner session required");
  const session = getWebSession(token);
  if (!session || Date.parse(session.expires_at) <= Date.now()) throw new Error('Owner session required');
  if (req.method !== 'GET') {
    const origin = req.get('origin');
    if (!origin || new URL(origin).host !== req.get('host')) throw new Error('Same-origin owner request required');
  }
  return { audience: 'owner', thread: 'owner-web', session: createHash('sha256').update(token).digest('hex') };
}
export function createBuilderRoutes(
  ownerForRequest = builderRestOwner,
  action = builderAction,
): Router {
  const router = Router();
  const handle = (name: string): RequestHandler => async (req, res) => {
    let owner: BuilderOwner;
    try { owner = ownerForRequest(req); } catch { res.status(403).json({ error: 'Authenticated owner required' }); return; }
    try {
      // Explicit fields only. No identity/configuration/path/command can come from HTTP.
      const args = name === 'start' ? { task: req.body?.task, mode: req.body?.mode }
        : { id: req.params.id, cursor: req.query.cursor, reason: req.body?.reason, ...(['prepare_deploy', 'deploy', 'rollback'].includes(name) ? { expected: req.body?.expected } : {}) };
      const result = await action(name, args, owner);
      res.status(name === 'start' ? 202 : 200).json({ ok: true, ...result });
    } catch (error) { res.status(400).json({ ok: false, error: redact(String(error)) }); }
  };
  router.get('/builder/jobs', handle('list'));
  router.post('/builder/jobs', handle('start'));
  router.get('/builder/jobs/:id', handle('status'));
  router.get('/builder/jobs/:id/logs', handle('logs'));
  router.post('/builder/jobs/:id/stop', handle('stop'));
  router.post('/builder/jobs/:id/prepare-deploy', handle('prepare_deploy'));
  router.post('/builder/jobs/:id/deploy', handle('deploy'));
  router.get('/builder/jobs/:id/deploy', handle('deploy_status'));
  router.get('/builder/jobs/:id/deploy/logs', handle('deploy_logs'));
  router.post('/builder/jobs/:id/rollback', handle('rollback'));
  return router;
}
