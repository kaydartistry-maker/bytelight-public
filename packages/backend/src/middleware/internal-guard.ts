/**
 * Internal-route guard — the door that /api/internal always said it had.
 *
 * routes/internal.ts opens with "localhost-only endpoints... No auth required
 * (localhost guard instead)". There was no localhost guard. Forty-two routes
 * answered anybody, and on 2026-08-04 a journal came back with HTTP 200 from
 * https://<public host>/api/internal/journal with no credentials at all.
 *
 * Why the obvious check is not enough: the backend binds 127.0.0.1 only, so the
 * reverse proxy connects over loopback and EVERY request — their person's, ours, a
 * stranger's — arrives with a loopback socket address. `remoteAddress` alone
 * says "local" for the whole internet.
 *
 * So this asks loopback socket AND no sign of a proxy hop. Any of the standard
 * forwarding headers means the request was relayed, however local the socket
 * looks. Fail closed, and say which header did it so a false refusal is one log
 * line away from being understood rather than a mystery.
 *
 * ─── THIS IS NO LONGER THE GUARANTEE (2026-08-16) ───
 *
 * Read the rest of that as history. The header half is a NEGATIVE check: it
 * holds only because the front in place adds at least one of these. A front that
 * relays without adding any — a TCP-level proxy, an nginx block with a bare
 * proxy_pass — would walk a public request straight through, and nothing here
 * could tell. Its correctness lived in a config file this repo does not carry
 * and no test can reach.
 *
 * The guarantee now is WHICH PORT answers. /api/internal is served by its own
 * loopback listener that nothing fronts (see internal-server.ts), so being able
 * to open the socket is the proof. That is positive, and a test holds it.
 *
 * This function still runs there, second, and it still earns its place: it is
 * what catches a front accidentally pointed at the internal port. Belt as well
 * as braces — but the braces are the port, not this.
 */

import type { Request, Response, NextFunction } from 'express';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Headers that only exist because something relayed this request. */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'via',
] as const;

/**
 * True when this request was made directly against the loopback interface and
 * not relayed by anything. Exported for tests — the rule lives in one place.
 */
/** 127.0.0.1, localhost or [::1], with or without a port. */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

export function directLocalCheck(req: {
  socket?: { remoteAddress?: string };
  headers: Record<string, unknown>;
}): { ok: true } | { ok: false; why: string } {
  const remote = req.socket?.remoteAddress || '';
  if (!LOOPBACK.has(remote)) return { ok: false, why: `remote ${remote || 'unknown'}` };
  for (const header of PROXY_HEADERS) {
    if (req.headers[header] !== undefined) return { ok: false, why: `${header} present` };
  }
  // DNS rebinding: a page in a browser on this box can point its own hostname
  // at 127.0.0.1 and reach these ports from a loopback socket with no proxy
  // headers. Its Host header still names the page's site, so only loopback
  // names are let through (security audit, Nov 6 2026).
  const host = req.headers.host;
  if (typeof host === 'string' && host && !LOOPBACK_HOST.test(host)) return { ok: false, why: `host ${host}` };
  // A page in a browser on this machine can still POST here from a loopback
  // socket under a loopback Host (a plain form, no rebinding needed), and the
  // lanes behind these routes run with no permission prompts. Browsers mark
  // such a request with Origin and Sec-Fetch-Site; curl, the hooks and node's
  // fetch send neither. So anything a browser stamped as coming from a page is
  // refused.
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) return { ok: false, why: `origin ${origin}` };
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site && site !== 'none') return { ok: false, why: `sec-fetch-site ${site}` };
  return { ok: true };
}

/** Express middleware form. Refusals are logged once each, with the reason. */
export function requireDirectLocal(req: Request, res: Response, next: NextFunction): void {
  const verdict = directLocalCheck(req as unknown as Parameters<typeof directLocalCheck>[0]);
  if (verdict.ok) {
    next();
    return;
  }
  console.warn(`[internal-guard] refused ${req.method} ${req.originalUrl} — ${verdict.why}`);
  res.status(404).json({ error: 'Not found' });
}
