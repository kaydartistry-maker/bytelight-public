/**
 * Turn leases (migrations/044_turn_leases.sql): a phone message isn't lost
 * when a restart cuts its turn off.
 *
 * Her message is stored before its turn runs, but the turn itself waits in an
 * in-memory queue, and shutdown aborts whatever is running. Before this, a
 * pm2 restart mid-reply left half a sentence (or nothing) and no one owed her
 * the rest. Now ws.ts writes a lease when the turn is handed off and releases
 * it when the turn ends any normal way (answered, errored, or her Stop). Once
 * shutdown has begun, releasing does nothing, so a turn the restart cut off
 * keeps its lease; so does one a hard crash took. On boot each lease gets
 * retried once more, at most twice in all, and only within the hour.
 *
 * Idea from Myosia's crash journal. Its code is proprietary; this is ours.
 */

import crypto from 'crypto';
import { getDb } from './init.js';

/** Past this a cut-off message is left alone rather than answered out of nowhere. */
export const LEASE_MAX_AGE_MS = 60 * 60_000;
/** Retries a lease gets after restarts, so one bad message can't loop us. */
export const LEASE_MAX_ATTEMPTS = 2;

export interface TurnLease {
  id: string;
  threadId: string;
  userMessageId: string;
  prompt: string;
  hadImages: boolean;
  attempts: number;
  createdAt: string;
}

interface Row {
  id: string;
  thread_id: string;
  user_message_id: string;
  prompt: string;
  had_images: number;
  attempts: number;
  created_at: string;
}

let holding = false;

/** Shutdown has begun: from here on leases stay, because the turns still
 *  running are about to be cut off. */
export function holdTurnLeases(): void {
  holding = true;
}

/** For tests: back to releasing normally. */
export function resetTurnLeaseHold(): void {
  holding = false;
}

export function leaseTurn(input: { threadId: string; userMessageId: string; prompt: string; hadImages?: boolean }, now = new Date()): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare('INSERT INTO turn_leases (id, thread_id, user_message_id, prompt, had_images, attempts, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run(id, input.threadId, input.userMessageId, input.prompt, input.hadImages ? 1 : 0, now.toISOString());
  return id;
}

/** The turn ended. Kept instead when shutdown cut it off. */
export function releaseTurn(id: string): void {
  if (holding) return;
  getDb().prepare('DELETE FROM turn_leases WHERE id = ?').run(id);
}

/**
 * The leases left from before this boot that are worth one more try, oldest
 * first, each with its attempt counted already (so a crash during the retry
 * still counts). Stale and worn-out leases are dropped here.
 */
export function takeCutOffTurns(now = new Date()): TurnLease[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM turn_leases ORDER BY created_at ASC').all() as Row[];
  const keep: TurnLease[] = [];
  for (const r of rows) {
    const age = now.getTime() - Date.parse(r.created_at);
    if (!(age < LEASE_MAX_AGE_MS) || r.attempts >= LEASE_MAX_ATTEMPTS) {
      db.prepare('DELETE FROM turn_leases WHERE id = ?').run(r.id);
      continue;
    }
    db.prepare('UPDATE turn_leases SET attempts = attempts + 1 WHERE id = ?').run(r.id);
    keep.push({
      id: r.id,
      threadId: r.thread_id,
      userMessageId: r.user_message_id,
      prompt: r.prompt,
      hadImages: r.had_images === 1,
      attempts: r.attempts + 1,
      createdAt: r.created_at,
    });
  }
  return keep;
}

function ago(fromIso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - Date.parse(fromIso)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'moments ago';
  return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
}

/** The prompt a retry runs on: what happened, then her message as it was. */
export function cutOffPrompt(lease: TurnLease, userName: string, now = new Date()): string {
  const lines = [
    `[byte-light restarted while you were answering ${userName}'s message below (sent ${ago(lease.createdAt, now)}). Anything you'd already said is in the chat above: pick up from there and don't repeat it. If you'd actually finished, a short word that you're back is enough.]`,
  ];
  if (lease.hadImages) {
    lines.push(`[She sent pictures with it. They aren't attached on this retry; ask for them again if you need them.]`);
  }
  lines.push('', lease.prompt);
  return lines.join('\n');
}
