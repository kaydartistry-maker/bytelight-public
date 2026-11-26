// A house with no password trusts whoever can reach it. That is reasonable
// only while the only one who can reach it is this machine, so two rules hold
// for a house with no password:
//
// - It will not start on an address other machines can reach. Binding to
//   0.0.0.0 or a network address with no password publishes every route, keys
//   included, to the network.
// - It answers only requests whose Host names this machine or one of the
//   configured cors.origins that is a private-network name (a home network or
//   a tailnet), and never one that came through a proxy or tunnel. A page in a browser on this machine can point its
//   own hostname at 127.0.0.1 (DNS rebinding) and read the answers as its own;
//   its Host header still names the page's site, which is how it is told apart.
//
// A password lifts both: the login cookie then decides who gets in.

import type { Request, Response, NextFunction } from 'express';

const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

/** True when the server is bound only to this machine. */
export function isLoopbackBind(host: string | undefined): boolean {
  return LOOPBACK_BINDS.has(String(host ?? '').trim().toLowerCase());
}

/**
 * Whether a hostname can only ever mean this machine, a home network or a
 * tailnet: private and link-local addresses, the tailnet's 100.64/10 range,
 * and the names those networks use (.local, .lan, .home.arpa, .internal,
 * .ts.net). A public name cannot be told apart from somebody's tunnel.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (/\.(?:local|lan|home\.arpa|internal|ts\.net)$/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/**
 * The Host values a house with no password answers besides the loopback
 * names: the hosts of its cors.origins that are private-network names. A
 * public name is left out even when listed, because a raw tunnel such as
 * ssh -R adds no forwarding header, so the proxy check below cannot see it,
 * and a public name in the list would then open every route with no login
 * (outside re-check, Nov 24 2026).
 */
export function allowedHostsFrom(origins: ReadonlyArray<string>): Set<string> {
  const hosts = new Set<string>();
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (isPrivateNetworkHost(url.hostname)) hosts.add(url.host.toLowerCase());
    } catch { /* not a URL: ignore */ }
  }
  return hosts;
}

// Headers a proxy or tunnel adds. A house with no password has nothing in
// front of it, so a request carrying one came through a tunnel or proxy
// somebody pointed at it, and a tunnel makes the house reachable from
// anywhere whatever Host it sends. The listed cors.origins only ever meant
// another name for this machine (fourth outside audit, Nov 20 2026: a public
// address added to cors.origins on a no-password house behind a tunnel opened
// every route with no login, and the refusal message suggested doing it).
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'tailscale-user-login'];

export function cameThroughProxy(headers: Record<string, unknown> | undefined): boolean {
  if (!headers) return false;
  return PROXY_HEADERS.some((h) => headers[h] !== undefined);
}

export function openHouseHostAllowed(host: string | undefined, allowed: ReadonlySet<string>, headers?: Record<string, unknown>): boolean {
  if (cameThroughProxy(headers)) return false;
  if (!host) return true; // HTTP/1.0 with no Host: not a browser
  if (LOOPBACK_HOST.test(host)) return true;
  return allowed.has(host.toLowerCase());
}

/** Express middleware: only acts while no password is set. */
export function openHouseGuard(hasPassword: () => boolean, allowed: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasPassword() || openHouseHostAllowed(req.headers.host, allowed, req.headers as Record<string, unknown>)) {
      next();
      return;
    }
    console.warn(`[open-house] refused ${req.method} ${req.originalUrl} — host ${req.headers.host}`);
    res.status(421).json({ error: 'This house has no password, so it only answers this machine directly. To reach it from anywhere else, through a tunnel or another device, set a password first.' });
  };
}
