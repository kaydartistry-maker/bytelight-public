/**
 * The Spellbook's home: the spells table and the looks table (migration 050).
 *
 * A spell is a scene with its people written as [Character N] tokens. It is
 * 'mine' (cast from a picture the operator dropped, or her own Notion vault) or
 * 'community' (the community archive, credited to its author). Renders link back to
 * their spell through GalleryMeta.spell.id; times_cast / last_cast_at say
 * which spells have never been made.
 *
 * A look is a style board: a recipe the engine gets as a closing paragraph,
 * plus up to six style pictures. The pictures write the recipe (Read my
 * board) and also ride every render as style references, labelled apart from
 * the cast's likeness pictures (services/style-reference.ts).
 */

import crypto from 'crypto';
import { existsSync, promises as fs } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { getConfig, getDb, setConfig } from './db.js';
import { REFS_DIR, spellRenders } from './image-gen.js';
import { LOOKS, SpellbookError, sceneCastSize, type ResolvedLook } from './spellbook.js';
import { STARTER_LOOKS, STARTER_LOOKS_FLAG, starterLookId } from './starter-looks.js';

// ─── Spells ─────────────────────────────────────────────────────────

export type SpellOrigin = 'mine' | 'community';
export type SpellFilter = 'all' | 'mine' | 'community' | 'unmade';

export interface Spell {
  id: string;
  title: string;
  scene: string;
  originalText: string | null;
  tags: string[];
  look: string | null;
  origin: SpellOrigin;
  author: string | null;
  credit: string | null;
  link: string | null;
  source: string | null;
  vault: string | null;
  engine: string | null;
  neutralized: boolean;
  createdAt: string;
  timesCast: number;
  lastCastAt: string | null;
  /** How many people the scene is written for. */
  castSize: number;
}

interface SpellRow {
  id: string; title: string; scene: string; original_text: string | null; tags: string; look: string | null;
  origin: string; author: string | null; credit: string | null; link: string | null; source: string | null;
  vault: string | null; engine: string | null; content_hash: string | null; neutralized: number;
  created_at: string; times_cast: number; last_cast_at: string | null;
}

function parseTags(raw: string): string[] {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []; }
  catch { return []; }
}

function toSpell(r: SpellRow): Spell {
  return {
    id: r.id, title: r.title, scene: r.scene, originalText: r.original_text, tags: parseTags(r.tags), look: r.look,
    origin: r.origin === 'community' ? 'community' : 'mine', author: r.author, credit: r.credit, link: r.link,
    source: r.source, vault: r.vault, engine: r.engine, neutralized: r.neutralized === 1, createdAt: r.created_at,
    timesCast: r.times_cast, lastCastAt: r.last_cast_at, castSize: sceneCastSize(r.scene),
  };
}

export function newSpellId(): string {
  return `spell_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

/** Normalized prompt text → hash. Case, spacing and punctuation never make a
 *  prompt "new", so the same vault imported twice adds nothing. */
export function contentHash(text: string): string {
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return crypto.createHash('sha256').update(norm).digest('hex');
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const clean = t.trim().slice(0, 40);
    if (clean && !out.some((o) => o.toLowerCase() === clean.toLowerCase())) out.push(clean);
  }
  return out.slice(0, 12);
}

export interface NewSpell {
  id?: string;
  title: string;
  scene: string;
  originalText?: string | null;
  tags?: string[];
  look?: string | null;
  origin?: SpellOrigin;
  author?: string | null;
  credit?: string | null;
  link?: string | null;
  source?: string | null;
  vault?: string | null;
  engine?: string | null;
  contentHash?: string | null;
  neutralized?: boolean;
  createdAt?: string;
  timesCast?: number;
  lastCastAt?: string | null;
}

/** Insert a spell. Returns null when its content hash is already in the book. */
export function insertSpell(s: NewSpell): Spell | null {
  const id = s.id ?? newSpellId();
  const res = getDb().prepare(`INSERT OR IGNORE INTO spells
    (id, title, scene, original_text, tags, look, origin, author, credit, link, source, vault, engine, content_hash, neutralized, created_at, times_cast, last_cast_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, s.title.slice(0, 120) || 'Untitled spell', s.scene, s.originalText ?? null, JSON.stringify(normalizeTags(s.tags ?? [])),
    s.look ?? null, s.origin ?? 'mine', s.author ?? null, s.credit ?? null, s.link ?? null, s.source ?? null,
    s.vault ?? null, s.engine ?? null, s.contentHash ?? null, s.neutralized === false ? 0 : 1,
    s.createdAt ?? new Date().toISOString(), s.timesCast ?? 0, s.lastCastAt ?? null,
  );
  return res.changes ? getSpell(id) : null;
}

