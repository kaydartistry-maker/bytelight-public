/**
 * Intentions (migrations/045_intentions.sql): a promise Companion A or Companion B made
 * her ("I'll ask how the meeting went", "dentist Monday 2:30"), kept until it's
 * said and she's answered.
 *
 * The "when" is an impulse (services/db/triggers.ts): an `after` time, her
 * status clearing, or both. Impulses already wait their turn when the house
 * is busy instead of dropping, which timers don't. This row is the promise
 * riding it; the orchestrator fires it in the promiser's own voice, closes it
 * when she answers in that thread, nudges once if she doesn't, then lets it
 * rest. Nothing fires or nudges inside the intentions' quiet hours.
 *
 * Idea from Myosia's intentions. Its code is proprietary; this is ours.
 */

import crypto from 'crypto';
import { getDb } from './init.js';
import { getConfig } from './config.js';
import { listCompanions } from './rooms.js';
import { cancelTrigger, createTrigger, type TriggerCondition } from './triggers.js';

export type IntentionState = 'pending' | 'asked' | 'nudged' | 'answered' | 'resting' | 'cancelled';

export interface Intention {
  id: string;
  companion: string;
  text: string;
  threadId: string | null;
  triggerId: string;
  state: IntentionState;
  /** 'companion' (filed live) or 'archivist' (caught on the sweep). */
  source: 'companion' | 'archivist';
  askedMessageId: string | null;
  askedAt: string | null;
  nudgedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  /** From the impulse: the time it waits for, and whether it waits on her status. */
  at: string | null;
  onStatusClears: boolean;
}

export const INTENTION_TEXT_MAX = 300;

/** The operator's choices: quiet 3–9 AM, one nudge a day later, then rest a day after that. */
export const INTENTION_DEFAULTS = {
  quietStart: '03:00',
  quietEnd: '09:00',
  nudgeAfterMinutes: 24 * 60,
  restAfterMinutes: 24 * 60,
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
    askedMessageId: r.asked_message_id,
    askedAt: r.asked_at,
    nudgedAt: r.nudged_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    at,
    onStatusClears,
  };
}

/**
 * File a promise. Give `at` (ISO), `onStatusClears`, or both (then both have
 * to be true). The same promise from the same companion, still open, comes
 * back as it is instead of being filed twice.
 */
