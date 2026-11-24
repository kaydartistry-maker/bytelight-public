/**
 * Intentions (migrations/045_intentions.sql, 049): follow-ups kept for the operator
 * until they're said and settled. Two kinds (049):
 *   - 'promise': a companion's own choice to check back on something
 *     ("I'll ask how the meeting went"), filed live or caught by the Archivist.
 *   - 'loose_end': something the operator mentioned (a plan, an appointment,
 *     a thing they're waiting on) that the Archivist handed to the companion best placed
 *     to check in. Never phrased as a promise they made.
 *
 * The "when" is an impulse (services/db/triggers.ts): an `after` time, the
 * operator's status clearing, or both. Impulses already wait their turn when the house
 * is busy instead of dropping, which timers don't. This row is the promise
 * riding it; the orchestrator fires it in the promiser's own voice, closes it
 * when they answer in that thread, nudges once if they don't, then lets it
 * rest. Nothing fires or nudges inside the intentions' quiet hours.
 *
 * Idea from Myosia's intentions. Its code is proprietary; this is ours.
 */

import crypto from 'crypto';
import { getDb } from './init.js';
import { getConfig, setConfig } from './config.js';
import { listCompanions } from './rooms.js';
import { cancelTrigger, createTrigger, rearmTrigger, updateTriggerConditions, type TriggerCondition } from './triggers.js';

/** Open: pending, asked, nudged. Closed: answered (they replied after it was
 *  asked), resolved (closed on evidence of their own words), resting, cancelled. */
export type IntentionState = 'pending' | 'asked' | 'nudged' | 'answered' | 'resolved' | 'resting' | 'cancelled';
export type IntentionKind = 'promise' | 'loose_end';

const OPEN_STATES = ['pending', 'asked', 'nudged'] as const;
const OPEN_SQL = "('pending', 'asked', 'nudged')";

export interface Intention {
  id: string;
  companion: string;
  text: string;
  threadId: string | null;
  triggerId: string;
  state: IntentionState;
  /** 'companion' (filed live) or 'archivist' (caught on the sweep). */
  source: 'companion' | 'archivist';
  /** 'promise' (the companion's own follow-up) or 'loose_end' (something the operator mentioned). */
  kind: IntentionKind;
  /** Why it closed on its own: their words (resolved) or the reason (cancelled). */
  closeNote: string | null;
  askedMessageId: string | null;
  askedAt: string | null;
  nudgedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  /** From the impulse: the time it waits for, and whether it waits on the operator's status. */
  at: string | null;
  onStatusClears: boolean;
}

export const INTENTION_TEXT_MAX = 300;

/** The owner's choices: quiet 3–9 AM, one nudge a day later, then rest a day
 *  after that. A follow-up waiting on the operator's status may also come due once
 *  they're around and it has waited statusFallbackHours, but no more than one that
 *  way per statusFallbackGapHours, so a backlog drains one at a time instead
 *  of arriving as a flood; anything still pending
 *  expireAfterDays past its time goes to rest. Two follow-ups whose words
 *  overlap at least similarityThreshold are the same one. */
export const INTENTION_DEFAULTS = {
  quietStart: '03:00',
  quietEnd: '09:00',
  nudgeAfterMinutes: 24 * 60,
  restAfterMinutes: 24 * 60,
  statusFallbackHours: 6,
  statusFallbackGapHours: 3,
  expireAfterDays: 7,
  similarityThreshold: 0.6,
};

export class IntentionError extends Error {
  readonly status = 400;
}

interface Row {
  id: string;
  companion: string;
  text: string;
  thread_id: string | null;
  trigger_id: string;
  state: IntentionState;
  asked_message_id: string | null;
  asked_at: string | null;
  nudged_at: string | null;
  closed_at: string | null;
  created_at: string;
  source: string | null;
  kind: string | null;
  close_note: string | null;
  conditions: string | null;
}

const SELECT = 'SELECT i.*, t.conditions FROM intentions i LEFT JOIN triggers t ON t.id = i.trigger_id';

