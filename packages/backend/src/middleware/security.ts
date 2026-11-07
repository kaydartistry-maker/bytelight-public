import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: true },
  skip: (req) => req.path === '/auth/check',
});
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  validate: { trustProxy: true },
});
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // geolocation=(self): Thresholds, Weather and Radar ask for her position;
  // an empty list refused them before Chrome could ever prompt.
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=()');
  next();
}
