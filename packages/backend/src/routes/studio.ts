// Studio routes — the authed data surface behind the Studio app.
// Covers: image-gen settings, reference drawers, and gallery.

import { Router } from 'express';
import { setSecret } from '../services/secrets.js';
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
  getDrawerDescription,
  saveDrawerDescription,
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
  STUDIO_UPLOADS_DIR,
  prepareStudioGeneration,
} from '../services/image-gen.js';
import { addStyleReference, deleteStyle, duplicateStyle, getStudioStyles, hasMJFlags, OPENAI_IMAGE_MODELS, requireStyle, resolveImageModel, saveStyle, setDefaultChatStyle, StudioStyleError, styleAssetPath } from '../services/studio-styles.js';
import { parsePromptGame, promptWritingInstruction } from '../services/studio-prompts.js';
import { prepareTransformationRequest } from '../services/studio-transformations.js';
import { BOSS_BATTLES_PATH } from '@bytelight/shared';
import { createBossBattleRoutes } from './boss-battles.js';

const router = Router();
// The bestiary uses Studio portrait jobs and saved styles, with its own owner check.
router.use(BOSS_BATTLES_PATH.slice('/api'.length), createBossBattleRoutes());

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
    res.json({ settings, monthlySpendUsd, models: OPENAI_IMAGE_MODELS, allowMeteredImages: getConfig('studio.allow_metered_images') === 'true', chatImageModel: getConfig('studio.chat_image_model') || 'subscription-auto' });
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
      if (!['codex', 'openai', 'openrouter'].includes(v)) { res.status(400).json({ error: 'Studio supports OpenAI image generation only.' }); return; }
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
    if ('openai_api_key' in b) setSecret('studio_openai_api_key', String(b.openai_api_key));
    if ('antigravity_model' in b) writes.push(['image_gen.antigravity_model', String(b.antigravity_model)]);
    if ('openart_model' in b) writes.push(['image_gen.openart_model', String(b.openart_model)]);
    if ('monthly_budget_usd' in b) {
      const n = Number(b.monthly_budget_usd);
      if (Number.isNaN(n) || n < 0) { res.status(400).json({ error: 'monthly_budget_usd must be a non-negative number' }); return; }
      writes.push(['image_gen.monthly_budget_usd', String(n)]);
    }
    if ('allowMeteredImages' in b) {
      if (typeof b.allowMeteredImages !== 'boolean') { res.status(400).json({ error: 'Metered model permission must be true or false.' }); return; }
      writes.push(['studio.allow_metered_images', String(b.allowMeteredImages)]);
      if (!b.allowMeteredImages) writes.push(['studio.chat_image_model', 'subscription-auto']);
    }
    if ('chatImageModel' in b) {
      const model = resolveImageModel(String(b.chatImageModel));
      writes.push(['studio.chat_image_model', model.id]);
    }

    for (const [k, v] of writes) setConfig(k, v);
    res.json({ success: true, settings: getImageGenSettings() });
  } catch (error) {
    console.error('[studio] settings write error:', error);
    res.status(500).json({ error: 'Failed to update Studio settings' });
  }
});