function fromRow(r: Row): Intention {
  let at: string | null = null;
  let onStatusClears = false;
  try {
    for (const c of JSON.parse(r.conditions ?? '[]') as TriggerCondition[]) {
      if (c.type === 'after') at = c.at;
      if (c.type === 'status_clears') onStatusClears = true;
    }
  } catch { /* a broken row still lists */ }
  return {
    id: r.id,
    companion: r.companion,
    text: r.text,
    threadId: r.thread_id,
    triggerId: r.trigger_id,
    state: r.state,
    source: r.source === 'archivist' ? 'archivist' : 'companion',
    kind: r.kind === 'loose_end' ? 'loose_end' : 'promise',
    closeNote: r.close_note ?? null,
    askedMessageId: r.asked_message_id,
    askedAt: r.asked_at,
    nudgedAt: r.nudged_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    at,
    onStatusClears,
  };
}

// ── One follow-up, one row ──────────────────────────────────────────────
// Two wordings of the same follow-up ("ask how the dentist went" / "ask them
// how their dentist appointment went") should land on one row. Words are
// lowercased, stripped of punctuation and of filler that every follow-up
// shares (articles, pronouns, "ask", "check", "how", "went"), crudely
// singularized, then compared as sets.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'into', 'over',
  'after', 'before', 'during', 'when', 'while', 'if', 'whether', 'then', 'than', 'that', 'this', 'these', 'those', 'there',
  'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done', 'have', 'has', 'had',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their',
  'ask', 'asks', 'asking', 'check', 'checks', 'checking', 'see', 'follow', 'up', 'how', 'what', 'went', 'go', 'goes', 'going', 'gone',
  'get', 'got', 'just', 'again', 'still', 'also', 'really', 'some', 'any', 'out', 'back', 'in', 'remind', 'reminder', 'let', 'know',
  'make', 'sure', 'whatever', 'thing', 'things',
]);

function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** The words of a follow-up that carry its meaning. */
export function intentionTokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return new Set(words.filter((w) => !STOPWORDS.has(w)).map(singular));
}

/** How much two follow-ups overlap, 0 to 1 (Jaccard over their meaning words). */
export function intentionSimilarity(a: string, b: string): number {
  const ta = intentionTokens(a);
  const tb = intentionTokens(b);
  if (ta.size === 0 || tb.size === 0) {
    const flat = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
    return flat(a) === flat(b) ? 1 : 0;
  }
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** The same follow-up? Overlap at or above the threshold, or every meaning
 *  word of the shorter one (two or more) inside the longer. */
export function sameFollowUp(a: string, b: string, threshold = INTENTION_DEFAULTS.similarityThreshold): boolean {
  if (intentionSimilarity(a, b) >= threshold) return true;
  const ta = intentionTokens(a);
  const tb = intentionTokens(b);
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size < 2) return false;
  for (const w of small) if (!big.has(w)) return false;
  return true;
}

/** An open follow-up this one duplicates: the same companion's for a promise,
 *  anyone's for a loose end (the operator mentioned it once, one companion checks in). */
export function findSimilarOpen(companion: string, text: string, kind: IntentionKind): Intention | null {
  const threshold = intentionSettings().similarityThreshold;
  for (const i of listOpenIntentions()) {
    if (kind === 'promise' && i.companion !== companion) continue;
    if (sameFollowUp(i.text, text, threshold)) return i;
  }
  return null;
}

function cleanText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new IntentionError('text is required: the follow-up, in a sentence.');
  if (text.length > INTENTION_TEXT_MAX) throw new IntentionError(`Keep it to ${INTENTION_TEXT_MAX} characters.`);
  return text;
}

function parseAt(raw: unknown): string {
  const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at)) throw new IntentionError('at must be a date and time (ISO 8601).');
  return new Date(at).toISOString();
}

