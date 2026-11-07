// routes/self-knowledge-routes.ts — authenticated Self-Knowledge API (the operator's window).
//
// Provenance: ported from the tris/Aerie fork — commit 8838f261
// (routes/self-knowledge.ts, the phone-facing review endpoints) plus 67339ed6
// (semantic retrieval, exposed here as a manual search endpoint). The
// four-drawer identity design is Annie's.
//
// Adaptations vs. the source fork:
//   (a) Wrapped in byte-light's createXRoutes(): Router factory convention
//       (the source exported a bare `default router`; here it mirrors
//       memory-routes.ts / mind-routes.ts so it mounts the same way). Auth is
//       provided by the authMiddleware boundary in api.ts — the router itself
//       carries no authMiddleware.use(), matching the house pattern.
//   (b) Every successful write broadcasts `self_knowledge` over the WS registry
//       so an open Self-Knowledge panel re-fetches. Same idiom as memory-routes.
//   (c) the operator reviewing from her window is the operator acting directly, so
//       receipts are attributed to 'user' (byte-light has no getOwnerSlug()).
//   (d) A /self-knowledge/search endpoint exposes the semantic index for MANUAL
//       search. Auto-retrieval into companion prompts is intentionally NOT
//       wired (the operator's ruling — see the slice report for the future wiring point).

import { Router } from 'express';
import {
  listSelfKnowledge,
  reviewSelfKnowledge,
  updateSelfKnowledgeContent,
  deleteSelfKnowledge,
  searchAcceptedSelfKnowledge,
  isSelfKnowledgeCategory,
  type SelfKnowledgeCategory,
  type SelfKnowledgeStatus,
} from '../services/db/self-knowledge.js';
import { semanticSearchSelfKnowledge } from '../services/self-knowledge-index.js';
import { registry } from '../services/registry.js';

export function createSelfKnowledgeRoutes(): Router {
  const router = Router();

  // List entries, optionally filtered by companion / category / status. Proposed
  // float to the top (see the DB layer's ORDER BY).
  router.get('/self-knowledge', (req, res) => {
    const companionId = typeof req.query.companion === 'string' ? req.query.companion : undefined;
    const categoryRaw = typeof req.query.category === 'string' ? req.query.category : undefined;
    const category = isSelfKnowledgeCategory(categoryRaw) ? (categoryRaw as SelfKnowledgeCategory) : undefined;
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    const status = statusRaw === 'proposed' || statusRaw === 'accepted' || statusRaw === 'dismissed'
      ? (statusRaw as SelfKnowledgeStatus) : undefined;
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 100, 200);
    const offset = parseInt(String(req.query.offset), 10) || 0;
    const { entries, total } = listSelfKnowledge({ companionId, category, status, limit, offset });
    res.json({ total, entries });
  });

  // Manual search over accepted entries. ?mode=semantic uses the embedding
  // index; otherwise keyword LIKE. This is the manual/semantic search surface —
  // nothing auto-injects into companion context.
  router.get('/self-knowledge/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.status(400).json({ error: 'q is required' });
      return;
    }
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 6, 50);
    try {
      if (req.query.mode === 'semantic') {
        const results = await semanticSearchSelfKnowledge(q, limit);
        res.json({ mode: 'semantic', results });
        return;
      }
      const results = searchAcceptedSelfKnowledge(q, limit);
      res.json({ mode: 'keyword', results });
    } catch (error) {
      console.error('Self-knowledge search error:', error);
      res.status(500).json({ error: 'Self-knowledge search failed' });
    }
  });

  // Accept a proposed entry into identity, or dismiss it. The operator's window keeps
  // full oversight — she can accept, dismiss, or restore any entry.
  router.post('/self-knowledge/:id/review', (req, res) => {
    const { status } = req.body as { status?: string };
    if (status !== 'accepted' && status !== 'dismissed') {
      res.status(400).json({ error: "status must be 'accepted' or 'dismissed'" });
      return;
    }
    const entry = reviewSelfKnowledge(String(req.params.id), status, 'user');
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    registry.broadcast({ type: 'self_knowledge', entry: { ...entry } });
    res.json(entry);
  });

  // Refine the wording.
  router.patch('/self-knowledge/:id', (req, res) => {
    const { content } = req.body as { content?: string };
    if (!content || !content.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    const entry = updateSelfKnowledgeContent(String(req.params.id), content.trim(), 'user');
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    registry.broadcast({ type: 'self_knowledge', entry: { ...entry } });
    res.json(entry);
  });

  router.delete('/self-knowledge/:id', (req, res) => {
    const deleted = deleteSelfKnowledge(String(req.params.id), 'user');
    if (!deleted) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
