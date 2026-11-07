import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync, existsSync, ftruncateSync, mkdirSync, openSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Stage fixtures before importing the route: its TTL sweep runs at module load.
process.env.GIF_SESSION_TTL_HOURS = '48';
process.env.GIF_SESSION_MAX_MB = '64';

const { PROJECT_ROOT } = await import('../config.js');
const WORK_DIR = join(PROJECT_ROOT, 'data', 'gif-work');
const UPLOAD_DIR = join(WORK_DIR, 'uploads');
const STALE = 'test-stale-session';
const FRESH = 'test-fresh-session';
const CAPPED = 'test-capped-session';
const FULL = 'test-full-session';
const FIT = 'test-fit-session';
const KEEP = 'test-keep-session';
const TIMING = 'test-timing-session';
const TRAILS = 'test-trails-session';
const FILTER = 'test-filter-session';
const ALL = [STALE, FRESH, CAPPED, FULL, FIT, KEEP, TIMING, TRAILS, FILTER];

const days = (n: number) => n * 24 * 60 * 60 * 1000;
function stageSession(name: string, files: Record<string, string | Buffer>, ageMs = 0): void {
  const dir = join(WORK_DIR, name);
  mkdirSync(dir, { recursive: true });
  const stamp = (Date.now() - ageMs) / 1000;
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
    if (ageMs) utimesSync(join(dir, file), stamp, stamp);
  }
  if (ageMs) utimesSync(dir, stamp, stamp);
}

mkdirSync(UPLOAD_DIR, { recursive: true });
stageSession(STALE, { 'frame-0001.png': 'old' }, days(3));
stageSession(FRESH, { 'frame-0001.png': 'new' });
const SCRAP = join(UPLOAD_DIR, 'test-scrap');
writeFileSync(SCRAP, 'orphaned multer temp file');
utimesSync(SCRAP, (Date.now() - days(3)) / 1000, (Date.now() - days(3)) / 1000);

const gifModule = await import('./gif.js');
const gifRouter = gifModule.default;
const { buildFitLadder, drawTextArgs, paletteUseChain } = gifModule;

