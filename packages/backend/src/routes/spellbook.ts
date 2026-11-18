// Spellbook routes: the authed door the Studio Spellbook talks to.
// The reader and its rules: services/spellbook.ts. The book itself (spells,
// looks): services/spellbook-store.ts. Casting an existing spell:
// services/spellbook-cast.ts. The vault importer: services/spellbook-vaults.ts.

import { Router, type Response } from 'express';
import multer from 'multer';
import { existsSync, promises as fs } from 'fs';
import { ImageGenError } from '../services/image-gen.js';
import {
  readSpell, saveSource, sourcePath, sourceExtFor, readBoard, SpellbookError,
} from '../services/spellbook.js';
import {
  ensureSpellbookReady, insertSpell, getSpell, listSpells, updateSpell, deleteSpell, surpriseSpell,
  tagCounts, filterCounts, rendersBySpell, resolveLook, listLooks, getLook, createLook, updateLook,
  setDefaultLook, setLookFavorite, deleteLook, saveLookImage, lookImagePath, MAX_LOOK_IMAGES,
  type Spell, type SpellFilter, type Look, type SpellRender,
} from '../services/spellbook-store.js';
import { castSeats, parseCast, prepareCast, startStudioCast, sourceUrl, SIZES } from '../services/spellbook-cast.js';
import {
  parseCommunityArchive, parseNotionExport, pullNotionLive, previewImport, commitImport, neutralizeStatus,
  startNeutralizePass, NOTION_EXPORT_FILE, COMMUNITY_ARCHIVE_FILE,
} from '../services/spellbook-vaults.js';
import { getSecret } from '../services/secrets.js';

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: MAX_LOOK_IMAGES } });
const vaultUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

const FILTERS = new Set<SpellFilter>(['all', 'mine', 'community', 'unmade']);

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().slice(0, max);
  return t || undefined;
}

function sendError(res: Response, error: unknown, label: string) {
  if (error instanceof SpellbookError || error instanceof ImageGenError) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error(`[spellbook] ${label}:`, error);
  res.status(500).json({ error: 'The spell fizzled. Try again.' });
}

function spellOut(s: Spell, renders: SpellRender[] = []) {
  return {
    ...s,
    sourceUrl: sourceUrl(s.source),
    cover: renders[0]?.url ?? null,
    renderCount: renders.length,
  };
}

function lookOut(l: Look) {
  return { ...l, label: l.name, imageUrls: l.images.map((f) => `/api/studio/spellbook/look-images/${encodeURIComponent(f)}`) };
}

function parseFilter(v: unknown): SpellFilter {
  return typeof v === 'string' && FILTERS.has(v as SpellFilter) ? v as SpellFilter : 'all';
}

// ─── The wall ───────────────────────────────────────────────────────

router.get('/studio/spellbook/spells', async (req, res) => {
  try {
    await ensureSpellbookReady();
    // A restart stops the background neutralize pass; opening the wall picks
    // it back up where it left off (it is a no-op when nothing is waiting).
    startNeutralizePass();
    const spells = listSpells({ q: cleanText(req.query.q, 120), filter: parseFilter(req.query.filter), tag: cleanText(req.query.tag, 40) });
    const renders = await rendersBySpell();
    res.json({
      spells: spells.map((s) => spellOut(s, renders.get(s.id))),
      tags: tagCounts(),
      counts: filterCounts(),
    });
  } catch (error) { sendError(res, error, 'list'); }
});

router.get('/studio/spellbook/spells/:id', async (req, res) => {
  try {
    await ensureSpellbookReady();
    const s = getSpell(req.params.id);
    if (!s) { res.status(404).json({ error: 'That spell is not in the book.' }); return; }
    const renders = (await rendersBySpell()).get(s.id) ?? [];
    res.json({ spell: spellOut(s, renders), renders });
  } catch (error) { sendError(res, error, 'open'); }
});

router.patch('/studio/spellbook/spells/:id', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const s = updateSpell(req.params.id, {
    title: cleanText(b.title, 120),
    tags: Array.isArray(b.tags) ? b.tags as string[] : undefined,
    credit: b.credit === null ? null : cleanText(b.credit, 120),
    link: b.link === null ? null : cleanText(b.link, 500),
  });
  if (!s) { res.status(404).json({ error: 'That spell is not in the book.' }); return; }
  res.json({ spell: spellOut(s) });
});

