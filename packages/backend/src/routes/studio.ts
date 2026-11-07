// Studio routes — the authed data surface behind the Studio app.
// Covers: image-gen settings, reference drawers, and gallery.

import { Router } from 'express';
import multer from 'multer';
import { basename, join } from 'path';
import { existsSync } from 'fs';
import { getConfig, setConfig, getThread, getDb, softDeleteMessage } from '../services/db.js';
import { deleteFile } from '../services/files.js';
import { registry } from '../services/registry.js';
import {
  getImageGenSettings,
  monthlyImageSpendUsd,
  listDrawers,
  createDrawer,
  renameDrawer,
  deleteDrawer,
  isValidSubject,
  listReferences,
  saveReference,
  deleteReference,
  saveOneOffReference,
  listGallery,
  getGalleryMeta,
  deleteGalleryItem,
  generateImage,
  recordGalleryMeta,
  galleryDimensions,
  startGenerateJob,
  getJobStatus,
  listImageJobs,
  ImageGenError,
  REFS_DIR,
  GALLERY_DIR,
} from '../services/image-gen.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function refUrl(slug: string, filename: string): string {
  return `/api/studio/refs/${slug}/${encodeURIComponent(filename)}`;
}

// ─── Settings ────────────────────────────────────────────────────────

router.get('/studio/settings', async (_req, res) => {
  try {
    const settings = getImageGenSettings();
    const monthlySpendUsd = await monthlyImageSpendUsd();
    res.json({ settings, monthlySpendUsd });
  } catch (error) {
    console.error('[studio] settings read error:', error);
    res.status(500).json({ error: 'Failed to read Studio settings' });
  }
});

router.put('/studio/settings', (req, res) => {
  try {
    const b = req.body as Record<string, unknown>;
    const writes: Array<[string, string]> = [];

    if ('enabled' in b) writes.push(['image_gen.enabled', b.enabled ? 'true' : 'false']);
    if ('backend' in b) {
      const v = String(b.backend);
      if (!['codex', 'openai', 'cloudflare', 'antigravity', 'openart'].includes(v)) { res.status(400).json({ error: 'backend must be codex, openai, cloudflare, antigravity, or openart' }); return; }
      writes.push(['image_gen.backend', v]);
    }
    if ('size' in b) {
      const v = String(b.size);
      if (!['square', 'portrait', 'landscape'].includes(v)) { res.status(400).json({ error: 'invalid size' }); return; }
      writes.push(['image_gen.size', v]);
    }
    if ('quality' in b) {
      const v = String(b.quality);
      if (!['auto', 'low', 'medium', 'high'].includes(v)) { res.status(400).json({ error: 'invalid quality' }); return; }
      writes.push(['image_gen.quality', v]);
    }
    if ('openai_model' in b) writes.push(['image_gen.openai_model', String(b.openai_model)]);
    if ('openai_api_key' in b) writes.push(['image_gen.openai_api_key', String(b.openai_api_key)]);
    if ('antigravity_model' in b) writes.push(['image_gen.antigravity_model', String(b.antigravity_model)]);
    if ('openart_model' in b) writes.push(['image_gen.openart_model', String(b.openart_model)]);
    if ('monthly_budget_usd' in b) {
      const n = Number(b.monthly_budget_usd);
      if (Number.isNaN(n) || n < 0) { res.status(400).json({ error: 'monthly_budget_usd must be a non-negative number' }); return; }
      writes.push(['image_gen.monthly_budget_usd', String(n)]);
    }

    for (const [k, v] of writes) setConfig(k, v);
    res.json({ success: true, settings: getImageGenSettings() });
  } catch (error) {
    console.error('[studio] settings write error:', error);
    res.status(500).json({ error: 'Failed to update Studio settings' });
  }
});

// ─── Folders (for organizing gallery) ────────────────────────────────