export function getSpell(id: string): Spell | null {
  const r = getDb().prepare('SELECT * FROM spells WHERE id = ?').get(id) as SpellRow | undefined;
  return r ? toSpell(r) : null;
}

export function hashExists(hash: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM spells WHERE content_hash = ?').get(hash);
}

export interface SpellQuery { q?: string; filter?: SpellFilter; tag?: string; limit?: number }

function whereFor(query: SpellQuery): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.filter === 'mine' || query.filter === 'community') { where.push('origin = ?'); params.push(query.filter); }
  if (query.filter === 'unmade') where.push('times_cast = 0');
  if (query.tag) { where.push("EXISTS (SELECT 1 FROM json_each(spells.tags) WHERE lower(json_each.value) = lower(?))"); params.push(query.tag); }
  const q = query.q?.trim();
  if (q) {
    for (const word of q.split(/\s+/).slice(0, 6)) {
      where.push('(title LIKE ? OR scene LIKE ? OR tags LIKE ? OR coalesce(author, \'\') LIKE ? OR coalesce(credit, \'\') LIKE ?)');
      const like = `%${word.replace(/[%_]/g, '')}%`;
      params.push(like, like, like, like, like);
    }
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listSpells(query: SpellQuery = {}): Spell[] {
  const { sql, params } = whereFor(query);
  const limit = Math.max(1, Math.min(2000, query.limit ?? 2000));
  const rows = getDb().prepare(`SELECT * FROM spells ${sql}
    ORDER BY coalesce(last_cast_at, created_at) DESC LIMIT ?`).all(...params, limit) as SpellRow[];
  return rows.map(toSpell);
}

/** Every tag in the book with how many spells carry it, most-used first. */
export function tagCounts(): Array<{ tag: string; count: number }> {
  const rows = getDb().prepare(`SELECT json_each.value AS tag, count(*) AS n FROM spells, json_each(spells.tags)
    GROUP BY lower(json_each.value) ORDER BY n DESC, tag ASC`).all() as Array<{ tag: string; n: number }>;
  return rows.map((r) => ({ tag: r.tag, count: r.n }));
}

export function filterCounts(): Record<SpellFilter, number> {
  const r = getDb().prepare(`SELECT count(*) AS all_n,
    sum(origin = 'mine') AS mine, sum(origin = 'community') AS community, sum(times_cast = 0) AS unmade FROM spells`).get() as
    { all_n: number; mine: number | null; community: number | null; unmade: number | null };
  return { all: r.all_n, mine: r.mine ?? 0, community: r.community ?? 0, unmade: r.unmade ?? 0 };
}

/** Surprise me: a never-made spell if there is one, else the one cast longest
 *  ago. Same filters as the wall. */
export function surpriseSpell(query: Omit<SpellQuery, 'limit'> & { exclude?: string[] } = {}): Spell | null {
  const base = whereFor(query);
  const clauses = base.sql ? [base.sql.slice('WHERE '.length)] : [];
  const params = [...base.params];
  const exclude = (query.exclude ?? []).filter((x) => typeof x === 'string').slice(0, 50);
  if (exclude.length) { clauses.push(`id NOT IN (${exclude.map(() => '?').join(',')})`); params.push(...exclude); }
  const where = (extra?: string) => {
    const all = extra ? [...clauses, extra] : clauses;
    return all.length ? `WHERE ${all.join(' AND ')}` : '';
  };
  const unmade = getDb().prepare(`SELECT * FROM spells ${where('times_cast = 0')} ORDER BY random() LIMIT 1`).get(...params) as SpellRow | undefined;
  if (unmade) return toSpell(unmade);
  const oldest = getDb().prepare(`SELECT * FROM spells ${where()} ORDER BY coalesce(last_cast_at, '0') ASC, random() LIMIT 1`).get(...params) as SpellRow | undefined;
  return oldest ? toSpell(oldest) : null;
}

export function updateSpell(id: string, patch: { title?: string; tags?: string[]; scene?: string; credit?: string | null; link?: string | null; look?: string | null }): Spell | null {
  const cur = getSpell(id);
  if (!cur) return null;
  getDb().prepare('UPDATE spells SET title = ?, tags = ?, scene = ?, credit = ?, link = ?, look = ? WHERE id = ?').run(
    (patch.title ?? cur.title).slice(0, 120) || cur.title,
    JSON.stringify(patch.tags ? normalizeTags(patch.tags) : cur.tags),
    patch.scene ?? cur.scene,
    patch.credit === undefined ? cur.credit : patch.credit,
    patch.link === undefined ? cur.link : patch.link,
    patch.look === undefined ? cur.look : patch.look,
    id,
  );
  return getSpell(id);
}

export function deleteSpell(id: string): boolean {
  return getDb().prepare('DELETE FROM spells WHERE id = ?').run(id).changes > 0;
}

/** A render of this spell finished. */
export function markCast(id: string, at = new Date().toISOString()): void {
  getDb().prepare('UPDATE spells SET times_cast = times_cast + 1, last_cast_at = ? WHERE id = ?').run(at, id);
}

/** Spells imported but not yet neutralized (their people still named). */
export function listUnneutralized(limit = 500): Spell[] {
  return (getDb().prepare('SELECT * FROM spells WHERE neutralized = 0 ORDER BY created_at ASC LIMIT ?').all(limit) as SpellRow[]).map(toSpell);
}

export function setNeutralized(id: string, scene: string, title?: string): void {
  getDb().prepare('UPDATE spells SET scene = ?, neutralized = 1, title = coalesce(?, title) WHERE id = ?').run(scene, title ?? null, id);
}

// ─── Renders ────────────────────────────────────────────────────────

export interface SpellRender { filename: string; url: string; createdAt: string; cast: string[]; prompt?: string }

export async function rendersBySpell(): Promise<Map<string, SpellRender[]>> {
  const raw = await spellRenders();
  const out = new Map<string, SpellRender[]>();
  for (const [id, list] of raw) {
    out.set(id, list.map((r) => ({ filename: r.filename, url: `/api/studio/gallery/${encodeURIComponent(r.filename)}`, createdAt: r.createdAt, cast: r.cast, prompt: r.prompt })));
  }
  return out;
}

// ─── Looks ──────────────────────────────────────────────────────────

export const LOOK_IMAGES_DIR = join(dirname(REFS_DIR), 'spellbook-looks');
export const MAX_LOOK_IMAGES = 6;

export interface Look {
  id: string;
  name: string;
  recipe: string;
  images: string[];
  keepPicture: boolean;
  isDefault: boolean;
  builtin: boolean;
  /** Starred: sorted first here and in Studio Create. */
  favorite: boolean;
  /** One of the old Create word presets, seeded once. Editable, deletable. */
  starter: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LookRow {
  id: string; name: string; recipe: string; images: string; keep_picture: number; is_default: number; builtin: number;
  favorite?: number; starter?: number; created_at: string; updated_at: string;
}

function toLook(r: LookRow): Look {
  return {
    id: r.id, name: r.name, recipe: r.recipe, images: parseTags(r.images), keepPicture: r.keep_picture === 1,
    isDefault: r.is_default === 1, builtin: r.builtin === 1, favorite: r.favorite === 1, starter: r.starter === 1, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

let looksSeeded = false;
/** Grungy film and Keep the picture's look, seeded once, then editable. */
export function seedLooks(): void {
  if (looksSeeded) return;
  const db = getDb();
  const now = new Date().toISOString();
  const hasDefault = !!db.prepare('SELECT 1 FROM looks WHERE is_default = 1').get();
  db.prepare(`INSERT OR IGNORE INTO looks (id, name, recipe, images, keep_picture, is_default, builtin, created_at, updated_at)
    VALUES ('grungy-film', ?, ?, '[]', 0, ?, 1, ?, ?)`).run(LOOKS['grungy-film'].label, LOOKS['grungy-film'].recipe, hasDefault ? 0 : 1, now, now);
  db.prepare(`INSERT OR IGNORE INTO looks (id, name, recipe, images, keep_picture, is_default, builtin, created_at, updated_at)
    VALUES ('keep', ?, '', '[]', 1, 0, 1, ?, ?)`).run(LOOKS.keep.label, now, now);
  seedStarterLooks();
  looksSeeded = true;
}

/** The old Create word presets become ordinary looks, once per house. The
 *  flag (not the rows) says it ran, so deleting a starter is permanent. */
export function seedStarterLooks(): number {
  if (getConfig(STARTER_LOOKS_FLAG)) return 0;
  const db = getDb();
  const insert = db.prepare(`INSERT OR IGNORE INTO looks (id, name, recipe, images, keep_picture, is_default, builtin, favorite, starter, created_at, updated_at)
    VALUES (?, ?, ?, '[]', 0, 0, 0, 0, 1, ?, ?)`);
  let added = 0;
  db.transaction(() => {
    STARTER_LOOKS.forEach((s, i) => {
      // Spaced a millisecond apart so they keep the old picker's order.
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString();
      added += insert.run(starterLookId(s.name), s.name, s.recipe, at, at).changes;
    });
    setConfig(STARTER_LOOKS_FLAG, new Date().toISOString());
  })();
  return added;
}

/** Tests only: forget that this process already seeded. */
export function resetLooksSeededForTests(): void { looksSeeded = false; }

export function listLooks(): Look[] {
  seedLooks();
  return (getDb().prepare('SELECT * FROM looks ORDER BY favorite DESC, builtin DESC, starter ASC, created_at ASC').all() as LookRow[]).map(toLook);
}

export function getLook(id: string): Look | null {
  seedLooks();
  const r = getDb().prepare('SELECT * FROM looks WHERE id = ?').get(id) as LookRow | undefined;
  return r ? toLook(r) : null;
}

export function defaultLook(): Look {
  seedLooks();
  const r = getDb().prepare('SELECT * FROM looks WHERE is_default = 1 LIMIT 1').get() as LookRow | undefined;
  return r ? toLook(r) : (getLook('grungy-film') as Look);
}

/** A look's style pictures as paths on disk (missing files dropped). */
export function lookStylePaths(l: Pick<Look, 'images'>): string[] {
  return l.images.map(lookImagePath).filter((p): p is string => !!p);
}

function toResolved(l: Look): ResolvedLook {
  return { id: l.id, name: l.name, recipe: l.recipe, keepPicture: l.keepPicture, styleImages: l.keepPicture ? [] : lookStylePaths(l) };
}

/** The look a cast uses: the one asked for, else the default. */
export function resolveLook(id: unknown): ResolvedLook {
  const l = (typeof id === 'string' && id ? getLook(id) : null) ?? defaultLook();
  return toResolved(l);
}

/** Studio Create: only the look asked for, never the default. Null when she
 *  picked none (or it is gone), so a plain Create stays plain. */
export function resolveCreateLook(id: unknown): ResolvedLook | null {
  const l = typeof id === 'string' && id ? getLook(id) : null;
  return l && !l.keepPicture ? toResolved(l) : null;
}

export function setLookFavorite(id: string, favorite: boolean): Look | null {
  if (!getLook(id)) return null;
  getDb().prepare('UPDATE looks SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id);
  return getLook(id);
}

export function createLook(input: { name: string; recipe: string; images: string[]; keepPicture?: boolean }): Look {
  seedLooks();
  const id = `look_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO looks (id, name, recipe, images, keep_picture, is_default, builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`).run(id, input.name.slice(0, 40) || 'New look', input.recipe.slice(0, 1200),
    JSON.stringify(input.images.slice(0, MAX_LOOK_IMAGES)), input.keepPicture ? 1 : 0, now, now);
  return getLook(id) as Look;
}

export function updateLook(id: string, patch: { name?: string; recipe?: string; images?: string[] }): Look | null {
  const cur = getLook(id);
  if (!cur) return null;
  getDb().prepare('UPDATE looks SET name = ?, recipe = ?, images = ?, updated_at = ? WHERE id = ?').run(
    (patch.name ?? cur.name).slice(0, 40) || cur.name,
    (patch.recipe ?? cur.recipe).slice(0, 1200),
    JSON.stringify((patch.images ?? cur.images).slice(0, MAX_LOOK_IMAGES)),
    new Date().toISOString(), id,
  );
  return getLook(id);
}

export function setDefaultLook(id: string): Look | null {
  if (!getLook(id)) return null;
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE looks SET is_default = 0').run();
    db.prepare('UPDATE looks SET is_default = 1 WHERE id = ?').run(id);
  })();
  return getLook(id);
}

export async function deleteLook(id: string): Promise<boolean> {
  const cur = getLook(id);
  if (!cur) return false;
  if (cur.builtin) throw new SpellbookError('The two starting looks can be edited but not deleted.');
  getDb().prepare('DELETE FROM looks WHERE id = ?').run(id);
  if (cur.isDefault) setDefaultLook('grungy-film');
  for (const img of cur.images) { const p = lookImagePath(img); if (p) await fs.unlink(p).catch(() => {}); }
  return true;
}

const LOOK_EXTS: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic' };

export async function saveLookImage(buf: Buffer, mime: string): Promise<string> {
  const ext = LOOK_EXTS[mime];
  if (!ext) throw new SpellbookError('Style pictures have to be JPG, PNG, WebP, GIF or HEIC.');
  await fs.mkdir(LOOK_IMAGES_DIR, { recursive: true });
  const name = `look-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  await fs.writeFile(join(LOOK_IMAGES_DIR, name), buf);
  return name;
}

export function lookImagePath(filename: string): string | null {
  const name = basename(filename);
  if (name !== filename || !/^look-\d+-[0-9a-f]{8}\.[a-z]+$/.test(name)) return null;
  if (!Object.values(LOOK_EXTS).includes(extname(name))) return null;
  const p = join(LOOK_IMAGES_DIR, name);
  return existsSync(p) ? p : null;
}

// ─── One-time backfill from slice 1 ─────────────────────────────────

let backfilled: Promise<void> | null = null;

/** Spells cast before the table existed live only on their gallery cards.
 *  Lift each one into the table once (INSERT OR IGNORE by id), counting its
 *  renders. Safe to call on every request; runs once per process. */
export function ensureSpellbookReady(): Promise<void> {
  seedLooks();
  if (!backfilled) {
    backfilled = (async () => {
      const renders = await spellRenders();
      for (const [id, list] of renders) {
        if (getSpell(id)) continue;
        const oldest = list[list.length - 1];
        const sp = oldest.spell;
        insertSpell({
          id, title: sp.title, scene: sp.scene, tags: sp.tags, look: sp.look, origin: 'mine',
          credit: sp.credit ?? null, link: sp.link ?? null, source: sp.source ?? null,
          createdAt: oldest.createdAt || new Date().toISOString(),
          timesCast: list.length, lastCastAt: list[0].createdAt || null,
        });
      }
    })().catch((err) => { backfilled = null; console.warn('[spellbook] backfill failed:', err); });
  }
  return backfilled;
}
