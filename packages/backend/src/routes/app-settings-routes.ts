import { Router, raw } from 'express';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { PROJECT_ROOT } from '../config.js';
import { getConfig, setConfig } from '../services/db.js';

// ============================================================================
// App-settings sync (Slice 8, Nov 2026). The phone app has always sent its
// setup to /api/app-settings (packages/phone/src/bytelight/settings-sync.ts),
// but no server route ever answered: the phone side was ported without its
// server half. This is that half.
//
//   GET  /app-settings            -> { settings, updatedAt }  (settings null = empty)
//   PUT  /app-settings            <- { settings }  -> { ok, updatedAt }
//   PUT  /app-assets              <- raw bytes (Content-Type = the file's type)
//                                 -> { id }  id = sha256 of the bytes
//   HEAD /app-assets/:id          -> 200 if stored, 404 if not
//   GET  /app-assets/:id          -> the bytes, with their type
//
// The setup is one JSON value in the config table. Pictures, fonts and videos
// travel as content-addressed assets (data/app-assets/<sha256>), so the JSON
// stays small and an unchanged file is never stored or sent twice.
// Single sovereign user: mounted behind authMiddleware in routes/api.ts.
// ============================================================================

const CONFIG_KEY = 'app_settings_sync';
const MAX_SETTINGS_CHARS = 4 * 1024 * 1024;   // the JSON, images excluded
const MAX_ASSET_BYTES = 25 * 1024 * 1024;     // a moving wallpaper is <= 20 MB
const ID = /^[a-f0-9]{64}$/;
const TYPE = /^[a-z]+\/[a-z0-9.+-]+$/i;
// Types that a browser would run as a page or script on the house's own
// address. Looks are pictures, fonts and videos; none of these belong here.
const PAGE_TYPE = /^(text\/(html|xml|javascript|ecmascript)|application\/(xhtml\+xml|xml|javascript|ecmascript|x-javascript))$/i;

export interface AppSettingsStore {
  get(): string | null;
  set(value: string): void;
}

const configStore: AppSettingsStore = {
  get: () => getConfig(CONFIG_KEY),
  set: (v) => setConfig(CONFIG_KEY, v),
};

export function createAppSettingsRoutes(opts: { store?: AppSettingsStore; assetsDir?: string; now?: () => number } = {}): Router {
  const store = opts.store ?? configStore;
  const assetsDir = opts.assetsDir ?? join(PROJECT_ROOT, 'data', 'app-assets');
  const now = opts.now ?? Date.now;
  const router = Router();

  router.get('/app-settings', (_req, res) => {
    const raw = store.get();
    if (!raw) return res.json({ settings: null, updatedAt: 0 });
    try {
      const saved = JSON.parse(raw) as { settings: unknown; updatedAt: number };
      res.json({ settings: saved.settings ?? null, updatedAt: Number(saved.updatedAt) || 0 });
    } catch {
      res.json({ settings: null, updatedAt: 0 });
    }
  });

  router.put('/app-settings', (req, res) => {
    const settings = (req.body ?? {}).settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings must be an object' });
    }
    const text = JSON.stringify(settings);
    if (text.length > MAX_SETTINGS_CHARS) {
      return res.status(413).json({ error: 'settings too large; pictures and files belong in /app-assets' });
    }
    const updatedAt = now();
    store.set(JSON.stringify({ settings, updatedAt }));
    res.json({ ok: true, updatedAt });
  });

  const assetPath = (id: string) => join(assetsDir, id);
  const typePath = (id: string) => join(assetsDir, `${id}.type`);

  router.put('/app-assets', raw({ type: () => true, limit: MAX_ASSET_BYTES }), (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'empty file' });
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    if (!TYPE.test(type)) return res.status(400).json({ error: 'bad content type' });
    if (PAGE_TYPE.test(type)) return res.status(415).json({ error: 'pages and scripts are not look files' });
    const id = createHash('sha256').update(body).digest('hex');
    if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
    if (!existsSync(assetPath(id))) {
      const tmp = `${assetPath(id)}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, assetPath(id));
    }
    writeFileSync(typePath(id), type);
    res.json({ id });
  });

  router.head('/app-assets/:id', (req, res) => {
    const id = req.params.id;
    res.status(ID.test(id) && existsSync(assetPath(id)) ? 200 : 404).end();
  });

  router.get('/app-assets/:id', (req, res) => {
    const id = req.params.id;
    if (!ID.test(id) || !existsSync(assetPath(id))) return res.status(404).json({ error: 'not found' });
    const type = existsSync(typePath(id)) ? readFileSync(typePath(id), 'utf8').trim() : 'application/octet-stream';
    res.setHeader('Content-Type', TYPE.test(type) ? type : 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Opened on its own, an asset is a locked box: no scripts, no requests.
    // Pictures, fonts and videos used by the app are unaffected.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    // Streamed from disk rather than read whole: a moving wallpaper can be
    // 20 MB, and streaming also answers Range requests so a video can seek.
    res.sendFile(resolve(assetPath(id)), { cacheControl: false, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });

  return router;
}
