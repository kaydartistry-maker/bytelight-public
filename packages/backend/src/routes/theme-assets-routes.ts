import { Router, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { getConfig } from '../services/db/config.js';
import { webRestOwner } from '../middleware/owner.js';
import { ThemeAssetStore, ThemeAssetError, DEFAULT_THEME_ASSET_LIMITS, type ThemeAssetKind } from '../services/theme-assets.js';

export interface ThemeAssetsRouteOptions { store?: ThemeAssetStore; readSetup?: () => unknown; ownerForRequest?: typeof webRestOwner }
/** Keep a local owner/origin boundary in addition to parent API authentication. */
export function createThemeAssetsRoutes(options: ThemeAssetsRouteOptions = {}): Router {
  const router = Router(), ownerForRequest = options.ownerForRequest ?? webRestOwner;
  // API route composition happens before server.ts loads configuration. Resolve
  // default storage only for an admitted request, never during module import.
  let store = options.store;
  const assetStore = () => store ??= new ThemeAssetStore();
  const readSetup = options.readSetup ?? (() => {
    const raw = getConfig('phone.app-settings');
    return raw ? JSON.parse(raw) : null;
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: options.store?.limits.maxBytes ?? DEFAULT_THEME_ASSET_LIMITS.maxBytes, files: 1, fields: 1, fieldSize: 20 } });
  // A bounded 200-asset portable import is sequential, so it must fit inside
  // this budget. The pre-multer slot guard below bounds memory/decode pressure.
  const limiter = rateLimit({ windowMs: 60_000, max: 250, standardHeaders: true, legacyHeaders: false, validate: { trustProxy: false } });
  let inFlightUploads = 0;
  const fail = (res: Response, error: unknown): void => {
    if (error instanceof ThemeAssetError) res.status(error.status).json({ error: error.message });
    else res.status(500).json({ error: 'Theme asset operation failed' });
  };
  router.use('/theme-assets', (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try { ownerForRequest(req); } catch { res.status(403).json({ error: 'owner_session_required' }); return; }
    next();
  });
  router.get('/theme-assets', (_req, res) => {
    try { res.json({ assets: assetStore().list() }); } catch (error) { fail(res, error); }
  });
  router.post('/theme-assets', limiter, (req, res) => {
    if (inFlightUploads >= 2) {
      res.setHeader('Retry-After', '1');
      res.setHeader('Connection', 'close');
      res.status(429).json({ error: 'Two theme uploads are already processing. Wait briefly and retry.' });
      req.resume(); // Discard, never buffer, the rejected multipart body.
      return;
    }
    inFlightUploads++;
    let released = false, validating = false;
    const release = () => {
      if (released) return;
      released = true; inFlightUploads--;
      req.off('aborted', closed); res.off('close', closed);
    };
    const closed = () => { if (!validating) release(); };
    req.once('aborted', closed); res.once('close', closed);
    try {
      upload.single('file')(req, res, async error => {
        if (released || req.aborted || res.destroyed) { release(); return; }
        if (error) { release(); res.status(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Invalid or oversized theme asset upload' }); return; }
        if (!req.file || !['image', 'font'].includes(req.body?.kind)) { release(); res.status(400).json({ error: 'Supply a file and kind image or font' }); return; }
        validating = true;
        try {
          const asset = await assetStore().save(req.file.buffer, req.file.originalname, req.body.kind as ThemeAssetKind);
          if (!res.destroyed) res.status(201).json({ asset });
        } catch (failure) { if (!res.destroyed) fail(res, failure); }
        finally { validating = false; release(); }
      });
    } catch (error) { release(); if (!res.destroyed) fail(res, error); }
  });
  router.get('/theme-assets/:id/file', (req, res) => {
    try {
      const result = assetStore().get(req.params.id);
      if (!result) { res.status(404).json({ error: 'Theme asset not found' }); return; }
      res.setHeader('Content-Type', result.asset.mime);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Disposition', 'inline');
      res.sendFile(result.path, error => { if (error && !res.headersSent) res.status(500).json({ error: 'Theme asset unavailable' }); });
    } catch (error) { fail(res, error); }
  });
  router.delete('/theme-assets/:id', (req, res) => {
    try {
      // Unknown/corrupt settings must never make an in-use asset deletable.
      let setup: unknown;
      try { setup = readSetup(); } catch { res.status(409).json({ error: 'Cannot verify theme asset references' }); return; }
      if (!assetStore().remove(req.params.id, setup)) { res.status(404).json({ error: 'Theme asset not found' }); return; }
      res.json({ deleted: true });
    } catch (error) { fail(res, error); }
  });
  return router;
}