// Folders stored in config as JSON
function getStudioFolders(): Array<{ id: string; name: string }> {
  const raw = getConfig('studio.folders');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string') : [];
  } catch {
    return [];
  }
}

function setStudioFolders(folders: Array<{ id: string; name: string }>): void {
  setConfig('studio.folders', JSON.stringify(folders));
}

router.get('/studio/folders', (_req, res) => {
  res.json({ folders: getStudioFolders() });
});

router.post('/studio/folders', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: 'Folder name is required' });
    return;
  }
  const folders = getStudioFolders();
  const id = `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  folders.push({ id, name: name.trim() });
  setStudioFolders(folders);
  res.json({ success: true, folder: { id, name: name.trim() } });
});

router.patch('/studio/folders/:id', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: 'Folder name is required' });
    return;
  }
  const folders = getStudioFolders();
  const idx = folders.findIndex((f) => f.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: 'Folder not found' });
    return;
  }
  folders[idx].name = name.trim();
  setStudioFolders(folders);
  res.json({ success: true, folder: folders[idx] });
});

router.delete('/studio/folders/:id', async (req, res) => {
  const folders = getStudioFolders();
  const next = folders.filter((f) => f.id !== req.params.id);
  if (next.length === folders.length) {
    res.status(404).json({ error: 'Folder not found' });
    return;
  }
  setStudioFolders(next);
  for (const item of await listGallery()) {
    if (item.folderId === req.params.id) {
      const meta = await getGalleryMeta(item.filename);
      if (meta) await recordGalleryMeta(item.filename, { ...meta, folderId: undefined });
    }
  }
  res.json({ success: true });
});

// ─── Drawers (named reference sets) ──────────────────────────────────

router.get('/studio/refs', async (_req, res) => {
  try {
    const drawers = listDrawers();
    const out = await Promise.all(
      drawers.map(async (d) => ({
        slug: d.slug,
        label: d.label,
        isDefault: d.isDefault,
        emoji: d.emoji,
        refs: (await listReferences(d.slug)).map((f) => ({ filename: f, url: refUrl(d.slug, f) })),
      })),
    );
    res.json({ drawers: out });
  } catch (error) {
    console.error('[studio] refs list error:', error);
    res.status(500).json({ error: 'Failed to list reference drawers' });
  }
});

router.post('/studio/drawers', (req, res) => {
  try {
    const b = req.body as { label?: string; emoji?: string };
    const drawer = createDrawer(String(b.label ?? ''), b.emoji);
    res.json({ success: true, drawer });
  } catch (error) {
    if (error instanceof ImageGenError) { res.status(400).json({ error: error.message }); return; }
    console.error('[studio] drawer create error:', error);
    res.status(500).json({ error: 'Failed to create drawer' });
  }
});

router.patch('/studio/drawers/:slug', (req, res) => {
  try {
    const b = req.body as { label?: string; emoji?: string };
    const drawer = renameDrawer(req.params.slug, String(b.label ?? ''), b.emoji);
    res.json({ success: true, drawer });
  } catch (error) {
    if (error instanceof ImageGenError) { res.status(400).json({ error: error.message }); return; }
    console.error('[studio] drawer rename error:', error);
    res.status(500).json({ error: 'Failed to rename drawer' });
  }
});

router.delete('/studio/drawers/:slug', async (req, res) => {
  try {
    const removed = await deleteDrawer(req.params.slug);
    res.json({ success: removed });
  } catch (error) {
    if (error instanceof ImageGenError) { res.status(400).json({ error: error.message }); return; }
    console.error('[studio] drawer delete error:', error);
    res.status(500).json({ error: 'Failed to delete drawer' });
  }
});

// ─── References (per-image) ──────────────────────────────────────────

router.post('/studio/refs/:subject', upload.single('file'), async (req, res) => {
  try {
    const subject = String(req.params.subject).toLowerCase();
    if (!isValidSubject(subject)) { res.status(400).json({ error: 'Unknown drawer' }); return; }
    if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }
    if (!req.file.mimetype.startsWith('image/')) { res.status(400).json({ error: 'Only image files allowed' }); return; }
    const filename = await saveReference(subject, req.file.originalname, req.file.buffer);
    res.json({ success: true, filename, url: refUrl(subject, filename) });
  } catch (error) {
    console.error('[studio] ref upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

router.delete('/studio/refs/:subject/:filename', async (req, res) => {
  try {
    const subject = String(req.params.subject).toLowerCase();
    if (!isValidSubject(subject)) { res.status(400).json({ error: 'Unknown drawer' }); return; }
    const removed = await deleteReference(subject, basename(req.params.filename));
    res.json({ success: removed });
  } catch (error) {
    console.error('[studio] ref delete error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

router.get('/studio/refs/:subject/:filename', (req, res) => {
  const subject = String(req.params.subject).toLowerCase();
  if (!isValidSubject(subject)) { res.status(404).end(); return; }
  const file = join(REFS_DIR, subject, basename(req.params.filename));
  if (!existsSync(file)) { res.status(404).end(); return; }
  res.sendFile(file);
});

router.post('/studio/one-off-refs', upload.single('file'), async (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/')) { res.status(400).json({ error: 'An image file is required' }); return; }
  try { const token = await saveOneOffReference(req.file.originalname, req.file.buffer); res.json({ token }); }
  catch (error) { console.error('[studio] one-off ref upload error:', error); res.status(500).json({ error: 'Upload failed' }); }
});

// ─── Gallery ─────────────────────────────────────────────────────────

router.get('/studio/gallery', async (_req, res) => {
  try {
    const items = await listGallery();
    const out = items.map((g) => {
      const thread = g.threadId ? getThread(g.threadId) : null;
      return {
        filename: g.filename,
        url: `/api/studio/gallery/${encodeURIComponent(g.filename)}`,
        mediaType: g.mediaType,
        createdAt: g.createdAt,
        messageId: g.messageId ?? null,
        threadId: g.threadId ?? null,
        threadName: thread?.name ?? null,
        prompt: g.prompt ?? null,
        model: g.model ?? null,
        backend: g.backend ?? null,
        width: g.width ?? null,
        height: g.height ?? null,
        folderId: g.folderId ?? null,
        aspectRatio: g.aspectRatio ?? null,
        references: g.references ?? null,
      };
    });
    res.json({ items: out });
  } catch (error) {
    console.error('[studio] gallery list error:', error);
    res.status(500).json({ error: 'Failed to list gallery' });
  }
});

// Update gallery item metadata (e.g., move to folder)
router.patch('/studio/gallery/:filename', async (req, res) => {
  try {
    const filename = basename(req.params.filename);
    const { folderId } = req.body as { folderId?: string | null };
    const existing = await getGalleryMeta(filename);
    if (!existing) {
      res.status(404).json({ error: 'Gallery item not found' });
      return;
    }
    if (folderId && !getStudioFolders().some((folder) => folder.id === folderId)) {
      res.status(400).json({ error: 'Folder not found' });
      return;
    }
    await recordGalleryMeta(filename, { ...existing, folderId: folderId ?? undefined });
    res.json({ success: true });
  } catch (error) {
    console.error('[studio] gallery update error:', error);
    res.status(500).json({ error: 'Failed to update gallery item' });
  }
});

router.delete('/studio/gallery/:filename', async (req, res) => {
  try {
    const filename = basename(req.params.filename);

    // Also pull it from the chat
    const meta = await getGalleryMeta(filename);
    if (meta?.messageId) {
      try {
        const row = getDb().prepare('SELECT metadata FROM messages WHERE id = ?').get(meta.messageId) as
          | { metadata: string | null }
          | undefined;
        if (row?.metadata) {
          const m = JSON.parse(row.metadata) as { fileId?: string };
          if (m.fileId) deleteFile(m.fileId);
        }
        softDeleteMessage(meta.messageId, new Date().toISOString());
        registry.broadcast({ type: 'message_deleted', messageId: meta.messageId });
      } catch (e) {
        console.warn('[studio] gallery→chat delete failed:', e instanceof Error ? e.message : e);
      }
    }

    const removed = await deleteGalleryItem(filename);
    res.json({ success: removed });
  } catch (error) {
    console.error('[studio] gallery delete error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

router.get('/studio/gallery/:filename', (req, res) => {
  const file = join(GALLERY_DIR, basename(req.params.filename));
  if (!existsSync(file)) { res.status(404).end(); return; }
  res.sendFile(file);
});

// ─── Generate (async job pattern) ────────────────────────────────────
// Returns a job ID immediately; client polls /studio/jobs/:id for status.

router.post('/studio/generate', async (req, res) => {
  try {
    const { prompt, subjects, oneOffRefs, size, customWidth, customHeight, threadId, messageId, async: useAsync, backend: reqBackend, codexModel, openaiModel, cloudflareModel, agyModel, openartModel, openartMedia } = req.body as {
      prompt?: string;
      subjects?: string[];
      oneOffRefs?: string[];
      size?: string;
      customWidth?: number;
      customHeight?: number;
      threadId?: string;
      messageId?: string;
      async?: boolean;
      backend?: string;
      codexModel?: string;
      openaiModel?: string;
      cloudflareModel?: string;
      agyModel?: string;
      openartModel?: string;
      openartMedia?: 'image' | 'video';
    };

    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    if (size === 'custom' && (!Number.isFinite(customWidth) || !Number.isFinite(customHeight) || customWidth! < 256 || customWidth! > 2048 || customHeight! < 256 || customHeight! > 2048)) {
      res.status(400).json({ error: 'custom dimensions must be between 256 and 2048 pixels' });
      return;
    }

    // Async mode: return job ID immediately
    if (useAsync !== false) {
      const metadata = { threadId, messageId, prompt, size, customWidth, customHeight, subjects };
      const jobId = startGenerateJob(
        { prompt, subjects, oneOffRefs, size, customWidth, customHeight, backend: reqBackend, codexModel, openaiModel, cloudflareModel, agyModel, openartModel, openartMedia },
        async (result) => {
          const { width, height } = galleryDimensions(metadata.size, metadata.customWidth, metadata.customHeight);
          await recordGalleryMeta(result.filename, {
            threadId: metadata.threadId,
            messageId: metadata.messageId,
            createdAt: new Date().toISOString(),
            prompt: metadata.prompt,
            model: result.model,
            backend: result.backend,
            width,
            height,
            aspectRatio: metadata.size || 'square',
            references: metadata.subjects?.length ? metadata.subjects : undefined,
          });
        },
      );
      res.json({ jobId });
      return;
    }

    // Sync mode (legacy, for local/LAN use where timeout isn't an issue)
    const result = await generateImage({ prompt, subjects, oneOffRefs, size, customWidth, customHeight, backend: reqBackend, codexModel, openaiModel, cloudflareModel, agyModel, openartModel, openartMedia });
    const { width, height } = galleryDimensions(size, customWidth, customHeight);

    // Always record gallery meta with prompt
    await recordGalleryMeta(result.filename, {
      threadId,
      messageId,
      createdAt: new Date().toISOString(),
      prompt,
      model: result.model,
      backend: result.backend,
      width,
      height,
      aspectRatio: size || 'square',
      references: subjects?.length ? subjects : undefined,
    });

    res.json({
      success: true,
      filename: result.filename,
      url: `/api/studio/gallery/${encodeURIComponent(result.filename)}`,
      backend: result.backend,
      model: result.model,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
    });
  } catch (error) {
    if (error instanceof ImageGenError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('[studio] generate error:', error);
    res.status(500).json({ error: 'Image generation failed' });
  }
});

// ─── Image jobs ─────────────────────────────────────────────────────


function jobResponse(job: ReturnType<typeof getJobStatus>) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt ?? null,
    error: job.error ?? null,
    prompt: job.input.prompt,
    backend: job.input.backend ?? null,
    model: job.input.codexModel ?? job.input.agyModel ?? job.input.openartModel ?? null,
    ...(job.result ? {
      filename: job.result.filename,
      url: `/api/studio/gallery/${encodeURIComponent(job.result.filename)}`,
      mediaType: job.result.mediaType ?? 'image',
      durationMs: job.result.durationMs,
    } : {}),
  };
}

// The phone polls this from any screen, so Studio work remains visible after
// Studio itself unmounts.
router.get('/studio/jobs', (_req, res) => {
  res.json({ jobs: listImageJobs().slice(0, 20).map((job) => jobResponse(job)) });
});

router.get('/studio/jobs/:id', (req, res) => {
  const job = jobResponse(getJobStatus(req.params.id));
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// ─── Prompt Enhancement ──────────────────────────────────────────
// Magic wand: expand a simple prompt into a detailed image-gen prompt
// through the same subscription-backed Codex lane as image generation.

import { getConfig as getDbConfig } from '../services/db.js';
import { spawn } from 'child_process';
import { homedir, tmpdir } from 'os';
import { readFile, unlink } from 'fs/promises';

const ENHANCE_SYSTEM = `You are an image generation prompt enhancer. Your job is to expand simple prompts into vivid, detailed descriptions suitable for AI image generation.

