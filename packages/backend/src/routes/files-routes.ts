import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { getDb } from '../services/db.js';
import { saveFile, getFile, deleteFile, listFiles } from '../services/files.js';

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

      // Scan messages for fileId references to determine in-use status
      const db = getDb();
      const rows = db.prepare('SELECT metadata FROM messages WHERE metadata IS NOT NULL AND deleted_at IS NULL').all() as Array<{ metadata: string }>;
      const usedFileIds = new Set<string>();
      for (const row of rows) {
        try {
          const meta = JSON.parse(row.metadata);
          if (meta.fileId) usedFileIds.add(meta.fileId);
        } catch { /* skip */ }
      }

      const enriched = files.map(f => ({
        ...f,
        inUse: usedFileIds.has(f.fileId),
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
