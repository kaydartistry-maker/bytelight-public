/**
 * GIF Lab routes — extract frames, create GIFs, optimize for Discord
 */

import { Router } from 'express';
import { spawn, execFileSync } from 'child_process';
import { join, basename, extname } from 'path';
import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, statSync, rmSync } from 'fs';
import { randomUUID, createHash } from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import { getBytelightConfig, PROJECT_ROOT } from '../config.js';
import { copyToGallery } from '../services/image-gen.js';

const router = Router();
// PORT ADAPTATION: npm workspaces run this backend below the repo root, so anchor shared data/tools to PROJECT_ROOT.
const DATA_DIR = join(PROJECT_ROOT, 'data');
const TOOLS_DIR = join(PROJECT_ROOT, 'tools');
const GIF_WORK_DIR = join(DATA_DIR, 'gif-work');
const UPLOAD_DIR = join(GIF_WORK_DIR, 'uploads');
const CUTOUT_SCRIPT = join(TOOLS_DIR, 'cutout.py');
const STILL_EXPORT_SCRIPT = join(TOOLS_DIR, 'still-export.py');
const MASK_PAINT_SCRIPT = join(TOOLS_DIR, 'mask-paint.py');

// PORT ADAPTATION: this branch's file service lacks the source helper, so keep its sanitizer route-local.
function attachmentFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || 'download';
}

// Several routes interpolate request-supplied values straight into an
// ffmpeg -vf filtergraph string (crop=W:H:X:Y, scale=W:H, colorkey/chromakey).
// A value that isn't actually a finite number or a 6-digit hex string can
// smuggle extra filter syntax into that graph, so every value crossing that
// boundary goes through one of these two checks first.
function finiteNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hexColorOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.replace('#', '');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? hex : null;
}

/** The exporter needs only Pillow, so the system interpreter usually suffices. */
function stillExportPython(): string {
  const configured = cutoutRuntime().python;
  return configured && existsSync(configured) ? configured : 'python3';
}

/**
 * Where the local cut-out runtime lives. Config first so an install can set it
 * once in bytelight.yaml; environment second for one-off overrides.
 */
function cutoutRuntime(): { python: string; model: string; alsoModels: string[] } {
  let configured: { python?: string; model?: string; also_models?: string[] } = {};
  try {
    // PORT ADAPTATION: use this tree's config accessor and identity-neutral cutout environment names.
    configured = getBytelightConfig().integrations?.cutout ?? {};
  } catch {
    /* config may not be loaded in isolated tests */
  }
  const alsoRaw = process.env.GIF_CUTOUT_ALSO_MODELS || (configured.also_models ?? []).join(',');
  return {
    python: process.env.GIF_CUTOUT_PYTHON || configured.python || '',
    model: process.env.GIF_CUTOUT_MODEL || configured.model || '',
    alsoModels: alsoRaw.split(',').map((p) => p.trim()).filter((p) => p && existsSync(p)),
  };
}

function cutoutSetupHint(runtime: { python: string; model: string }): string {
  const missing: string[] = [];
  if (!runtime.python) missing.push('an interpreter with onnxruntime, numpy and pillow');
  else if (!existsSync(runtime.python)) missing.push(`an interpreter at ${runtime.python}`);
  if (!runtime.model) missing.push('a u2net- or isnet-style .onnx model');
  else if (!existsSync(runtime.model)) missing.push(`a model file at ${runtime.model}`);
  return `Background removal needs ${missing.join(' and ')}. `
    + 'Set integrations.cutout.python and integrations.cutout.model in bytelight.yaml. '
    + 'See tools/cutout.py for the model download.';
}

/**
 * ffmpeg cannot draw text onto a paletted image, so it silently converts the
 * frames to a format without an alpha channel first — and a transparent GIF
 * comes back out solid white. Keeping the chain in rgba and building the
 * output palette with a slot reserved for transparency is what preserves it;
 * -offsetting keeps ffmpeg from cropping frames to their changed region, which
 * is the other half of how transparent GIFs get mangled here.
 */
/**
 * Where the text sits, as ffmpeg x/y expressions.
 *
 * A hand-placed anchor arrives as a fraction of the frame rather than a pixel
 * count, so the same placement lands in the same spot whether the GIF is
 * rendered at 128px or 320px — and the expression is evaluated against the real
 * text box, so a long caption can't be dragged off the edge.
 */
function textPositionExprs(opts: {
  position?: string;
  anchor?: { x?: number; y?: number } | null;
  x?: number;
  y?: number;
}): { posX: string; posY: string } {
  const { position = 'bottom', anchor } = opts;

  const fx = typeof anchor?.x === 'number' && Number.isFinite(anchor.x) ? clamp01(anchor.x) : null;
  const fy = typeof anchor?.y === 'number' && Number.isFinite(anchor.y) ? clamp01(anchor.y) : null;
  if (fx !== null && fy !== null) {
    return { posX: `x=(w-text_w)*${fx.toFixed(4)}`, posY: `y=(h-text_h)*${fy.toFixed(4)}` };
  }

  // Absolute pixels stay supported for callers that already send them.
  let posX = typeof opts.x === 'number' ? `x=${Math.round(opts.x)}` : 'x=(w-text_w)/2';
  let posY = 'y=h-th-10';
  if (typeof opts.y === 'number') posY = `y=${Math.round(opts.y)}`;
  else if (position === 'top') posY = 'y=10';
  else if (position === 'center') posY = 'y=(h-text_h)/2';
  return { posX, posY };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * ffmpeg's paletteuse dithers by default (sierra2_4a). Left unspecified, "dither
 * off" in the Studio only reached the later gifsicle pass — by then the speckle
 * was already encoded into the frames and could never be removed. The choice has
 * to be made here, at the first quantization, or it is not a choice at all.
 */
export function paletteUseChain(dither: boolean): string {
  return `paletteuse=alpha_threshold=128:dither=${dither ? 'sierra2_4a' : 'none'}`;
}

export function drawTextArgs(input: string, drawTextFilter: string, output: string, dither: boolean): string[] {
  return [
    '-i', input,
    '-filter_complex',
    `[0:v]format=rgba,${drawTextFilter},split[a][b];`
      + '[b]palettegen=reserve_transparent=1:stats_mode=diff[p];'
      + `[a][p]${paletteUseChain(dither)}`,
    '-gifflags', '-offsetting',
    '-y', output,
  ];
}

// Ensure work directory exists
mkdirSync(GIF_WORK_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer for file uploads
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

// PORT ADAPTATION: retain this tree's bounded scratch-session lifecycle.
const SESSION_TTL_MS = Math.max(1, Number(process.env.GIF_SESSION_TTL_HOURS) || 48) * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSION_FRAMES = 300;
const MAX_SESSION_BYTES = Math.max(64, Number(process.env.GIF_SESSION_MAX_MB) || 512) * 1024 * 1024;

function dirUsage(dir: string): { bytes: number; newestMs: number } {
  let bytes = 0;
  let newestMs = 0;
  try {
    newestMs = statSync(dir).mtimeMs;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = dirUsage(target);
        bytes += sub.bytes;
        newestMs = Math.max(newestMs, sub.newestMs);
      } else {
        const stat = statSync(target);
        bytes += stat.size;
        newestMs = Math.max(newestMs, stat.mtimeMs);
      }
    }
  } catch {
    /* session may be deleted mid-walk */
  }
  return { bytes, newestMs };
}

function sweepSessions(): void {
  try {
    const cutoff = Date.now() - SESSION_TTL_MS;
    let sessions = 0;
    let scraps = 0;
    let bytes = 0;
    for (const entry of readdirSync(GIF_WORK_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'uploads') continue;
      const dir = join(GIF_WORK_DIR, entry.name);
      const usage = dirUsage(dir);
      if (usage.newestMs >= cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      sessions += 1;
      bytes += usage.bytes;
    }
    for (const name of readdirSync(UPLOAD_DIR)) {
      const target = join(UPLOAD_DIR, name);
      const stat = statSync(target);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        rmSync(target, { force: true });
        scraps += 1;
        bytes += stat.size;
      }
    }
    if (sessions || scraps) {
      console.log(`[gif] sweep: removed ${sessions} stale sessions, ${scraps} upload scraps, ${(bytes / 1024 / 1024).toFixed(1)} MB reclaimed`);
    }
  } catch (error) {
    console.warn('[gif] session sweep failed:', error);
  }
}
sweepSessions();
setInterval(sweepSessions, SWEEP_INTERVAL_MS).unref();

function sessionHasRoom(res: import('express').Response, dir: string, incomingBytes: number): boolean {
  if (dirUsage(dir).bytes + incomingBytes <= MAX_SESSION_BYTES) return true;
  res.status(413).json({
    error: `Session storage limit reached (${Math.round(MAX_SESSION_BYTES / 1024 / 1024)} MB). Delete some frames or start a new session.`,
  });
  return false;
}

