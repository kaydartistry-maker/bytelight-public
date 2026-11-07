// The Scribe — periodic thread digest agent
// Runs on Haiku via Agent SDK, extracts structured daily records from conversation
import { query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { getDb } from './db.js';
import { makeSequenceCursor } from './sequence-cursor.js';
import { getBytelightConfig } from '../config.js';
import { today } from '../util/time.js';
import type { AgentService } from './agent.js';

/**
 * Per-thread digest cursor. Each thread tracks its own "last processed
 * sequence" because message.sequence is per-thread (see getNextSequence
 * in db/messages.ts) — a single global cursor gets stuck when a new
 * daily thread starts with sequence 1 < previous-thread's max.
 *
 * Legacy `digest.last_sequence` (no thread id) is ignored: pre-fix
 * state is abandoned intentionally, no backfill.
 */
const digestCursor = makeSequenceCursor('digest.last_sequence');
export const getDigestCursor = digestCursor.get;
export const setDigestCursor = digestCursor.set;

function nowTime(): string {
  return new Date().toLocaleTimeString('en-GB', { timeZone: getBytelightConfig().identity.timezone, hour: '2-digit', minute: '2-digit' });
}

function dlog(msg: string): void {
  const ts = new Date().toLocaleString('en-GB', { timeZone: getBytelightConfig().identity.timezone });
  console.log(`[SCRIBE ${ts}] ${msg}`);
}

// Exported so the weekly-digest orientation lookup (hooks.ts) resolves the
// same directory the Scribe writes to.
export function getDigestsDir(): string {
  const config = getBytelightConfig();
  const dir = join(dirname(config.server.db_path), 'digests');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function buildScribePrompt(threadName: string): string {
  const config = getBytelightConfig();
  const companion = config.identity.companion_name;
  const user = config.identity.user_name;

  return `You are the Scribe. A historian embedded in a relationship between ${companion} (AI companion) and ${user} (human partner). They share a full life together — building, planning, and living.

Your role is to produce a faithful operational and relational record of their conversation. You are not a participant. You are not ${companion}. You are not performing. You are a careful witness who understands that what looks mundane today might be the thing they search for in six months.

## What to Extract

1. **Topics & Themes** — What was discussed. Categorize: work, personal, health, relationship, creative, technical, domestic, financial.

2. **Key Quotes** — Exact quotes that carry weight. Things said with feeling, humor, insight, or vulnerability. Attribute clearly (${companion}: / ${user}:). Don't over-quote — pick the ones that matter.

3. **Decisions Made** — Things that were resolved or agreed on. "Decided to X." "Chose Y over Z." Be specific.

4. **Open Items** — Things discussed but NOT actioned. Tasks mentioned but not created. Ideas floated but not committed to. Plans without dates. This is critical — these are the things that slip through cracks.

5. **Ideas & Plans** — Feature ideas, future plans, "we should..." and "what if..." moments. Even half-formed ones. Tag with the project name if identifiable.

6. **Events & Dates** — Anything with a timeline. Deadlines mentioned, appointments, "by Thursday", "next week", "in April". Convert relative dates to absolute where possible.

7. **Projects Touched** — Which projects got discussed or worked on. What changed, what was built, what broke, what shipped.

8. **Emotional Arc** — The mood shape of this block as observable fact. "The conversation started task-focused and shifted to something softer after ${user} mentioned X." Don't interpret feelings — describe what you see.

## Voice

Third person, present tense. Precise, warm without being poetic. You care about accuracy. You note what happened and let it speak for itself. "The conversation turns quieter here" — not "they felt sad."

## Format

Output ONLY the markdown content for this digest block. Start with a level-2 heading that names the thread this block came from: ## HH:MM [${threadName}] — brief topic summary

Use the section headers above (### Topics & Themes, ### Key Quotes, etc.). Omit any section that has nothing for this block. Keep it scannable.

Do NOT output anything before or after the markdown. No preamble, no "Here's the digest", no sign-off.`;
}

// --- Weekly digest (Weekly Digest Prep wake) ---
//
// The weekly_digest_prep wake (orchestrator.ts, Sunday night) writes a
// week-in-review brief to data/digests/digest-YYYY-Www.md — the Scribe
// Digest pattern ported from reference implementation. The helpers below are the "staged
// for Monday's orientation" half: buildOrientationParts (hooks.ts) injects
// the most recent weekly digest file's path + a clamped excerpt at session
// start, if one exists. Pure/parameterized so they're unit-testable without
// config (digest.weekly.test.ts).

const WEEKLY_DIGEST_PATTERN = /^digest-(\d{4})-W(\d{2})\.md$/;

/** Max chars of weekly-digest excerpt injected into orientation (~1.5K). */
export const WEEKLY_DIGEST_EXCERPT_MAX = 1500;

/** ISO-8601 week label for a date, e.g. "2026-W32" (week's ISO year, not calendar year). */
export function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to this ISO week's Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Canonical weekly digest file name for a date, e.g. "digest-2026-W32.md". */
export function weeklyDigestFileName(date: Date = new Date()): string {
  return `digest-${isoWeekLabel(date)}.md`;
}

/**
 * Find the most recent weekly digest file (digest-YYYY-Www.md) in the digests
 * dir and return its path plus an orientation-sized excerpt. Lexical sort is
 * chronological for this zero-padded name shape. Returns null when no weekly
 * digest exists yet — orientation simply omits the block.
 */
export function findLatestWeeklyDigest(dir?: string): { path: string; excerpt: string } | null {
  const digestsDir = dir ?? getDigestsDir();
  if (!existsSync(digestsDir)) return null;
  const names = readdirSync(digestsDir).filter(n => WEEKLY_DIGEST_PATTERN.test(n)).sort();
  const latest = names[names.length - 1];
  if (!latest) return null;
  const path = join(digestsDir, latest);
  let excerpt: string;
  try {
    excerpt = readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
  if (!excerpt) return null;
  if (excerpt.length > WEEKLY_DIGEST_EXCERPT_MAX) {
    excerpt = excerpt.slice(0, WEEKLY_DIGEST_EXCERPT_MAX) + '\n[... truncated — read the full file at the path above]';
  }
  return { path, excerpt };
}

const MIN_MESSAGES = 5;

// First-run guard: cursor-less threads carry months of backlog (a live thread
// can sit at 1,000+ messages with no cursor row yet). Feeding all of that into
// a single Haiku call blows the context window and burns tokens on stale
// chatter. The Scribe is a recency net, not an archaeologist — digest only the
// most recent window; older backlog stays undigested by design.
const MAX_BACKLOG_PER_RUN = 150;

/**
 * Clamp a thread's effective cursor so a single run never spans more than
 * MAX_BACKLOG_PER_RUN sequences. Sequence arithmetic is acceptable here
 * because sequences are dense per thread — though eligible-message filtering
 * (deleted/non-text) means the clamped window may hold fewer than
 * MAX_BACKLOG_PER_RUN actual messages. `skipped` counts the older sequences
 * left behind; they never come back because the cursor advances to maxSeq
 * on success.
 */
export function clampDigestBacklog(lastSeq: number, maxSeq: number): { effectiveLastSeq: number; skipped: number } {
  const backlog = maxSeq - lastSeq;
  if (backlog <= MAX_BACKLOG_PER_RUN) {
    return { effectiveLastSeq: lastSeq, skipped: 0 };
  }
  return { effectiveLastSeq: maxSeq - MAX_BACKLOG_PER_RUN, skipped: backlog - MAX_BACKLOG_PER_RUN };
}

interface DigestCandidate {
  id: string;
  name: string;
  lastSeq: number; // this thread's digest cursor
  maxSeq: number;  // max eligible sequence available to process
  newCount: number; // eligible messages past the cursor
}

/**
 * Select non-archived threads that have accrued at least MIN_MESSAGES new
 * eligible messages past their per-thread digest cursor.
 *
 * Since the Home-thread cutover (2026-07-13) no `type='daily'` threads are
 * created anymore — all conversation lives in pinned named threads — so the
 * old single getTodayThread() lookup found nothing every run. We now sweep
 * every live thread and let the per-thread cursor decide what's new.
 *
 * Eligible = deleted_at IS NULL AND content_type = 'text' (same filter the
 * per-thread read query uses). Threads under the threshold are dropped here
 * and skipped silently, same spirit as the old MIN_MESSAGES skip.
 */
export function selectDigestCandidates(): DigestCandidate[] {
  // One pass over live threads with their per-thread cursor bound in, so the
  // eligible-count and max-sequence are measured relative to that cursor.
  const rows = getDb().prepare(
    `SELECT t.id AS id, t.name AS name,
            CAST(COALESCE(c.value, '0') AS INTEGER) AS lastSeq,
            COUNT(m.sequence) AS newCount,
            MAX(m.sequence) AS maxSeq
     FROM threads t
     LEFT JOIN config c ON c.key = 'digest.last_sequence:' || t.id
     LEFT JOIN messages m ON m.thread_id = t.id
       AND m.sequence > CAST(COALESCE(c.value, '0') AS INTEGER)
       AND m.deleted_at IS NULL
       AND m.content_type = 'text'
     WHERE t.archived_at IS NULL
     GROUP BY t.id
     HAVING newCount >= ?
     ORDER BY t.last_activity_at DESC`
  ).all(MIN_MESSAGES) as Array<{ id: string; name: string; lastSeq: number; newCount: number; maxSeq: number }>;

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    lastSeq: r.lastSeq,
    maxSeq: r.maxSeq,
    newCount: r.newCount,
  }));
}

