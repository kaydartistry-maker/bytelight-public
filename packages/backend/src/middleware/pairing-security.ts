import type { Request } from 'express';
/** Forwarded HTTPS is accepted only from the local reverse proxy, never arbitrary peers. */
export function isHttps(req: Request): boolean {
  const peer = req.socket?.remoteAddress;
  const localProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  return !!(req.socket as typeof req.socket & { encrypted?: boolean })?.encrypted ||
    (req.secure && !req.headers['x-forwarded-proto']) ||
    (localProxy && req.headers['x-forwarded-proto'] === 'https');
}
export function requireHttpsOrigin(req: Request): void {
  const origin = req.get('origin');
  if (!isHttps(req) || !origin || origin !== `https://${req.get('host')}` || new URL(origin).origin !== origin) throw new Error('Invalid request');
}
