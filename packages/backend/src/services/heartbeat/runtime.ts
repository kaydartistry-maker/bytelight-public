/**
 * Interactive CLI runtime — the subscription-billed Claude lane.
 *
 * Bridges byte-light's `AgentRuntime` interface onto a warm interactive
 * Claude Code session kept alive by the heartbeat supervisor. A turn is:
 * append the message to the session's inbox, wait for the matching reply
 * line in its outbox, emit it as one text delta.
 *
 * Replies arrive whole or in coarse chunks (no token streaming) — the trade
 * for flat-rate billing. A non-final chunk line carries `more: true`; each
 * chunk re-arms the reply window, so an ack-first session can work long past
 * the base timeout. Turns that still time out are ledgered and their late
 * replies delivered at the start of the next turn instead of dropped.
 * An idle outbox watcher (see `idleWatchTick`) delivers lines the session
 * writes OUTSIDE any turn — background-task findings, proactive follow-ups —
 * within seconds, instead of holding them hostage until the next knock.
 * The session itself holds conversation memory while warm; after a recycle
 * (~hourly when idle) we re-prime with recent thread history.
 *
 * H1 INERT — `CLAUDE_CLI_HEARTBEAT_ENABLED` defaults FALSE. With the flag
 * off, `runTurn` emits an `error` event immediately and never touches the
 * supervisor; nothing in `data/heartbeat/` is created and no child process
 * is spawned. The runtime is not yet wired to the dispatcher (that is H1b
 * glue) — it lands here typecheck-clean but unreachable.
 */

import { writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ModelRef, ProviderId, RuntimeId } from '@bytelight/shared';
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentTurnInput,
  NormalizedMessage,
  NormalizedImage,
} from '../runtimes/types.js';
import { extractLatestUserPrompt } from '../runtimes/latest-user-prompt.js';
import { buildEmojiSightBlock } from './emoji-sight.js';
import { getEmojiByName } from '../db/emojis.js';
import { PROJECT_ROOT } from '../../config.js';
import { BUSY_FRESH_MS, laneTagFor } from './constants.js';
import { thinNudgeForTurn } from './thin-nudge.js';
import { selectOtherLaneReplies, nextOtherLaneMark, renderOtherLaneBlock, clampForDelivery, speakerName } from './other-lane-net.js';
// Re-exported so existing callers and tests keep one import site.
export { OTHER_LANE_REPLY_CAP, selectOtherLaneReplies, nextOtherLaneMark } from './other-lane-net.js';
import { getHeartbeatSession, type HeartbeatSession } from './supervisor.js';
import { parseOutboxLine } from './outbox-line.js';
import { measureDelivery, MEMORY_OPEN, MEMORY_CLOSE, DELIVERY_CAP } from './provision.js';
import {
  latestTranscriptFile, readSessionUsage, contextWindowFor, logCompaction,
  computeUsageDelta, DEFAULT_CONTEXT_WINDOW_TOKENS, type UsageBaseline,
} from './transcript-usage.js';
import { unfiledNoticings, ambientRecall } from './whisper.js';
import { getBytelightConfig } from '../../config.js';
import type { PushService } from '../push.js';
import type { ThinkingInsertion } from '../agent.js';
import { errMessage } from '../../util/errors.js';
// NOTE: `db.js` and `ws.js` are LAZY-imported inside `postSystemLine` to
// break a module-load cycle. A future dispatcher (`runtimes/index.ts`) will
// construct a singleton of this runtime at module-load time; if we eagerly
// imported `ws.js` here, the chain would be:
//   runtimes/index.ts -> heartbeat/runtime.ts -> ws.ts -> agent.ts -> runtimes/index.ts
// and the back-edge would observe `InteractiveCliRuntime` before its class
// body initialized (TDZ). Deferring those imports to call time means the
// cycle is resolved before either side actually needs the symbol.

/**
 * Which of her messages reached no turn.
 *
 * Exported and pure ON PURPOSE. Aerie's first version of this rule lived
 * inside the runtime and its test held a hand-written COPY of the same filter,
 * so the test agreed with the bug and went green through every misfire. A
 * check that mirrors the implementation cannot fail on it.
 *
 * `currentPrompt` is NOT the bare message — it can carry a platform frame or
 * other prefixes — so matching by equality announced the message being read
 * right now as lost on every turn that carried one. Ask what the prompt can
 * answer: does it END with this message.
 *
 * Deliberately one-way: it may hand a message over twice, never zero times.
 */
export function selectMissedInbound<T extends { content: string; createdAt: string }>(
  users: T[],
  since: string | undefined,
  currentPrompt: string,
  newestAt: string,
): T[] {
  const prompt = currentPrompt.trim();
  const arrivingNow = (m: T): boolean => {
    const body = m.content.trim();
    // An image-only row has no text to match on, and every string ends with
    // the empty one. Identify it by position instead: the newest row is the
    // turn arriving now.
    if (body === '') return m.createdAt === newestAt;
    return prompt === body || prompt.endsWith(body);
  };
  return users.filter(m => (!since || m.createdAt > since) && !arrivingNow(m));
}

/**
 * What the [MISSED] banner says — two different events wearing one sentence
 * until you separate them. Every genuinely late batch Aerie measured landed
 * within seconds of a session birth, not in a gap between two turns of a
 * living lane: nothing raced; there was no window alive to hand them to.
 * Those arrive already replayed in the recycle context, so telling a fresh
 * session they "reached no turn at all" invites it to answer, at length, a
 * conversation it is holding in its other hand.
 */
export function missedInboundBanner(count: number, afterRestart: boolean): string {
  const s = count === 1 ? '' : 's';
  const it = count === 1 ? 'it' : 'them';
  if (afterRestart) {
    return `[MISSED — ${count} message${s} of hers landed while this lane was restarting, so no window was alive to take ${it}. They are almost certainly in the replayed conversation above. READ THAT FIRST and answer only what is genuinely unanswered — do not re-answer a thread you are already holding.]`;
  }
  return `[MISSED — ${count} message${s} of hers reached no turn at all. Stored, stamped delivered, handed to nobody. Answer ${it} now; if you already have, say so rather than repeating yourself.]`;
}

// 600s default, re-armed by every chunk the session writes — only sustained
// silence times a turn out. Late lines are delivered next turn, not dropped.
const REPLY_TIMEOUT_MS = (parseInt(process.env.HEARTBEAT_REPLY_TIMEOUT || '600', 10)) * 1000;

// Declared background work (io/.busy): background jobs run hooks-dark — the
// activity mirror never sees them — so a session touches io/.busy before
// spawning one, and while the flag stays fresh the reply window holds open.
// BUSY_FRESH_MS lives in ./constants.ts, shared with the supervisor watchdog.

// Per-turn cap on BOTH holds (open tool, fresh .busy) so nothing can zombie a
// turn. Deliberately the same env var the supervisor's watchdog uses for its
// long leash: if these two ever disagree, one clock waits patiently while the
// other kills the session anyway.
const WORKING_MAX_MS = (parseInt(process.env.HEARTBEAT_WATCHDOG_WORKING_TIMEOUT || '1200', 10)) * 1000;

// Re-prime seed budget (upstream warm-lane numbers, ported whole): the seed
// is re-sent as FRESH input on every recycle, so its size is a recurring
// cache-write cost. 30 newest messages, 4K chars each, 50K total.
export const RECYCLE_SEED_MESSAGES = 30;
export const RECYCLE_SEED_MSG_CHARS = 4_000;
export const RECYCLE_SEED_TOTAL_CHARS = 50_000;
const POLL_MS = 500;
const MAX_UNRESOLVED = 8;

// H1 inert default — flag must be explicitly set to 'true' to enable any
// supervisor activity. Anything else (undefined, 'false', '0', anything)
// keeps the lane fully off.
const FEATURE_FLAG_ENV = 'CLAUDE_CLI_HEARTBEAT_ENABLED';

function isHeartbeatEnabled(): boolean {
  return process.env[FEATURE_FLAG_ENV] === 'true';
}

// Routing helper (for a future slice). Lets the heartbeat lane choose the
// `claude-cli` runtime over the default `claude-sdk`. Independent of the H1
// inert flag (`CLAUDE_CLI_HEARTBEAT_ENABLED`): this helper only answers
// "which lane was selected"; the runtime itself fails safe via the H1 gate
// when the flag is off. The two layers are deliberately separate so a
// misconfigured env (cli selected + flag off) surfaces as the existing
// flag-off error rather than a silent SDK fallback.
//
// Strict equality on the literal string 'cli' — no fuzzy matching, no case
// folding, no trimming. Anything else routes to the default 'sdk' lane.
export const HEARTBEAT_RUNTIME_ENV = 'HEARTBEAT_CLAUDE_RUNTIME';

export function getHeartbeatRuntimeMode(): 'sdk' | 'cli' {
  return process.env[HEARTBEAT_RUNTIME_ENV] === 'cli' ? 'cli' : 'sdk';
}

/**
 * 12-hour wall-clock label in the configured timezone for the inbox `time`
 * field. Inlined `Intl.DateTimeFormat` — byte-light has no `services/time.ts`.
 */