/**
 * Extract frames from a video or GIF
 * POST /api/gif/extract-frames
 * Body: multipart form with 'file' field
 * Query: fps (default 10), maxFrames (default 100)
 */
router.post('/gif/extract-frames', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const fps = parseInt(req.query.fps as string) || 10;
  // PORT ADAPTATION: keep extracted sessions within this tree's 300-frame cap.
  const maxFrames = Math.min(MAX_SESSION_FRAMES, Math.max(1, parseInt(req.query.maxFrames as string) || 100));
  const sessionId = randomUUID();
  const sessionDir = join(GIF_WORK_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  try {
    const inputPath = req.file.path;
    const outputPattern = join(sessionDir, 'frame-%04d.png');

    // Use ffmpeg to extract frames
    await runProc('ffmpeg', [
      '-i', inputPath,
      '-vf', `fps=${fps}`,
      '-frames:v', String(maxFrames),
      outputPattern,
    ], (r) => `ffmpeg exited ${r.code}: ${r.stderr.slice(-500)}`);

    // Clean up uploaded file
    try { unlinkSync(inputPath); } catch {}

    // List extracted frames
    const frames = readdirSync(sessionDir)
      .filter(f => f.startsWith('frame-') && f.endsWith('.png'))
      .sort()
      .map(f => ({
        filename: f,
        url: `/api/gif/frame/${sessionId}/${f}`,
      }));

    res.json({ sessionId, frames, fps });
  } catch (err: any) {
    console.error('[gif] extract-frames error:', err);
    res.status(500).json({ error: err.message || 'Failed to extract frames' });
  }
});

/**
 * Get a frame image
 * GET /api/gif/frame/:sessionId/:filename
 */
router.get('/gif/frame/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;
  // Sanitize to prevent path traversal
  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  const framePath = join(GIF_WORK_DIR, sessionId, filename);
  if (!existsSync(framePath)) {
    res.status(404).json({ error: 'Frame not found' });
    return;
  }
  res.sendFile(framePath);
});

/**
 * Upload individual frames (for importing images)
 * POST /api/gif/upload-frame
 */
router.post('/gif/upload-frame', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const sessionId = (req.body.sessionId as string) || randomUUID();
  const sessionDir = join(GIF_WORK_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  try {
    // Find next frame number
    const existing = readdirSync(sessionDir).filter(f => f.startsWith('frame-'));
    // PORT ADAPTATION: preserve the per-session frame and disk caps for imported frames.
    if (existing.length >= MAX_SESSION_FRAMES) {
      try { unlinkSync(req.file.path); } catch {}
      res.status(400).json({ error: `Frame limit reached (${MAX_SESSION_FRAMES} per session)` });
      return;
    }
    if (!sessionHasRoom(res, sessionDir, req.file.size)) {
      try { unlinkSync(req.file.path); } catch {}
      return;
    }
    const nextNum = existing.length + 1;
    const filename = `frame-${String(nextNum).padStart(4, '0')}.png`;
    const destPath = join(sessionDir, filename);

    // Convert to PNG if needed
    const ext = extname(req.file.originalname).toLowerCase();
    if (ext === '.png') {
      // Just move it
      const data = readFileSync(req.file.path);
      writeFileSync(destPath, data);
    } else {
      // Convert with ffmpeg
      await runProc('ffmpeg', ['-i', req.file!.path, '-y', destPath], (r) => `Convert failed: ${r.code}`);
    }

    // Clean up temp file
    try { unlinkSync(req.file.path); } catch {}

    res.json({
      sessionId,
      frame: { filename, url: `/api/gif/frame/${sessionId}/${filename}` },
    });
  } catch (err: any) {
    console.error('[gif] upload-frame error:', err);
    res.status(500).json({ error: err.message || 'Failed to upload frame' });
  }
});

/**
 * Save a processed frame (e.g., after client-side background removal)
 * POST /api/gif/save-frame/:sessionId/:filename
 * Body: base64 PNG data
 */
router.post('/gif/save-frame/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;
  const { data } = req.body;

  if (!data) {
    res.status(400).json({ error: 'No data provided' });
    return;
  }

  // Sanitize
  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const sessionDir = join(GIF_WORK_DIR, sessionId);
  if (!existsSync(sessionDir)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    // Decode base64 and save
    const buffer = Buffer.from(data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    // PORT ADAPTATION: preserve the decoded-frame and per-session disk bounds.
    if (!buffer.length || buffer.length > 15 * 1024 * 1024) {
      res.status(400).json({ error: 'Invalid or oversized image data' });
      return;
    }
    if (!sessionHasRoom(res, sessionDir, buffer.length)) return;
    const framePath = join(sessionDir, filename);
    writeFileSync(framePath, buffer);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[gif] save-frame error:', err);
    res.status(500).json({ error: err.message || 'Failed to save frame' });
  }
});

/**
 * Crop frames in a session
 * POST /api/gif/crop/:sessionId
 * Body: { x: number, y: number, width: number, height: number, filename? }
 * With filename, only that frame is cropped; without it, every frame is.
 * Stashed original-* counterparts are cropped alongside so revert and
 * mask-paint stay aligned with the frames they back.
 */
router.post('/gif/crop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { x: rawX = 0, y: rawY = 0, width, height, filename } = req.body;

  const cropWidth = finiteNumberOrNull(width);
  const cropHeight = finiteNumberOrNull(height);
  const cropX = finiteNumberOrNull(rawX);
  const cropY = finiteNumberOrNull(rawY);
  if (cropWidth === null || cropHeight === null || cropX === null || cropY === null) {
    res.status(400).json({ error: 'x, y, width, and height must be numbers' });
    return;
  }

  if (sessionId.includes('..') || (typeof filename === 'string' && filename.includes('..'))) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const sessionDir = join(GIF_WORK_DIR, sessionId);
  if (!existsSync(sessionDir)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    const frames = readdirSync(sessionDir).filter(f => f.startsWith('frame-') && f.endsWith('.png'))
      .filter(f => typeof filename !== 'string' || f === filename);
    const targets = frames.flatMap(frame => {
      const original = `original-${frame}`;
      return existsSync(join(sessionDir, original)) ? [frame, original] : [frame];
    });

    for (const frame of targets) {
      const framePath = join(sessionDir, frame);
      const tempPath = join(sessionDir, `crop-temp-${frame}`);

      await runProc('ffmpeg', [
        '-i', framePath,
        '-vf', `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`,
        '-c:v', 'png',
        '-y',
        tempPath,
      ], (r) => `ffmpeg crop failed: ${r.stderr.slice(-500)}`);

      // Replace original with cropped version
      const data = readFileSync(tempPath);
      writeFileSync(framePath, data);
      try { unlinkSync(tempPath); } catch {}
    }

    res.json({ ok: true, croppedFrames: frames.length });
  } catch (err: any) {
    console.error('[gif] crop error:', err);
    res.status(500).json({ error: err.message || 'Crop failed' });
  }
});

/**
 * Chroma key removal — remove a specific color (e.g., green screen)
 * POST /api/gif/chroma-key/:sessionId/:filename
 * Body: { color: string (hex), tolerance?: number (0-1), blend?: number (0-1),
 *         mode?: 'chroma' | 'color' }
 *
 * Two filters, because they are good at different things. `chromakey` works in
 * YUV and is built for green screens. `colorkey` compares RGB directly, which
 * is what a flat generated backdrop — brown, orange, whatever — actually needs.
 * Default stays 'chroma' so existing GIF Lab calls behave as they always have.
 */
/**
 * Are the command-line tools this app is built on actually installed?
 * GET /api/gif/tools/status
 *
 * Everything here shells out to ffmpeg and gifsicle. Without them a perfectly
 * ordinary-looking button fails with a spawn error, which reads as a bug in the
 * app rather than a missing package — so say so before anyone presses it.
 */
