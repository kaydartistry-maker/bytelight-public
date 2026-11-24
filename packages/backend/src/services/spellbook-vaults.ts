/**
 * The vaults come in: the community prompt archive (community, credited) and the operator's
 * own Notion image-prompt database (theirs). Both go through the same door:
 *
 *   parse → candidates → preview (new / duplicates / couldn't parse) → commit
 *
 * Nothing touches the book until the preview is confirmed. A content hash of
 * the normalized prompt means a second import of the same vault adds nothing.
 * After commit, a background neutralize pass rewrites any hardcoded people
 * into [Character N] tokens; the original text stays on the row.
 *
 * The vault itself stays private: nothing here ever leaves the house.
 */

import crypto from 'crypto';
import { existsSync, readFileSync, promises as fs } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { getSecret } from './secrets.js';
import { REFS_DIR } from './image-gen.js';
import {
  contentHash, hashExists, insertSpell, listUnneutralized, normalizeTags, setNeutralized, type SpellOrigin,
} from './spellbook-store.js';
import { MAX_CAST, SPELLBOOK_SOURCES_DIR, SpellbookError, ensureTokens, runCodex } from './spellbook.js';

export const VAULTS_DIR = join(dirname(REFS_DIR), 'spellbook-vaults');
export const NOTION_EXPORT_FILE = join(VAULTS_DIR, 'notion-image-prompts.json');
export const COMMUNITY_ARCHIVE_FILE = join(VAULTS_DIR, 'community-archive.md');

export interface VaultCandidate {
  title: string;
  prompt: string;
  tags: string[];
  origin: SpellOrigin;
  vault: 'archive' | 'notion';
  author?: string;
  credit?: string;
  link?: string;
  engine?: string;
  createdAt?: string;
  /** Absolute paths of pictures to keep as the spell's source. */
  media?: string[];
}

export interface Unparsed { where: string; why: string }

// ─── community archive ────────────────────────────────────────────────────