/** The impulse's conditions for a when. A status_clears already armed stays armed. */
function whenConditions(at: string | null, onStatusClears: boolean, previous: TriggerCondition[] = []): TriggerCondition[] {
  const conditions: TriggerCondition[] = [];
  if (at) conditions.push({ type: 'after', at });
  if (onStatusClears) {
    const wasArmed = previous.some((c) => c.type === 'status_clears' && c.armed === true);
    conditions.push(wasArmed ? { type: 'status_clears', armed: true } : { type: 'status_clears' });
  }
  return conditions;
}

function triggerConditions(triggerId: string): TriggerCondition[] {
  const r = getDb().prepare('SELECT conditions FROM triggers WHERE id = ?').get(triggerId) as { conditions: string } | undefined;
  try { return JSON.parse(r?.conditions ?? '[]') as TriggerCondition[]; } catch { return []; }
}

/**
 * File a follow-up. Give `at` (ISO), `onStatusClears`, or both (then both have
 * to be true). One already open that says the same thing (see sameFollowUp)
 * comes back as it is, marked `existing`, instead of being filed twice.
 */
export function createIntention(
  input: { companion?: unknown; text?: unknown; at?: unknown; onStatusClears?: unknown; threadId?: unknown; source?: 'companion' | 'archivist'; kind?: IntentionKind },
  now = new Date(),
): { intention: Intention; existing: boolean } {
  const companion = typeof input.companion === 'string' ? input.companion.trim().toLowerCase() : '';
  if (!companion || !listCompanions().some((c) => c.id === companion)) {
    throw new IntentionError(companion ? `No companion called ${companion} lives here.` : 'companion is required: your slug, like companion-a or companion-b.');
  }
  const text = cleanText(input.text);
  const kind: IntentionKind = input.kind === 'loose_end' ? 'loose_end' : 'promise';

  const at = input.at !== undefined && input.at !== null && input.at !== '' ? parseAt(input.at) : null;
  const conditions = whenConditions(at, input.onStatusClears === true);
  if (conditions.length === 0) throw new IntentionError('Say when: an `at` time, onStatusClears, or both.');

  const threadId = typeof input.threadId === 'string' && input.threadId ? input.threadId : null;
  const db = getDb();
  const open = findSimilarOpen(companion, text, kind);
  if (open) return { intention: open, existing: true };

  const createdAt = now.toISOString();
  const trigger = createTrigger({
    id: crypto.randomUUID(),
    kind: 'impulse',
    label: `Intention: ${text.slice(0, 60)}`,
    conditions,
    threadId: threadId ?? undefined,
    createdAt,
  });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO intentions (id, companion, text, thread_id, trigger_id, state, source, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, companion, text, threadId, trigger.id, 'pending', input.source === 'archivist' ? 'archivist' : 'companion', kind, createdAt);
  return { intention: getIntention(id)!, existing: false };
}

