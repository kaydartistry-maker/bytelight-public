// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// routes/treehouse.ts — Treehouse API routes
//
// Ported from Aerie. Mounted after authMiddleware (routes/api.ts). Adapted:
// the owner reads the Treehouse and does not post in it, so only Aerie's
// read routes are here. Aerie's POST /treehouse/post and the generic
// /threads/:threadId/companion-post would let the phone write in a companion's
// voice; companions post through /api/internal/treehouse-post (localhost) in
// routes/internal-routes.ts instead.
import { Router } from 'express';
import * as treehouse from '../services/treehouse.js';

const router = Router();

router.get('/treehouse', (req, res) => {
  try {
    const info = treehouse.getTreehouseInfo();
    res.json(info);
  } catch (error) {
    console.error('Treehouse info error:', error);
    res.status(500).json({ error: 'Treehouse unavailable' });
  }
});

router.get('/treehouse/messages', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const before = req.query.before as string | undefined;
    const messages = treehouse.getTreehouseMessages(limit, before);
    res.json(messages);
  } catch (error) {
    console.error('Treehouse messages error:', error);
    res.status(500).json({ error: 'Treehouse unavailable' });
  }
});

router.get('/threads/:id/is-treehouse', (req, res) => {
  try {
    res.json({ isTreehouse: treehouse.isTreehouse(req.params.id) });
  } catch {
    res.json({ isTreehouse: false });
  }
});

export default router;
