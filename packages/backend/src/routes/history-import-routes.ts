// history-import-routes.ts — the import door for old chats (services/history-import.ts).
//
//   POST /memory/old-windows/upload    the export, as a file from the phone
//   POST /memory/old-windows/preview   { upload | path, month? }  → what is in it; writes nothing
//   POST /memory/old-windows/import    { upload | path, month? }  → starts the import
//   GET  /memory/old-windows/import    → where the import is
//
// A very large export may be too big to send through a tunnel, so the person
// can instead name a file already on the house's machine (`path`). An upload
// lands under a name the house makes, in a folder of its own, and is removed
// once its import finishes well; a named file is never removed.

import type { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PROJECT_ROOT } from '../config.js';
import { embed } from '../services/embeddings.js';
import { importStatus, previewExport, startImport } from '../services/history-import.js';

const UPLOAD_DIR = join(PROJECT_ROOT, 'data', 'uploads', 'history-import');
const UPLOAD_NAME = /^export-[a-f0-9]{16}\.(zip|json|af)$/;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MONTH = /^\d{4}-\d{2}$/;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try { mkdirSync(UPLOAD_DIR, { recursive: true }); cb(null, UPLOAD_DIR); } catch (e) { cb(e as Error, UPLOAD_DIR); }
    },
    filename: (_req, file, cb) => {
      const given = extname(file.originalname || '').toLowerCase();
      const ext = given === '.json' || given === '.af' ? given : '.zip';
      cb(null, `export-${randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /\.(zip|json|af)$/i.test(file.originalname || '')),
});

/** The file a request names, and whether the house made it (so may remove it). */
function fileOf(body: unknown): { path: string; ours: boolean } | { error: string } {
  const b = (body ?? {}) as { upload?: unknown; path?: unknown };
  if (typeof b.upload === 'string') {
    if (!UPLOAD_NAME.test(b.upload)) return { error: 'That upload is not one this house made.' };
    return { path: join(UPLOAD_DIR, b.upload), ours: true };
  }
  if (typeof b.path === 'string' && b.path.trim()) {
    const p = b.path.trim();
    if (!isAbsolute(p)) return { error: 'Give the full path to the file on this machine, starting with /.' };
    return { path: p, ours: false };
  }
  return { error: 'Choose an export first.' };
}

function monthOf(body: unknown): string | undefined | { error: string } {
  const m = (body as { month?: unknown } | undefined)?.month;
  if (m === undefined || m === null || m === '') return undefined;
  return typeof m === 'string' && MONTH.test(m) ? m : { error: 'The month should look like 2026-10.' };
}

export function registerHistoryImportRoutes(router: Router): void {
  router.post('/memory/old-windows/upload', (req, res) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err) {
        const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({ error: tooBig ? 'That file is too big to send. Put it on the house\'s machine and give its path instead.' : 'The upload did not come through.' });
      }
      if (!req.file) return res.status(400).json({ error: 'Pick the export zip, its conversations.json, or a Letta agent file (.af).' });
      res.json({ upload: req.file.filename, bytes: req.file.size });
    });
  });

  router.post('/memory/old-windows/preview', async (req, res) => {
    const file = fileOf(req.body);
    if ('error' in file) return res.status(400).json(file);
    const month = monthOf(req.body);
    if (month && typeof month === 'object') return res.status(400).json(month);
    try {
      res.json(await previewExport(file.path, { month }));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'That export could not be read.' });
    }
  });

  router.post('/memory/old-windows/import', (req, res) => {
    const file = fileOf(req.body);
    if ('error' in file) return res.status(400).json(file);
    const month = monthOf(req.body);
    if (month && typeof month === 'object') return res.status(400).json(month);
    try {
      void startImport(file.path, { month }, { embed, removeAfter: file.ours });
      res.status(202).json(importStatus());
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'The import could not start.' });
    }
  });

  router.get('/memory/old-windows/import', (_req, res) => {
    res.json(importStatus());
  });
}