function localClock12(timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date());
}

// Per-session bookkeeping that outlives individual turns: how far into the
// outbox we've consumed, and which timed-out turns are still owed a reply.
// In-memory — a backend restart starts the slate at the current outbox end.
interface LaneState {
  consumedOffset: number;
  activityOffset: number;
  unresolved: string[];
  /** Consecutive routed turns that timed out with zero chunks AND zero tool
   *  activity — the mute-zombie shape (session ticks but cannot speak). */
  silentTimeouts: number;
  /** Thread this lane last delivered into — the idle watcher's target.
   *  Null until the first routed turn binds one (nothing to deliver to
   *  before that anyway). */
  boundThreadId: string | null;
  /** True from runTurn entry to return — the idle watcher stands down
   *  completely while a turn owns the outbox offset. */
  turnActive: boolean;
  /** In-flight idle delivery (persist + broadcast + push). A starting turn
   *  awaits this BEFORE its never-drop-late sweep reads, so the two
   *  consumers of `consumedOffset` never interleave. */
  idleDelivery: Promise<void> | null;
  /** When the watcher first held a batch whose last line carried
   *  `more:true` (a chunked reply mid-flight) — held up to
   *  IDLE_MORE_GRACE_MS so one reply doesn't fragment across messages. */
  idleHoldSince: number | null;
  /** Last transcript gauge read for this lane — the compaction-transition
   *  baseline (same file + higher compaction count = a compaction landed)
   *  AND the session-to-date token totals as of the last recorded turn, so
   *  the next one can be filed as a DELTA (Aerie 18ec6725: the transcript
   *  only ever gives running totals; a usage row wants what a turn added). */
  lastUsage: (UsageBaseline & { contextTokens: number; compactions: number }) | null;
  /** How far into side-notes.jsonl has already been handed over. */
  sideNotesOffset: number;
  /**
   * The newest of her messages this lane has been HANDED — as a prompt, or by
   * the missed-inbound net. Distinct from when the lane last SPOKE; a message
   * can be stored, stamped delivered, and still have reached nobody. That is
   * the whole failure the watermark exists to catch.
   */
  lastHandedUserAt?: string;
  /**
   * Per thread: when this lane last STARTED a turn there (when it last read
   * that thread's history). Bounds how far back the other-lane net
   * (selectOtherLaneReplies) looks in that thread.
   */
  lastReadThreadAt: Map<string, string>;
}
const laneStates = new Map<string, LaneState>();

function laneStateFor(key: string, session: HeartbeatSession): LaneState {
  let state = laneStates.get(key);
  if (!state) {
    state = {
      consumedOffset: session.outboxSize(),
      activityOffset: session.activitySize(),
      unresolved: [],
      silentTimeouts: 0,
      boundThreadId: null,
      turnActive: false,
      idleDelivery: null,
      idleHoldSince: null,
      lastUsage: null,
      sideNotesOffset: session.sideNotesSize(),
      lastReadThreadAt: new Map(),
    };
    laneStates.set(key, state);
  }
  return state;
}

// ─── Outbox line classification (shared: turn-start sweep + idle watcher) ──
//
// One classifier for every out-of-turn outbox read, so the sweep and the
// watcher can never drift apart on turn_id semantics:
//   • `late`      — answers a turn on the unresolved ledger (timed-out turn),
//                   resolving it: explicit matching turn_id, or an id-less
//                   line assumed to answer the oldest owed turn. Identical to
//                   the historical never-drop-late sweep rules.
//   • `proactive` — a content line NOT owed to any turn: the session spoke of
//                   its own accord (background-task findings, follow-ups).
//                   Historically the sweep silently skipped these as "stale";
//                   that skip is exactly how the July 22 background-agent
//                   findings sat invisible until the next knock. They are
//                   deliveries now.
// Skipped entirely: non-JSON noise, content-less lines, and `silent:true`
// sentinels (a sentinel is only honored live, by the turn it names — see the
// in-turn handling in runTurn; out-of-turn it is inert by design).

export type OutboxDeliveryKind = 'late' | 'proactive';

export interface OutboxDelivery {
  content: string;
  thinking: string | null;
  more: boolean;
  kind: OutboxDeliveryKind;
}

export interface OutboxClassification {
  deliveries: OutboxDelivery[];
  /** The unresolved ledger AFTER the deliveries above resolved their turns. */
  unresolved: string[];
  /** True when the last deliverable line carried `more:true` — a chunked
   *  reply is mid-flight and more lines are expected shortly. */
  endsWithMore: boolean;
}

function classifyOutboxLines(
  lines: readonly string[],
  unresolved: readonly string[],
): OutboxClassification {
  const ledger = [...unresolved];
  const deliveries: OutboxDelivery[] = [];
  let endsWithMore = false;
  // parseOutboxLine recovers replies glued onto one line by a write that
  // missed its newline — a bare JSON.parse threw and took BOTH replies with
  // it — and reports anything genuinely unreadable instead of swallowing it.
  const parsedObjects: any[] = [];
  for (const line of lines) {
    for (const obj of parseOutboxLine(line, (fragment, error) => {
      console.error(`[InteractiveCli] UNREADABLE OUTBOX LINE in out-of-turn read (a reply may be lost): ${error} :: ${fragment.slice(0, 160)}`);
    })) {
      parsedObjects.push(obj);
    }
  }
  for (const parsed of parsedObjects) {
    // Sentinels never post: even a malformed one that carries content is a
    // declaration of intentional silence, not a message.
    if (parsed.silent === true) continue;
    const content = typeof parsed.content === 'string' ? parsed.content : null;
    if (!content) continue;
    const thinking = typeof parsed.thinking === 'string' && parsed.thinking.trim()
      ? parsed.thinking
      : null;
    const tid = typeof parsed.turn_id === 'string' ? parsed.turn_id : null;
    const more = parsed.more === true;

    let kind: OutboxDeliveryKind;
    if (tid !== null && ledger.includes(tid)) {
      ledger.splice(ledger.indexOf(tid), 1);
      kind = 'late';
    } else if (tid === null && ledger.length > 0) {
      ledger.shift(); // no id — assume it answers the oldest owed turn
      kind = 'late';
    } else {
      kind = 'proactive';
    }
    deliveries.push({ content, thinking, more, kind });
    endsWithMore = more;
  }
  return { deliveries, unresolved: ledger, endsWithMore };
}

/**
 * A reply seen by the LIVE loop for a turn that is no longer owed.
 *
 * Out-of-turn reads don't need this — classifyOutboxLines delivers not-owed
 * lines as `proactive` (the July 22 decision). But the live loop advances
 * consumedOffset past everything it reads, so a line it skips is never seen
 * again by any reader. That skip used to be a bare `continue`: no log, no
 * counter, no trace — a finished reply could vanish and the only witness was
 * The operator noticing she never got an answer. Delivering it here is deliberately NOT
 * done: mid-turn it would arrive glued into the message being written. Keep
 * the text where it can be recovered by hand, and make the loss audible.
 * (Aerie 18be3c8d, live-loop half; her sweep half is superseded by ours.)
 */
export function recordOrphanedReply(
  path: string | undefined,
  turnId: string | null,
  content: string,
): void {
  console.error(
    `[InteractiveCli] ORPHANED OUTBOX LINE — turn ${turnId ?? '(none)'} is already resolved, so this reply was ` +
    `written after that turn's final line and is NOT being delivered. ${content.length} chars preserved ` +
    `${path ? `in ${path}` : 'nowhere — this session exposes no orphan path'}. ` +
    `First 160: ${content.slice(0, 160)}`,
  );
  if (!path) return;
  try {
    appendFileSync(
      path,
      JSON.stringify({ at: new Date().toISOString(), turn_id: turnId, content }) + '\n',
    );
  } catch (err) {
    console.error(`[InteractiveCli] could not preserve orphaned reply: ${(err as Error).message}`);
  }
}

const EXT_BY_MEDIA: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface InteractiveCliOptions {
  /** Session key — one warm claude per key (companion slug, or 'primary') */
  sessionKey?: string;
  /** Display name of the human, shown as the inbox author */
  userName?: string;
  /** Companion display name, used for history rendering on a session recycle */
  companionName?: string;
}

/**
 * Module-level capability descriptor mirroring `CLAUDE_CAPABILITIES` /
 * `CODEX_CAPABILITIES`. Exported so a future dispatcher (`runtimes/index.ts`)
 * can package it into its dispatch packet.
 */
export const CLAUDE_CLI_CAPABILITIES = {
  tools: false,
  vision: true,           // images flow as files the session can Read
  reasoning: true,        // self-reported via the outbox `thinking` field
  mcp: false,
  sessionResume: true,    // the warm session IS the resume
  fileCheckpointing: false,
  streaming: false,       // coarse chunked replies, no token streaming
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Strip the `<core-memory>…</core-memory>` span from the orientation string.
 *
 * On this lane the core-memory blocks ride the session's CLAUDE.md (written at
 * provision/recycle — see provision.ts renderCoreMemorySection), so carrying
 * them in EVERY delivered message just burned ~150K chars of the delivery cap
 * and got the recycle bridge truncated first. reference implementation (reference implementation) delivery model.
 * Returns the cleaned text plus how many chars were stripped (for the payload
 * instrumentation). No span → pass-through with stripped=0.
 */