// Saved styles use the same authenticated router as references and gallery.
router.get('/studio/styles', (_req, res) => {
  try { res.json(getStudioStyles()); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.get('/studio/styles/assets/:filename', (req, res) => {
  try { const path = styleAssetPath(req.params.filename); if (!existsSync(path)) { res.sendStatus(404); return; } res.sendFile(path); }
  catch { res.sendStatus(404); }
});
router.put('/studio/styles/default-chat', (req, res) => {
  try {
    const id = req.body.styleId;
    if (id !== null && typeof id !== 'string') throw new StudioStyleError('Choose a saved style or clear the default.');
    res.json(setDefaultChatStyle(id));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.post('/studio/styles', (req, res) => {
  try { res.json({ style: saveStyle(req.body) }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.patch('/studio/styles/:id', (req, res) => {
  try { res.json({ style: saveStyle(req.body, req.params.id) }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.delete('/studio/styles/:id', (req, res) => {
  try { deleteStyle(req.params.id); res.json({ success: true }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.post('/studio/styles/:id/duplicate', (req, res) => {
  try { res.json({ style: duplicateStyle(req.params.id) }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
router.post('/studio/styles/:id/references', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new StudioStyleError('Choose a reference image.');
    res.json({ style: await addStyleReference(String(req.params.id), req.file.buffer, req.file.originalname, Number(req.body.revision)) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
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
        description: getDrawerDescription(d.slug),
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

router.put('/studio/drawers/:slug/description', (req, res) => {
  try {
    res.json({ description: saveDrawerDescription(req.params.slug, req.body?.description) });
  } catch (error) {
    if (error instanceof ImageGenError) { res.status(400).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Could not save the drawer description.' });
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
        sourcePrompt: g.sourcePrompt ?? null,
        styleId: g.styleId ?? null,
        imageModelId: g.imageModelId ?? null,
        styleTitle: g.styleTitle ?? null,
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

router.post('/studio/transform', async (req, res) => {
  try {
    const input = await prepareTransformationRequest(req.body, STUDIO_UPLOADS_DIR);
    const jobId = startGenerateJob(input, async result => {
      const { width, height } = galleryDimensions(input.size);
      await recordGalleryMeta(result.filename, {
        createdAt: new Date().toISOString(), prompt: input.prompt, sourcePrompt: input.prompt,
        styleId: '', model: result.model, backend: result.backend,
        width, height, aspectRatio: input.size || getImageGenSettings().size,
      });
    });
    res.json({ jobId });
  } catch (error) {
    if (error instanceof ImageGenError || error instanceof StudioStyleError) { res.status(400).json({ error: error.message }); return; }
    console.error('[studio] transformation error:', error);
    res.status(500).json({ error: 'Transformation could not be started.' });
  }
});

router.post('/studio/generate', async (req, res) => {
  try {
    const { prompt, sourcePrompt, subjects, oneOffRefs, size, customWidth, customHeight, threadId, messageId, async: useAsync, backend: reqBackend, codexModel, openaiModel, cloudflareModel, agyModel, openartModel, openartMedia } = req.body as {
      prompt?: string;
      sourcePrompt?: string;
      styleId?: string;
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
    const styleId = req.body.styleId ?? '';
    const imageModelId = req.body.imageModelId ?? 'subscription-auto';
    if (typeof imageModelId !== 'string' || (reqBackend && !['codex', 'openai', 'openrouter'].includes(reqBackend))) { res.status(400).json({ error: 'Choose an OpenAI image model.' }); return; }

    if (typeof prompt !== 'string' || !prompt.trim() || (sourcePrompt !== undefined && typeof sourcePrompt !== 'string') || (styleId !== undefined && typeof styleId !== 'string')) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    if (size === 'custom' && (!Number.isFinite(customWidth) || !Number.isFinite(customHeight) || customWidth! < 256 || customWidth! > 2048 || customHeight! < 256 || customHeight! > 2048)) {
      res.status(400).json({ error: 'custom dimensions must be between 256 and 2048 pixels' });
      return;
    }

    // Async mode: return job ID immediately
    if (useAsync !== false) {
      const metadata = { threadId, messageId, prompt, sourcePrompt, styleId, size, customWidth, customHeight, subjects };
      const jobId = startGenerateJob(
        { usageOrigin: 'studio', prompt, sourcePrompt, styleId, imageModelId, subjects, descriptionSubjects: req.body.descriptionSubjects, subjectDescriptions: req.body.subjectDescriptions, oneOffRefs, size, customWidth, customHeight },
        async (result) => {
          const { width, height } = galleryDimensions(metadata.size, metadata.customWidth, metadata.customHeight);
          await recordGalleryMeta(result.filename, {
            threadId: metadata.threadId,
            messageId: metadata.messageId,
            createdAt: new Date().toISOString(),
            prompt: metadata.prompt,
            sourcePrompt: metadata.sourcePrompt,
            styleId: metadata.styleId,
            model: result.model,
            backend: result.backend,
            width,
            height,
            aspectRatio: metadata.size || 'square',
            references: metadata.subjects?.length ? metadata.subjects : undefined,
          });
        },
      );
      res.json({ jobId, sourcePrompt, styleId });
      return;
    }

    // Sync mode (legacy, for local/LAN use where timeout isn't an issue)
    const result = await generateImage({ usageOrigin: 'studio', prompt, sourcePrompt, styleId, imageModelId, subjects, descriptionSubjects: req.body.descriptionSubjects, subjectDescriptions: req.body.subjectDescriptions, oneOffRefs, size, customWidth, customHeight });
    const { width, height } = galleryDimensions(size, customWidth, customHeight);

    // Always record gallery meta with prompt
    await recordGalleryMeta(result.filename, {
      threadId,
      messageId,
      createdAt: new Date().toISOString(),
      prompt,
      sourcePrompt,
      styleId,
      model: result.model,
      backend: result.backend,
      width,
      height,
      aspectRatio: size || 'square',
      references: subjects?.length ? subjects : undefined,
    });

    res.json({
      success: true,
      sourcePrompt,
      styleId,
      filename: result.filename,
      url: `/api/studio/gallery/${encodeURIComponent(result.filename)}`,
      backend: result.backend,
      model: result.model,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      accountingWarning: result.accountingWarning ?? null,
    });
  } catch (error) {
    if (error instanceof ImageGenError || error instanceof StudioStyleError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('[studio] generate error:', error);
    res.status(500).json({ error: 'Image generation failed' });
  }
});

// ─── Image jobs ─────────────────────────────────────────────────────


export function jobResponse(job: ReturnType<typeof getJobStatus>) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt ?? null,
    error: job.error ?? null,
    prompt: job.input.prompt,
    sourcePrompt: job.input.sourcePrompt ?? null,
    styleId: job.input.styleId ?? null,
    imageModelId: job.input.imageModelId ?? 'subscription-auto',
    aspectRatio: job.input.size ?? null,
    referenceDrawers: job.input.subjects ?? [],
    subjectDescriptions: job.input.subjectDescriptions,
    ...galleryDimensions(job.input.size, job.input.customWidth, job.input.customHeight),
    backend: job.input.backend ?? null,
    model: job.result?.model ?? job.input.codexModel ?? job.input.openaiModel ?? job.input.cloudflareModel ?? job.input.agyModel ?? job.input.openartModel ?? null,
    ...(job.result ? {
      filename: job.result.filename,
      url: `/api/studio/gallery/${encodeURIComponent(job.result.filename)}`,
      mediaType: job.result.mediaType ?? 'image',
      durationMs: job.result.durationMs,
      accountingWarning: job.result.accountingWarning ?? null,
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
async function codexEnhance(prompt: string, model: string, mode: 'game' | 'enhance' = 'enhance', stylePrompt = ''): Promise<string> {
  const codexBin = findCodexBin();
  if (!codexBin) throw new Error('Codex not installed');

  const outputFile = join(tmpdir(), `byte-light-enhance-${crypto.randomUUID()}.txt`);
  const fullPrompt = promptWritingInstruction(mode, prompt, stylePrompt);

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

    const model = getDbConfig('image_gen.enhance_model') || getDbConfig('image_gen.codex_model') || 'gpt-5.5';
    const style = req.body.styleId ? requireStyle(String(req.body.styleId)) : undefined;
    const enhanced = await codexEnhance(prompt.trim(), model, 'enhance', style?.prompt);
    if (hasMJFlags(enhanced) || enhanced.length > 650) throw new StudioStyleError('The prompt writer returned an invalid suggestion. Your original prompt is unchanged.');
    res.json({ enhanced });
  } catch (error) {
    console.error('[studio] enhance error:', error);
    res.status(500).json({ error: 'Prompt enhancement failed' });
  }
});

router.post('/studio/prompt-game', async (req, res) => {
  try {
    if (typeof req.body.words !== 'string') throw new StudioStyleError('Enter the random words first.');
    const style = req.body.styleId ? requireStyle(String(req.body.styleId)) : undefined;
    const model = getDbConfig('image_gen.enhance_model') || getDbConfig('image_gen.codex_model') || 'gpt-5.5';
    const prompts = parsePromptGame(await codexEnhance(req.body.words, model, 'game', style?.prompt));
    res.json({ prompts });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

router.post('/studio/preview', async (req, res) => {
  try {
    const b = req.body;
    if (typeof b.prompt !== 'string' || typeof b.styleId !== 'string' || typeof b.imageModelId !== 'string') throw new StudioStyleError('Choose a prompt, style and image model.');
    const prepared = prepareStudioGeneration({ prompt: b.prompt, styleId: b.styleId, imageModelId: b.imageModelId, subjects: b.subjects, descriptionSubjects: b.descriptionSubjects, subjectDescriptions: b.subjectDescriptions });
    res.json({ prompt: prepared.prompt, style: prepared.styleSnapshot ?? null, model: resolveImageModel(prepared.imageModelId) });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

export default router;