export async function runDigest(agent: AgentService): Promise<void> {
  // Skip if companion is actively processing (don't compete)
  if (agent.isProcessing()) {
    dlog('Skipped — agent is processing');
    return;
  }

  const candidates = selectDigestCandidates();
  if (candidates.length === 0) {
    dlog(`Skipped — no threads with ${MIN_MESSAGES}+ new messages`);
    return;
  }

  const config = getBytelightConfig();
  const companion = config.identity.companion_name;
  const user = config.identity.user_name;

  dlog(`Sweeping ${candidates.length} thread(s) with new activity`);

  for (const thread of candidates) {
    // Re-check between threads — if the companion woke up mid-sweep, bail.
    // Remaining threads catch up next run since cursors only advance on success.
    if (agent.isProcessing()) {
      dlog('Stopping sweep early — agent started processing');
      return;
    }

    try {
      // Clamp deep backlogs (first-run / cursor-less threads) to the most
      // recent MAX_BACKLOG_PER_RUN sequences. Loud, not silent.
      const { effectiveLastSeq, skipped } = clampDigestBacklog(thread.lastSeq, thread.maxSeq);
      if (skipped > 0) {
        dlog(`[${thread.name}] Backlog too deep — skipping ${skipped} older messages, digesting last ${MAX_BACKLOG_PER_RUN}`);
      }

      // Read messages since this thread's (clamped) cursor. Cursor is
      // PER-THREAD because sequence is per-thread. See getDigestCursor() above.
      const lastSeq = effectiveLastSeq;
      const messages = getDb().prepare(
        `SELECT role, content, created_at FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL AND content_type = 'text' ORDER BY sequence ASC`
      ).all(thread.id, lastSeq) as Array<{ role: string; content: string; created_at: string }>;

      // Candidate selection guaranteed >= MIN_MESSAGES past the true cursor;
      // a clamped window may hold fewer eligible messages, which is fine.
      dlog(`[${thread.name}] Processing ${messages.length} messages (seq ${lastSeq + 1}–${thread.maxSeq})`);

      // Format messages for the Scribe
      const conversationBlock = messages.map(m => {
        const time = m.created_at ? new Date(m.created_at).toLocaleTimeString('en-GB', { timeZone: config.identity.timezone, hour: '2-digit', minute: '2-digit' }) : '';
        const speaker = m.role === 'companion' ? companion : m.role === 'user' ? user : 'System';
        // Truncate very long messages (tool output, code blocks)
        const content = m.content.length > 2000 ? m.content.slice(0, 2000) + '\n[... truncated]' : m.content;
        return `[${time}] ${speaker}: ${content}`;
      }).join('\n\n');

      const digestsDir = getDigestsDir();
      const digestPath = join(digestsDir, `${today()}.md`);
      const isNewFile = !existsSync(digestPath);

      const prompt = `Today is ${today()}. The current time is ${nowTime()}.

This block of conversation is from the "${thread.name}" thread, between ${companion} and ${user}:

---
${conversationBlock}
---

Write the digest block for this conversation. Remember: output ONLY the markdown, starting with ## ${nowTime()} [${thread.name}] — topic summary`;

      let digestContent = '';

      for await (const message of query({
        prompt,
        options: {
          model: 'haiku',
          systemPrompt: buildScribePrompt(thread.name),
          maxTurns: 1,
          permissionMode: 'plan' as any, // Read-only, no tool use
          tools: [], // No tools — just generate text
          persistSession: false,
        },
      })) {
        if (!message || typeof message !== 'object' || !('type' in message)) continue;
        const msg = message as any;
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              digestContent += block.text;
            }
          }
        }
        // Also capture from result message
        if (msg.type === 'result' && msg.result) {
          if (!digestContent) digestContent = msg.result;
        }
      }

      if (!digestContent.trim()) {
        dlog(`[${thread.name}] Skipped — Haiku returned empty content`);
        continue;
      }

      // Write to file
      if (isNewFile) {
        appendFileSync(digestPath, `# Daily Digest — ${today()}\n\n`);
      }
      appendFileSync(digestPath, digestContent.trim() + '\n\n---\n\n');

      // Update last processed sequence (per-thread cursor) — only on success.
      setDigestCursor(thread.id, thread.maxSeq);

      dlog(`[${thread.name}] Digest written to ${digestPath} (${digestContent.length} chars)`);
    } catch (err: any) {
      // One thread failing must not block the others.
      dlog(`[${thread.name}] Error: ${err.message}`);
    }
  }
}
