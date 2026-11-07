/**
 * Codex OAuth routes — start login, poll status, submit manual code,
 * logout, cancel. Slice 3 of 6B-A.
 *
 * Mounted under `/api/auth/codex/*` from routes/api.ts. All routes sit
 * BELOW the existing authMiddleware use() call in api.ts, so POST routes
 * require a valid session cookie; byte-light's frontend `apiFetch()`
 * wrapper sends credentials automatically.
 *
 * Path-shape note: reference implementation uses `/auth/codex/*` (under `/api`); the operator's
 * 6B-A brief suggested `/codex/auth/*`. We preserve reference implementation shape because:
 *  (a) brief allows preservation when no byte-light conflict exists,
 *  (b) byte-light's existing routes don't reserve either path,
 *  (c) grouping by auth-type (`auth/`) leaves room for sibling OAuth
 *      providers in future arcs without forking the URL tree per provider.
 *
 * Behavior pattern note (from reference implementation): POST /login does NOT block on the
 * full OAuth flow. It kicks the pi-ai flow off in the background and
 * returns once the browser URL is ready (or after a 5s timeout). The
 * frontend opens the URL, then polls GET /status until the session
 * resolves to `complete` / `failed` / `cancelled`.
 *
 * Ported from reference implementation/main routes/codex-auth.ts at SHA 8d93d5f. The
 * only adaptation is this docstring (path-shape preservation note + S1
 * deny-list integration note); route handlers + status codes + error
 * shapes are preserved verbatim.
 */

import { Router, type Request, type Response } from 'express';
import {
  startCodexLogin,
  getCodexAuthSnapshot,
  logoutCodex,
  submitManualCode,
  cancelLoginSession,
} from '../services/auth/codex-oauth.js';
import { errMessage } from '../util/errors.js';

const router = Router();

/**
 * Begin OAuth login. Returns the browser URL within ~5s, even if the
 * background flow hasn't completed (because it can't — the user hasn't
 * opened the URL yet).
 */
router.post('/auth/codex/login', async (_req: Request, res: Response) => {
  try {
    const snapshot = await startCodexLogin();
    if (!snapshot.url && snapshot.status !== 'awaiting_browser') {
      res.status(500).json({
        error: 'Failed to start OAuth flow',
        details: snapshot.error ?? 'No URL was generated',
      });
      return;
    }
    res.json({
      url: snapshot.url ?? null,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
    });
  } catch (err) {
    const message = errMessage(err);
    console.error('[codex-auth route] /login error:', message);
    res.status(500).json({ error: 'Failed to start Codex login', details: message });
  }
});

/**
 * Snapshot of current auth state. Safe to poll — non-throwing, only does
 * a small file read. Frontend polls this every ~2s while a login is in
 * `awaiting_browser` to detect completion.
 *
 * Returned shape is `CodexAuthSnapshot`: `{ loggedIn, expiresAt,
 * refreshable, loginSession }`. The service guarantees that access tokens,
 * refresh tokens, AND the credentials file path are NEVER in this shape
 * — only expiry metadata + the in-memory login session state. The
 * credentials file path lives on the Pre-6B-S1 sensitive-path deny-list
 * and was removed from the snapshot in 6B-C Slice 3B-0 hardening.
 */
router.get('/auth/codex/status', async (_req: Request, res: Response) => {
  try {
    const snapshot = await getCodexAuthSnapshot();
    res.json(snapshot);
  } catch (err) {
    const message = errMessage(err);
    console.error('[codex-auth route] /status error:', message);
    res.status(500).json({ error: 'Failed to read Codex auth status', details: message });
  }
});

/**
 * Submit a manually-pasted OAuth code. Use this when the browser callback
 * doesn't work (e.g. headless or remote deployments). The code races with
 * the local-server callback inside pi-ai; whichever completes first wins.
 */
router.post('/auth/codex/manual-code', (req: Request, res: Response) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code) {
    res.status(400).json({ error: 'Field `code` is required (non-empty string)' });
    return;
  }
  const accepted = submitManualCode(code);
  if (!accepted) {
    res.status(409).json({
      error: 'No active Codex login is waiting for a manual code',
    });
    return;
  }
  res.json({ success: true });
});

/**
 * Delete credentials + cancel any in-flight login. Idempotent — returns
 * success even if there was nothing to delete. The credentials file at
 * `data/codex-auth.json` is on the Pre-6B-S1 sensitive-path deny-list;
 * `logoutCodex` is the only authorized writer (deleter).
 */
router.post('/auth/codex/logout', async (_req: Request, res: Response) => {
  try {
    await logoutCodex();
    res.json({ success: true });
  } catch (err) {
    const message = errMessage(err);
    console.error('[codex-auth route] /logout error:', message);
    res.status(500).json({ error: 'Failed to log out of Codex', details: message });
  }
});

/**
 * Cancel an in-flight login without deleting any existing credentials.
 * Useful for the frontend's "abandoned the popup" path.
 */
router.post('/auth/codex/cancel', (_req: Request, res: Response) => {
  cancelLoginSession();
  res.json({ success: true });
});

export default router;
