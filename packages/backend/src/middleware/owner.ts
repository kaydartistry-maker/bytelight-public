import { requireHttpsOrigin } from './pairing-security.js';
import { type Request } from 'express';
import { createHash } from 'node:crypto';
import { parse } from 'cookie';
import { getWebSession } from '../services/db.js';
import { getCookieName } from '../middleware/auth.js';
import type { BuilderOwner } from '../services/builder-jobs.js';

export function createWebRestOwner(deps = { session: getWebSession }) {
  return function owner(req: Request): BuilderOwner {
    // The shared auth middleware deliberately allows passwordless local apps.
    // Owner REST requires an actual owner session even in that configuration.
    const token = parse(req.headers.cookie || '')[getCookieName()];
    if (!token) throw new Error("Owner session required");
    const session = deps.session(token);
    if (!session || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.now()) throw new Error('Owner session required');
    if (req.method !== 'GET') {
      requireHttpsOrigin(req);
    }
    return { audience: 'owner', thread: 'owner-web', session: createHash('sha256').update(token).digest('hex') };
  };
}

export const webRestOwner = createWebRestOwner();