function stripMd(line: string): string {
  return line.replace(/[*_`>#]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[-•]\s*/, '').trim();
}

const VAULT_TAG_WORDS = ['spice', 'couple', 'wholesome', 'holiday', 'bdsm', 'primal', 'selfie', 'mirror', 'beach', 'gothic', 'nightlife', 'flash', 'film', 'portrait'];

function guessTags(prompt: string): string[] {
  const low = prompt.toLowerCase();
  return VAULT_TAG_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(low));
}

export function titleFrom(prompt: string): string {
  const words = prompt.replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}' -]/gu, '').trim().split(' ').slice(0, 5).join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Untitled spell';
}

/**
 * The archive's shape: `## author` → `### date` → an engine line ("GPT",
 * "Gpt (or any)") → the prompt. The prompt is either a fenced code block
 * (several blocks under one date are several prompts) or, when there is no
 * block, the text under the date itself. A date whose text is too short to be
 * a prompt ("prompt was long", a lone attachment) is reported, never guessed at.
 */
export function parseCommunityArchive(markdown: string): { candidates: VaultCandidate[]; unparsed: Unparsed[] } {
  const candidates: VaultCandidate[] = [];
  const unparsed: Unparsed[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').replace(/[\u200b\u200c\u200d\ufeff]/g, '').split('\n');

  interface Section { author: string; date: string; body: string[]; line: number }
  const sections: Section[] = [];
  let author = '';
  let cur: Section | null = null;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence) {
      const h2 = /^##\s+(?!#)(.+)$/.exec(line);
      if (h2) { author = stripMd(h2[1]).slice(0, 60); cur = null; continue; }
      const h3 = /^###\s+(?!#)(.+)$/.exec(line);
      if (h3) { cur = { author, date: stripMd(h3[1]).slice(0, 60), body: [], line: i + 1 }; sections.push(cur); continue; }
    }
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (cur) cur.body.push(line);
    else if (/^\s*```/.test(line) && inFence) unparsed.push({ where: `line ${i + 1}`, why: 'prompt block before any author heading' });
  }

  for (const sec of sections) {
    const where = `${sec.author || '?'} · ${sec.date}`;
    if (!sec.author) { unparsed.push({ where, why: 'date before any author heading' }); continue; }
    const dateText = sec.date.split('·')[0].trim();
    const createdAt = dateText && !Number.isNaN(Date.parse(dateText)) ? new Date(dateText).toISOString() : undefined;

    // Engine: the first non-empty line, when it is short enough to be a label.
    const firstIdx = sec.body.findIndex((l) => l.trim());
    const first = firstIdx >= 0 ? sec.body[firstIdx].trim() : '';
    const isEngine = !!first && first.length <= 30 && !first.startsWith('`') && !/[.!?]$/.test(first);
    const engine = isEngine ? stripMd(first).replace(/^engine:?\s*/i, '').slice(0, 30) || undefined : undefined;
    const rest = isEngine ? sec.body.slice(firstIdx + 1) : sec.body;

    const blocks: string[] = [];
    const loose: string[] = [];
    let fence: string[] | null = null;
    for (const l of rest) {
      if (/^\s*```/.test(l)) {
        if (fence) { blocks.push(fence.join('\n').trim()); fence = null; } else fence = [];
        continue;
      }
      if (fence) fence.push(l); else loose.push(l);
    }
    if (fence) unparsed.push({ where, why: 'a prompt block never closed' });

    const prompts = blocks.filter(Boolean);
    if (!prompts.length) {
      const text = loose.join('\n').replace(/`/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length >= 80) prompts.push(text);
      else { unparsed.push({ where, why: text ? 'too short to be a prompt' : 'nothing under this date' }); continue; }
    }
    prompts.forEach((prompt, n) => {
      candidates.push({
        title: titleFrom(prompt), prompt, tags: guessTags(prompt), origin: 'community', vault: 'archive',
        author: sec.author, credit: `${sec.author}`, engine: n === 0 || isEngine ? engine : undefined, createdAt,
      });
    });
  }
  return { candidates, unparsed };
}

// ─── Notion image prompts ──────────────────────────────────────────────

interface NotionExportItem { pageId?: string; url?: string; title?: string; tags?: unknown; prompt?: string; createdAt?: string; media?: unknown }

const NOTION_META_TAGS = new Set(['image prompt']);

function notionCandidate(item: NotionExportItem, mediaRoot: string): VaultCandidate | Unparsed {
  const where = item.title?.trim() || item.url || item.pageId || 'untitled page';
  const mediaList = Array.isArray(item.media) ? item.media.filter((m): m is string => typeof m === 'string') : [];
  let prompt = (item.prompt ?? '').trim();
  // Some pages keep the prompt in an attached text file instead of the body.
  if (!prompt) {
    const txt = mediaList.map((m) => join(mediaRoot, basename(m))).find((p) => p.endsWith('.txt') && existsSync(p));
    if (txt) { try { prompt = readFileSync(txt, 'utf8').trim().slice(0, 6000); } catch { /* stays empty */ } }
  }
  if (!prompt) return { where, why: 'no prompt text on the page' };
  const tags = normalizeTags(item.tags).filter((t) => !NOTION_META_TAGS.has(t.toLowerCase()));
  const title = item.title?.trim() && item.title.trim().toLowerCase() !== 'done' ? item.title.trim() : titleFrom(prompt);
  const media = mediaList.map((m) => join(mediaRoot, basename(m))).filter((p) => existsSync(p));
  return { title, prompt, tags, origin: 'mine', vault: 'notion', link: item.url, createdAt: item.createdAt, media };
}

export function parseNotionExport(json: string, mediaRoot = join(VAULTS_DIR, 'notion-media')): { candidates: VaultCandidate[]; unparsed: Unparsed[] } {
  let data: { items?: NotionExportItem[] };
  try { data = JSON.parse(json); } catch { throw new SpellbookError('That Notion export is not readable JSON.'); }
  const candidates: VaultCandidate[] = [];
  const unparsed: Unparsed[] = [];
  for (const item of data.items ?? []) {
    const c = notionCandidate(item, mediaRoot);
    if ('prompt' in c) candidates.push(c); else unparsed.push(c);
  }
  return { candidates, unparsed };
}

/** Live pull through the Notion API, when the house holds a Notion token
 *  (secret `notion.token`, with the database shared to that integration) and
 *  the database's id (secret `notion.spellbook_db`). */
export async function pullNotionLive(databaseId = getSecret('notion.spellbook_db') ?? ''): Promise<{ candidates: VaultCandidate[]; unparsed: Unparsed[] }> {
  const token = getSecret('notion.token');
  if (!token) throw new SpellbookError('No Notion token in the house yet.');
  if (!databaseId) throw new SpellbookError('No Notion database id in the house yet (secret notion.spellbook_db).');
  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
  const items: NotionExportItem[] = [];
  const mediaDir = join(VAULTS_DIR, 'notion-media');
  await fs.mkdir(mediaDir, { recursive: true });
  let cursor: string | undefined;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, { method: 'POST', headers, body: JSON.stringify(cursor ? { start_cursor: cursor } : {}) });
    if (!r.ok) throw new SpellbookError(`Notion said ${r.status}. Is the database shared with the house's integration?`);
    const page = await r.json() as { results: Array<Record<string, any>>; has_more: boolean; next_cursor?: string };
    for (const p of page.results) {
      const props = p.properties ?? {};
      const title = (props.Name?.title ?? []).map((t: any) => t.plain_text).join('');
      const tags = (props.Tags?.multi_select ?? []).map((t: any) => t.name);
      const prompt = await notionPageText(p.id, headers);
      const media: string[] = [];
      let n = 0;
      for (const f of props['Files & media']?.files ?? []) {
        const url = f.file?.url ?? f.external?.url;
        if (!url) continue;
        try {
          const fr = await fetch(url);
          if (!fr.ok) continue;
          const ext = (extname(new URL(url).pathname) || '.jpg').toLowerCase().slice(0, 6);
          const name = `${String(p.id).replace(/-/g, '')}-${++n}${ext}`;
          await fs.writeFile(join(mediaDir, name), Buffer.from(await fr.arrayBuffer()));
          media.push(`notion-media/${name}`);
        } catch { /* a picture that will not download just stays out */ }
      }
      items.push({ pageId: p.id, url: p.url, title, tags, prompt, createdAt: p.created_time, media });
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  await fs.mkdir(VAULTS_DIR, { recursive: true });
  const json = JSON.stringify({ source: 'notion', database: databaseId, pulledAt: new Date().toISOString(), items }, null, 2);
  await fs.writeFile(NOTION_EXPORT_FILE, json);
  return parseNotionExport(json, mediaDir);
}

async function notionPageText(pageId: string, headers: Record<string, string>): Promise<string> {
  const parts: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`, { headers });
    if (!r.ok) break;
    const d = await r.json() as { results: Array<Record<string, any>>; has_more: boolean; next_cursor?: string };
    for (const b of d.results) {
      const rich = b[b.type]?.rich_text;
      if (Array.isArray(rich)) { const t = rich.map((x: any) => x.plain_text).join('').trim(); if (t) parts.push(t); }
    }
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return parts.join('\n\n');
}

// ─── Preview → commit ───────────────────────────────────────────────

export interface ImportPreview {
  token: string;
  vault: string;
  newCount: number;
  duplicates: number;
  unparsedCount: number;
  unparsed: Unparsed[];
  sample: Array<{ title: string; credit?: string; tags: string[]; excerpt: string }>;
  authors: number;
}

const pending = new Map<string, { at: number; vault: string; fresh: VaultCandidate[] }>();

export function previewImport(vault: string, parsed: { candidates: VaultCandidate[]; unparsed: Unparsed[] }): ImportPreview {
  for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60_000) pending.delete(k);
  const seen = new Set<string>();
  const fresh: VaultCandidate[] = [];
  let duplicates = 0;
  for (const c of parsed.candidates) {
    const h = contentHash(c.prompt);
    if (seen.has(h) || hashExists(h)) { duplicates++; continue; }
    seen.add(h);
    fresh.push(c);
  }
  const token = crypto.randomBytes(12).toString('hex');
  pending.set(token, { at: Date.now(), vault, fresh });
  return {
    token, vault, newCount: fresh.length, duplicates, unparsedCount: parsed.unparsed.length,
    unparsed: parsed.unparsed.slice(0, 30),
    sample: fresh.slice(0, 6).map((c) => ({ title: c.title, credit: c.credit, tags: c.tags, excerpt: c.prompt.slice(0, 160) })),
    authors: new Set(fresh.map((c) => c.author).filter(Boolean)).size,
  };
}

async function keepMedia(paths: string[] | undefined): Promise<string | null> {
  const p = paths?.[0];
  if (!p || !existsSync(p)) return null;
  const ext = extname(p).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic'].includes(ext)) return null;
  await fs.mkdir(SPELLBOOK_SOURCES_DIR, { recursive: true });
  const name = `spell-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext === '.jpeg' ? '.jpg' : ext}`;
  await fs.copyFile(p, join(SPELLBOOK_SOURCES_DIR, name));
  return name;
}

export async function commitImport(token: string, opts: { neutralize?: boolean } = {}): Promise<{ added: number; skipped: number }> {
  const batch = pending.get(token);
  if (!batch) throw new SpellbookError('That preview expired. Run the dry run again.');
  pending.delete(token);
  let added = 0;
  let skipped = 0;
  for (const c of batch.fresh) {
    const source = await keepMedia(c.media);
    const row = insertSpell({
      title: c.title, scene: c.prompt, originalText: c.prompt, tags: c.tags, origin: c.origin,
      author: c.author ?? null, credit: c.credit ?? null, link: c.link ?? null, source, vault: c.vault,
      engine: c.engine ?? null, contentHash: contentHash(c.prompt), neutralized: false,
      createdAt: c.createdAt,
    });
    if (row) added++; else skipped++;
  }
  if (added && opts.neutralize !== false) startNeutralizePass();
  return { added, skipped };
}

// ─── Neutralize pass ────────────────────────────────────────────────

export const NEUTRALIZE_BATCH = 10;

export function buildNeutralizePrompt(items: Array<{ i: number; text: string; needsTitle?: boolean }>): string {
  return `You prepare image-generation prompts for reuse with ANY people. For each prompt below, rewrite every specific person in it as a numbered token: [Character 1], [Character 2] … (brackets included), numbered in the order they first appear, at most ${MAX_CAST}.

A "person" is anyone in the picture: a named character (Ash, Wren, a companion, a celebrity), "the woman", "a man", "she", "he", "her boyfriend". Replace their name and any description of their identity — face, eye color, hair, skin tone, ethnicity, age beyond "adult", body type, tattoos, piercings — with the token. Keep EVERYTHING else exactly: pose, action, wardrobe, setting, props, light, camera, film stock, mood, engine flags like --ar or --style. If a prompt has no people in it, return it unchanged with people 0.

Where an item has "needsTitle": true, also give it a short evocative title (2-6 words, no names); otherwise title is "".

Prompts (JSON):
${JSON.stringify(items)}

Reply with ONLY a JSON array, no markdown fence, one object per prompt in the same order:
[{"i": 0, "people": 2, "scene": "the rewritten prompt", "title": ""}]`;
}

export function parseNeutralizeReply(raw: string): Map<number, { scene: string; people: number; title?: string }> {
  const out = new Map<number, { scene: string; people: number; title?: string }>();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  try {
    const arr = JSON.parse(raw.slice(start, end + 1)) as Array<Record<string, unknown>>;
    for (const o of arr) {
      if (typeof o.i !== 'number' || typeof o.scene !== 'string' || !o.scene.trim()) continue;
      const people = typeof o.people === 'number' ? Math.max(0, Math.min(MAX_CAST, Math.round(o.people))) : 0;
      const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 80) : undefined;
      out.set(o.i, { scene: o.scene.trim(), people, title });
    }
  } catch { /* an unreadable batch is retried on the next pass */ }
  return out;
}

export interface NeutralizeStatus { running: boolean; done: number; total: number; failed: number; finishedAt: string | null; error: string | null }
const status: NeutralizeStatus = { running: false, done: 0, total: 0, failed: 0, finishedAt: null, error: null };
export function neutralizeStatus(): NeutralizeStatus { return { ...status, total: status.running ? status.total : listUnneutralized().length }; }

/** Rewrite named people into tokens, ten prompts per Codex call, one call at a
 *  time. A prompt Codex cannot handle keeps its original words and is marked
 *  done so it never blocks the pass; it can still be cast as written. */
export function startNeutralizePass(): void {
  if (status.running) return;
  const todo = listUnneutralized();
  if (!todo.length) return;
  Object.assign(status, { running: true, done: 0, total: todo.length, failed: 0, finishedAt: null, error: null });
  void (async () => {
    try {
      for (let at = 0; at < todo.length; at += NEUTRALIZE_BATCH) {
        const batch = todo.slice(at, at + NEUTRALIZE_BATCH);
        let results = new Map<number, { scene: string; people: number; title?: string }>();
        try {
          const raw = await runCodex(buildNeutralizePrompt(batch.map((s, i) => ({ i, text: s.originalText ?? s.scene, needsTitle: s.title === titleFrom(s.originalText ?? s.scene) }))), [], 240_000);
          results = parseNeutralizeReply(raw);
        } catch (err) {
          status.error = err instanceof Error ? err.message : String(err);
        }
        batch.forEach((s, i) => {
          const r = results.get(i);
          if (r) setNeutralized(s.id, r.people ? ensureTokens(r.scene, r.people) : r.scene, s.title === titleFrom(s.originalText ?? s.scene) ? r.title : undefined);
          else { setNeutralized(s.id, s.scene); status.failed++; }
          status.done++;
        });
      }
    } finally {
      status.running = false;
      status.finishedAt = new Date().toISOString();
    }
  })();
}