export function stripCoreMemoryFromOrientation(orientation: string): { text: string; stripped: number } {
  const open = orientation.indexOf(MEMORY_OPEN);
  if (open === -1) return { text: orientation, stripped: 0 };
  const close = orientation.indexOf(MEMORY_CLOSE, open);
  if (close === -1) return { text: orientation, stripped: 0 };
  const end = close + MEMORY_CLOSE.length;
  // Collapse the seam the removal leaves (the memory part arrives newline-
  // padded on both sides) without touching newlines elsewhere.
  const before = orientation.slice(0, open).replace(/\n+$/, '\n');
  const after = orientation.slice(end).replace(/^\n+/, '\n');
  return { text: before + after, stripped: end - open };
}

/**
 * Hard ceiling on ALL recall content riding one turn — the whisper (ambient
 * recall) card plus the Archivist's unfiled-noticings card, combined.
 *
 * whisper.ts already budgets each half small (RECALL_MAX_CHARS + a 3-item
 * noticings list), so under normal load recall is a few hundred to ~1.5K
 * chars. This is the delivery-side backstop: even if both cards run long,
 * recall as a whole may not exceed this. Order of a few K — a handful of
 * small cards, never a memory payload. Kept well under the delivery cap so
 * recall stays the optional passenger, not a co-driver.
 */
export const RECALL_BUDGET_CHARS = 8000;

/**
 * Fit the two recall cards to the turn's headroom, recall-trims-first.
 *
 * Two guards, in this order:
 *   1. Combined recall may never exceed RECALL_BUDGET_CHARS. The whisper card
 *      is the first to go, then the noticings card (recall before bookkeeping).
 *   2. If the WHOLE assembled payload would still exceed the delivery cap,
 *      recall is dropped entirely BEFORE the hook gets to touch the bridge or
 *      the conversation middle. Recall is the optional passenger; the bridge
 *      floor and the owner's message are not.
 *
 * `base` is everything that is NOT recall (context + orientation + the user's
 * message) — the mass recall has to make room around. Returns the two cards
 * as they should actually ride, plus a note of what was dropped for the log.
 */
export function fitRecallToCap(
  whisper: string,
  unfiled: string,
  baseChars: number,
): { whisper: string; unfiled: string; trimmed: 'none' | 'budget' | 'cap' } {
  let w = whisper;
  let u = unfiled;
  let trimmed: 'none' | 'budget' | 'cap' = 'none';

  // Guard 1 — combined recall budget. Drop whisper first, then unfiled.
  if (w.length + u.length > RECALL_BUDGET_CHARS) {
    trimmed = 'budget';
    w = '';
    if (u.length > RECALL_BUDGET_CHARS) u = '';
  }

  // Guard 2 — delivery-cap headroom. If the base alone plus recall would blow
  // the cap, recall yields entirely (whisper first, then unfiled) so the
  // bridge floor and the conversation survive the hook untouched.
  if (baseChars + w.length + u.length > DELIVERY_CAP) {
    trimmed = 'cap';
    if (baseChars + u.length <= DELIVERY_CAP) {
      w = ''; // dropping the whisper alone fits
    } else {
      w = '';
      u = ''; // even the noticings can't ride; base is on its own
    }
  }

  return { whisper: w, unfiled: u, trimmed };
}

/**
 * Validate-but-do-not-mutate model id helper.
 *
 * The bracket suffix `[1m]` is a legitimate Anthropic 1M-context request
 * marker. This helper is INTENTIONALLY a pass-through: it never strips the
 * suffix and never silent-downgrades a 1M model to the default-context
 * variant.
 *
 * The open question (H1b-deferred): does `claude --model <model>[1m]` actually
 * parse at the CLI surface? The SDK accepts the bracket syntax natively, but
 * the CLI's `--model` arg parser is a different code path and brackets are
 * shell glob characters. The spawn-site fix lives in `supervisor.ts` (see the
 * `TODO(H1b)` there). Until verified, we pass through.
 */
export function prepareClaudeCliModelId(modelId: string): string {
  return modelId;
}

export class InteractiveCliRuntime implements AgentRuntime {
  // H1b: 'claude-cli' is now a member of the shared `RuntimeId` union
  // (model-manifest.ts), so the H1a cast is gone. The provider that maps
  // here is the pickable 'claude-cli' provider (providerToRuntime).
  readonly id: RuntimeId = 'claude-cli';
  readonly providerId: ProviderId = 'claude-cli';

  private options: InteractiveCliOptions;
  private aborted = false;

  constructor(options: InteractiveCliOptions = {}) {
    this.options = options;
  }

  abort(): void {
    this.aborted = true;
  }

  /**
   * Post a visible system line into the bound thread (supervisor incidents).
   *
   * `db.js` and `ws.js` are imported lazily here to break a module-load
   * cycle — see the import-comment at the top of this file for the trace.
   */
  private async postSystemLine(threadId: string, text: string): Promise<void> {
    try {
      const [{ createMessage }, { registry }] = await Promise.all([
        import('../db.js'),
        import('../ws.js'),
      ]);
      const msg = createMessage({
        id: randomUUID(),
        threadId,
        role: 'system',
        content: text,
        createdAt: new Date().toISOString(),
      });
      registry.broadcast({ type: 'message', message: msg });
    } catch (err) {
      console.error('[InteractiveCli] failed to post system line:', err);
    }
  }

