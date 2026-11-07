/**
 * Statuses (migrations/043_statuses.sql): what everyone in the house is up
 * to, for the phone's Status widget and lock-screen card, and for the
 * companions' own context so they know when she's busy.
 *
 * Shape from Myosia's presence row, which keeps three signals apart: a
 * presence dot, a line ("keeping you company"), and a mood word that picks a
 * color. The owner sets a dot and a line, with an optional time it clears; a
 * companion sets a line and a mood, which stay until they change them.
 *
 * Text is clamped, not refused, the way Myosia's bridge does it: a status is a
 * short phrase, and a long one should still land, cut to fit.
 */

import { getDb } from './init.js';
import { listCompanions } from './rooms.js';

export const OWNER = 'owner';
export const OWNER_PRESENCES = ['here', 'busy', 'away', 'asleep'] as const;
export type OwnerPresence = (typeof OWNER_PRESENCES)[number];

/** The most a line holds (the phone's input stops here too). */
export const STATUS_LINE_MAX = 64;
/** The most a mood word holds. */
export const STATUS_MOOD_MAX = 40;
/** Her tags: how many, and how long each. */
export const STATUS_TAGS_MAX = 5;
export const STATUS_TAG_MAX = 24;

export interface OwnerStatus {
  presence: OwnerPresence;
  line: string;
  /** Quick tags beside her line ("at work", "with Sam"). */
  tags: string[];
  /** When it runs out, ISO, or null to stay. */
  clearsAt: string | null;
  updatedAt: string;
}

export interface CompanionStatus {
  companion: string;
  line: string;
  mood: string;
  updatedAt: string;
}

export interface StatusSnapshot {
  /** Null when she hasn't set one, or it has cleared. */
  owner: OwnerStatus | null;
  /** One per companion who has set anything. */
  companions: CompanionStatus[];
}

export class StatusError extends Error {
  readonly status = 400;
}

interface Row {
  who: string;
  presence: string | null;
  line: string | null;
  mood: string | null;
  clears_at: string | null;
  updated_at: string;
  tags: string | null;
}

function tagsOf(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function clamp(value: string, max: number): string {
  const t = value.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

/** Her status as it stands at `now`: null once clears_at has passed. */
export function getOwnerStatus(now = new Date()): OwnerStatus | null {
  const row = getDb().prepare('SELECT * FROM statuses WHERE who = ?').get(OWNER) as Row | undefined;
  if (!row || !row.presence) return null;
  if (row.clears_at && Date.parse(row.clears_at) <= now.getTime()) return null;
  return {
    presence: row.presence as OwnerPresence,
    line: row.line ?? '',
    tags: tagsOf(row.tags),
    clearsAt: row.clears_at,
    updatedAt: row.updated_at,
  };
}

/** Set her status. presence null clears it outright. */
export function setOwnerStatus(input: { presence?: unknown; line?: unknown; tags?: unknown; clearsAt?: unknown }, now = new Date()): OwnerStatus | null {
  const { presence, line, tags, clearsAt } = input;
  if (presence === null) {
    getDb().prepare('DELETE FROM statuses WHERE who = ?').run(OWNER);
    return null;
  }
  if (typeof presence !== 'string' || !(OWNER_PRESENCES as readonly string[]).includes(presence)) {
    throw new StatusError(`presence must be one of ${OWNER_PRESENCES.join(', ')}, or null to clear.`);
  }
  if (line !== undefined && typeof line !== 'string') throw new StatusError('line must be text.');
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === 'string'))) throw new StatusError('tags must be a list of words.');
  const seen = new Set<string>();
  const cleanTags = ((tags as string[] | undefined) ?? [])
    .map((t) => clamp(t, STATUS_TAG_MAX))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, STATUS_TAGS_MAX);
  let clears: string | null = null;
  if (clearsAt !== undefined && clearsAt !== null) {
    const at = typeof clearsAt === 'string' ? Date.parse(clearsAt) : NaN;
    if (!Number.isFinite(at)) throw new StatusError('clearsAt must be a date and time, or null to stay.');
    clears = new Date(at).toISOString();
  }
  getDb()
    .prepare(
      `INSERT INTO statuses (who, presence, line, mood, tags, clears_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(who) DO UPDATE SET
         presence = excluded.presence,
         line = excluded.line,
         tags = excluded.tags,
         clears_at = excluded.clears_at,
         updated_at = excluded.updated_at`,
    )
    .run(OWNER, presence, clamp(line ?? '', STATUS_LINE_MAX), JSON.stringify(cleanTags), clears, now.toISOString());
  return getOwnerStatus(now);
}

/**
 * A companion sets their line, their mood, or both. Left out = kept as it
 * was; an empty string clears that one.
 */