function gifToolStatus() {
  const check = (bin: string, versionFlag: string): boolean => {
    try {
      execFileSync(bin, [versionFlag], { stdio: 'ignore', timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  };
  // PORT ADAPTATION: ffmpeg 4.4 exits 1 on `--version` (banner + error exit) so
  // it needs `-version`; gifsicle is the opposite and only accepts `--version`.
  const ffmpeg = check('ffmpeg', '-version');
  const gifsicle = check('gifsicle', '--version');
  const missing = [!ffmpeg && 'ffmpeg', !gifsicle && 'gifsicle'].filter(Boolean) as string[];
  return {
    ready: missing.length === 0,
    ffmpeg,
    gifsicle,
    reason: missing.length === 0
      ? null
      : `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not installed on the server. `
        // PORT ADAPTATION: scrub source identity and a setup-doc path that does not exist in this tree.
        + 'Install them and restart the backend — on Debian or Ubuntu, apt install ffmpeg gifsicle.',
  };
}

router.get('/gif/tools/status', (_req, res) => {
  res.json(gifToolStatus());
});

// PORT ADAPTATION: keep the legacy endpoint as a thin alias until the frontend port lands.
router.get('/gif/capabilities', (_req, res) => {
  res.json(gifToolStatus());
});

/**
 * Is local background removal available, and if not, what's missing?
 * GET /api/gif/cutout/status
 */
router.get('/gif/cutout/status', (_req, res) => {
  const runtime = cutoutRuntime();
  const ready = !!runtime.python && !!runtime.model
    && existsSync(runtime.python) && existsSync(runtime.model)
    && existsSync(CUTOUT_SCRIPT);
  res.json({
    ready,
    model: ready ? basename(runtime.model) : null,
    reason: ready ? null : cutoutSetupHint(runtime),
  });
});

/**
 * Remove the background from one frame, in place, keeping a copy of the
 * original so the tab can show a before and let the user start over.
 * POST /api/gif/cutout/:sessionId/:filename
 * Body: { feather?: number (px), threshold?: number (0-1) }
 */
router.post('/gif/cutout/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const { feather = 0, threshold } = req.body ?? {};

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const runtime = cutoutRuntime();
  if (!runtime.python || !runtime.model || !existsSync(runtime.python) || !existsSync(runtime.model)) {
    res.status(501).json({ error: cutoutSetupHint(runtime) });
    return;
  }

  const sessionDir = join(GIF_WORK_DIR, sessionId);
  const framePath = join(sessionDir, filename);
  if (!existsSync(framePath)) {
    res.status(404).json({ error: 'Frame not found' });
    return;
  }

  // Keep the untouched frame once, so re-running with different edges works
  // from the original rather than from an already-cut image.
  const originalPath = join(sessionDir, `original-${filename}`);
  if (!existsSync(originalPath)) writeFileSync(originalPath, readFileSync(framePath));

  const outputPath = join(sessionDir, `cutout-${filename}`);
  const args = [CUTOUT_SCRIPT, originalPath, outputPath, '--model', runtime.model];
  // A second model family costs ~1s and covers the first one's blind spots:
  // one loses a secondary person, the other loses low-contrast clothing.
  for (const extra of cutoutRuntime().alsoModels) args.push('--also-model', extra);
  const featherPx = Number(feather);
  if (Number.isFinite(featherPx) && featherPx > 0) args.push('--feather', String(Math.min(12, featherPx)));
  const cut = Number(threshold);
  if (Number.isFinite(cut) && cut > 0) args.push('--threshold', String(Math.min(1, cut)));

  try {
    const { stderr } = await runProc(runtime.python, args, (r) => r.stderr.trim() || `cutout exited ${r.code}`);
    if (stderr.trim()) console.warn('[gif] cutout notes:', stderr.trim());

    writeFileSync(framePath, readFileSync(outputPath));
    try { unlinkSync(outputPath); } catch { /* best effort */ }

    res.json({
      filename,
      url: `/api/gif/frame/${sessionId}/${filename}?t=${Date.now()}`,
      originalUrl: `/api/gif/frame/${sessionId}/original-${filename}`,
    });
  } catch (err: any) {
    console.error('[gif] cutout error:', err);
    res.status(500).json({ error: err.message || 'Background removal failed' });
  }
});

/**
 * Put a cut frame back the way it arrived.
 * POST /api/gif/cutout/:sessionId/:filename/revert
 */
router.post('/gif/cutout/:sessionId/:filename/revert', (req, res) => {
  const { sessionId, filename } = req.params;
  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  const sessionDir = join(GIF_WORK_DIR, sessionId);
  const originalPath = join(sessionDir, `original-${filename}`);
  if (!existsSync(originalPath)) {
    res.status(404).json({ error: 'No original kept for this frame' });
    return;
  }
  writeFileSync(join(sessionDir, filename), readFileSync(originalPath));
  res.json({ filename, url: `/api/gif/frame/${sessionId}/${filename}?t=${Date.now()}` });
});

/**
 * Export one frame as a still, to a size budget, keeping transparency.
 * POST /api/gif/still-export/:sessionId/:filename
 * Body: { format?: 'png'|'webp', maxSide?: number, maxBytes?: number,
 *         padSquare?: boolean, allowReduce?: boolean }
 *
 * PNG with alpha has no palette limit, so nothing lossy happens unless the file
 * is genuinely over budget — the colour ladder is a last resort, not a default.
 */
router.post('/gif/still-export/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const {
    format = 'png', maxSide = 0, maxBytes = 0, padSquare = false, allowReduce = true,
  } = req.body ?? {};

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  if (format !== 'png' && format !== 'webp') {
    res.status(400).json({ error: "format must be 'png' or 'webp'" });
    return;
  }

  const sessionDir = join(GIF_WORK_DIR, sessionId);
  const framePath = join(sessionDir, filename);
  if (!existsSync(framePath)) {
    res.status(404).json({ error: 'Frame not found' });
    return;
  }
  if (!existsSync(STILL_EXPORT_SCRIPT)) {
    res.status(501).json({ error: 'tools/still-export.py is missing from this install' });
    return;
  }

  // A single-image session always names its frame frame-0001, so deriving the
  // export name from it gave every cutout the identical filename and they
  // stacked up as copies of one file. Stamp it so each save has its own name.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  // PORT ADAPTATION: exported filenames must not carry the source fork's product identity.
  const outName = `gif-cutout-${stamp}.${format}`;
  const outPath = join(sessionDir, outName);
  const args = [STILL_EXPORT_SCRIPT, framePath, outPath, '--format', format];
  if (Number(maxSide) > 0) args.push('--max-side', String(Math.min(4096, Math.round(Number(maxSide)))));
  if (Number(maxBytes) > 0) args.push('--max-bytes', String(Math.round(Number(maxBytes))));
  if (padSquare) args.push('--pad-square');
  if (!allowReduce) args.push('--no-reduce');

  try {
    const { stdout } = await runProc(stillExportPython(), args, (r) => r.stderr.trim() || `export exited ${r.code}`);

    let stats: Record<string, unknown> = {};
    try { stats = JSON.parse(stdout.trim().split('\n').pop() || '{}'); } catch { /* report what we can */ }

    res.json({
      filename: outName,
      url: `/api/gif/output/${sessionId}/${outName}?t=${Date.now()}`,
      ...stats,
    });
  } catch (err: any) {
    console.error('[gif] still-export error:', err);
    res.status(500).json({ error: err.message || 'Export failed' });
  }
});

/**
 * Hand-painted corrections to a cut frame's transparency.
 * POST /api/gif/mask-paint/:sessionId/:filename
 * Multipart: optional `restore` and `erase` painted layers (PNG with strokes
 * drawn on transparency, any size).
 *
 * The point of this route is that no model gets every picture right. Rather than
 * a picture being a loss, the person looking at it paints the fix. Only alpha is
 * edited; restored pixels come from the retained original, not from a guess.
 */
