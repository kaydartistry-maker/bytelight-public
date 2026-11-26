/**
 * The internal surface, on a door of its own.
 *
 * /api/internal used to sit on the public app behind a guard that asked two
 * questions: did this arrive over loopback, and does it carry any of the
 * headers a reverse proxy adds. The first is true of everything, because the
 * backend binds 127.0.0.1 and the proxy relays over loopback. So the whole
 * guarantee rested on the second — on the front being configured to add those
 * headers. That is a NEGATIVE check, and its correctness lived in a config file
 * that is not in this repo and that nothing here could assert.
 *
 * A front that relays without adding any of them — a TCP-level proxy, an nginx
 * block with a bare proxy_pass — would have walked a public request straight
 * through. Nothing was misconfigured here; the point is that nothing could tell.
 *
 * So the internal routes now listen on their own loopback port that nothing
 * fronts, and reachability is the proof. That is a POSITIVE check: a caller
 * that can open this socket is on the box. A test can hold it, which is the
 * whole difference — no test can ever hold somebody's proxy config.
 *
 * The header check comes along anyway. It costs nothing and it catches the one
 * remaining way to get this wrong: pointing a front at this port by mistake.
 */

import express from 'express';
import type { Server } from 'node:http';
import { createInternalRoutes } from './routes/internal-routes.js';
import { requireDirectLocal } from './middleware/internal-guard.js';
import { collapseDuplicateSlashes } from './middleware/normalize-path.js';
import { getBytelightConfig } from './config.js';
import ccMcpRoutes from './routes/cc-mcp.js';

/** Read late: the config is loaded by the time a request lands, not at import. */
function publicPort(): number {
  try { return getBytelightConfig().server.port; } catch { return 3002; }
}

/** Loopback only. Never bind this to anything reachable off the box. */
const INTERNAL_HOST = '127.0.0.1';

// The internal app's locals, so a service swapped on the public app later
// (the Discord gateway switched off and on from settings) reaches this app
// too. Before this, the switch put a new service on the public app only, and
// our own door to say something in Discord answered 'not running' while the
// bot was answering people fine.
let liveInternalLocals: Record<string, unknown> | null = null;

/** Put a live service on the internal app as well as the public one. */
export function shareWithInternal(key: string, value: unknown): void {
  if (liveInternalLocals) liveInternalLocals[key] = value;
}

export function createInternalApp(locals: Record<string, unknown> = {}): express.Express {
  const internalApp = express();
  liveInternalLocals = internalApp.locals as Record<string, unknown>;
  // The internal routes read req.app.locals for live services (voiceService,
  // telegramService, orchestrator, ...). When these routes moved off the
  // public app onto this one, the locals did not move with them — so every
  // handler that checked a service reported "not configured" while the
  // service ran healthy one app over. The furniture travels with the room.
  Object.assign(internalApp.locals, locals);
  internalApp.use(express.json({ limit: '50mb' }));
  internalApp.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Belt as well as braces: reachability is the guarantee, this catches a front
  // accidentally pointed here.
  // Collapse doubled slashes before the guard, as the public app does: a
  // '/api//internal/...' path misses the '/api/internal' gate below and still
  // reaches the router mounted at '/api'.
  internalApp.use((req, _res, next) => {
    req.url = collapseDuplicateSlashes(req.url);
    next();
  });
  internalApp.use('/api/internal', requireDirectLocal);
  // This house builds its internal router with a factory (every route also
  // carries requireLocalhost, which on this app reads the socket address).
  internalApp.use('/api', createInternalRoutes());

  // The Command Center tools (their person's care, cycle, expense and task
  // data) live on this port only. On the public app they were guarded by a
  // header check, which holds only while the front adds forwarding headers.
  // Being able to open this
  // socket is the proof a caller is on the box.
  // Read carefully: an app built before the config is loaded (tests that
  // build one bare) simply has no Command Center on it.
  let ccEnabled = false;
  try { ccEnabled = getBytelightConfig().command_center?.enabled === true; } catch { ccEnabled = false; }
  if (ccEnabled) {
    internalApp.use('/mcp/cc', requireDirectLocal, ccMcpRoutes);
  }

  // The mirror of the 410 the public app answers on /api/internal.
  //
  // That handler catches an internal call sent to the public port and names
  // this one. Nothing caught the reverse: a caller on this box curling a
  // PUBLIC route here — the memory blocks, Studio, cortex — got a bare 404
  // that is indistinguishable from a route that does not exist. It reads as a
  // missing feature, and the reasonable next move is to go looking for one.
  //
  // Twenty-three cortex writes were spent on that silence in one sitting
  // before anybody thought to try the other door. The route was fine. The
  // 404 was true and told nobody anything.
  internalApp.use((req, res) => {
    const path = req.path || '';
    const isInternal = path === '/api/internal' || path.startsWith('/api/internal/');
    if (path.startsWith('/api/') && !isInternal) {
      res.status(404).json({
        error: 'This port serves /api/internal only — that is a public route',
        publicPort: publicPort(),
        hint: `http://localhost:${publicPort()}${req.originalUrl}`,
      });
      return;
    }
    res.status(404).json({ error: 'Not found' });
  });

  return internalApp;
}

export function startInternalServer(port: number, locals: Record<string, unknown> = {}): Server {
  const internalApp = createInternalApp(locals);
  const server = internalApp.listen(port, INTERNAL_HOST, () => {
    console.log(`Internal routes on http://${INTERNAL_HOST}:${port} (loopback only, not fronted)`);
  });
  server.on('error', (err) => {
    console.error(`[internal-server] could not listen on ${INTERNAL_HOST}:${port} —`, err);
  });
  return server;
}