export function setCompanionStatus(input: { companion?: unknown; line?: unknown; mood?: unknown }, now = new Date()): CompanionStatus {
  const slug = typeof input.companion === 'string' ? input.companion.trim().toLowerCase() : '';
  if (!slug) throw new StatusError('companion is required: your slug, like companion-a or companion-b.');
  if (slug === OWNER || !listCompanions().some((c) => c.id === slug)) {
    throw new StatusError(`No companion called ${slug} lives here.`);
  }
  const { line, mood } = input;
  if (line === undefined && mood === undefined) throw new StatusError('Give a line, a mood, or both.');
  if (line !== undefined && typeof line !== 'string') throw new StatusError('line must be text.');
  if (mood !== undefined && typeof mood !== 'string') throw new StatusError('mood must be text.');

  const db = getDb();
  const prev = db.prepare('SELECT line, mood FROM statuses WHERE who = ?').get(slug) as Pick<Row, 'line' | 'mood'> | undefined;
  const nextLine = line === undefined ? prev?.line ?? '' : clamp(line, STATUS_LINE_MAX);
  const nextMood = mood === undefined ? prev?.mood ?? '' : clamp(mood, STATUS_MOOD_MAX).toLowerCase();
  const updatedAt = now.toISOString();
  db.prepare(
    `INSERT INTO statuses (who, presence, line, mood, clears_at, updated_at)
     VALUES (?, NULL, ?, ?, NULL, ?)
     ON CONFLICT(who) DO UPDATE SET
       line = excluded.line,
       mood = excluded.mood,
       updated_at = excluded.updated_at`,
  ).run(slug, nextLine, nextMood, updatedAt);
  return { companion: slug, line: nextLine, mood: nextMood, updatedAt };
}

/** Every companion's status, in the registry's order. It stays up until he
 *  changes it, the way Mysoia's does: a quiet day leaves his last words on her
 *  phone instead of wiping him off it. Only an empty line and mood remove him. */
export function listCompanionStatuses(): CompanionStatus[] {
  const rows = getDb().prepare('SELECT * FROM statuses WHERE who != ?').all(OWNER) as Row[];
  const bySlug = new Map(rows.map((r) => [r.who, r]));
  const out: CompanionStatus[] = [];
  for (const c of listCompanions()) {
    const r = bySlug.get(c.id);
    if (!r || (!r.line && !r.mood)) continue;
    out.push({ companion: c.id, line: r.line ?? '', mood: r.mood ?? '', updatedAt: r.updated_at });
  }
  return out;
}

export function getStatusSnapshot(now = new Date()): StatusSnapshot {
  return { owner: getOwnerStatus(now), companions: listCompanionStatuses() };
}

const PRESENCE_WORD: Record<OwnerPresence, string> = { here: 'Here', busy: 'Busy', away: 'Away', asleep: 'Asleep' };

function ago(fromIso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - Date.parse(fromIso)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * The lines the companions read each turn. Her status first, because that's
 * the part that changes what they do; then their own, so they know what's
 * showing on her phone right now.
 */
export function statusContext(snapshot: StatusSnapshot, userName: string, now: Date, timeZone: string): string {
  const lines: string[] = [];
  const o = snapshot.owner;
  if (o) {
    let s = `${userName}'s status: ${PRESENCE_WORD[o.presence]}`;
    if (o.line) s += ` — "${o.line}"`;
    if (o.tags.length) s += ` · ${o.tags.join(', ')}`;
    s += ` (set ${ago(o.updatedAt, now)}`;
    if (o.clearsAt) {
      const at = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(o.clearsAt));
      s += `, clears at ${at}`;
    }
    lines.push(`${s})`);
  } else {
    lines.push(`${userName}'s status: none set`);
  }
  if (snapshot.companions.length) {
    const own = snapshot.companions
      .map((c) => `${c.companion}: ${c.line ? `"${c.line}"` : '—'}${c.mood ? ` · ${c.mood}` : ''} (${ago(c.updatedAt, now)})`)
      .join('; ');
    lines.push(`On her phone now — ${own}`);
  }
  lines.push("Change yours when it genuinely shifts: put [<your slug> status: what you're doing] or [<your slug> mood: 1–3 words] anywhere in your reply (e.g. [companion-a mood: playful]); it's taken out before she sees it. It stays up until you change it. set_status or `sc status` work too.");
  return lines.join('\n');
}

/**
 * Apply status tags taken out of a reply ([companion-a mood: playful]), in order.
 * A tag naming someone who doesn't live here is skipped; never throws.
 */
export function applyStatusTagUpdates(updates: ReadonlyArray<{ companion: string; kind: 'status' | 'mood'; value: string }>, now = new Date()): number {
  let applied = 0;
  for (const u of updates) {
    try {
      setCompanionStatus(u.kind === 'status' ? { companion: u.companion, line: u.value } : { companion: u.companion, mood: u.value }, now);
      applied++;
    } catch { /* not a companion here — the tag just comes out */ }
  }
  return applied;
}