router.delete('/studio/spellbook/spells/:id', (req, res) => {
  res.json({ deleted: deleteSpell(req.params.id) });
});

router.get('/studio/spellbook/surprise', async (req, res) => {
  try {
    await ensureSpellbookReady();
    const exclude = typeof req.query.exclude === 'string' ? req.query.exclude.split(',').filter(Boolean) : [];
    const s = surpriseSpell({ filter: parseFilter(req.query.filter), tag: cleanText(req.query.tag, 40), exclude });
    if (!s) { res.status(404).json({ error: 'Nothing in the book matches that yet.' }); return; }
    const renders = (await rendersBySpell()).get(s.id) ?? [];
    res.json({ spell: spellOut(s, renders), renders });
  } catch (error) { sendError(res, error, 'surprise'); }
});

// ─── Casting ────────────────────────────────────────────────────────

// Drop a picture → read it → pin the spell → cast it. One call from the phone.
router.post('/studio/spellbook/cast', upload.single('file'), async (req, res) => {
  try {
    await ensureSpellbookReady();
    const file = req.file;
    if (!file) throw new SpellbookError('Drop a picture first.');
    if (!sourceExtFor(file.mimetype)) throw new SpellbookError('That file is not a picture the reader can open (JPG, PNG, WebP, GIF or HEIC).');
    const cast = parseCast(req.body?.cast);
    const look = resolveLook(req.body?.look);
    const size = SIZES.has(req.body?.size) ? req.body.size as string : 'portrait';

    const source = await saveSource(file.buffer, file.mimetype);
    const path = sourcePath(source);
    if (!path) throw new Error('saved source could not be resolved');

    const scene = await readSpell(path, cast.length, look, await castSeats(cast));
    const spell = insertSpell({
      title: scene.title, scene: scene.scene, tags: scene.tags, look: look.id, origin: 'mine', source,
      credit: cleanText(req.body?.credit, 120) ?? null, link: cleanText(req.body?.link, 500) ?? null,
    });
    if (!spell) throw new Error('spell insert was ignored');
    const prepared = await prepareCast(spell, cast, look.id, { justRead: true });
    const jobId = startStudioCast(prepared, size);
    res.json({ jobId, spell: { ...spellOut(spell), ...prepared.lineage, sourceUrl: sourceUrl(source) }, prompt: prepared.prompt, promptNoNames: prepared.promptNoNames });
  } catch (error) {
    sendError(res, error, 'cast');
  }
});

// Cast a spell already in the book: Run with…, Make it, Again, Swap cast,
// Try a look. Same spell id, so every render lines up on its page.
router.post('/studio/spellbook/run', async (req, res) => {
  try {
    await ensureSpellbookReady();
    const body = req.body as { spellId?: string; cast?: unknown; look?: string; size?: string };
    const spell = typeof body.spellId === 'string' ? getSpell(body.spellId) : null;
    if (!spell) throw new SpellbookError('That spell is not in the book.');
    const cast = parseCast(body.cast);
    const size = SIZES.has(body.size ?? '') ? body.size : 'portrait';
    const prepared = await prepareCast(spell, cast, body.look);
    const jobId = startStudioCast(prepared, size);
    res.json({ jobId, spell: { ...spellOut(spell), ...prepared.lineage, sourceUrl: sourceUrl(spell.source) }, prompt: prepared.prompt, promptNoNames: prepared.promptNoNames, rewritten: prepared.rewritten });
  } catch (error) {
    sendError(res, error, 'run');
  }
});

// Slice 1's door, kept for any phone still holding the old screen.
router.post('/studio/spellbook/recast', async (req, res) => {
  try {
    await ensureSpellbookReady();
    const body = req.body as { spell?: { id?: string }; cast?: unknown; look?: string; size?: string };
    const spell = body.spell?.id ? getSpell(body.spell.id) : null;
    if (!spell) throw new SpellbookError('That spell is not in the book.');
    const cast = parseCast(body.cast);
    const size = SIZES.has(body.size ?? '') ? body.size : 'portrait';
    const prepared = await prepareCast(spell, cast, body.look);
    const jobId = startStudioCast(prepared, size);
    res.json({ jobId, spell: { ...spellOut(spell), ...prepared.lineage, sourceUrl: sourceUrl(spell.source) }, prompt: prepared.prompt, promptNoNames: prepared.promptNoNames });
  } catch (error) {
    sendError(res, error, 'recast');
  }
});