function toolsReady(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('gifsicle', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const { GALLERY_DIR, deleteGalleryItem, getGalleryMeta } = await import('../services/image-gen.js');
let keptGalleryFilename = '';

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type RouteResult = { status: number; body: unknown };
async function invoke(
  method: 'get' | 'post',
  path: string,
  request: Record<string, unknown> = {},
): Promise<RouteResult> {
  const layer = (gifRouter as any).stack.find((candidate: any) =>
    candidate.route?.path === path && candidate.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route exists`);
  const handler = layer.route.stack.at(-1).handle;
  let status = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };
  await handler(
    { body: {}, params: {}, query: {}, ...request },
    response,
    (error?: unknown) => {
      if (error) throw error;
    },
  );
  return { status, body };
}

after(async () => {
  for (const name of ALL) rmSync(join(WORK_DIR, name), { recursive: true, force: true });
  rmSync(SCRAP, { force: true });
  if (keptGalleryFilename) await deleteGalleryItem(keptGalleryFilename);
});

describe('session sweep', () => {
  it('removes sessions whose newest file is older than the TTL', () => {
    assert.equal(existsSync(join(WORK_DIR, STALE)), false);
  });

  it('protects sessions with recent activity', () => {
    assert.equal(existsSync(join(WORK_DIR, FRESH, 'frame-0001.png')), true);
  });

  it('removes orphaned multer upload scraps', () => {
    assert.equal(existsSync(SCRAP), false);
  });
});

describe('session caps', () => {
  it('rejects uploads past the per-session frame cap', async () => {
    const frames: Record<string, string> = {};
    for (let i = 1; i <= 300; i++) {
      frames[`frame-${String(i).padStart(4, '0')}.png`] = '';
    }
    stageSession(CAPPED, frames);

    const uploadPath = join(UPLOAD_DIR, 'test-capped-upload');
    writeFileSync(uploadPath, TINY_PNG);
    const result = await invoke('post', '/gif/upload-frame', {
      body: { sessionId: CAPPED },
      file: { path: uploadPath, size: TINY_PNG.length, originalname: 'tiny.png' },
    });

    assert.equal(result.status, 400);
    const body = result.body as { error: string };
    assert.match(body.error, /frame limit/i);
    assert.equal(existsSync(uploadPath), false);
  });

  it('returns 413 for writes into a session over the disk cap', async () => {
    stageSession(FULL, { 'big.gif': '' });
    const fd = openSync(join(WORK_DIR, FULL, 'big.gif'), 'r+');
    ftruncateSync(fd, 65 * 1024 * 1024);
    closeSync(fd);

    const saved = await invoke('post', '/gif/save-frame/:sessionId/:filename', {
      params: { sessionId: FULL, filename: 'frame-0001.png' },
      body: { data: `data:image/png;base64,${TINY_PNG.toString('base64')}` },
    });
    assert.equal(saved.status, 413);

    const optimized = await invoke('post', '/gif/optimize/:sessionId/:filename', {
      params: { sessionId: FULL, filename: 'big.gif' },
      body: {},
    });
    assert.equal(optimized.status, 413);
  });
});

describe('maxBytes compatibility', () => {
  it('accepts the request field without bypassing the canonical session guard', async () => {
    const result = await invoke('post', '/gif/create', {
      body: {
        sessionId: 'no-such-session',
        frames: ['frame-0001.png'],
        maxBytes: 512 * 1024,
      },
    });
    assert.equal(result.status, 404);
  });

  it('honors the user quality settings when auto-fit is not permitted', async (t) => {
    if (!toolsReady()) { t.skip('ffmpeg and gifsicle are required for the render pipeline'); return; }
    stageSession(FIT, {
      'frame-0001.png': TINY_PNG,
      'frame-0002.png': TINY_PNG,
    });

    const result = await invoke('post', '/gif/create', {
      body: {
        sessionId: FIT,
        frames: ['frame-0001.png', 'frame-0002.png'],
        fps: 10,
        colors: 256,
        lossy: 0,
        dither: false,
        maxBytes: 1, // impossible target
      },
    });

    assert.equal(result.status, 200);
    const body = result.body as {
      fitApplied: boolean; targetKb: number; fitMet: boolean; discordOk: boolean;
      effective: { colors: number; lossy: number; dither: boolean; autoFit: boolean };
      adjustments: string[];
    };
    assert.equal(body.targetKb, 0);
    assert.equal(body.fitMet, false);
    assert.equal(body.discordOk, false);
    // Without permission, the user's settings are untouched — no ladder ran.
    assert.equal(body.effective.colors, 256);
    assert.equal(body.effective.lossy, 0);
    assert.equal(body.effective.autoFit, false);
    assert.ok(body.adjustments.some((a) => /over target/.test(a)), 'oversize is reported, not hidden');
  });

  it('degrades within permitted bounds when auto-fit is enabled, and never past them', async (t) => {
    if (!toolsReady()) { t.skip('ffmpeg and gifsicle are required for the render pipeline'); return; }
    stageSession(FIT, {
      'frame-0001.png': TINY_PNG,
      'frame-0002.png': TINY_PNG,
    });

    const result = await invoke('post', '/gif/create', {
      body: {
        sessionId: FIT,
        frames: ['frame-0001.png', 'frame-0002.png'],
        fps: 10,
        autoFit: true,
        dither: false,
        maxBytes: 1, // impossible target
      },
    });

    assert.equal(result.status, 200);
    const body = result.body as {
      fitMet: boolean;
      effective: { colors: number; lossy: number; dither: boolean; autoFit: boolean };
      adjustments: string[];
    };
    assert.equal(body.fitMet, false);
    assert.ok(body.effective.colors >= 32, 'ladder floor is 32 colors');
    assert.ok(body.effective.lossy <= 200, 'ladder ceiling is lossy 200');
    assert.equal(body.effective.dither, false, 'dither stays off when the user turned it off');
    assert.ok(body.adjustments.length > 0, 'adjustments are reported');
  });

  it('reports a comfortable fit without touching quality', async (t) => {
    if (!toolsReady()) { t.skip('ffmpeg and gifsicle are required for the render pipeline'); return; }
    stageSession(FIT, {
      'frame-0001.png': TINY_PNG,
      'frame-0002.png': TINY_PNG,
    });

    const result = await invoke('post', '/gif/create', {
      body: {
        sessionId: FIT,
        frames: ['frame-0001.png', 'frame-0002.png'],
        fps: 10,
        colors: 256,
        maxBytes: 512 * 1024,
      },
    });

    assert.equal(result.status, 200);
    const body = result.body as {
      fitMet: boolean; fitApplied: boolean; width: number; height: number; format: string;
      effective: { colors: number; lossy: number };
    };
    assert.equal(body.fitMet, true);
    assert.equal(body.fitApplied, false);
    assert.equal(body.format, 'gif');
    assert.equal(body.width, 1);
    assert.equal(body.height, 1);
    assert.equal(body.effective.colors, 256);
  });
});

describe('dithering reaches the encoder', () => {
  it('paletteuse carries an explicit dither choice in both states', () => {
    assert.match(paletteUseChain(false), /dither=none/);
    assert.match(paletteUseChain(true), /dither=sierra2_4a/);
  });

  it('text rendering passes the same choice through its palette chain', () => {
    const off = drawTextArgs('in.gif', 'drawtext=text=hi', 'out.gif', false);
    const on = drawTextArgs('in.gif', 'drawtext=text=hi', 'out.gif', true);
    const filterOff = off[off.indexOf('-filter_complex') + 1];
    const filterOn = on[on.indexOf('-filter_complex') + 1];
    assert.match(filterOff, /dither=none/);
    assert.match(filterOn, /dither=sierra2_4a/);
    assert.doesNotMatch(filterOff, /dither=sierra/);
  });
});

describe('fit ladder bounds', () => {
  it('never grants more quality than the user chose', () => {
    const rungs = buildFitLadder({ colors: 64, lossy: 100, dither: false });
    for (const rung of rungs) {
      assert.ok(rung.colors <= 64, `colors ${rung.colors} respects the user's 64`);
      assert.ok(rung.lossy >= 100, `lossy ${rung.lossy} never drops below the user's 100`);
      assert.ok(rung.lossy <= 200, 'lossy is capped at 200');
      assert.equal(rung.dither, false, 'dither follows the user, never forced on');
    }
  });

  it('carries dither through when the user enabled it', () => {
    assert.ok(buildFitLadder({ dither: true }).every((rung) => rung.dither === true));
  });
});

