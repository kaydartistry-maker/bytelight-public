import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { getDb } from '../services/db.js';
import { saveFile, getFile, deleteFile, listFiles } from '../services/files.js';
import { referencedFileIds } from '../services/file-references.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many uploads, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

export function createFilesRoutes(): Router {
  const router = Router();

  // File upload
  // Sacred chain: uploadRateLimiter → upload.single('file') → handler
  router.post('/files', uploadRateLimiter, upload.single('file'), (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      const fileMeta = saveFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      res.json(fileMeta);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Upload failed';
      console.error('File upload error:', msg);
      res.status(400).json({ error: msg });
    }
  });

  // File listing (MUST be before /files/:id)
  router.get('/files/list', (req, res) => {
    try {
      const files = listFiles();

      // A file is in use if anything in the house still points at it. Live
      // messages are read on their own so a file attached only to a deleted
      // message can still be cleaned. Every other table is read whole: a fixed
      // list of tables missed a new feature's thumbnails the day it shipped,
      // and "Clean orphans" deletes whatever this calls unused, so a new feature
      // that stores files must never fall through. The audit log only records
      // that something happened, so a mention there is not a use. Embedding
      // tables hold vectors, never file ids.
      // Every stored file id comes from crypto.randomUUID(), a v4 uuid, so it
      // always contains "-4". Text without it cannot point at a file; skipping
      // it before the regex roughly halves the scan on the live house.
      const db = getDb();
      const known = new Set(files.map(f => f.fileId.toLowerCase()));
      const SKIP = new Set(['messages', 'audit_log', 'sqlite_sequence']);
      function* texts(): Generator<string | null> {
        for (const row of db.prepare("SELECT metadata, content FROM messages WHERE deleted_at IS NULL AND (instr(metadata, '-4') > 0 OR instr(content, '-4') > 0)").iterate() as Iterable<{ metadata: string | null; content: string | null }>) {
          yield row.metadata;
          yield row.content;
        }
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        for (const { name } of tables) {
          if (SKIP.has(name) || name.endsWith('_embeddings')) continue;
          let rows: Iterable<unknown[]>;
          try {
            rows = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).raw().iterate() as Iterable<unknown[]>;
          } catch { continue; }
          for (const row of rows) {
            for (const cell of row) if (typeof cell === 'string' && cell.length >= 36 && cell.includes('-4')) yield cell;
          }
        }
      }
      const usedFileIds = referencedFileIds(texts(), known);

      const enriched = files.map(f => ({
        ...f,
        inUse: usedFileIds.has(f.fileId.toLowerCase()),
      }));

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      const orphanCount = enriched.filter(f => !f.inUse).length;

      res.json({ files: enriched, totalSize, totalCount: files.length, orphanCount });
    } catch (error) {
      console.error('Error listing files:', error);
      res.status(500).json({ error: 'Failed to list files' });
    }
  });

  // Delete a file
  router.delete('/files/:id', (req, res) => {
    try {
      const deleted = deleteFile(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting file:', error);
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  // File download
  router.get('/files/:id', (req, res) => {
    try {
      const file = getFile(req.params.id);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400'); // 24h cache
      // Ported whole from Thornvale (fa006235). The phone asks for ?download=1
      // on every save, because a WebView (and a browser link without a
      // download attribute) decides what to do from the response: without
      // this header a picture is shown in place and nothing is saved.
      if (req.query.download !== undefined) {
        // On disk a file is only its uuid plus an extension; the human name lives
        // in the message that carries it. The page passes it back so the saved
        // file is not a wall of hex -- but it is user input reaching a header, so
        // it gets stripped of separators and anything non-printable below.
        const asked = typeof req.query.name === 'string' ? req.query.name : '';
        const cleaned = asked.replace(/[\\/]/g, '').replace(/^\.+/, '').slice(0, 120).trim();
        const name = cleaned || file.filename || 'download';
        // Quotes and control characters would break out of the header value.
        const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
      }
      res.sendFile(file.path);
    } catch (error) {
      console.error('File download error:', error);
      res.status(500).json({ error: 'Failed to retrieve file' });
    }
  });

  return router;
}