router.post(
  '/gif/mask-paint/:sessionId/:filename',
  upload.fields([{ name: 'restore', maxCount: 1 }, { name: 'erase', maxCount: 1 }]),
  async (req, res) => {
    // Express types params as string | string[] once middleware is attached.
    const sessionId = String(req.params.sessionId);
    const filename = String(req.params.filename);
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const restore = files.restore?.[0];
    const erase = files.erase?.[0];

    const cleanup = () => {
      for (const file of [restore, erase]) {
        if (file?.path) { try { unlinkSync(file.path); } catch { /* best effort */ } }
      }
    };

    if (sessionId.includes('..') || filename.includes('..')) {
      cleanup();
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    if (!restore && !erase) {
      res.status(400).json({ error: 'Nothing painted' });
      return;
    }

    const sessionDir = join(GIF_WORK_DIR, sessionId);
    const framePath = join(sessionDir, filename);
    if (!existsSync(framePath)) {
      cleanup();
      res.status(404).json({ error: 'Frame not found' });
      return;
    }
    if (!existsSync(MASK_PAINT_SCRIPT)) {
      cleanup();
      res.status(501).json({ error: 'tools/mask-paint.py is missing from this install' });
      return;
    }

    // Painting can happen before any cut, so the original may not exist yet.
    const originalPath = join(sessionDir, `original-${filename}`);
    if (!existsSync(originalPath)) writeFileSync(originalPath, readFileSync(framePath));

    const outputPath = join(sessionDir, `painted-${filename}`);
    const args = [MASK_PAINT_SCRIPT, framePath, originalPath, outputPath];
    if (restore) args.push('--restore', restore.path);
    if (erase) args.push('--erase', erase.path);

    try {
      await runProc(stillExportPython(), args, (r) => r.stderr.trim() || `mask-paint exited ${r.code}`);

      writeFileSync(framePath, readFileSync(outputPath));
      try { unlinkSync(outputPath); } catch { /* best effort */ }

      res.json({
        filename,
        url: `/api/gif/frame/${sessionId}/${filename}?t=${Date.now()}`,
      });
    } catch (err: any) {
      console.error('[gif] mask-paint error:', err);
      res.status(500).json({ error: err.message || 'Painting failed' });
    } finally {
      cleanup();
    }
  },
);

router.post('/gif/chroma-key/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const { color, tolerance = 0.3, blend = 0.1, mode = 'chroma' } = req.body;

  const hex = hexColorOrNull(color);
  if (!hex) {
    res.status(400).json({ error: 'color required as a 6-digit hex string' });
    return;
  }

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const sessionDir = join(GIF_WORK_DIR, sessionId);
  const framePath = join(sessionDir, filename);
  if (!existsSync(framePath)) {
    res.status(404).json({ error: 'Frame not found' });
    return;
  }

  try {
    const outputPath = join(sessionDir, `chroma-${filename}`);

    // Similarity is 0-1 where 0.01 is very tight and 0.5 is loose
    const similarity = Math.min(1, Math.max(0.01, Number(tolerance)));
    const softness = Math.min(1, Math.max(0, Number(blend)));
    const filter = mode === 'color' ? 'colorkey' : 'chromakey';

    // Keep the untouched frame so a key can be retried, or undone, from the
    // real image rather than from an already-keyed one.
    const keyOriginal = join(sessionDir, `original-${filename}`);
    if (!existsSync(keyOriginal)) writeFileSync(keyOriginal, readFileSync(framePath));

    await runProc('ffmpeg', [
      '-i', keyOriginal,
      '-vf', `${filter}=0x${hex.toUpperCase()}:${similarity}:${softness}`,
      '-c:v', 'png',
      '-y',
      outputPath,
    ], (r) => `ffmpeg chromakey failed: ${r.stderr.slice(-500)}`);

    // Replace original with keyed version
    const data = readFileSync(outputPath);
    writeFileSync(framePath, data);
    try { unlinkSync(outputPath); } catch {}

    res.json({
      ok: true,
      filename,
      url: `/api/gif/frame/${sessionId}/${filename}?t=${Date.now()}`,
    });
  } catch (err: any) {
    console.error('[gif] chroma-key error:', err);
    res.status(500).json({ error: err.message || 'Chroma key failed' });
  }
});

// PORT ADAPTATION: preserve this tree's compress-to-fit escalation for preset byte budgets.
const FIT_LADDER: Array<[colors: number, lossy: number]> = [
  [256, 60], [200, 90], [128, 120], [96, 160], [64, 200], [48, 200], [32, 200],
];

export type FitOptions = {
  colors?: number;
  lossy?: number;
  dither?: boolean;
  /** Explicit permission to reduce colors / raise lossy beyond the user's settings. */
  allowDegrade?: boolean;
};

export type FitReport = {
  /** The file was over target, so fitting ran. */
  attempted: boolean;
  /** The file on disk was replaced by a smaller candidate. */
  applied: boolean;
  /** True when a plain lossless re-optimization was the pass that got kept. */
  lossless: boolean;
  /** Degradation actually used by the kept candidate; null = user's own settings untouched. */
  colors: number | null;
  lossy: number | null;
  dither: boolean;
  fit: boolean;
  sizeBytes: number;
};

/**
 * The ladder never grants itself more quality than the user chose: colors only
 * go down from the user's slider, lossy only up from it, and dither follows the
 * user's checkbox instead of being forced on. Degrading past the user's own
 * settings at all requires allowDegrade — the old ladder's silent march to
 * lossy 200 is the specific behavior this replaces.
 */
export function buildFitLadder(opts: FitOptions): Array<{ colors: number; lossy: number; dither: boolean }> {
  const userColors = typeof opts.colors === 'number' && opts.colors >= 2 && opts.colors <= 256 ? opts.colors : 256;
  const userLossy = typeof opts.lossy === 'number' && opts.lossy > 0 ? Math.min(200, opts.lossy) : 0;
  const dither = opts.dither === true;
  const rungs: Array<{ colors: number; lossy: number; dither: boolean }> = [];
  for (const [colors, lossy] of FIT_LADDER) {
    const rung = { colors: Math.min(colors, userColors), lossy: Math.min(200, Math.max(lossy, userLossy)), dither };
    const last = rungs[rungs.length - 1];
    if (!last || last.colors !== rung.colors || last.lossy !== rung.lossy) rungs.push(rung);
  }
  return rungs;
}

async function compressToFit(final: string, maxBytes: number, dir: string, opts: FitOptions = {}): Promise<FitReport> {
  const originalSize = statSync(final).size;
  const report: FitReport = {
    attempted: false, applied: false, lossless: false,
    colors: null, lossy: null, dither: false,
    fit: originalSize <= maxBytes, sizeBytes: originalSize,
  };
  if (report.fit) return report;
  report.attempted = true;

  type Candidate = { path: string; size: number; rung: { colors: number; lossy: number; dither: boolean } | null };
  let best: Candidate | null = null;
  const temps: string[] = [];
  try {
    // Lossless first: the create pass runs gifsicle without -O, so a plain -O3
    // re-optimization often buys real bytes without touching quality at all.
    const losslessTmp = join(dir, `${randomUUID()}-fit.gif`);
    temps.push(losslessTmp);
    await runGifsicle(['-O3', '-o', losslessTmp, final]);
    const losslessSize = statSync(losslessTmp).size;
    if (losslessSize < originalSize) best = { path: losslessTmp, size: losslessSize, rung: null };

    if ((!best || best.size > maxBytes) && opts.allowDegrade) {
      for (const rung of buildFitLadder(opts)) {
        const tmp = join(dir, `${randomUUID()}-fit.gif`);
        temps.push(tmp);
        const args = ['-O3', '--colors', String(rung.colors)];
        if (rung.dither) args.push('--dither');
        if (rung.lossy > 0) args.push(`--lossy=${rung.lossy}`);
        args.push('-o', tmp, final);
        await runGifsicle(args);
        const size = statSync(tmp).size;
        if (!best || size < best.size) best = { path: tmp, size, rung };
        if (size <= maxBytes) break;
      }
    }

    if (!best) return report; // nothing beat the original; keep it and report honestly
    renameSync(best.path, final);
    report.applied = true;
    report.lossless = best.rung === null;
    report.colors = best.rung?.colors ?? null;
    report.lossy = best.rung?.lossy ?? null;
    report.dither = best.rung?.dither ?? false;
    report.sizeBytes = best.size;
    report.fit = best.size <= maxBytes;
    return report;
  } finally {
    for (const tmp of temps) {
      if (tmp !== best?.path) rmSync(tmp, { force: true });
    }
  }
}

/** Actual pixel dimensions of a rendered output, however it was encoded. */
async function imageDimensions(path: string): Promise<{ width: number | null; height: number | null }> {
  if (path.toLowerCase().endsWith('.gif')) {
    try {
      const info = await runGifsicle(['--info', path]);
      const match = info.match(/logical screen (\d+)x(\d+)/);
      if (match) return { width: Number(match[1]), height: Number(match[2]) };
    } catch { /* fall through to ffprobe */ }
  }
  try {
    const { stdout: out } = await runProc('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path,
    ], (r) => `ffprobe exited ${r.code}`);
    const [w, h] = out.trim().split(/[,\n]/).map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) return { width: w, height: h };
  } catch { /* dimensions stay unknown */ }
  return { width: null, height: null };
}

/**
 * Scale every frame's own delay instead of flattening the animation to one
 * uniform delay read off the first frame. Duplicate removal folds delays into
 * the surviving frames, so a uniform -d silently destroys that timing.
 * Explode-and-reassemble is the same pattern dropDuplicateFrames uses; disposal
 * and loop count are restated because gifsicle does not reliably carry them.
 */
