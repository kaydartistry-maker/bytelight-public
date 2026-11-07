import { Router } from 'express';
import { mindUrl, mindKey } from '../services/mind-secrets.js';

// ─── Mind Bridge proxy ───────────────────────────────────────────

async function mindFetch(path: string): Promise<unknown> {
  const res = await fetch(`${mindUrl()}${path}`, {
    headers: { Authorization: `Bearer ${mindKey()}` },
  });
  if (!res.ok) throw new Error(`Mind API ${res.status}`);
  return res.json();
}

export function createMindRoutes(): Router {
  const router = Router();

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
