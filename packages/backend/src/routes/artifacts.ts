// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Artifacts — interactive React components shown in the phone's Artifacts app.
//
// Ported from the Artifacts handlers in Aerie's routes/api.ts. Two changes:
// - byte-light gives these handlers their own file; api.ts mounts it after
//   authMiddleware, the same gate Aerie's api.ts router had.
// - Aerie imports @babel/core statically and compiles with
//   @babel/preset-react. byte-light does not depend on either, so Babel is
//   loaded with a dynamic import and any miss (module or preset absent, or a
//   compile error) stores the raw code — the fallback Aerie already had. The
//   phone's sealed frame compiles JSX itself with babel.min.js when it sees it.

import { Router } from 'express';
import crypto from 'crypto';
import { getDb } from '../services/db.js';

const router = Router();

// A variable specifier keeps TypeScript from requiring @babel/core's types,
// which byte-light only has transitively (if at all).
const BABEL_CORE = '@babel/core';

async function compileJsx(code: string): Promise<string> {
  try {
    const babel = await import(BABEL_CORE);
    const transformAsync = babel.transformAsync ?? babel.default?.transformAsync;
    const result = await transformAsync(code, {
      presets: ['@babel/preset-react'],
      filename: 'artifact.jsx',
    });
    if (result?.code) {
      console.log('[Artifacts] Compiled JSX successfully');
      return result.code as string;
    }
  } catch (compileErr: any) {
    console.warn('[Artifacts] JSX compilation failed, storing raw code:', compileErr?.message ?? compileErr);
    // Store raw code if compilation fails — might be plain JS already
  }
  return code;
}

// ─── Artifacts (interactive React components) ────────────────────
router.get('/artifacts', (req, res) => {
  try {
    const db = getDb();
    const artifacts = db.prepare(`
      SELECT id, name, description, thumbnail, created_at, updated_at
      FROM artifacts
      ORDER BY updated_at DESC
    `).all();
    res.json({ artifacts });
  } catch (err) {
    console.error('[Artifacts] List error:', err);
    res.status(500).json({ error: 'Failed to list artifacts' });
  }
});

router.get('/artifacts/:id', (req, res) => {
  try {
    const db = getDb();
    const artifact = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(req.params.id);
    if (!artifact) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    res.json({ artifact });
  } catch (err) {
    console.error('[Artifacts] Get error:', err);
    res.status(500).json({ error: 'Failed to get artifact' });
  }
});

router.post('/artifacts', async (req, res) => {
  try {
    const { name, description, code, thumbnail } = req.body;
    if (!name || !code) {
      return res.status(400).json({ error: 'name and code are required' });
    }

    // Pre-compile JSX to plain JavaScript
    const compiledCode = await compileJsx(code);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(`
      INSERT INTO artifacts (id, name, description, code, thumbnail, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, description || null, compiledCode, thumbnail || null, now, now);
    const artifact = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id);
    res.status(201).json({ artifact });
  } catch (err) {
    console.error('[Artifacts] Create error:', err);
    res.status(500).json({ error: 'Failed to create artifact' });
  }
});

router.patch('/artifacts/:id', (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    const { name, description, code, thumbnail } = req.body;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE artifacts SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        code = COALESCE(?, code),
        thumbnail = COALESCE(?, thumbnail),
        updated_at = ?
      WHERE id = ?
    `).run(name ?? null, description ?? null, code ?? null, thumbnail ?? null, now, req.params.id);
    const artifact = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(req.params.id);
    res.json({ artifact });
  } catch (err) {
    console.error('[Artifacts] Update error:', err);
    res.status(500).json({ error: 'Failed to update artifact' });
  }
});

router.delete('/artifacts/:id', (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[Artifacts] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete artifact' });
  }
});

export default router;