async function scaleFrameDelays(inputPath: string, outputPath: string, workDir: string, multiplier: number): Promise<boolean> {
  const scratch = join(workDir, `speed-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
  try {
    const info = await runGifsicle(['--info', inputPath]);
    const delays = parseDelays(info);
    const loopsForever = /loop forever/.test(info);
    await runGifsicle(['--unoptimize', '--explode', '-o', join(scratch, 'f'), inputPath]);
    const gifFrames = readdirSync(scratch).filter(f => f.startsWith('f.')).sort();
    if (gifFrames.length < 1) return false;

    const args: string[] = ['--disposal=background'];
    if (loopsForever) args.push('--loopcount=forever');
    gifFrames.forEach((frame, index) => {
      const delay = delays[index] ?? 10;
      // Browsers treat <2cs as "ignore and play at ~10fps", so 2 is the floor.
      args.push(`--delay=${Math.max(2, Math.round(delay * multiplier))}`, join(scratch, frame));
    });
    args.push('-o', outputPath);
    await runGifsicle(args);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Create GIF from frames
 * POST /api/gif/create
 * Body: { sessionId, frames: string[], fps: number, loop: boolean, optimize: boolean, width?: number, height?: number,
 *         speed?: number, lossy?: number, colors?: number, dither?: boolean, text?: { content, position, fontSize, fontColor, borderColor, fontFamily } }
 */
router.post('/gif/create', async (req, res) => {
  const {
    sessionId, frames, fps = 10, loop = true, optimize = true, width, height,
    fit = false, speed, lossy, colors, dither = false, text, maxBytes,
    preserveColors, autoFit = false, format = 'gif',
  } = req.body;

  if (!sessionId || !frames?.length) {
    res.status(400).json({ error: 'sessionId and frames required' });
    return;
  }
  if (format !== 'gif' && format !== 'apng') {
    res.status(400).json({ error: "format must be 'gif' or 'apng'" });
    return;
  }

  const sessionDir = join(GIF_WORK_DIR, sessionId);
  if (!existsSync(sessionDir)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  // PORT ADAPTATION: reject new outputs once a session has reached its disk cap.
  if (!sessionHasRoom(res, sessionDir, 0)) return;
  const requestedMaxBytes = Number(maxBytes);
  const hasTarget = Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0;
  // `fit` historically meant both "pad to the box" and "keep colors / skip the
  // ladder". Padding stays on `fit`; quality preservation reads the explicit
  // field when a caller sends it and falls back to `fit` for older callers.
  const preserve = typeof preserveColors === 'boolean' ? preserveColors : fit;

  try {
    const outputId = randomUUID();
    const rawGif = join(sessionDir, `${outputId}-raw.gif`);
    const finalGif = join(sessionDir, `${outputId}.${format}`);
    const paletteFile = join(sessionDir, `${outputId}-palette.png`);

    // Build filter string with optional scaling
    let scaleFilter = '';
    if (width || height) {
      const parsedWidth = width ? finiteNumberOrNull(width) : null;
      const parsedHeight = height ? finiteNumberOrNull(height) : null;
      if ((width && parsedWidth === null) || (height && parsedHeight === null)) {
        res.status(400).json({ error: 'width and height must be numbers' });
        return;
      }
      const w = parsedWidth ?? -1;
      const h = parsedHeight ?? -1;
      scaleFilter = fit && width && height
        ? `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,`
        : `scale=${w}:${h}:flags=lanczos,`;
    }

    // Use image2 demuxer with glob pattern for transparent PNGs
    // First, create symlinks with sequential names to handle arbitrary filenames
    const seqDir = join(sessionDir, `seq-${outputId}`);
    mkdirSync(seqDir, { recursive: true });

    // EVERY FRAME HAS TO BE THE SAME SIZE BEFORE FFMPEG SEES IT.
    // The image2 demuxer reads the first picture, fixes the stream size from it,
    // and dies on the first one that differs — with an "internal bug, should not
    // have happened" and a frame number, which is the only clue that the picture
    // at that index was a different shape. Extracted video frames always match;
    // hand-picked images almost never do. So the canvas is the largest width and
    // the largest height across the set, and anything smaller is centred on it
    // with transparent padding rather than stretched.
    const sizes = await Promise.all(frames.map(async (f: string) => {
      const src = join(sessionDir, f);
      if (!existsSync(src)) return null;
      try {
        const meta = await sharp(src).metadata();
        return { width: meta.width || 0, height: meta.height || 0 };
      } catch {
        return null;
      }
    }));
    const canvasW = Math.max(1, ...sizes.map((s) => s?.width || 0));
    const canvasH = Math.max(1, ...sizes.map((s) => s?.height || 0));

    for (let i = 0; i < frames.length; i++) {
      const src = join(sessionDir, frames[i]);
      const dst = join(seqDir, `frame${String(i).padStart(5, '0')}.png`);
      if (!existsSync(src)) continue;
      const size = sizes[i];
      if (size && size.width === canvasW && size.height === canvasH) {
        // THE SAME SIZE IS NOT THE SAME FORMAT, and ffmpeg cares about both.
        // This used to copy the bytes straight through, which is faster and
        // wrong: frames extracted from a video are RGB, while anything sharp
        // has touched comes back RGBA. Mix the two in one sequence and the
        // filter graph reconfigures halfway and dies with "Internal bug, should
        // not have happened" — which explainFfmpegFailure reads as a size
        // mismatch, sending the user to fix a thing that was never broken. Import a
        // video, add a still, press create: that was the whole bug.
        await sharp(src).ensureAlpha().png().toFile(dst);
        continue;
      }
      // withoutEnlargement: a smaller picture sits on the canvas at its own
      // size rather than being blown up to fill it. Upscaling a 200px sticker
      // to sit beside a 1000px photo makes the whole set soft to rescue one
      // frame's framing, and softness cannot be undone later. Flip this to
      // false if filling the canvas ever matters more than staying sharp.
      await sharp(src)
        .resize(canvasW, canvasH, {
          fit: 'contain',
          withoutEnlargement: true,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .ensureAlpha()
        .png()
        .toFile(dst);
    }


    const inputPattern = join(seqDir, 'frame%05d.png');
    const adjustments: string[] = [];

    // Build the caption filter once — the GIF path applies it in its own
    // palette-preserving pass, the APNG path inlines it into the render.
    let drawTextFilter = '';
    if (text?.content) {
      const { content, position = 'bottom', fontSize = 24, fontColor = 'white', borderColor = 'black', fontFamily = 'DejaVu Sans', anchor } = text;
      const { posX, posY } = textPositionExprs({ position, anchor });
      const escapedText = content.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:');
      const escapedFont = fontFamily.replace(/:/g, '\\:');
      drawTextFilter = `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${fontColor}:${posX}:${posY}:borderw=2:bordercolor=${borderColor}`;
    }

    if (format === 'apng') {
      // APNG is genuinely full color — there is no palette step to limit it, and
      // it is the animated format Discord actually accepts for full-color
      // stickers. A "keep colors" GIF was never able to keep this promise.
      const clampedSpeed = typeof speed === 'number' && speed !== 1 ? Math.min(4, Math.max(0.25, speed)) : 1;
      const chain = `${scaleFilter}format=rgba${drawTextFilter ? `,${drawTextFilter}` : ''}`;
      await runProc('ffmpeg', [
        '-framerate', String((Number(fps) || 10) * clampedSpeed),
        '-i', inputPattern,
        '-lavfi', chain,
        '-plays', loop ? '0' : '1',
        '-f', 'apng',
        '-y', finalGif,
      ], (r) => `ffmpeg apng failed: ${r.stderr.slice(-500)}`);
    } else {

    // Step 1: Generate palette (needed for transparency)
    await runProc('ffmpeg', [
      '-framerate', String(fps),
      '-i', inputPattern,
      '-vf', `${scaleFilter}palettegen=reserve_transparent=1`,
      '-y',
      paletteFile,
    ], (r) => `ffmpeg palette failed: ${r.stderr.slice(-500)}`);

    // Step 2: Create GIF using palette
    // ffmpeg's gif encoder enables `transdiff` and `offsetting` BY DEFAULT — it writes
    // each frame as a delta (unchanged pixels marked transparent, cropped to a bounding
    // box) and relies on the previous frame showing through. That is invisible on an
    // opaque GIF and catastrophic on a transparent one: the areas that should be see-through
    // get filled by the previous frame instead. Removing flags we never passed does nothing —
    // these have to be switched OFF explicitly so every frame is written whole.
    await runProc('ffmpeg', [
      '-framerate', String(fps),
      '-i', inputPattern,
      '-i', paletteFile,
      '-lavfi', `${scaleFilter}${paletteUseChain(dither === true)}`,
      '-gifflags', '-transdiff-offsetting',
      '-loop', loop ? '0' : '-1',
      '-y',
      rawGif,
    ], (r) => `ffmpeg gif failed: ${r.stderr.slice(-500)}`);

    // GIF transparency means "keep whatever pixel was already there", so every frame of a
    // transparent animation needs disposal method 2 (restore to background) or the previous
    // frame stays visible underneath. ffmpeg's muxer can't set disposal; gifsicle can.
    // This is safe now only because the frames above are whole — applying it to delta frames
    // clears everything except what changed (which is why an earlier attempt left just the eyes).
    // No -O flag: gifsicle without it rewrites frames as-is instead of re-differencing them.
    const gifsicleArgs: string[] = ['--disposal=background'];
    if (typeof colors === 'number' && colors >= 2 && colors <= 256) {
      gifsicleArgs.push('--colors', String(colors));
      // Dithering helps photographic sources and hurts flat art — it adds visible
      // speckle and inflates the file, so the caller decides rather than us.
      if (dither) gifsicleArgs.push('--dither');
    }
    if (typeof lossy === 'number' && lossy > 0) {
      gifsicleArgs.push(`--lossy=${Math.min(200, Math.max(0, lossy))}`);
    }
    gifsicleArgs.push('-o', finalGif, rawGif);

    await runProc('gifsicle', gifsicleArgs, (r) => `gifsicle failed: ${r.stderr || r.code}`);
    try { unlinkSync(rawGif); } catch {}

    // Apply speed change if requested — scaling every frame's own delay rather
    // than flattening the animation to one delay read off the first frame.
    if (typeof speed === 'number' && speed !== 1) {
      const clampedSpeed = Math.min(4, Math.max(0.25, speed));
      const speedTempGif = join(sessionDir, `${outputId}-speed.gif`);
      if (await scaleFrameDelays(finalGif, speedTempGif, sessionDir, 1 / clampedSpeed)) {
        writeFileSync(finalGif, readFileSync(speedTempGif));
        try { unlinkSync(speedTempGif); } catch {}
      }
    }

    // Apply text overlay if requested
    if (drawTextFilter) {
      const textTempGif = join(sessionDir, `${outputId}-text.gif`);
      await runProc('ffmpeg', drawTextArgs(finalGif, drawTextFilter, textTempGif, dither === true),
        (r) => `ffmpeg text failed: ${r.stderr.slice(-500)}`);
      // Replace original
      const data = readFileSync(textTempGif);
      writeFileSync(finalGif, data);
      try { unlinkSync(textTempGif); } catch {}
    }

    } // end GIF-specific pipeline

    // Cleanup temp files
    try { unlinkSync(paletteFile); } catch {}
    try {
      for (const f of readdirSync(seqDir)) unlinkSync(join(seqDir, f));
      rmSync(seqDir, { recursive: true });
    } catch {}

    // Fitting runs whenever a GIF has a byte target. Without explicit permission
    // (autoFit) it is limited to lossless re-optimization — quality degradation
    // past the user's own settings never happens silently, and the ladder that
    // does run is capped by those settings instead of a hardcoded march to
    // lossy 200. APNG has no palette to reduce, so it reports honestly instead.
    let fitReport: FitReport | null = null;
    if (hasTarget && format === 'gif') {
      fitReport = await compressToFit(finalGif, requestedMaxBytes, sessionDir, {
        colors: typeof colors === 'number' ? colors : undefined,
        lossy: typeof lossy === 'number' ? lossy : undefined,
        dither: dither === true,
        allowDegrade: autoFit === true && !preserve,
      });
      if (fitReport.applied && fitReport.lossless) adjustments.push('lossless re-optimization applied');
      if (fitReport.colors !== null) {
        adjustments.push(`auto-fit reduced quality to ${fitReport.colors} colors, lossy ${fitReport.lossy}`);
      }
      if (fitReport.attempted && !fitReport.fit) {
        adjustments.push(autoFit === true && !preserve
          ? 'still over target at the lowest permitted quality'
          : 'over target — enable auto-fit to allow quality reduction, or lower colors/size yourself');
      }
    }

    // Get file size and real dimensions — never report a size the file doesn't have.
    const stats = statSync(finalGif);
    const sizeBytes = stats.size;
    const sizeKb = Math.round(sizeBytes / 1024);
    const discordOk = hasTarget ? sizeBytes <= requestedMaxBytes : sizeBytes <= 256 * 1024;
    const dims = await imageDimensions(finalGif);
    if (hasTarget && format === 'apng' && sizeBytes > requestedMaxBytes) {
      adjustments.push('APNG keeps full color and cannot be auto-compressed — reduce dimensions, frames, or fps to fit');
    }

    res.json({
      url: `/api/gif/output/${sessionId}/${outputId}.${format}`,
      filename: `${outputId}.${format}`,
      format,
      width: dims.width,
      height: dims.height,
      sizeBytes,
      sizeKb,
      discordOk,
      fitApplied: fitReport?.applied ?? false,
      targetKb: hasTarget ? Math.round(requestedMaxBytes / 1024) : null,
      fitMet: hasTarget ? sizeBytes <= requestedMaxBytes : null,
      effective: format === 'apng'
        ? { colors: null, lossy: 0, dither: false, autoFit: false }
        : {
            colors: fitReport?.colors ?? (typeof colors === 'number' ? colors : 256),
            lossy: fitReport?.lossy ?? (typeof lossy === 'number' ? Math.min(200, Math.max(0, lossy)) : 0),
            dither: dither === true,
            autoFit: autoFit === true,
          },
      adjustments,
    });
  } catch (err: any) {
    console.error('[gif] create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create GIF' });
  }
});

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a tool, buffer both streams, and settle when it exits. A zero exit
 * resolves with the output; anything else rejects with the message `failure`
 * builds, so each call site keeps its own error wording.
 */
function runProc(cmd: string, args: string[], failure: (result: ProcResult) => string): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());
    proc.on('close', (code) => {
      const result = { code, stdout, stderr };
      if (code === 0) resolve(result);
      else reject(new Error(failure(result)));
    });
    proc.on('error', reject);
  });
}

/** Run gifsicle and resolve with its combined output (--info writes to stdout). */
async function runGifsicle(args: string[]): Promise<string> {
  const { stdout, stderr } = await runProc('gifsicle', args,
    (r) => `gifsicle failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return stdout + stderr;
}

/** Per-frame delays in hundredths of a second, in frame order, from `gifsicle --info`. */
function parseDelays(info: string): number[] {
  return [...info.matchAll(/delay ([\d.]+)s/g)].map(m => Math.round(parseFloat(m[1]) * 100));
}

const DITHER_METHODS = ['default', 'floyd-steinberg', 'ro64', 'o3', 'o4', 'o8', 'ordered', 'halftone', 'squarehalftone', 'diagonal', 'atkinson'];
const COLOR_METHODS = ['diversity', 'blend-diversity', 'median-cut'];

/**
 * Drop consecutive duplicate frames, folding each dropped frame's delay into the
 * frame it repeats so the animation keeps its original timing.
 *
 * Compares decoded pixels rather than stored frame bytes. Two identical-looking frames can
 * be written with different palettes, so hashing the frame files finds only a fraction of
 * the duplicates (31 of 58 on the test animation). One ffmpeg pass composites every frame
 * to a PNG instead, and PNG output is deterministic for identical pixels.
 *
 * Rebuilds from gifsicle's exploded frames, which keep palette and transparency, and which
 * are whole frames — consistent with the create route's deliberate ghost-frame avoidance.
 *
 * Returns the number of frames removed.
 */
async function dropDuplicateFrames(inputPath: string, outputPath: string, workDir: string): Promise<number> {
  const scratch = join(workDir, `dedup-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });

  try {
    const info = await runGifsicle(['--info', inputPath]);
    const delays = parseDelays(info);
    const loopsForever = /loop forever/.test(info);

    await runProc('ffmpeg', [
      '-loglevel', 'error', '-i', inputPath,
      '-vsync', 'passthrough', join(scratch, 'p-%05d.png'),
    ], (r) => `ffmpeg failed: ${r.stderr.trim() || r.code}`);

    await runGifsicle(['--unoptimize', '--explode', '-o', join(scratch, 'g'), inputPath]);

    const entries = readdirSync(scratch);
    const pngs = entries.filter(f => f.startsWith('p-')).sort();
    const gifFrames = entries.filter(f => f.startsWith('g.')).sort();

    // If the two decoders disagree on frame count there is no safe way to map one onto
    // the other, so leave the animation alone rather than dropping the wrong frames.
    if (gifFrames.length < 2 || pngs.length !== gifFrames.length) return 0;

    const kept: { file: string; delay: number }[] = [];
    let lastHash = '';
    pngs.forEach((p, i) => {
      const hash = createHash('sha1').update(readFileSync(join(scratch, p))).digest('hex');
      const delay = delays[i] ?? 10;
      if (hash === lastHash && kept.length > 0) {
        kept[kept.length - 1].delay += delay;
      } else {
        kept.push({ file: join(scratch, gifFrames[i]), delay });
        lastHash = hash;
      }
    });

    const removed = gifFrames.length - kept.length;
    if (removed === 0) return 0;

    // These are whole transparent frames. Clear the canvas before drawing the next
    // one or transparent pixels reveal the previous frame as a ghost underneath.
    const args: string[] = ['--disposal=background'];
    if (loopsForever) args.push('--loopcount=forever');
    for (const k of kept) args.push(`--delay=${Math.max(1, k.delay)}`, k.file);
    args.push('-o', outputPath);
    await runGifsicle(args);

    return removed;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Drop every nth frame and fold its delay into the preceding retained frame. */
async function dropEveryNthFrame(
  inputPath: string,
  outputPath: string,
  workDir: string,
  nth: number,
): Promise<number> {
  const scratch = join(workDir, `thin-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });

  try {
    const info = await runGifsicle(['--info', inputPath]);
    const delays = parseDelays(info);
    const loopsForever = /loop forever/.test(info);
    await runGifsicle(['--unoptimize', '--explode', '-o', join(scratch, 'f'), inputPath]);
    const gifFrames = readdirSync(scratch).filter(f => f.startsWith('f.')).sort();
    if (gifFrames.length < 2) return 0;

    const kept: { file: string; delay: number }[] = [];
    gifFrames.forEach((frame, index) => {
      const delay = delays[index] ?? 10;
      if ((index + 1) % nth === 0 && kept.length > 0) {
        kept[kept.length - 1].delay += delay;
      } else {
        kept.push({ file: join(scratch, frame), delay });
      }
    });

    const removed = gifFrames.length - kept.length;
    if (removed === 0) return 0;
    // `--explode` gives us whole frames, but disposal is not reliably carried when
    // selected frames are assembled into a new GIF. Set it explicitly so transparent
    // regions remain transparent instead of accumulating prior poses.
    const args: string[] = ['--disposal=background'];
    if (loopsForever) args.push('--loopcount=forever');
    for (const frame of kept) {
      args.push(`--delay=${Math.max(1, frame.delay)}`, frame.file);
    }
    args.push('-o', outputPath);
    await runGifsicle(args);
    return removed;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Optimize an existing GIF with gifsicle
 * POST /api/gif/optimize/:sessionId/:filename
 * Body: {
 *   lossy?: number (0-200), colors?: number (2-256),
 *   dither?: boolean (default false), ditherMethod?: string, colorMethod?: string,
 *   optimizeLevel?: 1|2|3 (default 3), unoptimize?: boolean,
 *   removeFrames?: number (2-4), dropDuplicates?: boolean,
 *   stripMetadata?: boolean (default true), interlace?: boolean,
 *   scale?: number (0-1), resizeWidth?: number, resizeHeight?: number
 * }
 */
router.post('/gif/optimize/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const {
    lossy, colors, dither = false, ditherMethod, colorMethod,
    optimizeLevel = 3, unoptimize = false,
    removeFrames, dropDuplicates = false,
    stripMetadata = true, interlace = false,
    scale, resizeWidth, resizeHeight, maxBytes,
  } = req.body;

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const sessionDir = join(GIF_WORK_DIR, sessionId);
  const gifPath = join(sessionDir, filename);
  if (!existsSync(gifPath)) {
    res.status(404).json({ error: 'GIF not found' });
    return;
  }
  // PORT ADAPTATION: preserve the session disk cap before optimization writes another GIF.
  if (!sessionHasRoom(res, sessionDir, 0)) return;

  const outputId = randomUUID();
  const outputPath = join(sessionDir, `${outputId}.gif`);
  let dedupPath: string | null = null;
  let thinnedPath: string | null = null;

  try {
    const sizeBefore = statSync(gifPath).size;
    let sourcePath = gifPath;
    let framesDropped = 0;

    // Duplicate removal rewrites the file, so it runs as its own pass first.
    if (dropDuplicates) {
      const candidate = join(sessionDir, `${outputId}-dedup.gif`);
      framesDropped = await dropDuplicateFrames(gifPath, candidate, sessionDir);
      if (framesDropped > 0) {
        dedupPath = candidate;
        sourcePath = candidate;
      }
    }

    if (typeof removeFrames === 'number' && removeFrames >= 2 && removeFrames <= 4) {
      const candidate = join(sessionDir, `${outputId}-thin.gif`);
      const removed = await dropEveryNthFrame(sourcePath, candidate, sessionDir, removeFrames);
      if (removed > 0) {
        thinnedPath = candidate;
        sourcePath = candidate;
        framesDropped += removed;
      }
    }

    const args: string[] = [];

    // Coalesce to whole frames — larger, but some editors choke on delta frames.
    if (unoptimize) args.push('--unoptimize');

    // Comments and names are pure overhead once a GIF is finished.
    if (stripMetadata) args.push('--no-comments', '--no-names', '--no-extensions');

    // Lossy compression (0-200, higher = smaller and noisier)
    if (typeof lossy === 'number' && lossy > 0) {
      args.push(`--lossy=${Math.min(200, Math.max(0, lossy))}`);
    }

    // Color reduction (2-256)
    if (typeof colors === 'number' && colors >= 2 && colors <= 256) {
      args.push('--colors', String(colors));
      if (typeof colorMethod === 'string' && COLOR_METHODS.includes(colorMethod)) {
        args.push('--color-method', colorMethod);
      }
      // Dithering trades file size for smoother gradients — worth it on photos,
      // actively harmful on flat art, so it is the caller's call. Defaults off:
      // measured on a 41-frame transparent emote at 64 colours, dithering moved
      // ~22 px/frame away from the source AND grew the file (253 KB vs 245 KB).
      // Emotes and stickers are flat art, which is most of what this Lab makes.
      if (dither) {
        args.push(typeof ditherMethod === 'string' && DITHER_METHODS.includes(ditherMethod)
          ? `--dither=${ditherMethod}`
          : '--dither');
      }
    }

    // Resize: proportional scale, or fit inside a box (gifsicle takes _ for "unset").
    if (typeof scale === 'number' && scale > 0 && scale < 1) {
      args.push('--scale', String(scale));
    } else if (typeof resizeWidth === 'number' || typeof resizeHeight === 'number') {
      const w = typeof resizeWidth === 'number' ? Math.round(resizeWidth) : '_';
      const h = typeof resizeHeight === 'number' ? Math.round(resizeHeight) : '_';
      args.push('--resize-fit', `${w}x${h}`);
    }

    if (interlace) args.push('--interlace');

    const level = [1, 2, 3].includes(optimizeLevel) ? optimizeLevel : 3;
    args.push(`-O${level}`);
    args.push('-o', outputPath);
    args.push(sourcePath);

    await runGifsicle(args);

    const sizeBytes = statSync(outputPath).size;
    const requestedMaxBytes = Number(maxBytes);
    const hasTarget = Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0;
    const targetBytes = hasTarget ? Math.min(512 * 1024, requestedMaxBytes) : 256 * 1024;
    const dims = await imageDimensions(outputPath);

    res.json({
      url: `/api/gif/output/${sessionId}/${outputId}.gif`,
      filename: `${outputId}.gif`,
      format: 'gif',
      width: dims.width,
      height: dims.height,
      sizeBytes,
      sizeKb: Math.round(sizeBytes / 1024),
      sizeBeforeKb: Math.round(sizeBefore / 1024),
      savedPercent: sizeBefore > 0 ? Math.round((1 - sizeBytes / sizeBefore) * 100) : 0,
      framesDropped,
      discordOk: sizeBytes <= targetBytes,
      maxKb: Math.round(targetBytes / 1024),
      targetKb: hasTarget ? Math.round(targetBytes / 1024) : null,
      fitMet: hasTarget ? sizeBytes <= targetBytes : null,
      effective: {
        colors: typeof colors === 'number' ? colors : null,
        lossy: typeof lossy === 'number' ? lossy : 0,
        dither: dither === true,
      },
    });
  } catch (err: any) {
    console.error('[gif] optimize error:', err);
    res.status(500).json({ error: err.message || 'Optimization failed' });
  } finally {
    if (dedupPath && existsSync(dedupPath)) unlinkSync(dedupPath);
    if (thinnedPath && existsSync(thinnedPath)) unlinkSync(thinnedPath);
  }
});