router.get('/studio/spellbook/sources/:filename', (req, res) => {
  const p = sourcePath(req.params.filename);
  if (!p) { res.status(404).end(); return; }
  res.sendFile(p);
});

// ─── Looks ──────────────────────────────────────────────────────────

router.get('/studio/spellbook/looks', (_req, res) => {
  try { res.json({ looks: listLooks().map(lookOut) }); }
  catch (error) { sendError(res, error, 'looks'); }
});

function keptImages(raw: unknown, current: string[]): string[] {
  let list: unknown = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { list = []; } }
  if (!Array.isArray(list)) return current;
  return list.filter((f): f is string => typeof f === 'string' && current.includes(f));
}

async function savedUploads(files: Express.Multer.File[] | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const f of files ?? []) out.push(await saveLookImage(f.buffer, f.mimetype));
  return out;
}

router.post('/studio/spellbook/looks', upload.array('images', MAX_LOOK_IMAGES), async (req, res) => {
  try {
    const name = cleanText(req.body?.name, 40);
    if (!name) throw new SpellbookError('Give the look a name.');
    const images = await savedUploads(req.files as Express.Multer.File[]);
    const look = createLook({ name, recipe: cleanText(req.body?.recipe, 1200) ?? '', images });
    if (req.body?.makeDefault === 'true') setDefaultLook(look.id);
    res.json({ look: lookOut(getLook(look.id) as Look) });
  } catch (error) { sendError(res, error, 'new look'); }
});

router.put('/studio/spellbook/looks/:id', upload.array('images', MAX_LOOK_IMAGES), async (req, res) => {
  try {
    const cur = getLook(String(req.params.id));
    if (!cur) { res.status(404).json({ error: 'That look is gone.' }); return; }
    const kept = keptImages(req.body?.keep, cur.images);
    const added = await savedUploads(req.files as Express.Multer.File[]);
    const images = [...kept, ...added].slice(0, MAX_LOOK_IMAGES);
    for (const old of cur.images) if (!images.includes(old)) { const p = lookImagePath(old); if (p) await fs.unlink(p).catch(() => {}); }
    const look = updateLook(cur.id, { name: cleanText(req.body?.name, 40), recipe: typeof req.body?.recipe === 'string' ? req.body.recipe.trim().slice(0, 1200) : undefined, images });
    if (req.body?.makeDefault === 'true') setDefaultLook(cur.id);
    res.json({ look: lookOut(getLook(cur.id) ?? look as Look) });
  } catch (error) { sendError(res, error, 'edit look'); }
});

router.post('/studio/spellbook/looks/:id/default', (req, res) => {
  const look = setDefaultLook(req.params.id);
  if (!look) { res.status(404).json({ error: 'That look is gone.' }); return; }
  res.json({ look: lookOut(look) });
});

// Small edits that need no upload: the favorite star.
router.patch('/studio/spellbook/looks/:id', (req, res) => {
  const b = (req.body ?? {}) as { favorite?: unknown };
  if (typeof b.favorite !== 'boolean') { res.status(400).json({ error: 'Say whether it is a favorite.' }); return; }
  const look = setLookFavorite(String(req.params.id), b.favorite);
  if (!look) { res.status(404).json({ error: 'That look is gone.' }); return; }
  res.json({ look: lookOut(look) });
});

router.delete('/studio/spellbook/looks/:id', async (req, res) => {
  try { res.json({ deleted: await deleteLook(req.params.id) }); }
  catch (error) { sendError(res, error, 'delete look'); }
});