describe('speed preserves per-frame timing', () => {
  it('scales each frame delay individually instead of flattening to the first', async (t) => {
    if (!toolsReady()) { t.skip('ffmpeg and gifsicle are required'); return; }
    stageSession(TIMING, {});
    const dir = join(WORK_DIR, TIMING);
    // Two single-frame GIFs assembled with different delays: 10cs and 30cs.
    writeFileSync(join(dir, 'f.png'), TINY_PNG);
    execFileSync('ffmpeg', ['-i', join(dir, 'f.png'), '-y', join(dir, 'a.gif')], { stdio: 'ignore' });
    execFileSync('gifsicle', [
      '--delay=10', join(dir, 'a.gif'), '--delay=30', join(dir, 'a.gif'),
      '--loopcount=forever', '-o', join(dir, 'timing.gif'),
    ], { stdio: 'ignore' });

    const result = await invoke('post', '/gif/speed/:sessionId/:filename', {
      params: { sessionId: TIMING, filename: 'timing.gif' },
      body: { speed: 2 },
    });
    assert.equal(result.status, 200);
    const body = result.body as { filename: string };

    const info = execFileSync('gifsicle', ['--info', join(dir, body.filename)]).toString();
    const delays = [...info.matchAll(/delay ([\d.]+)s/g)].map((m) => Math.round(parseFloat(m[1]) * 100));
    // The old handler read the first delay and flattened everything to it.
    assert.deepEqual(delays, [5, 15], 'each delay is halved on its own');
    assert.match(info, /loop forever/, 'loop count survives the retiming');
  });
});