export function createIntention(
  input: { companion?: unknown; text?: unknown; at?: unknown; onStatusClears?: unknown; threadId?: unknown; source?: 'companion' | 'archivist' },
  now = new Date(),
): { intention: Intention; existing: boolean } {
  const companion = typeof input.companion === 'string' ? input.companion.trim().toLowerCase() : '';
  if (!companion || !listCompanions().some((c) => c.id === companion)) {
    throw new IntentionError(companion ? `No companion called ${companion} lives here.` : 'companion is required: your slug, like companion-a or companion-b.');
  }
  const text = typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new IntentionError('text is required: what you promised, in a sentence.');
  if (text.length > INTENTION_TEXT_MAX) throw new IntentionError(`Keep it to ${INTENTION_TEXT_MAX} characters.`);

  const conditions: TriggerCondition[] = [];
  if (input.at !== undefined && input.at !== null && input.at !== '') {
    const at = typeof input.at === 'string' ? Date.parse(input.at) : NaN;
    if (!Number.isFinite(at)) throw new IntentionError('at must be a date and time (ISO 8601).');
    conditions.push({ type: 'after', at: new Date(at).toISOString() });
  }
  if (input.onStatusClears === true) conditions.push({ type: 'status_clears' });
  if (conditions.length === 0) throw new IntentionError('Say when: an `at` time, onStatusClears, or both.');

  const threadId = typeof input.threadId === 'string' && input.threadId ? input.threadId : null;
  const db = getDb();
  const open = db.prepare(`${SELECT} WHERE i.companion = ? AND lower(i.text) = lower(?) AND i.state IN ('pending', 'asked', 'nudged')`).get(companion, text) as Row | undefined;
  if (open) return { intention: fromRow(open), existing: true };

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
  db.prepare('INSERT INTO intentions (id, companion, text, thread_id, trigger_id, state, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, companion, text, threadId, trigger.id, 'pending', input.source === 'archivist' ? 'archivist' : 'companion', createdAt);
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
  return (getDb().prepare(`${SELECT} WHERE i.state IN ('pending', 'asked', 'nudged') ORDER BY i.created_at ASC`).all() as Row[]).map(fromRow);
}

/** Open ones first, then the last 20 closed ones. */
export function listIntentions(): Intention[] {
  const closed = (getDb().prepare(`${SELECT} WHERE i.state NOT IN ('pending', 'asked', 'nudged') ORDER BY COALESCE(i.closed_at, i.created_at) DESC LIMIT 20`).all() as Row[]).map(fromRow);
  return [...listOpenIntentions(), ...closed];
}

/** Take a promise back. Its impulse goes with it. */
export function cancelIntention(id: string, now = new Date()): boolean {
  const i = getIntention(id);
  if (!i || !['pending', 'asked', 'nudged'].includes(i.state)) return false;
  cancelTrigger(i.triggerId);
  getDb().prepare("UPDATE intentions SET state = 'cancelled', closed_at = ? WHERE id = ?").run(now.toISOString(), id);
  return true;
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

/** Settings, with the operator's defaults; each can be changed in the config table. */
export function intentionSettings() {
  const minutes = (key: string, fallback: number) => {
    const n = Number(getConfig(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    quietStart: getConfig('intentions.quiet_start') || INTENTION_DEFAULTS.quietStart,
    quietEnd: getConfig('intentions.quiet_end') || INTENTION_DEFAULTS.quietEnd,
    nudgeAfterMinutes: minutes('intentions.nudge_after_minutes', INTENTION_DEFAULTS.nudgeAfterMinutes),
    restAfterMinutes: minutes('intentions.rest_after_minutes', INTENTION_DEFAULTS.restAfterMinutes),
  };
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
  | { kind: 'rest'; intention: Intention };

/**
 * What the open promises need now: closed because she answered, a nudge
 * because she hasn't (one, after nudgeAfter), or rest (restAfter past the
 * nudge). Closing and resting happen here; a nudge is handed back for the
 * orchestrator to say. Never more than one nudge per call.
 */
export function followUps(now: Date, opts: { quiet: boolean; nudgeAfterMinutes: number; restAfterMinutes: number }): FollowUp[] {
  const out: FollowUp[] = [];
  let nudging = false;
  for (const i of listOpenIntentions()) {
    if (i.state === 'pending' || !i.threadId) continue;
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

/** The prompt the moment runs on: the promise, in the promiser's hands. */
export function intentionPrompt(i: Intention, userName: string, now = new Date()): string {
  return `[A promise coming due] ${nameOf(i.companion)}, you told ${userName} ${ago(i.createdAt, now)}: "${i.text}". It's time. Bring it to her now as yourself, in your own voice, the way you'd naturally pick it back up. Don't call it a reminder or mention a timer or a system.`;
}

/** The one nudge. */
export function nudgePrompt(i: Intention, userName: string, now = new Date()): string {
  return `[A promise, asked again] ${nameOf(i.companion)}, you brought this up with ${userName} ${ago(i.askedAt ?? i.createdAt, now)} and she hasn't answered: "${i.text}". Ask once more: short, warm, a little playful, and own that you're asking again. This is the only nudge; after it, it rests.`;
}

/** For their context each turn: what they're holding for her. */
export function intentionsContext(userName: string, timeZone: string): string {
  const open = listOpenIntentions();
  const lines: string[] = [];
  if (open.length) {
    const when = (i: Intention) => {
      const parts: string[] = [];
      if (i.at) parts.push(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(i.at)));
      if (i.onStatusClears) parts.push('when her status clears');
      return parts.join(' and ');
    };
    lines.push(`Promises you're holding for ${userName}:`);
    for (const i of open) {
      const state = i.state === 'pending' ? when(i) : i.state === 'asked' ? 'asked, waiting on her' : 'nudged once, waiting on her';
      lines.push(`- ${i.companion}: "${i.text}" (${state}${i.source === 'archivist' ? '; caught by the Archivist' : ''})`);
    }
  }
  lines.push('When you promise her something with a when ("I\'ll ask how the meeting went", "dentist Monday 2:30"), file it with set_intention or `sc intention`. It comes back to you when it\'s due.');
  return lines.join('\n');
}

/**
 * A promise the Archivist caught in a conversation, filed straight away (the operator's
 * call: nothing to approve). The sweep can run up to its interval late, so a
 * promise whose time has already gone by more than ten minutes is left alone
 * rather than brought up out of nowhere. Never throws; returns what happened.
 */
export function fileCaughtIntention(
  op: { companion?: unknown; text?: unknown; at?: unknown; on_status_clears?: unknown },
  threadId: string,
  now = new Date(),
): 'filed' | 'already filed' | 'already past' | 'refused' {
  const at = typeof op.at === 'string' && op.at ? Date.parse(op.at) : NaN;
  if (Number.isFinite(at) && at < now.getTime() - 10 * 60_000) return 'already past';
  try {
    const { existing } = createIntention({
      companion: op.companion,
      text: op.text,
      at: Number.isFinite(at) ? new Date(at).toISOString() : undefined,
      onStatusClears: op.on_status_clears === true,
      threadId,
      source: 'archivist',
    }, now);
    return existing ? 'already filed' : 'filed';
  } catch {
    return 'refused';
  }
}
