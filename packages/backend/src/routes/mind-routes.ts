import { Router } from 'express';
import { mindUrl, mindKey } from '../services/mind-secrets.js';
import { consoleAllows, consoleSegments } from '../services/mind-console.js';

// ─── Mind Bridge proxy ───────────────────────────────────────────

async function mindFetch(path: string): Promise<unknown> {
  const res = await fetch(`${mindUrl()}${path}`, {
    headers: { Authorization: `Bearer ${mindKey()}` },
  });
  if (!res.ok) throw new Error(`Mind API ${res.status}`);
  return res.json();
}

export interface MindRouteDeps {
  url?: () => string;
  key?: () => string;
  fetchImpl?: typeof fetch;
}

export function createMindRoutes(deps: MindRouteDeps = {}): Router {
  const router = Router();
  const brainUrl = deps.url ?? mindUrl;
  const brainKey = deps.key ?? mindKey;
  const doFetch = deps.fetchImpl ?? fetch;

  // ─── The console hallway ───────────────────────────────────────
  // /api/mind/brain/<room>/... goes on to the brain's own /api/<room>/...
  // Reads of known rooms pass; writes pass only when mind-console.ts names
  // them. Sits behind authMiddleware with its neighbours, so it is the
  // owner's alone.
  router.all(/^\/mind\/brain\/(.+)$/, async (req, res) => {
    const segs = consoleSegments((req.params as Record<string, string>)[0] ?? '');
    if (!segs) { res.status(400).json({ error: 'bad path' }); return; }
    if (!consoleAllows(req.method, segs)) {
      res.status(403).json({ error: 'the console cannot do that' });
      return;
    }
    const base = brainUrl();
    const key = brainKey();
    if (!base || !key) { res.status(503).json({ error: 'Mind Bridge not configured' }); return; }

    const qIndex = req.originalUrl.indexOf('?');
    const query = qIndex >= 0 ? req.originalUrl.slice(qIndex) : '';
    const target = `${base.replace(/\/+$/, '')}/api/${segs.map(encodeURIComponent).join('/')}${query}`;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    try {
      const upstream = await doFetch(target, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await upstream.text();
      res.status(upstream.status);
      res.type(upstream.headers.get('content-type') || 'application/json');
      res.send(text);
    } catch (e: any) {
      res.status(502).json({ error: e?.name === 'TimeoutError' ? 'the brain took too long' : 'could not reach the brain' });
    }
  });

  router.get('/mind/health', async (_req, res) => {
    try {
      if (!mindUrl() || !mindKey()) { res.status(503).json({ error: 'Mind Bridge not configured' }); return; }
      const data = await mindFetch('/api/health');
      res.json(data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get('/mind/entities', async (_req, res) => {
    try {
      if (!mindUrl() || !mindKey()) { res.status(503).json({ error: 'Mind Bridge not configured' }); return; }
      const data = await mindFetch('/api/entities');
      res.json(data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get('/mind/entities/:id', async (req, res) => {
    try {
      if (!mindUrl() || !mindKey()) { res.status(503).json({ error: 'Mind Bridge not configured' }); return; }
      const data = await mindFetch(`/api/entities/${req.params.id}`);
      res.json(data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get('/mind/journals', async (_req, res) => {
    try {
      if (!mindUrl() || !mindKey()) { res.status(503).json({ error: 'Mind Bridge not configured' }); return; }
      // Journals aren't stored as type 'journal' - they're observations with reflective content
      // Search for journal-like entries instead of filtering by nonexistent type
      const data = await mindFetch('/api/search?q=' + encodeURIComponent('journal OR reflection OR session'));
      res.json(data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get('/mind/identity', async (_req, res) => {
    try {
      if (!mindUrl() || !mindKey()) { res.status(503).json({ error: 'Mind Bridge not configured' }); return; }
      const data = await mindFetch('/api/identity');
      res.json(data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get('/mind/threads', async (_req, res) => {
    try {
      if (!mindUrl() || !mindKey()) { res.status(503).json({ error: 'Mind Bridge not configured' }); return; }
      const data = await mindFetch('/api/threads');
      res.json(data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get('/mind/recent', async (_req, res) => {
    try {
      if (!mindUrl() || !mindKey()) { res.status(503).json({ error: 'Mind Bridge not configured' }); return; }
      const data = await mindFetch('/api/recent');
      res.json(data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