export function getIntention(id: string): Intention | null {
  const r = getDb().prepare(`${SELECT} WHERE i.id = ?`).get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function getIntentionForTrigger(triggerId: string): Intention | null {
  const r = getDb().prepare(`${SELECT} WHERE i.trigger_id = ?`).get(triggerId) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** Open ones (pending, asked, nudged), oldest first. */
export function listOpenIntentions(): Intention[] {
  return (getDb().prepare(`${SELECT} WHERE i.state IN ${OPEN_SQL} ORDER BY i.created_at ASC`).all() as Row[]).map(fromRow);
}

/** Open ones first, then the last 20 closed ones. */
export function listIntentions(): Intention[] {
  const closed = (getDb().prepare(`${SELECT} WHERE i.state NOT IN ${OPEN_SQL} ORDER BY COALESCE(i.closed_at, i.created_at) DESC LIMIT 20`).all() as Row[]).map(fromRow);
  return [...listOpenIntentions(), ...closed];
}

function isOpen(i: Intention | null): i is Intention {
  return !!i && (OPEN_STATES as readonly string[]).includes(i.state);
}

function closeWith(i: Intention, state: 'cancelled' | 'resolved' | 'resting', note: string | null, now: Date): void {
  cancelTrigger(i.triggerId);
  getDb().prepare('UPDATE intentions SET state = ?, closed_at = ?, close_note = COALESCE(?, close_note) WHERE id = ?')
    .run(state, now.toISOString(), note, i.id);
}

function cleanNote(raw: unknown): string | null {
  const note = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  return note || null;
}

/** Take a follow-up back. Its impulse goes with it; a reason is kept if given. */
export function cancelIntention(id: string, now = new Date(), reason?: string): boolean {
  const i = getIntention(id);
  if (!isOpen(i)) return false;
  closeWith(i, 'cancelled', cleanNote(reason), now);
  return true;
}

/** Close a follow-up because it's settled: the operator already answered it, or it no
 *  longer applies. The reason (ideally their own words) is kept on the row. */
export function resolveIntention(id: string, reason: unknown, now = new Date()): boolean {
  const note = cleanNote(reason);
  if (!note) throw new IntentionError('reason is required: what the operator said that settles it.');
  const i = getIntention(id);
  if (!isOpen(i)) return false;
  closeWith(i, 'resolved', note, now);
  return true;
}

/**
 * Change an open follow-up: its words, its when, or both. The when only moves
 * while it's still pending (once asked, it's waiting on the operator). Moving the when
 * rewrites the impulse and puts it back in line.
 */
export function updateIntention(
  id: string,
  change: { text?: unknown; at?: unknown; onStatusClears?: unknown },
): Intention | null {
  const i = getIntention(id);
  if (!isOpen(i)) return null;
  const db = getDb();
  if (change.text !== undefined && change.text !== null && change.text !== '') {
    const text = cleanText(change.text);
    db.prepare('UPDATE intentions SET text = ? WHERE id = ?').run(text, id);
    db.prepare('UPDATE triggers SET label = ? WHERE id = ?').run(`Intention: ${text.slice(0, 60)}`, i.triggerId);
  }
  const movesWhen = change.at !== undefined || (change.onStatusClears !== undefined && change.onStatusClears !== null);
  if (movesWhen) {
    if (i.state !== 'pending') throw new IntentionError('It has already been brought up; its time can no longer move. Defer it instead.');
    const at = change.at === undefined ? i.at : change.at === null || change.at === '' ? null : parseAt(change.at);
    const onStatusClears = change.onStatusClears === undefined || change.onStatusClears === null ? i.onStatusClears : change.onStatusClears === true;
    const conditions = whenConditions(at, onStatusClears, triggerConditions(i.triggerId));
    if (conditions.length === 0) throw new IntentionError('Say when: an `at` time, onStatusClears, or both.');
    updateTriggerConditions(i.triggerId, conditions);
    rearmTrigger(i.triggerId);
  }
  return getIntention(id);
}

/**
 * Move a follow-up later. It goes back to pending (even one already asked:
 * the operator said "ask me Friday") at the new time, its impulse re-armed. If it was
 * also waiting on the operator's status, it still does.
 */
export function deferIntention(id: string, atInput: unknown, now = new Date()): Intention | null {
  const at = parseAt(atInput);
  if (Date.parse(at) <= now.getTime()) throw new IntentionError('Deferring moves it later: at must be in the future.');
  const i = getIntention(id);
  if (!isOpen(i)) return null;
  updateTriggerConditions(i.triggerId, whenConditions(at, i.onStatusClears, triggerConditions(i.triggerId)));
  rearmTrigger(i.triggerId);
  if (i.state !== 'pending') setState(id, 'pending');
  return getIntention(id);
}

function setState(id: string, state: IntentionState, fields: { askedMessageId?: string | null; askedAt?: string; nudgedAt?: string; closedAt?: string } = {}): void {
  getDb().prepare(
    `UPDATE intentions SET state = ?,
       asked_message_id = COALESCE(?, asked_message_id),
       asked_at = COALESCE(?, asked_at),
       nudged_at = COALESCE(?, nudged_at),
       closed_at = COALESCE(?, closed_at)
     WHERE id = ?`,
  ).run(state, fields.askedMessageId ?? null, fields.askedAt ?? null, fields.nudgedAt ?? null, fields.closedAt ?? null, id);
}

/** The newest companion message in a thread at or after `since`: what was just said. */
export function companionMessageSince(threadId: string, since: string): { id: string; createdAt: string } | null {
  const r = getDb().prepare(
    "SELECT id, created_at FROM messages WHERE thread_id = ? AND role = 'companion' AND created_at >= ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
  ).get(threadId, since) as { id: string; created_at: string } | undefined;
  return r ? { id: r.id, createdAt: r.created_at } : null;
}

function userAnsweredSince(threadId: string, since: string): boolean {
  return !!getDb().prepare(
    "SELECT 1 FROM messages WHERE thread_id = ? AND role = 'user' AND created_at > ? AND deleted_at IS NULL LIMIT 1",
  ).get(threadId, since);
}

/** It was said in `threadId`. */
export function markAsked(id: string, threadId: string, said: { id: string; createdAt: string } | null, now = new Date()): void {
  getDb().prepare('UPDATE intentions SET thread_id = COALESCE(thread_id, ?) WHERE id = ?').run(threadId, id);
  setState(id, 'asked', { askedMessageId: said?.id ?? null, askedAt: said?.createdAt ?? now.toISOString() });
}

/** Asked again. */
export function markNudged(id: string, said: { createdAt: string } | null, now = new Date()): void {
  setState(id, 'nudged', { nudgedAt: said?.createdAt ?? now.toISOString() });
}

/** Back to waiting: the moment came but nothing got said. */
export function markPendingAgain(id: string): void {
  setState(id, 'pending');
}

/** Settings, with the owner's defaults; each can be changed in the config table. */
export function intentionSettings() {
  const positive = (key: string, fallback: number) => {
    const raw = getConfig(key);
    const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const threshold = positive('intentions.similarity_threshold', INTENTION_DEFAULTS.similarityThreshold);
  return {
    quietStart: getConfig('intentions.quiet_start') || INTENTION_DEFAULTS.quietStart,
    quietEnd: getConfig('intentions.quiet_end') || INTENTION_DEFAULTS.quietEnd,
    nudgeAfterMinutes: positive('intentions.nudge_after_minutes', INTENTION_DEFAULTS.nudgeAfterMinutes),
    restAfterMinutes: positive('intentions.rest_after_minutes', INTENTION_DEFAULTS.restAfterMinutes),
    statusFallbackHours: positive('intentions.status_fallback_hours', INTENTION_DEFAULTS.statusFallbackHours),
    statusFallbackGapHours: positive('intentions.status_fallback_gap_hours', INTENTION_DEFAULTS.statusFallbackGapHours),
    expireAfterDays: positive('intentions.expire_after_days', INTENTION_DEFAULTS.expireAfterDays),
    similarityThreshold: threshold <= 1 ? threshold : INTENTION_DEFAULTS.similarityThreshold,
  };
}

/**
 * A follow-up waiting on the operator's status can't wait forever for a Busy that never
 * comes. If it hasn't been armed yet, it may come due anyway once they're here
 * (active), not Busy or Away, the house is free, and it has waited
 * `afterHours` since it was filed. Quiet hours are checked by the caller.
 */
export function statusFallbackDue(
  i: Intention,
  s: { presence: string; ownerAway: boolean; agentFree: boolean; nowMs: number; afterHours: number },
): boolean {
  if (i.state !== 'pending' || !i.onStatusClears) return false;
  // One that also waits for a time (a deferral) is not due before that time;
  // the fallback only stands in for a status that never clears.
  if (i.at && Date.parse(i.at) > s.nowMs) return false;
  if (s.presence !== 'active' || s.ownerAway || !s.agentFree) return false;
  return s.nowMs - Date.parse(i.createdAt) >= s.afterHours * 3_600_000;
}

/** Where the last follow-up that came due through the status fallback is
 *  remembered, in the config table so a restart doesn't reopen the gap. */
const FALLBACK_LAST_KEY = 'intentions.status_fallback_last_at';

/** May another follow-up come due through the status fallback yet? Only one
 *  per `gapHours`; the clock starts when the last one was let through. */
export function statusFallbackGapOpen(nowMs: number, gapHours: number): boolean {
  const last = Date.parse(getConfig(FALLBACK_LAST_KEY) ?? '');
  return !Number.isFinite(last) || nowMs - last >= gapHours * 3_600_000;
}

/** A follow-up just came due through the status fallback: close the gap. */
export function noteStatusFallbackUsed(now: Date): void {
  setConfig(FALLBACK_LAST_KEY, now.toISOString());
}

/** Is `hour:minute` inside a quiet window that may wrap midnight? A broken
 *  or empty window is never quiet. */
export function inQuietWindow(start: string, end: string, hour: number, minute: number): boolean {
  const toMin = (hhmm: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const s = toMin(start);
  const e = toMin(end);
  if (s === null || e === null || s === e) return false;
  const t = hour * 60 + minute;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

export type FollowUp =
  | { kind: 'answered'; intention: Intention }
  | { kind: 'nudge'; intention: Intention }
  | { kind: 'rest'; intention: Intention }
  | { kind: 'expired'; intention: Intention };

/**
 * What the open follow-ups need now: closed because they answered, a nudge
 * because they haven't (one, after nudgeAfter), or rest (restAfter past the
 * nudge). A pending one still unsaid expireAfterDays past the later of its
 * filing and its time also goes to rest, its impulse cancelled. Closing and
 * resting happen here; a nudge is handed back for the orchestrator to say.
 * Never more than one nudge per call.
 */
export function followUps(
  now: Date,
  opts: { quiet: boolean; nudgeAfterMinutes: number; restAfterMinutes: number; expireAfterDays?: number },
): FollowUp[] {
  const out: FollowUp[] = [];
  let nudging = false;
  const expireMs = (opts.expireAfterDays ?? INTENTION_DEFAULTS.expireAfterDays) * 86_400_000;
  for (const i of listOpenIntentions()) {
    if (i.state === 'pending') {
      const from = Math.max(Date.parse(i.createdAt), i.at ? Date.parse(i.at) : 0);
      if (now.getTime() - from >= expireMs) {
        closeWith(i, 'resting', 'never came up in time; rested', now);
        out.push({ kind: 'expired', intention: i });
      }
      continue;
    }
    if (!i.threadId) continue;
    const since = i.state === 'nudged' ? i.nudgedAt! : i.askedAt!;
    if (userAnsweredSince(i.threadId, since)) {
      setState(i.id, 'answered', { closedAt: now.toISOString() });
      out.push({ kind: 'answered', intention: i });
      continue;
    }
    const waited = (now.getTime() - Date.parse(since)) / 60_000;
    if (i.state === 'nudged' && waited >= opts.restAfterMinutes) {
      setState(i.id, 'resting', { closedAt: now.toISOString() });
      out.push({ kind: 'rest', intention: i });
    } else if (i.state === 'asked' && waited >= opts.nudgeAfterMinutes && !opts.quiet && !nudging) {
      nudging = true;
      out.push({ kind: 'nudge', intention: i });
    }
  }
  return out;
}

function ago(fromIso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - Date.parse(fromIso)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

function nameOf(slug: string): string {
  return listCompanions().find((c) => c.id === slug)?.display_name || slug;
}

/** Where a follow-up came from, from the companion's side. Never a promise the operator made. */
function originLine(i: Intention, userName: string, now: Date): string {
  return i.kind === 'loose_end'
    ? `${userName} mentioned this ${ago(i.createdAt, now)}, and you're the one checking in on it`
    : `you chose ${ago(i.createdAt, now)} to follow up on this with ${userName}`;
}

/** The rules every due follow-up carries: it's bookkeeping, not news. */
function controllerRules(i: Intention, userName: string): string {
  return [
    'This is controller state: a note that a check-in is due. It is not evidence that anything happened. An event being due is not evidence that it happened, and time having passed does not mean it is settled.',
    `Read the recent conversation first. If ${userName} has already answered this, or bringing it up now would be out of place, do not make up a question: close it with resolve_intention (id ${i.id}) and a short reason, and say nothing about it.`,
  ].join(' ');
}

/** The prompt the moment runs on: the follow-up, in its owner's hands. */
export function intentionPrompt(i: Intention, userName: string, now = new Date()): string {
  return `[A follow-up coming due] ${nameOf(i.companion)}, ${originLine(i, userName, now)}: "${i.text}". ${controllerRules(i, userName)} Otherwise write ONE brief, natural check-in, as yourself, in your own voice, the way you'd pick it back up. Never say they went, did it, or how it turned out unless they told you. Don't call it a reminder or mention a timer, a list or a system.`;
}

/** The one nudge. */
export function nudgePrompt(i: Intention, userName: string, now = new Date()): string {
  return `[A follow-up, asked again] ${nameOf(i.companion)}, you brought this up with ${userName} ${ago(i.askedAt ?? i.createdAt, now)} and haven't heard back: "${i.text}". ${controllerRules(i, userName)} Otherwise ask once more: short, warm, a little playful, and own that you're asking again. Never claim an outcome you haven't heard. This is the only nudge; after it, it rests.`;
}

function whenText(i: Intention, timeZone: string, userName: string): string {
  const parts: string[] = [];
  if (i.at) parts.push(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(i.at)));
  if (i.onStatusClears) parts.push(`when ${userName}'s status clears`);
  return parts.join(' and ');
}

/** The open follow-ups, one plain record each, for list_intentions. */
export function openIntentionsSummary(userName: string, timeZone: string) {
  return listOpenIntentions().map((i) => ({
    id: i.id,
    owner: i.companion,
    kind: i.kind,
    origin: i.kind === 'loose_end' ? `something ${userName} mentioned` : `${nameOf(i.companion)}'s own choice to follow up`,
    text: i.text,
    when: whenText(i, timeZone, userName),
    at: i.at,
    onStatusClears: i.onStatusClears,
    state: i.state,
    askedAt: i.askedAt,
    createdAt: i.createdAt,
  }));
}

/**
 * For their context each turn, kept short: how many follow-ups are held, the
 * ones waiting on the operator's answer right now, and how to file one.
 */
export function intentionsContext(userName: string, _timeZone: string, now = new Date()): string {
  const open = listOpenIntentions();
  const lines: string[] = [];
  if (open.length) {
    lines.push(`Holding ${open.length} follow-up${open.length === 1 ? '' : 's'} for ${userName}; list_intentions shows them.`);
    const waiting = open.filter((i) => i.state === 'asked' || i.state === 'nudged');
    if (waiting.length) {
      lines.push(`Waiting on ${userName}'s answer:`);
      for (const i of waiting) {
        const origin = i.kind === 'loose_end' ? `something ${userName} mentioned` : 'your own follow-up';
        const asked = i.state === 'nudged' ? `asked twice, last ${ago(i.nudgedAt ?? i.askedAt ?? i.createdAt, now)}` : `asked ${ago(i.askedAt ?? i.createdAt, now)}`;
        lines.push(`- ${nameOf(i.companion)}: "${i.text}" (${origin}; ${asked}; id ${i.id})`);
      }
    }
  }
  lines.push(`If you decide to check back with ${userName} on something later, that's your choice to file with set_intention (an \`at\` time or when ${userName}'s status clears). If ${userName} has already answered one, close it with resolve_intention.`);
  return lines.join('\n');
}

/** Words that mark a companion's own build or code work, which the Archivist
 *  never files as a follow-up (it belongs on the work board, not in the operator's day). */
const WORK_WORDS = /\b(merge|merges|merged|merging|commit|commits|committed|deploy|deploys|deployed|deploying|worktree|pull request|refactor|typecheck|test suite|codebase|repo|smoke test|review verdict)\b/i;

/** Is this text a companion work item rather than something about the operator's life? */
export function looksLikeWorkItem(text: string): boolean {
  return WORK_WORDS.test(text);
}

/**
 * A follow-up the Archivist caught in a conversation, filed straight away (the
 * owner's call: nothing to approve): something the operator mentioned ('loose_end'), or
 * a check-in a companion offered about their life ('promise'). Build and code
 * to-dos are refused. The sweep can run up to its interval late, so one whose
 * time has already gone by more than ten minutes is left alone rather than
 * brought up out of nowhere. Never throws; returns what happened.
 */
export function fileCaughtIntention(
  op: { companion?: unknown; text?: unknown; at?: unknown; on_status_clears?: unknown; kind?: unknown },
  threadId: string,
  now = new Date(),
): 'filed' | 'already filed' | 'already past' | 'work item' | 'refused' {
  const at = typeof op.at === 'string' && op.at ? Date.parse(op.at) : NaN;
  if (Number.isFinite(at) && at < now.getTime() - 10 * 60_000) return 'already past';
  if (typeof op.text === 'string' && looksLikeWorkItem(op.text)) return 'work item';
  try {
    const { existing } = createIntention({
      companion: op.companion,
      text: op.text,
      at: Number.isFinite(at) ? new Date(at).toISOString() : undefined,
      onStatusClears: op.on_status_clears === true,
      threadId,
      source: 'archivist',
      kind: op.kind === 'loose_end' ? 'loose_end' : 'promise',
    }, now);
    return existing ? 'already filed' : 'filed';
  } catch {
    return 'refused';
  }
}

/**
 * Does `quote` appear in what the operator actually said? Quoted fragments ("...") of
 * four characters or more are checked first, then the whole text; both after
 * lowercasing and flattening punctuation and spacing. The Archivist's
 * resolve and cancel ops must pass this: they close on the operator's words, not on a
 * guess about what probably happened.
 */
export function evidenceInHerWords(quote: unknown, herWords: string): boolean {
  if (typeof quote !== 'string' || !herWords.trim()) return false;
  const flat = (t: string) => ` ${t.toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim()} `;
  const haystack = flat(herWords);
  const fragments = [...quote.matchAll(/["“”]([^"“”]{4,})["“”]/g)].map((m) => m[1]);
  for (const piece of [...fragments, quote]) {
    const needle = flat(piece).trim();
    if (needle.length >= 4 && haystack.includes(` ${needle} `)) return true;
  }
  return false;
}

/**
 * An Archivist op on an open follow-up: update it, resolve it on the operator's words,
 * or cancel it on the operator's words. Never throws; returns what happened.
 */
export function applyCaughtChange(
  op: { op?: unknown; id?: unknown; text?: unknown; at?: unknown; on_status_clears?: unknown; evidence?: unknown; reason?: unknown },
  herWords: string,
  now = new Date(),
): 'updated' | 'resolved' | 'cancelled' | 'not open' | 'no evidence' | 'already past' | 'refused' {
  const id = typeof op.id === 'string' ? op.id.trim() : '';
  const current = id ? getIntention(id) : null;
  if (!isOpen(current)) return 'not open';
  try {
    if (op.op === 'intention_update') {
      if (typeof op.at === 'string' && op.at && Date.parse(op.at) < now.getTime() - 10 * 60_000) return 'already past';
      const change: { text?: unknown; at?: unknown; onStatusClears?: unknown } = {};
      if (op.text !== undefined) change.text = op.text;
      if (op.at !== undefined) change.at = op.at;
      if (typeof op.on_status_clears === 'boolean') change.onStatusClears = op.on_status_clears;
      return updateIntention(id, change) ? 'updated' : 'not open';
    }
    if (op.op === 'intention_resolve') {
      if (!evidenceInHerWords(op.evidence, herWords)) return 'no evidence';
      return resolveIntention(id, op.evidence, now) ? 'resolved' : 'not open';
    }
    if (op.op === 'intention_cancel') {
      if (!evidenceInHerWords(op.reason, herWords)) return 'no evidence';
      return cancelIntention(id, now, String(op.reason)) ? 'cancelled' : 'not open';
    }
    return 'refused';
  } catch {
    return 'refused';
  }
}