describe('transparent motion has no trails', () => {
  it('a moving opaque box leaves its old position fully transparent', async (t) => {
    if (!toolsReady()) { t.skip('ffmpeg and gifsicle are required'); return; }
    stageSession(TRAILS, {});
    const dir = join(WORK_DIR, TRAILS);
    // Two 64×64 transparent frames with a red box at x=4 then x=44.
    for (const [index, x] of [[1, 4], [2, 44]] as const) {
      execFileSync('ffmpeg', [
        '-f', 'lavfi', '-i', 'color=black@0.0:s=64x64,format=rgba',
        // replace=1: write the box's alpha instead of blending into the
        // transparent canvas (blending onto alpha 0 leaves alpha 0).
        '-vf', `drawbox=x=${x}:y=4:w=16:h=16:color=red@1:t=fill:replace=1`,
        '-frames:v', '1', '-y', join(dir, `frame-000${index}.png`),
      ], { stdio: 'ignore' });
    }

    const result = await invoke('post', '/gif/create', {
      body: { sessionId: TRAILS, frames: ['frame-0001.png', 'frame-0002.png'], fps: 10 },
    });
    assert.equal(result.status, 200);
    const body = result.body as { filename: string; width: number; height: number };
    assert.equal(body.width, 64);
    assert.equal(body.height, 64);

    // Decode the finished GIF back to PNGs and read the alpha of frame 2 where
    // frame 1's box used to be — any non-zero alpha there is a ghost trail.
    execFileSync('ffmpeg', [
      '-i', join(dir, body.filename), '-vsync', 'passthrough', '-y', join(dir, 'decoded-%d.png'),
    ], { stdio: 'ignore' });
    const alphaAt = (png: string, x: number): Buffer => execFileSync('ffmpeg', [
      '-i', join(dir, png),
      '-vf', `crop=8:8:${x + 4}:8,alphaextract`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { maxBuffer: 1024 * 1024 });

    const oldSpot = alphaAt('decoded-2.png', 4);
    assert.ok([...oldSpot].every((v) => v === 0), 'old position is fully transparent — no trail');
    const newSpot = alphaAt('decoded-2.png', 44);
    assert.ok([...newSpot].every((v) => v > 200), 'the box itself did not disappear');
  });
});

describe('tool status compatibility', () => {
  it('serves identical data from tools/status and the temporary capabilities alias', async () => {
    const [statusResult, aliasResult] = await Promise.all([
      invoke('get', '/gif/tools/status'),
      invoke('get', '/gif/capabilities'),
    ]);
    assert.equal(statusResult.status, 200);
    assert.equal(aliasResult.status, 200);

    const status = statusResult.body as Record<string, unknown>;
    const alias = aliasResult.body as Record<string, unknown>;
    assert.deepEqual(alias, status);
    assert.equal(typeof status.ready, 'boolean');
    assert.equal(typeof status.ffmpeg, 'boolean');
    assert.equal(typeof status.gifsicle, 'boolean');
  });

  it('reports cutout readiness without requiring a configured model', async () => {
    const result = await invoke('get', '/gif/cutout/status');
    assert.equal(result.status, 200);
    const body = result.body as { ready: boolean; reason: string | null };
    assert.equal(typeof body.ready, 'boolean');
    if (!body.ready) assert.equal(typeof body.reason, 'string');
  });
});

describe('keep finished GIF in the Studio gallery', () => {
  it('copies the GIF and records gallery metadata', async () => {
    stageSession(KEEP, { 'finished.gif': Buffer.from('GIF89a') });
    const result = await invoke('post', '/gif/keep/:sessionId/:filename', {
      params: { sessionId: KEEP, filename: 'finished.gif' },
    });

    assert.equal(result.status, 200);
    const body = result.body as { filename: string; url: string; location: string };
    keptGalleryFilename = body.filename;
    assert.match(body.filename, /^gif_.*\.gif$/);
    assert.equal(body.url, `/api/studio/gallery/${encodeURIComponent(body.filename)}`);
    assert.equal(body.location, 'Studio gallery');
    assert.equal(existsSync(join(GALLERY_DIR, body.filename)), true);
    const meta = await getGalleryMeta(body.filename);
    assert.equal(meta?.backend, 'gif');
    assert.equal(meta?.model, 'GIF Studio');
  });

  it('returns 404 when the finished GIF is missing', async () => {
    const result = await invoke('post', '/gif/keep/:sessionId/:filename', {
      params: { sessionId: KEEP, filename: 'missing.gif' },
    });
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: 'GIF not found' });
  });
});

describe('filter parameters are validated before reaching ffmpeg', () => {
  stageSession(FILTER, { 'frame-0001.png': TINY_PNG });

  it('rejects a crop whose dimensions are not numbers', async () => {
    const result = await invoke('post', '/gif/crop/:sessionId', {
      params: { sessionId: FILTER },
      body: { width: '8,drawtext=text=pwned', height: 8, x: 0, y: 0 },
    });
    assert.equal(result.status, 400);
    const body = result.body as { error: string };
    assert.match(body.error, /number/i);
  });

  it('rejects a chroma-key color that is not a plain 6-digit hex string', async () => {
    const result = await invoke('post', '/gif/chroma-key/:sessionId/:filename', {
      params: { sessionId: FILTER, filename: 'frame-0001.png' },
      body: { color: '00ff00:1:1,drawbox=pwned' },
    });
    assert.equal(result.status, 400);
    const body = result.body as { error: string };
    assert.match(body.error, /hex/i);
  });

  it('rejects a create request whose scale target is not a number', async () => {
    const result = await invoke('post', '/gif/create', {
      body: {
        sessionId: FILTER,
        frames: ['frame-0001.png'],
        width: '64,drawtext=text=pwned',
      },
    });
    assert.equal(result.status, 400);
    const body = result.body as { error: string };
    assert.match(body.error, /number/i);
  });
});