Rules:
- Keep the enhanced prompt under 150 words
- Add specific details: lighting, atmosphere, style, composition, textures
- Maintain the original intent — don't change the subject or scene
- Output ONLY the enhanced prompt, no explanations or commentary
- Use natural descriptive language, not keyword spam`;

// Resolve the same standalone Codex install used by Studio image generation.
// PM2 does not inherit ~/.local/bin in PATH, so command lookup is unreliable.
function findCodexBin(): string | null {
  const configured = getDbConfig('image_gen.codex_bin')
    || process.env.CODEX_BIN
    || join(homedir(), '.local', 'bin', 'codex');
  return existsSync(configured) ? configured : null;
}

// Run codex exec for prompt enhancement with a specific model
async function codexEnhance(prompt: string, model: string): Promise<string> {
  const codexBin = findCodexBin();
  if (!codexBin) throw new Error('Codex not installed');

  const outputFile = join(tmpdir(), `byte-light-enhance-${Date.now()}.txt`);
  const fullPrompt = `${ENHANCE_SYSTEM}\n\nExpand this prompt:\n${prompt}`;

  return new Promise((resolve, reject) => {
    const proc = spawn(codexBin, [
      'exec',
      '-m', model,
      '--ephemeral',
      '--skip-git-repo-check',
      '-o', outputFile,
      fullPrompt,
    ], {
      env: { ...process.env, HOME: homedir() },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });

    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', async (code) => {
      try {
        if (code !== 0) {
          reject(new Error(`Codex exited ${code}: ${stderr.slice(0, 200)}`));
          return;
        }
        const result = await readFile(outputFile, 'utf-8');
        await unlink(outputFile).catch(() => {});
        resolve(result.trim());
      } catch (err) {
        reject(err);
      }
    });

    proc.on('error', reject);
  });
}

router.post('/studio/enhance', async (req, res) => {
  try {
    const { prompt, backend, codexModel } = req.body as {
      prompt?: string;
      backend?: string;
      codexModel?: string;
    };
    if (!prompt?.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const model = codexModel || getDbConfig('image_gen.enhance_model') || 'gpt-5.4-mini';
    const enhanced = await codexEnhance(prompt.trim(), model);
    res.json({ enhanced });
  } catch (error) {
    console.error('[studio] enhance error:', error);
    res.status(500).json({ error: 'Prompt enhancement failed' });
  }
});

export default router;