/**
 * Change GIF speed
 * POST /api/gif/speed/:sessionId/:filename
 * Body: { speed: number (0.25-4, where 2 = 2x faster, 0.5 = half speed) }
 */
router.post('/gif/speed/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const { speed = 1 } = req.body;

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const gifPath = join(GIF_WORK_DIR, sessionId, filename);
  if (!existsSync(gifPath)) {
    res.status(404).json({ error: 'GIF not found' });
    return;
  }
  // PORT ADAPTATION: preserve the session disk cap before speed changes write another GIF.
  if (!sessionHasRoom(res, join(GIF_WORK_DIR, sessionId), 0)) return;

  // Clamp speed to reasonable range
  const clampedSpeed = Math.min(4, Math.max(0.25, speed));
  // Delay multiplier is inverse of speed (faster = shorter delays)
  const delayMultiplier = 1 / clampedSpeed;

  try {
    const outputId = randomUUID();
    const sessionDir = join(GIF_WORK_DIR, sessionId);
    const outputPath = join(sessionDir, `${outputId}.gif`);

    // Scale each frame's own delay. A uniform -d read off the first frame
    // destroys accumulated timing — duplicate removal folds dropped frames'
    // delays into their survivors, and one flat delay erases exactly that.
    if (!await scaleFrameDelays(gifPath, outputPath, sessionDir, delayMultiplier)) {
      res.status(500).json({ error: 'Could not read frames to change speed' });
      return;
    }

    const stats = statSync(outputPath);
    const sizeBytes = stats.size;
    const sizeKb = Math.round(sizeBytes / 1024);
    const discordOk = sizeBytes <= 256 * 1024;
    const dims = await imageDimensions(outputPath);

    res.json({
      url: `/api/gif/output/${sessionId}/${outputId}.gif`,
      filename: `${outputId}.gif`,
      format: 'gif',
      width: dims.width,
      height: dims.height,
      sizeBytes,
      sizeKb,
      discordOk,
      newSpeed: clampedSpeed,
    });
  } catch (err: any) {
    console.error('[gif] speed error:', err);
    res.status(500).json({ error: err.message || 'Speed change failed' });
  }
});

