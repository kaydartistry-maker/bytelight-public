import { json, type RequestHandler } from 'express';
/** Parser failures may contain raw request bodies. Never forward them to the logger. */
export function privateJson(limit: string): RequestHandler {
  const parse = json({ limit });
  return (req, res, next) => parse(req, res, error => {
    if (error) { res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid request' }); return; }
    next();
  });
}