  /**
   * Write image attachments from a normalized user message to the session's
   * `io/images` directory. Returns the absolute paths so the inbox JSON can
   * list them and the warm session can `Read` each file.
   *
   * byte-light's `NormalizedImage` carries `{base64, mimeType}` (no `data:`
   * prefix); the upstream lane read pi-ai-shaped `b.source.data` /
   * `b.source.media_type`. The shape translation is the only delta.
   */
  private writeImages(session: HeartbeatSession, images: readonly NormalizedImage[] | undefined): string[] {
    const paths: string[] = [];
    if (!images || images.length === 0) return paths;
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const data = img?.base64;
      if (typeof data !== 'string' || !data) continue;
      const ext = EXT_BY_MEDIA[img?.mimeType ?? ''] || 'png';
      const file = join(session.imagesDir, `${Date.now()}-${i}.${ext}`);
      try {
        writeFileSync(file, Buffer.from(data, 'base64'));
        paths.push(file);
      } catch { /* skip unwritable image */ }
    }
    return paths;
  }

  /**
   * Clamp one seed message to `cap` chars: keep the head (85%) and the tail
   * (10%) with a visible truncation marker between. Ported whole from the
   * upstream lane's `clampForInbox` (minus its file-block pre-pass, which has
   * no byte-light equivalent) — the seed rides the same hook payload as the
   * live message, so one pasted log must not eat the whole budget.
   */
  private clampForSeed(content: string, cap: number): string {
    return clampForDelivery(content, cap);
  }

  /**
   * Build the re-prime seed from `input.messages`.
   *
   * The upstream lane took a `loadHistory` closure + `threadId` and queried
   * the DB. byte-light passes the full history via `input.messages`, so we
   * read from that directly — no DB closure, no thread-id round-trip.
   *
   * Budgeted (upstream numbers, ported whole): at most the newest
   * RECYCLE_SEED_MESSAGES messages, each clamped to RECYCLE_SEED_MSG_CHARS,
   * under a RECYCLE_SEED_TOTAL_CHARS total that drops OLDEST first with a
   * visible omitted-count marker. Every recycle used to re-send up to ~49
   * unclamped messages as fresh input — a repeated cache-write tax this
   * budget bounds.
   */
  private buildRecycleContext(messages: NormalizedMessage[]): string {
    const { companionName, userName } = this.options;

    // Exclude the latest user message — it's the one we're about to deliver
    // via the inbox; including it twice would echo. The upstream `loadHistory`
    // call returned only prior turns; byte-light's `input.messages` may
    // include the in-flight user message at the tail.
    const history: NormalizedMessage[] = [...messages];
    while (history.length > 0 && history[history.length - 1].role === 'user') {
      history.pop();
    }
    if (history.length === 0) return '';

    const windowed = history.slice(-RECYCLE_SEED_MESSAGES);
    const lines = windowed.map(m =>
      `${m.role === 'assistant' ? speakerName(m.companionId, companionName || 'Companion') : (userName || 'User')}: ${this.clampForSeed(typeof m.content === 'string' ? m.content : '', RECYCLE_SEED_MSG_CHARS)}`,
    );
    let dropped = history.length - windowed.length;
    while (lines.length > 1 && lines.reduce((n, s) => n + s.length + 1, 0) > RECYCLE_SEED_TOTAL_CHARS) {
      lines.shift();
      dropped++;
    }
    if (dropped > 0) {
      lines.unshift(`[${dropped} older message${dropped === 1 ? '' : 's'} omitted from this seed for size]`);
    }
    const header = '[Session recycled — recent conversation, oldest first, for continuity:]';
    return [
      header,
      ...lines,
      '[End of context. The message below continues this conversation — respond to it in character.]',
      '',
    ].join('\n');
  }

  /**
   * Render the other-lane net (see selectOtherLaneReplies), labelled by who
   * actually spoke. Returns '' when nothing was said elsewhere. The mark moves
   * when the turn finishes, so the same reply is not offered twice.
   */
  private buildOtherLaneBlock(
    state: LaneState,
    key: string,
    threadId: string,
    messages: readonly { role: string; content: string; createdAt: string; lane?: string; companionId?: string }[],
  ): string {
    const theirs = selectOtherLaneReplies(messages, state.lastReadThreadAt.get(threadId), laneTagFor('claude-cli', key));
    return renderOtherLaneBlock(theirs, this.options.companionName || 'Companion');
  }

  /**
   * Her messages that reached nobody.
   *
   * There were two nets and a seam between them. The recycle seed is
   * assembled at the START of a turn, so anything arriving during one is
   * already too late for it. Side notes are only written while a turn is
   * active and exactly one lane is busy. A message that lands in between is
   * stored, stamped delivered, and handed to no window at all — Aerie counted
   * four before anyone had a witness beyond a screenshot.
   *
   * So this runs on EVERY turn and asks the plainest possible question: is
   * there anything of hers newer than the last thing this lane was handed,
   * that is not the thing it is being handed right now? Anything found is
   * given over late and written to io/missed-inbound.jsonl, so there is a
   * witness on disk even if the window never mentions it.
   *
   * Deliberately one-way: it can hand a message over twice, never zero times.
   * A doubled answer is visible and annoying; a lost one is neither.
   */
  private buildMissedInboundBlock(
    state: LaneState,
    messages: readonly { role: string; content: string; createdAt: string }[],
    currentPrompt: string,
    afterRestart: boolean,
    missedPath: string,
  ): string {
    const since = state.lastHandedUserAt;

    const users = messages.filter(m => m.role === 'user');
    const newestAt = users.reduce((a, m) => (m.createdAt > a ? m.createdAt : a), '');

    const mine = selectMissedInbound(users, since, currentPrompt, newestAt);

    // Advance the watermark past everything of hers we can see, including the
    // message arriving now — otherwise the same one is offered again forever.
    if (newestAt) state.lastHandedUserAt = newestAt > (since || '') ? newestAt : (since || newestAt);

    if (mine.length === 0) return '';

    // How late each one is. A miss found seconds after it was sent is the
    // handover working; one found an hour later is the seam this exists for,
    // and reading them the same way is what let a mislabel hide a real loss.
    const now = Date.now();
    const lateness = (m: { createdAt: string }): string => {
      const ms = now - Date.parse(m.createdAt);
      if (!Number.isFinite(ms) || ms < 0) return 'unknown';
      const mins = Math.round(ms / 60_000);
      return mins < 1 ? `${Math.round(ms / 1000)}s late` : `${mins}m late`;
    };

    try {
      for (const m of mine) {
        appendFileSync(missedPath, JSON.stringify({
          found_at: new Date().toISOString(),
          sent_at: m.createdAt,
          late: lateness(m),
          // Why it was late: the lane was being born, or a live lane was busy.
          // Averaging those two together is what made a healthy median out of
          // an outage.
          reason: afterRestart ? 'session-birth' : 'race',
          content: m.content,
        }) + '\n', 'utf8');
      }
    } catch { /* the handover below is the point; the log is the backup */ }

    const userName = this.options.userName || 'User';
    return [
      '',
      missedInboundBanner(mine.length, afterRestart),
      ...mine.map(m => `${userName} (${m.createdAt}, ${lateness(m)}): ${this.clampForSeed(m.content, 4_000)}`),
      '[End of missed messages.]',
      '',
    ].join('\n');
  }

  async *runTurn(input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent> {
    this.aborted = false;

    // Required first event by byte-light's runtime contract (types.ts).
    yield { type: 'start', runtimeId: this.id, modelRef: input.modelRef };

    // H1 inert gate. Flag-off short-circuits BEFORE any supervisor call,
    // so no session dir is provisioned and no child process is spawned.
    if (!isHeartbeatEnabled()) {
      yield {
        type: 'error',
        message:
          'Claude CLI heartbeat runtime is not enabled. Set ' +
          `${FEATURE_FLAG_ENV}=true to opt in. This lane is registered ` +
          'but unreachable by default in H1 — no UI routes to it yet.',
        recoverable: false,
      };
      return;
    }

    const key = this.options.sessionKey || 'primary';
    const session = getHeartbeatSession(key);
    const state = laneStateFor(key, session);

    // Turn-active fence for the idle outbox watcher: while a turn runs the
    // watcher stands down entirely (`turnActive` is checked synchronously at
    // every tick), and any delivery already in flight is drained here BEFORE
    // the never-drop-late sweep reads — the shared `consumedOffset` only ever
    // has one consumer at a time. Cleared in `finally`, which also fires when
    // the consumer abandons the generator mid-stream (.return()).
    state.turnActive = true;
    // The other-lane mark is the newest row this turn's history read (see
    // nextOtherLaneMark): a reply another lane writes after the snapshot is
    // newer than it and is offered next turn. Own rows are excluded by lane
    // tag, so the earlier mark cannot echo them.
    const turnStartedIso = new Date().toISOString();
    let turnCompleted = false;
    // Mirror onto the session so the supervisor's watchdog can measure a live
    // turn from its own start instead of a file older than it is.
    session.turnActive = true;
    session.turnStartedAt = Date.now();
    session.turnThreadId = input.thread.id;
    try {
      if (state.idleDelivery) {
        try { await state.idleDelivery; } catch { /* watcher logs its own failures */ }
      }
      // Intercept the terminal 'done' so the context gauge rides every
      // completed turn, ahead of it (the runtime contract keeps 'done'
      // terminal). The gauge is observation-only and fail-quiet — a missing
      // or unreadable transcript costs the turn its meter and nothing else.
      for await (const event of this.runTurnBody(input, key, session, state)) {
        if (event.type === 'done') {
          if (event.finishReason !== 'aborted' && event.finishReason !== 'error') turnCompleted = true;
          try {
            yield* this.emitLaneGauge(key, state);
          } catch { /* never let the gauge break a finished turn */ }
        }
        yield event;
      }
    } finally {
      // A guest's turn, or one that failed before delivering, does not move
      // the mark: those replies are still owed to the owner's next turn.
      const mark = nextOtherLaneMark({
        prev: state.lastReadThreadAt.get(input.thread.id),
        read: input.messages,
        completed: turnCompleted,
        guest: input.audience?.kind === 'guest',
        fallback: turnStartedIso,
      });
      if (mark) state.lastReadThreadAt.set(input.thread.id, mark);
      state.turnActive = false;
      session.turnActive = false;
      session.turnStartedAt = 0;
      session.turnThreadId = null;
    }
  }

  /**
   * Read the lane's live CLI transcript and surface the same signals the SDK
   * lane reports: a `context_usage` runtime event (the shared consumer in
   * agent.ts broadcasts it to the existing ContextIndicator), a `usage`
   * event carrying the DELTA this turn added (so the turn's usage_events row
   * gets real numbers instead of zeros), and — when the
   * transcript shows a NEW native compaction since the last look — a
   * system-labeled `compaction_notice` WS banner plus a durable line in
   * logs/compaction.log. The compaction itself is Claude Code's own in-place
   * auto-compaction; nothing here (and nothing anywhere in this lane) writes
   * summary content into the app DB or any thread.
   */
  private async *emitLaneGauge(key: string, state: LaneState): AsyncIterable<AgentRuntimeEvent> {
    const file = latestTranscriptFile(key);
    if (!file) return;
    const usage = await readSessionUsage(file.path, file.size, file.mtime);
    if (!usage) return;

    const contextWindow = usage.model ? contextWindowFor(usage.model) : DEFAULT_CONTEXT_WINDOW_TOKENS;
    yield { type: 'context_usage', used: usage.contextTokens, max: contextWindow };

    const prev = state.lastUsage;
    const sameFile = prev !== null && prev.path === file.path;
    if (sameFile && usage.compactions > prev.compactions) {
      const preTokens = prev.contextTokens || usage.contextTokens;
      void logCompaction(key, preTokens, usage.contextTokens);
      try {
        const { registry } = await import('../ws.js');
        registry.broadcast({
          type: 'compaction_notice',
          preTokens,
          message: `Context compacted in place (was ${Math.round(preTokens / 1000)}K tokens) — warm session continues`,
          isComplete: true,
        });
      } catch { /* banner is best-effort; the log line above is durable */ }
      console.log(`[Heartbeat:${key}] native compaction observed — ${preTokens} → ${usage.contextTokens} tokens, same session`);
    }

    // File what this turn actually cost. This lane reports nothing per
    // request — no streaming counts, no API response to read — so it filed
    // no usage rows at all while every API lane had real figures.
    // The numbers were never missing: Claude Code writes them into the
    // transcript we already read for the gauge above. What goes on the row
    // is the DELTA since this lane's last turn (Aerie 18ec6725). Input and
    // cache reads are the whole conversation re-sent — the same measure
    // every API lane on the Usage dashboard already reports as Input.
    const delta = computeUsageDelta(prev ?? undefined, usage, file.path);
    state.lastUsage = {
      path: file.path,
      contextTokens: usage.contextTokens,
      compactions: usage.compactions,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    };
    // A turn that grew nothing (silent timeout, abort before any reply) files
    // no row — an all-zeros row is the exact noise this event exists to end.
    if (!delta.inputTokens && !delta.outputTokens && !delta.cacheReadTokens && !delta.cacheWriteTokens) return;
    yield {
      type: 'usage',
      input: delta.inputTokens,
      output: delta.outputTokens,
      cacheRead: delta.cacheReadTokens,
      cacheWrite: delta.cacheWriteTokens,
      // Explicit null: this lane is subscription-billed — no per-turn dollar
      // measurement exists, and estimating API-equivalent cost would invent
      // one. The consumer files NULL, never a guess.
      cost: null,
    };
  }

  private async *runTurnBody(
    input: AgentTurnInput,
    key: string,
    session: HeartbeatSession,
    state: LaneState,
  ): AsyncIterable<AgentRuntimeEvent> {

    // Validate-but-do-not-strip the model id (preserves `[1m]`).
    // No identity flows through provisioning — the written CLAUDE.md is
    // operational-only (see provision.ts). Identity for the warm session
    // comes from Claude CLI's CLAUDE.md walk-up from cwd (the H2 surface).
    const modelId = prepareClaudeCliModelId(input.modelRef.model);

    let modelRecycle = false;
    try {
      modelRecycle = session.ensure(modelId);
    } catch (err) {
      yield {
        type: 'error',
        message: `heartbeat session failed to start: ${errMessage(err)}`,
        recoverable: false,
      };
      return;
    }

    // Supervisor incidents (cap/auth backoff, watchdog recycles) become
    // visible system lines in this thread — dead air is the bug.
    const threadId = input.thread.id;
    // Bind the lane to this thread for out-of-turn delivery, and make sure
    // the idle outbox watcher is running now that there is somewhere to
    // deliver to.
    state.boundThreadId = threadId;
    ensureIdleWatcher();
    session.onIncident = (text) => {
      // Fire-and-forget — supervisor's `reportIncident` is sync and ignores
      // return; postSystemLine surfaces its own errors via console on failure.
      void this.postSystemLine(threadId, text);
    };

    // Recycle-in-progress: the old session is being torn down. Hold this turn
    // until the NEW session has launched — appending to the inbox now would let
    // the dying session's hook consume the message (advancing the shared inbox
    // offset), leaving the fresh session with nothing to answer and the turn
    // dead on the reply timeout.
    if (modelRecycle) {
      // Slice 3 (thought semantics): runtime seams (recycle/timeout notes)
      // are byte-light's own notices, not anyone's voice → kind 'system'.
      const note = '[Recycling the warm session before delivering this message…]';
      yield { type: 'thinking_delta', text: note, kind: 'system' };
      const relaunched = await session.waitForRelaunch();
      if (!relaunched) {
        const warn = '[Recycle is taking longer than expected — delivering the message anyway; it will be picked up when the session comes back.]';
        yield { type: 'thinking_delta', text: warn, kind: 'system' };
      }
    }

    const fresh = session.consumeFreshFlag();
    if (fresh) {
      // A relaunched session has NOT lost its in-flight work — the relaunch
      // resumes the transcript, so a session killed mid-turn finishes the
      // thought it was holding and writes that line to the outbox afterwards.
      // The ledger used to be cleared here on the opposite reasoning, which
      // made exactly those finished replies unrecoverable: no owed turn, both
      // readers skipped the line, offset advanced past it (Aerie 3b8bf231).
      // Keep the ledger; stale ids age out at MAX_UNRESOLVED and delivery
      // still requires a real matching outbox line. The offset clamps stay —
      // a truncated outbox would make a stale offset read garbage.
      state.consumedOffset = Math.min(state.consumedOffset, session.outboxSize());
      state.activityOffset = Math.min(state.activityOffset, session.activitySize());
    }
    const guestTurn = input.audience?.kind === 'guest';
    const contextBlock = fresh ? this.buildRecycleContext(input.messages) : '';
    // The think-and-thin nudge rides ahead of the bridge, as it did at the
    // source: the bridge's last line says the next thing is the owner's message.
    const thinBlock = thinNudgeForTurn({ fresh, guest: guestTurn, autonomous: input.isAutonomous, laneKey: key });

    // Orientation cheat-sheet — agent.ts assembles it per-turn into
    // `input.orientation` with LIVE data (sticker catalog, mood, life status,
    // gap/time, plus first-message static: skills, chat-tools, image-gen
    // manifest). The Claude SDK lane injects it as a [Context] block on every
    // turn; the warm CLI session needs the same wrap or it loses the sticker
    // catalog and the rest of the cheat-sheet on turn 1+ (substrate parity).
    // EXCEPT core memory: on this lane the blocks ride the session's CLAUDE.md
    // (provision/recycle), not the pipe — strip them so the delivery cap is
    // spent on the conversation, not on re-sending memory every turn.
    const orientationStrip = input.orientation
      ? stripCoreMemoryFromOrientation(input.orientation)
      : { text: '', stripped: 0 };
    const orientationBlock = orientationStrip.text.trim()
      ? `[Context]\n${orientationStrip.text}\n[/Context]\n\n`
      : '';

    // Surface the recycle seam in the UI — the warm session restarted and is
    // being re-primed, which is otherwise invisible to the user.
    if (fresh) {
      yield {
        type: 'thinking_delta',
        text: '[Session recycled — warm CLI session restarted; re-primed with recent thread history.]',
        kind: 'system',
      };
    }

    const turnId = randomUUID().slice(0, 8);

    // Pull the latest user message — content + any attached images.
    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
    const userImages = lastUser?.images;
    const userContent = extractLatestUserPrompt(input.messages);
    const images = this.writeImages(session, userImages);

    let emittedText = false;
    const joined = (content: string) => (emittedText ? '\n\n' + content : content);

    // Never-drop-late: sweep outbox lines written since the last turn ended.
    // Replies that belong to timed-out turns are delivered now, ahead of the
    // new reply, instead of being silently skipped. Proactive lines (not owed
    // to any turn — background-task findings the idle watcher didn't get to
    // first, e.g. written mid-hold or before the watcher's next tick) are
    // delivered here too, never dropped. Classification is shared with the
    // idle watcher (`classifyOutboxLines`) so the two paths cannot drift.
    {
      const swept = session.readOutboxFrom(state.consumedOffset);
      state.consumedOffset = swept.newOffset;
      const classified = classifyOutboxLines(swept.lines, state.unresolved);
      state.unresolved = classified.unresolved;
      state.idleHoldSince = null; // whatever the watcher was holding for, we own it now
      const deliverNow = classified.deliveries;
      if (deliverNow.length > 0) {
        const lateCount = deliverNow.filter((d) => d.kind === 'late').length;
        const noteHead =
          lateCount === deliverNow.length
            ? `Late repl${lateCount === 1 ? 'y' : 'ies'} from an earlier turn that outran its window`
            : lateCount === 0
              ? 'Output the session wrote between turns'
              : `Late repl${lateCount === 1 ? 'y' : 'ies'} from an earlier turn, plus output the session wrote between turns`;
        yield {
          type: 'thinking_delta',
          text: `[${noteHead} — delivered now, ahead of the current reply.]`,
          kind: 'system',
        };
        for (const l of deliverNow) {
          if (l.thinking) {
            // The `thinking` reply field is written by the companion itself
            // (see provision.ts prompt contract) → kind 'authored'.
            yield { type: 'thinking_delta', text: l.thinking, kind: 'authored' };
          }
          yield { type: 'text_delta', text: joined(l.content) };
          emittedText = true;
        }
      }
    }

    // Stamp the user-visible time label in the configured timezone — the hook
    // has no tz config, so a raw `ts` would render in server time (UTC).
    let timeLabel: string | undefined;
    try { timeLabel = localClock12(getBytelightConfig().identity.timezone); } catch { /* config not loaded */ }

    // Tool activity from between turns (idle-tick work) isn't this turn's —
    // fast-forward so the live tool feed below only shows what THIS turn does.
    state.activityOffset = session.activitySize();

    // The Archivist's noticings, handed over rather than written onto the
    // walls. Fail-quiet by construction (see whisper.ts) — bookkeeping must
    // never delay or drop a turn — but wrapped again here because this now
    // sits on the delivery path. Placed INSIDE deliveredContent deliberately,
    // so slice 1's payload instrumentation counts it like everything else.
    // Not on a guest's turn (turn-audience.ts): the noticings are about the
    // owner, and a guest's answer lands in a room the guest reads.
    let unfiledBlock = '';
    if (!guestTurn) {
      try { unfiledBlock = unfiledNoticings(); } catch { /* never delay a turn */ }
    }

    // Ambient recall — archived memories resembling this message ride in ahead
    // of it. Timeboxed and fail-quiet inside ambientRecall(); a slow or
    // unreachable Cortex costs this turn its recall and nothing else. This is
    // the half that lets the blocks shrink: what is retrievable no longer has
    // to be carried on every turn.
    let whisperBlock = '';
    let recallSurfaced: import('./whisper.js').SurfacedRecall | null = null;
    // A guest's turn gets no recall at all: the guest's own words would choose
    // which memories surfaced, into a room the guest reads.
    if (!guestTurn) try {
      const recall = await ambientRecall(userContent, key, fresh);
      whisperBlock = recall.block;
      recallSurfaced = recall.surfaced;
    } catch { /* never delay a turn */ }

    // Runs on every turn, autonomous or not — the seam it closes is exactly
    // the one a recycle opens, and a live turn is the next chance to notice.
    // A guest's turn is answered in the guest's room, and this block tells the
    // lane to answer the owner's missed messages now. So on a guest's turn it
    // hands none over and leaves the watermark where it is: they come with the
    // owner's own next turn instead, late and never lost.
    const missedBlock = guestTurn ? '' : this.buildMissedInboundBlock(
      state, input.messages, userContent, fresh, session.missedInboundPath,
    );

    // Same net, other half: what the room said that this lane never heard.
    // Not on a fresh session (the recycle seed already carries the history)
    // and not on a guest's turn (household words do not ride into a guest's
    // room).
    const otherLaneBlock = (guestTurn || fresh) ? '' : this.buildOtherLaneBlock(state, key, input.thread.id, input.messages);

    // Side notes sent while the last turn was working. The session may read
    // them live from io/side-notes.jsonl, but nothing guarantees it looked —
    // so whatever is still unread is handed over here. Late, never lost.
    let sideNoteBlock = '';
    // The owner's notes are the owner's. On a guest's turn they stay unread and
    // the offset does not move, so they come with the owner's next turn
    // instead, and an answer to one never lands in a guest's room.
    if (!guestTurn) try {
      const pending = session.readSideNotesFrom(state.sideNotesOffset);
      state.sideNotesOffset = pending.newOffset;
      if (pending.notes.length > 0) {
        // The session may have read a note live and already answered it. That
        // never suppresses the handover — the whole worth of this path is that
        // her note does not depend on the session's judgement — but it should
        // not come back dressed as unread either, or the session repeats
        // itself and she cannot tell an echo from a miss. So: hand over every
        // note exactly as before, and label the ones it says it already had.
        // ISO-8601 UTC stamps compare lexicographically; an empty stamp on
        // either side means no claim, which reads as unseen. Anything that
        // goes wrong reading the mark degrades to an empty mark — every note
        // unlabelled, i.e. exactly the blind-handover behaviour.
        let readMark = '';
        try { readMark = session.sideNotesReadMark?.() ?? ''; } catch { readMark = ''; }
        const alreadySeen = (at: string): boolean => Boolean(readMark && at && at <= readMark);
        const noteLines = pending.notes
          .map((note) => `- ${note.text}${alreadySeen(note.at) ? '  [you picked this up live — already answered, no need to repeat it]' : ''}`)
          .join('\n');
        const anyUnseen = pending.notes.some((note) => !alreadySeen(note.at));
        const header = anyUnseen
          ? '[Sent to you while you were working and not read at the time — answer these too:]'
          : '[Sent to you while you were working — you already picked these up live, so they are here for the record only:]';
        sideNoteBlock = `${header}\n${noteLines}\n\n`;
      }
    } catch { /* a missing or unreadable file must never delay the turn */ }

    // Recall is the optional passenger. Everything else — the recycle bridge,
    // the orientation cheat-sheet, the owner's message, her side notes — has
    // priority. Fit the two recall cards to the turn's headroom BEFORE
    // assembly: if the payload would blow the delivery cap, recall trims FIRST
    // (whisper, then noticings) so the hook never has to reach for the bridge
    // floor or the conversation middle on recall's account.
    const baseChars = (thinBlock + contextBlock + orientationBlock + otherLaneBlock + missedBlock + sideNoteBlock + userContent).length;
    const fitted = fitRecallToCap(whisperBlock, unfiledBlock, baseChars);
    whisperBlock = fitted.whisper;
    unfiledBlock = fitted.unfiled;
    const recallChars = whisperBlock.length + unfiledBlock.length;

    // Her custom emojis arrive as shortcode text; name the file so we can look.
    const emojiBlock = buildEmojiSightBlock(userContent, getEmojiByName, join(PROJECT_ROOT, 'data', 'emojis'));
    const deliveredContent =
      thinBlock + contextBlock + orientationBlock + otherLaneBlock + missedBlock + whisperBlock + unfiledBlock + sideNoteBlock + userContent + emojiBlock;

    // The shiver — tell the reply message what recall surfaced, but only when
    // the whisper actually SURVIVED the cap fit. If fitRecallToCap trimmed the
    // block away to protect the payload, the memory never rode the turn, so the
    // owner must not see a shimmer claiming it did. (Receipts already fired
    // inside ambientRecall; the ledger records the attempt regardless — the
    // shimmer is specifically "this reply carried recall.")
    if (recallSurfaced && whisperBlock.length > 0) {
      yield {
        type: 'memory_surface',
        cards: recallSurfaced.cards,
        dejavu: recallSurfaced.dejavu,
      };
    }

    // Payload instrumentation — observation only, no behaviour change. The
    // delivery cap is enforced inside the session's hook, where it is invisible
    // from here: a turn that loses its recycle bridge to memory bloat looks
    // identical in the logs to one that didn't. `measureDelivery` mirrors the
    // hook's arithmetic (see provision.ts) so the real numbers are on the
    // record every turn. Core memory no longer rides the payload (it lives in
    // the session's CLAUDE.md), so `memory` now reads 0 by design; the
    // stripped size is logged alongside so the CLAUDE.md-side number stays on
    // the record too.
    try {
      const m = measureDelivery(deliveredContent);
      const bridgeNote = m.bridgeChars > 0 ? `bridge ${m.bridgeChars}` : 'bridge none';
      const memNote = orientationStrip.stripped > 0
        ? `memory ${m.memoryChars} in payload (${orientationStrip.stripped} chars ride CLAUDE.md)`
        : `memory ${m.memoryChars}`;
      // Recall rides the payload as small cards; report its weight every turn
      // alongside memory and bridge. A `trimmed` note is appended when recall
      // yielded its seat so a shrunk-to-nothing recall isn't read as "nothing
      // matched."
      const recallNote = fitted.trimmed === 'none'
        ? `recall ${recallChars}`
        : `recall ${recallChars} (trimmed:${fitted.trimmed})`;
      if (m.stage === 'none') {
        console.log(
          `[Heartbeat:${key}] payload ${m.payloadChars}/${m.cap} chars ` +
          `(${memNote}, ${bridgeNote}, ${recallNote}) — under cap, delivered whole`,
        );
      } else {
        const cuts = [
          m.bridgeDropped > 0 ? `bridge -${m.bridgeDropped}` : null,
          m.middleDropped > 0 ? `middle -${m.middleDropped}` : null,
        ].filter(Boolean).join(', ');
        console.warn(
          `[Heartbeat:${key}] payload ${m.payloadChars}/${m.cap} chars ` +
          `(${memNote}, ${bridgeNote}, ${recallNote}) — TRUNCATED at stage '${m.stage}': ` +
          `${cuts || 'no chars dropped'} — delivering ${m.deliveredChars}`,
        );
      }
    } catch (err) {
      console.warn(`[Heartbeat:${key}] payload measurement failed:`, err);
    }

    session.appendInbox({
      ts: new Date().toISOString(),
      ...(timeLabel ? { time: timeLabel } : {}),
      channel: 'bytelight',
      author: this.options.userName || 'user',
      content: deliveredContent,
      turn: turnId,
      ...(images.length > 0 ? { images } : {}),
      // Read by the Stop hook into io/.turn-audience, where the tool gate
      // looks before every tool call. See services/turn-audience.ts.
      ...(input.audience ? { audience: input.audience } : {}),
    });

    const turnStartedAt = Date.now();
    let deadline = turnStartedAt + REPLY_TIMEOUT_MS;
    let offset = state.consumedOffset;
    let chunks = 0;
    let activitySeq = 0;
    // Synthesized tool-use ids per tool name, for hook payloads without one.
    const pendingTools: Record<string, string[]> = {};
    // Tools that sent a `pre` and haven't reported back — a running tool holds
    // its turn open (bounded by WORKING_MAX_MS below).
    const openTools = new Set<string>();

    // Wire abort-signal to the internal flag so byte-light's plumbing
    // (AbortSignal) can cancel a turn the same as an explicit abort() call.
    const abortHandler = () => { this.aborted = true; };
    input.abortSignal?.addEventListener('abort', abortHandler);

    try {
      while (Date.now() < deadline) {
        if (this.aborted) {
          // Intentional retraction (message edit) — do NOT ledger this turn:
          // a late answer to a retracted message should stay retracted.
          state.consumedOffset = offset;
          yield { type: 'done', finishReason: 'aborted' };
          return;
        }
        if (session.status === 'unavailable') {
          state.consumedOffset = offset;
          yield {
            type: 'error',
            message: session.lastError || 'heartbeat session unavailable',
            recoverable: false,
          };
          return;
        }

        // Tool-activity tail — surface the session's tool calls live, and treat
        // them as liveness: a session deep in tool work is not silent, so every
        // activity line re-arms the reply window just like a chunk does.
        {
          const act = session.readActivityFrom(state.activityOffset);
          state.activityOffset = act.newOffset;
          let sawActivity = false;
          for (const actLine of act.lines) {
            let ev: any;
            try { ev = JSON.parse(actLine); } catch { continue; }
            const tool = typeof ev.tool === 'string' && ev.tool ? ev.tool : 'tool';
            if (ev.phase === 'pre') {
              sawActivity = true;
              let id: string;
              if (typeof ev.id === 'string' && ev.id) {
                id = ev.id;
              } else {
                id = `cli-${turnId}-${activitySeq++}`;
                (pendingTools[tool] ||= []).push(id);
              }
              openTools.add(id);
              const detail = typeof ev.detail === 'string' && ev.detail ? ev.detail : '';
              yield { type: 'tool_start', id, name: tool, input: detail ? { detail } : {} };
            } else if (ev.phase === 'post') {
              sawActivity = true;
              const id = typeof ev.id === 'string' && ev.id ? ev.id : pendingTools[tool]?.shift();
              if (id) openTools.delete(id);
              // Fill from the PostToolUse-captured tool_response when present;
              // old-format lines (no output/isError) fall back to empty/false.
              const output = typeof ev.output === 'string' ? ev.output : '';
              const isError = ev.isError === true;
              if (id) yield { type: 'tool_result', id, name: tool, output, isError };
            }
          }
          if (sawActivity) deadline = Date.now() + REPLY_TIMEOUT_MS;
        }

        // A running tool holds its turn open: one command that blocks for
        // twenty minutes pings the activity mirror once — at the start — so
        // without this the window closes on a session that is visibly
        // mid-task. Bounded by the same per-turn cap as io/.busy, so a tool
        // that never reports back can't zombie a turn.
        if (openTools.size > 0 && Date.now() - turnStartedAt < WORKING_MAX_MS) {
          const held = Date.now() + REPLY_TIMEOUT_MS;
          if (held > deadline) deadline = held;
        }

        // Declared background work: a fresh io/.busy re-arms the window each
        // poll while the flag stays fresh (background jobs run hooks-dark, so
        // the activity mirror never sees them).
        {
          const busy = session.busyMtime();
          if (
            busy > 0 &&
            Date.now() - busy < BUSY_FRESH_MS &&
            Date.now() - turnStartedAt < WORKING_MAX_MS
          ) {
            const held = Date.now() + REPLY_TIMEOUT_MS;
            if (held > deadline) deadline = held;
          }
        }

        const { lines, newOffset } = session.readOutboxFrom(offset);
        offset = newOffset;
        let fallback: { content: string; thinking: string | null; more: boolean } | null = null;

        // parseOutboxLine recovers replies glued onto one line by a write that
        // missed its newline — that used to throw and take BOTH replies with
        // it — and reports anything genuinely unreadable instead of swallowing
        // it. A dropped reply and a slow one look identical from her side, so
        // silence here is the expensive kind.
        const liveParsed: any[] = [];
        for (const line of lines) {
          const objs = parseOutboxLine(line, (fragment, error) => {
            console.error(`[InteractiveCli] UNREADABLE OUTBOX LINE (a reply may be lost): ${error} :: ${fragment.slice(0, 160)}`);
          });
          if (objs.length === 0 && line.trim()) {
            // Nothing readable at all — keep the old behaviour of offering the
            // raw line rather than nothing, now logged on the way past.
            if (chunks === 0) fallback = { content: line, thinking: null, more: false };
            continue;
          }
          for (const obj of objs) liveParsed.push(obj);
        }

        for (const parsed of liveParsed) {
          // Silent-completion sentinel: a turn that genuinely warrants no
          // visible output (rare — internal wakes still narrate) can end the
          // turn cleanly instead of stalling into a timeout by writing
          // {"turn_id":"<id>","silent":true} with no content. Only honor it
          // for THIS turn — a matching turn_id — so stale/other-turn sentinels
          // don't cut a live turn short. Yield done with no text_delta.
          if (parsed.silent === true && parsed.turn_id === turnId) {
            state.consumedOffset = offset;
            state.silentTimeouts = 0;
            session.clearBusy();
            yield { type: 'done', finishReason: 'stop' };
            return;
          }
          const content = typeof parsed.content === 'string' ? parsed.content : null;
          if (!content) continue;
          const thinking = typeof parsed.thinking === 'string' && parsed.thinking.trim()
            ? parsed.thinking
            : null;
          const tid = typeof parsed.turn_id === 'string' ? parsed.turn_id : null;
          const more = parsed.more === true;

          // Our reply — or a continuation chunk whose turn_id the model dropped.
          if (tid === turnId || (tid === null && chunks > 0)) {
            if (thinking) {
              yield { type: 'thinking_delta', text: thinking, kind: 'authored' };
            }
            yield { type: 'text_delta', text: joined(content) };
            emittedText = true;
            chunks++;
            if (more) {
              deadline = Date.now() + REPLY_TIMEOUT_MS; // every chunk re-arms the window
              continue;
            }
            state.consumedOffset = offset;
            state.silentTimeouts = 0;
            // The final line landing ends the declared-busy window.
            session.clearBusy();
            yield { type: 'done', finishReason: 'stop' };
            return;
          }

          if (tid !== null) {
            // A different turn_id: if it's a turn we timed out on, deliver it
            // late rather than dropping it; anything else is stale — skip.
            if (state.unresolved.includes(tid)) {
              // Pay the ledger on the FINAL chunk only. A late reply is as
              // likely to be five lines as one, and clearing the entry on the
              // first of them made every chunk after it read as owed to nobody
              // and get dropped — Aerie measured five chunks written, one
              // delivered (her 519945db). A late reply that never sends its
              // final chunk leaves the entry behind, which costs one extra
              // delivery attempt and never a drop.
              if (!more) state.unresolved = state.unresolved.filter((t) => t !== tid);
              if (thinking) {
                yield { type: 'thinking_delta', text: thinking, kind: 'authored' };
              }
              yield { type: 'text_delta', text: joined(content) };
              emittedText = true;
            } else {
              // Not owed, so it was written after that turn's final line. This
              // used to skip on a bare continue and leave no trace at all —
              // and the offset advance below the loop makes the skip permanent.
              recordOrphanedReply(session.orphanedRepliesPath, tid, content);
            }
            continue;
          }

          // No turn_id before any chunk landed (model forgot) — usable if
          // nothing better shows up in this batch.
          fallback = { content, thinking, more };
        }

        if (fallback !== null && chunks === 0) {
          if (fallback.thinking) {
            yield { type: 'thinking_delta', text: fallback.thinking, kind: 'authored' };
          }
          yield { type: 'text_delta', text: joined(fallback.content) };
          emittedText = true;
          chunks++;
          if (fallback.more) {
            deadline = Date.now() + REPLY_TIMEOUT_MS;
          } else {
            state.consumedOffset = offset;
            state.silentTimeouts = 0;
            session.clearBusy();
            yield { type: 'done', finishReason: 'stop' };
            return;
          }
        }

        await sleep(POLL_MS);
      }
    } finally {
      input.abortSignal?.removeEventListener('abort', abortHandler);
    }

    // Window closed on sustained silence. Ledger the turn so its reply is
    // delivered with the next turn instead of dropped.
    state.consumedOffset = offset;
    state.unresolved.push(turnId);
    if (state.unresolved.length > MAX_UNRESOLVED) state.unresolved.shift();

    if (emittedText) {
      // Something already reached the UI — end the turn gracefully; the
      // remainder arrives with the next message via the ledger.
      state.silentTimeouts = 0; // chunks flowed — the session can speak
      const note = `[Reply window closed after ${REPLY_TIMEOUT_MS / 1000}s of silence mid-delivery — any remaining chunks will arrive with the next message.]`;
      yield { type: 'thinking_delta', text: note, kind: 'system' };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    // Fully silent turn: no chunks AND no tool activity for the whole window.
    // One could be a stall; two in a row is the mute-zombie shape — a session
    // whose every reply is being refused can tick forever without speaking.
    // Recycle it for a fresh window.
    state.silentTimeouts++;
    let recycleNote = '';
    if (state.silentTimeouts >= 2) {
      state.silentTimeouts = 0;
      session.requestRestart();
      recycleNote = ' Two consecutive turns were fully silent — recycling the warm session.';
    }

    yield {
      type: 'error',
      message:
        `heartbeat reply timeout after ${REPLY_TIMEOUT_MS / 1000}s — if the reply lands late it will be delivered with the next message.${recycleNote} ` +
        `Session status: ${session.status}${session.lastError ? ` (${session.lastError})` : ''}. ` +
        `Check data/heartbeat/${key}/session.log`,
      recoverable: true,
    };
  }
}

// ─── Idle outbox watcher ─────────────────────────────────────────────
//
// The never-drop-late sweep only runs at the START of a turn — so a line the
// session writes with nobody talking (a spawned background task finishing,
// a proactive follow-up) used to sit in the outbox until the operator's next
// message knocked. The operator was the delivery mechanism (July 22
// incident). This watcher is the fix: a cheap poller that, while NO turn is
// active for a lane, delivers new outbox lines within seconds via the same
// out-of-turn companion-message path the reminder timers use
// (orchestrator.ts deliverDueTimers): persist → thread activity → ws
// broadcast → push.
//
// Race safety around the shared `consumedOffset` (one per lane, also used by
// the turn-start sweep):
//   • the tick skips any lane with `turnActive` or an `idleDelivery` in
//     flight — checked synchronously, and the offset advance below happens
//     synchronously in the same tick, so a turn starting later can never
//     double-read those bytes;
//   • runTurn sets `turnActive` BEFORE its first await and drains
//     `idleDelivery` before its sweep reads — a watcher batch always lands
//     ahead of the new turn, never interleaved with it.
// Net: every outbox byte is consumed exactly once, by exactly one of the two
// consumers.

const IDLE_WATCH_INTERVAL_MS = (parseInt(process.env.HEARTBEAT_IDLE_WATCH_INTERVAL || '3', 10)) * 1000;
// A batch whose last line says `more:true` is a chunked reply mid-flight —
// hold up to this long for the final chunk so one reply doesn't fragment
// into several thread messages. After the grace, deliver what we have
// (the rest arrives with a later tick — late, never lost).
const IDLE_MORE_GRACE_MS = (parseInt(process.env.HEARTBEAT_IDLE_MORE_GRACE || '20', 10)) * 1000;

// Wired from server.ts at boot (same pattern as agentService.setPushService).
// Null → deliveries still persist + broadcast, just no push.
let idlePushService: PushService | null = null;
export function setHeartbeatPushService(service: PushService): void {
  idlePushService = service;
}

let idleWatcherTimer: ReturnType<typeof setInterval> | null = null;

/** Start the idle watcher once — called when a turn first binds a thread.
 *  unref'd so it never holds the process open. */
function ensureIdleWatcher(): void {
  if (idleWatcherTimer) return;
  idleWatcherTimer = setInterval(idleWatchTick, IDLE_WATCH_INTERVAL_MS);
  idleWatcherTimer.unref?.();
}

/** One watcher pass over every lane. Everything before the delivery promise
 *  is SYNCHRONOUS on purpose — see the race-safety note above. */
function idleWatchTick(): void {
  if (!isHeartbeatEnabled()) return;
  for (const [key, state] of laneStates) {
    if (state.turnActive || state.idleDelivery || !state.boundThreadId) continue;
    const session = getHeartbeatSession(key);

    // Cheap stat-only gate before any parsing.
    const size = session.outboxSize();
    if (size < state.consumedOffset) {
      // Outbox shrank (manual cleanup / reset) — clamp, same as the fresh-
      // flag clamp in runTurnBody, so we never read garbage at a stale offset.
      state.consumedOffset = size;
      state.idleHoldSince = null;
      continue;
    }
    if (size === state.consumedOffset) {
      state.idleHoldSince = null;
      continue;
    }

    const { lines, newOffset } = session.readOutboxFrom(state.consumedOffset);
    if (lines.length === 0) continue; // partial line — wait for its newline

    // Classify WITHOUT committing: if we end up holding for a mid-flight
    // chunked reply, the next tick re-reads and re-classifies from the same
    // offset (the classifier is pure).
    const classified = classifyOutboxLines(lines, state.unresolved);
    if (classified.endsWithMore) {
      if (state.idleHoldSince === null) {
        state.idleHoldSince = Date.now();
        continue;
      }
      if (Date.now() - state.idleHoldSince < IDLE_MORE_GRACE_MS) continue;
      // Grace expired — deliver the partial reply rather than sit on it.
    }
    state.idleHoldSince = null;

    // Commit synchronously BEFORE any async delivery work: offset + ledger
    // move together, and no other consumer can interleave a read in between.
    state.consumedOffset = newOffset;
    state.unresolved = classified.unresolved;
    if (classified.deliveries.length === 0) continue;

    const threadId = state.boundThreadId;
    state.idleDelivery = idleDeliver(key, threadId, classified.deliveries)
      .catch((err) => {
        // Bytes are consumed but delivery failed — log loudly; same
        // best-effort posture as postSystemLine.
        console.error(`[Heartbeat:${key}] idle outbox delivery failed:`, err);
      })
      .finally(() => {
        state.idleDelivery = null;
      });
  }
}

/**
 * Persist one companion message for a watcher batch and fan it out — the
 * exact out-of-turn delivery shape the reminder timers use, plus the
 * thinking-segment metadata a heartbeat turn would have produced (system
 * note + authored `thinking` fields), so the UI renders it like any other
 * companion reply. Lazy imports for the same module-cycle reason as
 * postSystemLine.
 */
async function deliverIdleOutbox(
  key: string,
  threadId: string,
  deliveries: readonly OutboxDelivery[],
): Promise<void> {
  const [{ createMessage, updateThreadActivity }, { registry }, { buildSegments, extractThinkingSummary }] =
    await Promise.all([
      import('../db.js'),
      import('../ws.js'),
      import('../agent.js'),
    ]);

  const lateCount = deliveries.filter((d) => d.kind === 'late').length;
  const note =
    lateCount === deliveries.length
      ? `[Late repl${lateCount === 1 ? 'y' : 'ies'} from an earlier turn that outran its window — delivered as soon as ${lateCount === 1 ? 'it' : 'they'} landed.]`
      : '[Written by the warm session between turns — delivered proactively, without waiting for the next message.]';

  let content = '';
  const thinkingBlocks: ThinkingInsertion[] = [
    { textOffset: 0, content: note, summary: extractThinkingSummary(note), kind: 'system' },
  ];
  for (const d of deliveries) {
    if (content) content += '\n\n';
    if (d.thinking) {
      // Authored by the companion itself (provision.ts prompt contract).
      thinkingBlocks.push({
        textOffset: content.length,
        content: d.thinking,
        summary: extractThinkingSummary(d.thinking),
        kind: 'authored',
      });
    }
    content += d.content;
  }

  const segments = buildSegments(content, [], thinkingBlocks);
  const now = new Date().toISOString();
  const message = createMessage({
    id: randomUUID(),
    threadId,
    role: 'companion',
    content,
    contentType: 'text',
    metadata: {
      source: 'heartbeat-idle-watcher',
      lane: laneTagFor('claude-cli', key),
      ...(segments.length > 0 ? { segments } : {}),
    },
    createdAt: now,
  });
  updateThreadActivity(threadId, now, true);
  registry.broadcast({ type: 'message', message });

  if (idlePushService) {
    let title = 'Companion';
    try { title = getBytelightConfig().identity.companion_name; } catch { /* config not loaded */ }
    const preview = content.substring(0, 120).replace(/\n/g, ' ');
    idlePushService
      .sendIfOffline({ title, body: preview, threadId, tag: `msg-${message.id}`, url: '/chat' })
      .catch((err) => console.error(`[Heartbeat:${key}] idle push error:`, err));
  }

  console.log(`[Heartbeat:${key}] idle outbox watcher delivered ${deliveries.length} line(s) to thread ${threadId}`);
}

// Injectable seam so watcher-tick tests can capture batches without a live
// DB / websocket registry. Production never touches this.
type IdleDeliverFn = typeof deliverIdleOutbox;
let idleDeliver: IdleDeliverFn = deliverIdleOutbox;

// ─── Test surface ────────────────────────────────────────────────────

/**
 * Test-only: reset the in-memory lane-state map. Lets tests run multiple
 * runTurn invocations against the same session key without stale ledger
 * state from a previous case. Also stops the idle watcher interval so a
 * later case can observe a clean start.
 */
export function __resetLaneStateForTests(): void {
  laneStates.clear();
  if (idleWatcherTimer) {
    clearInterval(idleWatcherTimer);
    idleWatcherTimer = null;
  }
  idleDeliver = deliverIdleOutbox;
}

/** Test-only: swap the idle-delivery function so tick tests can capture
 *  batches without a live DB/websocket. Reset by __resetLaneStateForTests. */
export function __setIdleDeliveryForTests(fn: IdleDeliverFn): void {
  idleDeliver = fn;
}

/** Test-only: peek at a lane's state (offset/ledger/flags). */
export function __getLaneStateForTests(key: string): LaneState | undefined {
  return laneStates.get(key);
}

/** Test-only: create/fetch a lane bound to a thread, as a routed turn would. */
export function __bindLaneForTests(key: string, threadId: string): LaneState {
  const state = laneStateFor(key, getHeartbeatSession(key));
  state.boundThreadId = threadId;
  return state;
}

export const __TEST_INTERNALS__ = {
  isHeartbeatEnabled,
  localClock12,
  extractLatestUserPrompt,
  FEATURE_FLAG_ENV,
  HEARTBEAT_RUNTIME_ENV,
  getHeartbeatRuntimeMode,
  classifyOutboxLines,
  idleWatchTick,
  IDLE_MORE_GRACE_MS,
};