/**
 * List available fonts
 * GET /api/gif/fonts
 */
router.get('/gif/fonts', async (_req, res) => {
  try {
    const proc = spawn('fc-list', [':', 'family']);
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    await new Promise<void>((resolve) => proc.on('close', resolve));

    // fc-list prints every alias a face answers to on one comma-separated line
    // ("Bebas Neue,Bebas Neue Bold"). Only the first is a family drawtext can
    // match, so listing the raw line offers names that render nothing.
    const fontSet = new Set<string>();
    output.split('\n').forEach(line => {
      const family = line.split(',')[0].trim();
      if (family) fontSet.add(family);
    });
    const fonts = Array.from(fontSet).sort((a, b) => a.localeCompare(b));

    res.json({ fonts: fonts.length ? fonts : FALLBACK_FONTS });
  } catch {
    res.json({ fonts: FALLBACK_FONTS });
  }
});

const FALLBACK_FONTS = ['DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif'];

/**
 * Serve one installed font file so the picker can draw each name in its own
 * typeface. The fonts live on the server; without this the list is only names
 * typed in the app's own font, which shows nothing about what you're choosing.
 *
 * GET /api/gif/font-file/:family
 */
router.get('/gif/font-file/:family', async (req, res) => {
  const family = req.params.family;
  if (!family || family.length > 80 || /[:;'"\n\\]/.test(family)) {
    res.status(400).json({ error: 'Invalid family' });
    return;
  }

  try {
    const proc = spawn('fc-match', ['-f', '%{family}\t%{file}', `${family}:style=Regular`]);
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    await new Promise<void>((resolve) => proc.on('close', resolve));

    const [matchedFamilies, file] = out.split('\t');
    // fc-match always answers with something, so an unknown name comes back as
    // the system default. Serving that would draw the picker a lie.
    const matched = (matchedFamilies || '').split(',').map(f => f.trim());
    if (!file || !matched.includes(family)) {
      res.status(404).json({ error: 'Font not found' });
      return;
    }

    const path = file.trim();
    if (!/^\/(usr\/share\/|usr\/local\/share\/|home\/[^/]+\/\.(local\/share\/)?)fonts\//.test(path)
      || !/\.(ttf|otf|ttc)$/i.test(path)
      || !existsSync(path)) {
      res.status(404).json({ error: 'Font not readable' });
      return;
    }

    res.setHeader('Content-Type', path.toLowerCase().endsWith('.otf') ? 'font/otf' : 'font/ttf');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(path);
  } catch (err: any) {
    console.error('[gif] font-file error:', err);
    res.status(500).json({ error: 'Font lookup failed' });
  }
});

/**
 * Add text overlay to GIF
 * POST /api/gif/add-text/:sessionId/:filename
 * Body: { text: string, x?: number, y?: number, fontSize?: number, fontColor?: string, borderColor?: string, fontFamily?: string, position?: string }
 */
router.post('/gif/add-text/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const {
    text,
    x,
    y,
    fontSize = 24,
    fontColor = 'white',
    borderColor = 'black',
    fontFamily = 'DejaVu Sans',
    position = 'bottom', // top, center, bottom
    anchor, // { x, y } as fractions of the frame — a hand-placed position
    dither = false, // the re-quantization here dithers by default unless told not to
  } = req.body;

  if (!text) {
    res.status(400).json({ error: 'text required' });
    return;
  }

  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const gifPath = join(GIF_WORK_DIR, sessionId, filename);
  if (!existsSync(gifPath)) {
    res.status(404).json({ error: 'GIF not found' });
    return;
  }

  try {
    const outputId = randomUUID();
    const outputPath = join(GIF_WORK_DIR, sessionId, `${outputId}.gif`);

    const { posX, posY } = textPositionExprs({ position, anchor, x, y });

    // Escape text for ffmpeg (single quotes and backslashes)
    const escapedText = text.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:');
    const escapedFont = fontFamily.replace(/:/g, '\\:');

    const drawTextFilter = `drawtext=text='${escapedText}':font='${escapedFont}':fontsize=${fontSize}:fontcolor=${fontColor}:${posX}:${posY}:borderw=2:bordercolor=${borderColor}`;

    await runProc('ffmpeg', drawTextArgs(gifPath, drawTextFilter, outputPath, dither === true),
      (r) => `ffmpeg text overlay failed: ${r.stderr.slice(-500)}`);

    const stats = statSync(outputPath);
    const sizeBytes = stats.size;
    const sizeKb = Math.round(sizeBytes / 1024);
    const discordOk = sizeBytes <= 256 * 1024;

    res.json({
      url: `/api/gif/output/${sessionId}/${outputId}.gif`,
      filename: `${outputId}.gif`,
      sizeBytes,
      sizeKb,
      discordOk,
    });
  } catch (err: any) {
    console.error('[gif] add-text error:', err);
    res.status(500).json({ error: err.message || 'Text overlay failed' });
  }
});

