// Custom emoji API routes
import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { authMiddleware } from '../middleware/auth.js';
import {
  createEmoji,
  getEmoji,
  getEmojiByName,
  listEmojis,
  updateEmoji,
  deleteEmoji,
  createEmojiPack,
  getEmojiPack,
  getEmojiPackByName,
  listEmojiPacks,
  updateEmojiPack,
  deleteEmojiPack,
  getPacksWithEmojis,
} from '../services/db/emojis.js';
import { PROJECT_ROOT } from '../config.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 }, // 1MB max — animated emoji can run large
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, WebP, and GIF files are allowed'));
    }
  },
});

// Same wrapper-with-errors pattern as the stickers route — surface multer
// rejections as 4xx with a useful body instead of letting them bubble.
function uploadWithErrors(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large (max 1MB).' });
      }
      return res.status(400).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message || 'Upload failed' });
  });
}

// BYTE-LIGHT ADAPTATION: full-sweep derived this from dirname(db_path); here
// it sits beside data/stickers under PROJECT_ROOT, the same folder server.ts
// serves at /emojis.
function getEmojiDir(): string {
  const dir = join(PROJECT_ROOT, 'data', 'emojis');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

// All routes require auth
router.use(authMiddleware);

// === Pack routes ===

// List all packs
router.get('/packs', (_req, res) => {
  const packs = listEmojiPacks();
  res.json(packs);
});

// Get packs with emojis (for picker UI)
router.get('/packs-with-emojis', (_req, res) => {
  const packs = getPacksWithEmojis();
  res.json(packs);
});

// Create pack
router.post('/packs', (req, res) => {
  const { name, description, userOnly } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Name is required' });
  }

  const existing = getEmojiPackByName(name);
  if (existing) {
    return res.status(409).json({ error: 'Pack with this name already exists' });
  }

  const pack = createEmojiPack({
    id: crypto.randomUUID(),
    name: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    description,
    userOnly: Boolean(userOnly),
    createdAt: new Date().toISOString(),
  });

  res.status(201).json(pack);
});

// Update pack
router.put('/packs/:id', (req, res) => {
  const { id } = req.params;
  const { name, description, userOnly } = req.body;

  const pack = getEmojiPack(id);
  if (!pack) {
    return res.status(404).json({ error: 'Pack not found' });
  }

  if (name && name !== pack.name) {
    const existing = getEmojiPackByName(name);
    if (existing) {
      return res.status(409).json({ error: 'Pack with this name already exists' });
    }
  }

  updateEmojiPack(id, {
    name: name ? name.toLowerCase().replace(/[^a-z0-9]/g, '') : undefined,
    description,
    userOnly,
  });

  res.json(getEmojiPack(id));
});

// Delete pack
router.delete('/packs/:id', (req, res) => {
  const { id } = req.params;

  const pack = getEmojiPack(id);
  if (!pack) {
    return res.status(404).json({ error: 'Pack not found' });
  }

  // Delete all emoji files in this pack
  const emojis = listEmojis(id);
  for (const emoji of emojis) {
    const filepath = join(getEmojiDir(), emoji.filename);
    if (existsSync(filepath)) {
      unlinkSync(filepath);
    }
  }

  deleteEmojiPack(id);
  res.status(204).send();
});

// === Emoji routes ===

// List all emojis (optionally by pack)
router.get('/', (req, res) => {
  const { packId } = req.query;
  const emojis = listEmojis(packId as string | undefined);
  res.json(emojis);
});

// Lookup emoji by name (for shortcode resolution)
router.get('/lookup', (req, res) => {
  const { name } = req.query;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name query param required' });
  }
  const emoji = getEmojiByName(name);
  if (!emoji) {
    return res.status(404).json({ error: 'Emoji not found' });
  }
  res.json(emoji);
});

// Upload emoji
router.post('/', uploadWithErrors, (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { name, aliases, packId } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    if (packId) {
      const pack = getEmojiPack(packId);
      if (!pack) {
        return res.status(404).json({ error: 'Pack not found' });
      }
    }

    const sanitizedName = sanitizeFilename(name);
    const existing = getEmojiByName(sanitizedName);
    if (existing) {
      return res.status(409).json({ error: 'Emoji with this name already exists' });
    }

    const ext = req.file.mimetype === 'image/webp' ? '.webp'
      : req.file.mimetype === 'image/gif' ? '.gif' : '.png';
    const filename = `${sanitizedName}${ext}`;
    const filepath = join(getEmojiDir(), filename);

    writeFileSync(filepath, req.file.buffer);

    let parsedAliases: string[] = [];
    if (aliases) {
      try {
        parsedAliases = typeof aliases === 'string' ? JSON.parse(aliases) : aliases;
      } catch {
        parsedAliases = [];
      }
    }

    const emoji = createEmoji({
      id: crypto.randomUUID(),
      name: sanitizedName,
      filename,
      aliases: parsedAliases,
      packId: packId || null,
      createdAt: new Date().toISOString(),
    });

    res.status(201).json(emoji);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/.test(message)) {
      return res.status(409).json({ error: 'An emoji with this name already exists.' });
    }
    console.error('[Emojis] Upload failed:', err);
    res.status(500).json({ error: message });
  }
});

// Update emoji (PUT and PATCH both work)
router.patch('/:id', updateEmojiHandler);
router.put('/:id', updateEmojiHandler);

function updateEmojiHandler(req: import('express').Request, res: import('express').Response) {
  const id = req.params.id as string;
  const { name, aliases } = req.body;

  const emoji = getEmoji(id);
  if (!emoji) {
    return res.status(404).json({ error: 'Emoji not found' });
  }

  if (name) {
    const sanitizedName = sanitizeFilename(name);
    const existing = getEmojiByName(sanitizedName);
    if (existing && existing.id !== id) {
      return res.status(409).json({ error: 'Emoji with this name already exists' });
    }
  }

  updateEmoji(id, {
    name: name ? sanitizeFilename(name) : undefined,
    aliases,
  });

  res.json(getEmoji(id));
}

// Delete emoji
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  const emoji = getEmoji(id);
  if (!emoji) {
    return res.status(404).json({ error: 'Emoji not found' });
  }

  const filepath = join(getEmojiDir(), emoji.filename);
  if (existsSync(filepath)) {
    unlinkSync(filepath);
  }

  deleteEmoji(id);
  res.status(204).send();
});

export default router;