// Read my board: the style pictures go to the recipe reader and nowhere else.
router.post('/studio/spellbook/looks/read-board', upload.array('images', MAX_LOOK_IMAGES), async (req, res) => {
  const temp: string[] = [];
  try {
    const paths: string[] = [];
    const lookId = cleanText(req.body?.lookId, 80);
    const cur = lookId ? getLook(lookId) : null;
    for (const f of keptImages(req.body?.keep, cur?.images ?? [])) { const p = lookImagePath(f); if (p) paths.push(p); }
    for (const f of (req.files as Express.Multer.File[] | undefined) ?? []) {
      const name = await saveLookImage(f.buffer, f.mimetype);
      temp.push(name);
      const p = lookImagePath(name); if (p) paths.push(p);
    }
    res.json(await readBoard(paths));
  } catch (error) {
    sendError(res, error, 'read board');
  } finally {
    for (const t of temp) { const p = lookImagePath(t); if (p) await fs.unlink(p).catch(() => {}); }
  }
});

router.get('/studio/spellbook/look-images/:filename', (req, res) => {
  const p = lookImagePath(req.params.filename);
  if (!p) { res.status(404).end(); return; }
  res.sendFile(p);
});

// ─── The vaults ─────────────────────────────────────────────────────

router.get('/studio/spellbook/vaults', async (_req, res) => {
  let staged: { pulledAt: string | null; count: number } | null = null;
  if (existsSync(NOTION_EXPORT_FILE)) {
    try {
      const d = JSON.parse(await fs.readFile(NOTION_EXPORT_FILE, 'utf8')) as { pulledAt?: string; items?: unknown[] };
      staged = { pulledAt: d.pulledAt ?? null, count: d.items?.length ?? 0 };
    } catch { /* unreadable export reads as none */ }
  }
  let archiveStaged: { savedAt: string } | null = null;
  if (existsSync(COMMUNITY_ARCHIVE_FILE)) {
    try { archiveStaged = { savedAt: (await fs.stat(COMMUNITY_ARCHIVE_FILE)).mtime.toISOString() }; } catch { /* reads as none */ }
  }
  res.json({ notionStaged: staged, archiveStaged, notionLive: !!getSecret('notion.token') && !!getSecret('notion.spellbook_db'), neutralize: neutralizeStatus() });
});

// Dry run: nothing is written until the preview is confirmed.
router.post('/studio/spellbook/vaults/preview', vaultUpload.single('file'), async (req, res) => {
  try {
    await ensureSpellbookReady();
    const source = cleanText(req.body?.source, 20);
    if (req.file) {
      const text = req.file.buffer.toString('utf8');
      const isJson = req.file.originalname.toLowerCase().endsWith('.json') || text.trimStart().startsWith('{');
      res.json(isJson ? previewImport('notion', parseNotionExport(text)) : previewImport('archive', parseCommunityArchive(text)));
      return;
    }
    if (source === 'notion-live') { res.json(previewImport('notion', await pullNotionLive())); return; }
    if (source === 'notion-staged') {
      if (!existsSync(NOTION_EXPORT_FILE)) throw new SpellbookError('There is no Notion pull waiting in the house.');
      res.json(previewImport('notion', parseNotionExport(await fs.readFile(NOTION_EXPORT_FILE, 'utf8'))));
      return;
    }
    if (source === 'archive-staged') {
      if (!existsSync(COMMUNITY_ARCHIVE_FILE)) throw new SpellbookError('There is no community archive waiting in the house.');
      res.json(previewImport('archive', parseCommunityArchive(await fs.readFile(COMMUNITY_ARCHIVE_FILE, 'utf8'))));
      return;
    }
    throw new SpellbookError('Pick a vault: drop the community archive file, or bring in Notion.');
  } catch (error) { sendError(res, error, 'vault preview'); }
});

router.post('/studio/spellbook/vaults/commit', async (req, res) => {
  try {
    const token = cleanText((req.body as { token?: string }).token, 64);
    if (!token) throw new SpellbookError('Run the dry run first.');
    res.json({ ...(await commitImport(token)), neutralize: neutralizeStatus() });
  } catch (error) { sendError(res, error, 'vault commit'); }
});

router.get('/studio/spellbook/vaults/neutralize', (_req, res) => { res.json(neutralizeStatus()); });
router.post('/studio/spellbook/vaults/neutralize', (_req, res) => { startNeutralizePass(); res.json(neutralizeStatus()); });

export default router;