/**
 * Get output GIF
 */
router.get('/gif/output/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;
  if (sessionId.includes('..') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  const gifPath = join(GIF_WORK_DIR, sessionId, filename);
  if (!existsSync(gifPath)) {
    res.status(404).json({ error: 'GIF not found' });
    return;
  }
  const byExt: Record<string, string> = {
    '.gif': 'image/gif', '.png': 'image/png', '.webp': 'image/webp', '.apng': 'image/apng',
  };
  res.setHeader('Content-Type', byExt[extname(filename).toLowerCase()] || 'application/octet-stream');
  // ?download=1 turns a tap on the export pill into an actual saved file
  // rather than a navigation to the image.
  if (req.query?.download) {
    res.setHeader('Content-Disposition', `attachment; filename="${attachmentFilename(basename(filename))}"`);
  }
  res.sendFile(gifPath);
});

/**
 * Copy a finished GIF out of its temporary session and into Studio gallery storage.
 * POST /api/gif/keep/:sessionId/:filename
 */
router.post('/gif/keep/:sessionId/:filename', async (req, res) => {
  const { sessionId, filename } = req.params;
  const ext = extname(filename).toLowerCase();
  // .apng rides along: the keep-colors sticker lane exports real APNG now.
  if (sessionId.includes('..') || filename.includes('..') || basename(filename) !== filename || (ext !== '.gif' && ext !== '.apng')) {
    res.status(400).json({ error: 'Invalid GIF path' });
    return;
  }
  const source = join(GIF_WORK_DIR, sessionId, filename);
  if (!existsSync(source)) {
    res.status(404).json({ error: 'GIF not found' });
    return;
  }
  try {
    const kept = await copyToGallery(source, ext, 'gif', {
      createdAt: new Date().toISOString(),
      prompt: 'GIF Studio export',
      model: 'GIF Studio',
      backend: 'gif',
    });
    res.json({
      filename: kept.filename,
      url: `/api/studio/gallery/${encodeURIComponent(kept.filename)}`,
      location: 'Studio gallery',
    });
  } catch (err: any) {
    console.error('[gif] keep error:', err);
    res.status(500).json({ error: err.message || 'Could not save GIF to gallery' });
  }
});

/**
 * Delete a session and its files
 */
router.delete('/gif/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (sessionId.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  const sessionDir = join(GIF_WORK_DIR, sessionId);
  if (existsSync(sessionDir)) {
    try {
      for (const f of readdirSync(sessionDir)) {
        unlinkSync(join(sessionDir, f));
      }
      rmSync(sessionDir, { recursive: true });
    } catch {}
  }
  res.json({ ok: true });
});

export default router;
