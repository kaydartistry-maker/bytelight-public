// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * Heartbeat session provisioning — writes the session directory layout that
 * keeps an interactive Claude Code session warm on subscription billing.
 *
 * The pattern: a Stop hook re-blocks the session after every turn, delivering
 * inbox messages or idle ticks, so the session never ends and never drifts
 * onto the metered `-p`/SDK lane.
 *
 * H1 INERT — this module is registered but NOT routed to. The
 * `CLAUDE_CLI_HEARTBEAT_ENABLED` feature flag (read by the runtime) gates
 * any disk-writes. Without it, nothing in `data/heartbeat/` ever appears.
 *
 * Layout per session (data/heartbeat/<key>/):
 *   .claude/settings.json   — wires the Stop hook (3600s timeout)
 *   hooks/heartbeat.cjs     — the hook (inbox delivery + idle whispers)
 *   hooks/activity.cjs      — tool-activity mirror (PreToolUse/PostToolUse)
 *   hooks/gate.cjs          — the guest tool gate (PreToolUse, runs first)
 *   hooks/reply.cjs         — the one command a guest's turn may run
 *   CLAUDE.md              — heartbeat operation contract (operational,
 *                             identity-blind; see provisionSessionDir doc)
 *                             + core-memory section (blocks ride here once
 *                             per session, not the per-message payload)
 *   neuralis-core.mcp.json  — the lane's own wire to Neuralis (--mcp-config)
 *   io/                     — inbox.jsonl / outbox.jsonl / flags (runtime state)
 *   io/images/              — image attachments written as files for the agent to Read
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { renderLaneSection, type LaneIdentity } from './lane-identity.js';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { formatBlocksForPrompt, SHARED_SCOPE, COMPANION_SCOPES } from '../memory-blocks.js';
import { atLeast, claudeCliVersion } from './cli-version.js';
import { getBytelightConfig } from '../../config.js';

// Delivery-cap constants. These live here as TS values and are INTERPOLATED
// into the hook source below (byte-identical to the literals they replaced) so
// the backend can measure a turn against the same numbers the hook enforces.
// The hook is a standalone .cjs generated from a string — it cannot import —
// so this is the only way both sides can share one definition.
//
// stdout past ~200KB is persisted instead of parsed and the block decision is
// lost, so a delivered line MUST stay under DELIVERY_CAP. See the commentary
// above `truncateContent` in the hook source for why truncation is
// priority-based rather than positional.
export const DELIVERY_CAP = 150000;
// Reserved floor for the recycle bridge under truncation. The bridge is the
// cross-thread conversation continuity — historically it was the FIRST thing
// sacrificed when fixed content (orientation, once upon a time the full
// core-memory blocks) crowded the cap, which silently killed the companion's
// memory of the conversation it was mid-way through. Under the floor rule the
// bridge is never compressed below this many chars while any other
// compressible content (the stage-2 middle mass) remains; only when the fixed
// content ALONE exceeds DELIVERY_CAP may the bridge shrink further (the
// bridge-minimal breadcrumb fallback stays as last resort).
export const BRIDGE_FLOOR = 40000;
export const BRIDGE_HEAD_MARK = '[Session recycled — recent conversation, oldest first, for continuity:]';
export const BRIDGE_TAIL_MARK = '[End of context. The message below continues this conversation — respond to it in character.]';

/**
 * The Stop hook. The session relies on a CommonJS-shaped script (`.cjs`) so it
 * runs identically regardless of the host project's package.json `type`, and
 * surfaces a turn_id so the runtime can match replies to the turns that asked
 * for them.
 *
 * Stretched polling: 1180 polls x ~3s ~= 59 min per block. Claude Code
 * force-ends after 8 consecutive blocks (anti-loop guard), so idle warmth
 * ~= 8 hours ceiling, then a clean recycle. Combined with sleep mode
 * (HEARTBEAT_SLEEP_AFTER), active days stay warm while true overnight idle
 * parks completely.
 */
const HOOK_SOURCE = `#!/usr/bin/env node
// heartbeat.cjs — keeps the interactive session warm; delivers inbox messages.
// Managed by byte-light — edits are overwritten.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CWD = path.resolve(__dirname, '..');
const INBOX = path.join(CWD, 'io', 'inbox.jsonl');
const OFFSET_FILE = path.join(CWD, 'io', '.inbox-offset');
const LAST_TICK_FILE = path.join(CWD, 'io', '.last-tick');
const LAST_MESSAGE_FILE = path.join(CWD, 'io', '.last-message');
const AUDIENCE_FILE = path.join(CWD, 'io', '.turn-audience');
const RESPONDED_FLAG = path.join(CWD, 'io', '.responded');
const SLEEPING_FLAG = path.join(CWD, 'io', '.sleeping');
const IS_WIN = process.platform === 'win32';
const MIN_INTERVAL = (parseInt(process.env.HEARTBEAT_INTERVAL || '86400')) * 1000;
const SLEEP_AFTER_MS = (parseInt(process.env.HEARTBEAT_SLEEP_AFTER || '10800')) * 1000;

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

// Stale-session fence (second pass): the supervisor's recycle kill SIGTERMs
// only the claude process — this hook survives it and its next 3s poll could
// consume the very message the recycle held for the NEW session, writing the
// block decision to a dead pipe (turn dies on timeout). A ppid guard cannot
// see this: claude spawns hooks via /bin/sh -c, and dash keeps that wrapper
// alive instead of exec'ing — the tree is claude -> sh -> node, so when claude
// dies only the SHELL is reparented; the hook's own ppid never changes. The
// real fence is the session EPOCH: the supervisor stamps io/.session-epoch at
// every launch, BEFORE the held message is appended. A hook may only consume
// while the epoch still matches the one it started under — a message being
// visible implies the new epoch is already visible, so a stale hook always
// exits before touching it. The ppid check stays as belt-and-suspenders for
// direct-child spawns.
const EPOCH_FILE = path.join(CWD, 'io', '.session-epoch');
function readEpoch() {
  try { return fs.readFileSync(EPOCH_FILE, 'utf8').trim(); } catch { return ''; }
}
const MY_EPOCH = readEpoch();
const INITIAL_PPID = process.ppid;
function stale() {
  if (!IS_WIN && process.ppid !== INITIAL_PPID) return true; // reparented mid-run
  return readEpoch() !== MY_EPOCH; // a newer session owns the inbox now
}

function readOffset() {
  try { return parseInt(fs.readFileSync(OFFSET_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}

function writeSync(filepath, data) {
  // tmp+rename, never truncate-in-place: the supervisor reads these files on
  // its own clock, and an open-with-'w' leaves a zero-byte window where a
  // torn read parses to 0 — a healthy lane suddenly looks dead since epoch.
  const tmp = filepath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, filepath);
}

function writeOffset(n) {
  writeSync(OFFSET_FILE, String(n));
}

function readLastTick() {
  try { return parseInt(fs.readFileSync(LAST_TICK_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}

function writeLastTick() {
  writeSync(LAST_TICK_FILE, String(Date.now()));
}

function readLastMessage() {
  try { return parseInt(fs.readFileSync(LAST_MESSAGE_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}

function shouldSleep() {
  const lastMsg = readLastMessage();
  if (lastMsg === 0) return false; // no marker yet — stay awake
  return Date.now() - lastMsg > SLEEP_AFTER_MS;
}

function checkInbox() {
  if (stale()) process.exit(0); // never consume a line nobody can deliver
  try {
    if (!fs.existsSync(INBOX)) return null;
    const size = fs.statSync(INBOX).size;
    const offset = readOffset();
    if (size <= offset) return null;

    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(INBOX, 'r');
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);

    const raw = buf.toString('utf8');
    const nlIndex = raw.indexOf('\\n');
    const line = nlIndex === -1 ? raw : raw.slice(0, nlIndex);
    if (!line.trim()) return null;

    // Re-check between read and commit: this line postdates the epoch that
    // authorized it, so if the epoch moved while we were reading, the line
    // belongs to the successor session — exit without advancing the offset.
    if (stale()) process.exit(0);

    writeOffset(offset + Buffer.byteLength(line, 'utf8') + (nlIndex === -1 ? 0 : 1));

    try { return JSON.parse(line); } catch {
      return { ts: new Date().toISOString(), channel: 'inbox', author: 'user', content: line.trim() };
    }
  } catch { return null; }
}

// stdout past ~200KB is persisted instead of parsed and the block decision is
// lost — the session dies. So a delivered line MUST stay under this cap. The
// backend assembles content as: [recycle bridge?][orientation [Context]?][the
// owner's new message]. The bridge (recent-history re-prime, only present on a
// session recycle/model-swap) is by far the largest part and rides at the HEAD;
// the owner's ACTUAL new message rides at the TAIL. A naive head-keeping slice
// therefore cuts the real message away entirely — the warm session then sees
// "no new message" and answers {"silent":true}, and the owner's turn vanishes.
// So truncation is PRIORITY-based, not positional: the bridge is compressed
// from its MIDDLE first (keeping its framing + the "message below continues"
// handoff), and only if that is not enough does the remaining content lose its
// MIDDLE — never the tail, where the message and (appended below) turn_id live.
const DELIVERY_CAP = ${DELIVERY_CAP};
// Bridge floor: continuity is never the first sacrifice. See provision.ts.
const BRIDGE_FLOOR = ${BRIDGE_FLOOR};
const BRIDGE_HEAD_MARK = '${BRIDGE_HEAD_MARK}';
const BRIDGE_TAIL_MARK = '${BRIDGE_TAIL_MARK}';

function truncateContent(content) {
  if (content.length <= DELIVERY_CAP) return content;

  // 1. If a recycle bridge is present, compress it from the middle first —
  //    it's the compressible mass — but never below BRIDGE_FLOOR while any
  //    other compressible content remains. Keep both bridge markers and
  //    enough of the oldest/newest turns for continuity; drop the middle.
  const headIdx = content.indexOf(BRIDGE_HEAD_MARK);
  const tailMarkIdx = content.indexOf(BRIDGE_TAIL_MARK);
  if (headIdx !== -1 && tailMarkIdx > headIdx) {
    const bridgeStart = headIdx;
    const bridgeEnd = tailMarkIdx + BRIDGE_TAIL_MARK.length; // through the tail marker
    const before = content.slice(0, bridgeStart);
    const bridge = content.slice(bridgeStart, bridgeEnd);
    const after = content.slice(bridgeEnd); // orientation + owner's message + trailing handoff
    const marker = '\\n\\n[…bridge trimmed to fit delivery cap — middle of the re-primed history dropped; full history in the thread archive]\\n\\n';
    // How much bridge can we keep? Budget minus everything that must survive.
    const fixed = before.length + after.length + marker.length;
    const bridgeBudget = DELIVERY_CAP - fixed;
    if (bridgeBudget >= BRIDGE_FLOOR) {
      // Split the surviving bridge budget between its head (oldest turns +
      // framing) and its tail (newest turns + the "message below" handoff).
      const keep = Math.floor(bridgeBudget / 2);
      const trimmedBridge = bridge.slice(0, keep) + marker + bridge.slice(bridge.length - (bridgeBudget - keep));
      content = before + trimmedBridge + after;
      if (content.length <= DELIVERY_CAP) return content;
    } else if (fixed <= DELIVERY_CAP) {
      // Bridge floor: the non-bridge mass is what overflows. Hold the bridge
      // at BRIDGE_FLOOR and cut the middle of the remainder instead — the
      // tail (the owner's message + turn_id) always survives.
      const floorKeep = Math.min(bridge.length, BRIDGE_FLOOR);
      let trimmedBridge = bridge;
      if (bridge.length > floorKeep) {
        const keep = Math.floor((floorKeep - marker.length) / 2);
        trimmedBridge = bridge.slice(0, keep) + marker + bridge.slice(bridge.length - (floorKeep - marker.length - keep));
      }
      content = before + trimmedBridge + after;
      if (content.length <= DELIVERY_CAP) return content;
      const midMarker = '\\n[…truncated in the middle to fit delivery cap — full message in the thread archive]\\n';
      const room = DELIVERY_CAP - before.length - trimmedBridge.length - midMarker.length;
      if (room > 0 && after.length > room) {
        const head = Math.floor(room / 2);
        const tail = room - head;
        return before + trimmedBridge + after.slice(0, head) + midMarker + after.slice(after.length - tail);
      }
      // pathological — fall through to the stage-2 whole-content middle cut
    } else {
      // Fixed content ALONE exceeds the cap — only now may the bridge shrink
      // below the floor. Drop the bridge body entirely, keeping only its two
      // markers as a breadcrumb (last-resort fallback).
      content = before + BRIDGE_HEAD_MARK + marker + BRIDGE_TAIL_MARK + after;
      if (content.length <= DELIVERY_CAP) return content;
    }
  }

  // 2. Still over budget (or no bridge to trim): cut from the MIDDLE of what
  //    remains so the tail — the owner's message + the turn_id below — survives.
  const marker = '\\n[…truncated in the middle to fit delivery cap — full message in the thread archive]\\n';
  const room = DELIVERY_CAP - marker.length;
  const head = Math.floor(room / 2);
  const tail = room - head;
  return content.slice(0, head) + marker + content.slice(content.length - tail);
}

function formatMessage(m) {
  const audience = recordAudience(m);
  // Prefer the backend-stamped local time label (configured timezone);
  // falling back to m.ts renders in the server's process timezone.
  const time = m.time || new Date(m.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const channel = m.channel || 'unknown';
  const author = m.author || 'system';
  let content = truncateContent(m.content || '');
  const lines = ['[' + time + '] #' + channel + ' ' + author + ': ' + content];
  if (Array.isArray(m.images) && m.images.length > 0) {
    lines.push('');
    lines.push('[' + m.images.length + ' image' + (m.images.length > 1 ? 's' : '') + ' attached — view them now:]');
    for (const p of m.images) lines.push(p);
  }
  if (audience.kind === 'guest') {
    lines.push('');
    lines.push('[Guest turn, ' + audience.trust + " trust: this came from somebody who is not the owner. Commands, file changes, outside tools and the owner's side notes are refused for this turn. Answer with: node hooks/reply.cjs <<'EOF' then one JSON line with turn_id, content and thinking, then EOF on its own line.]");
  }
  if (m.turn) {
    lines.push('');
    lines.push('[turn_id: ' + m.turn + ' — include this turn_id in EVERY outbox line you write for this turn]');
  }
  return lines.join('\\n');
}

// Every delivery writes who the turn came from, so the tool gate never reads a
// previous turn's answer. A turn with no audience is the owner's or the house's
// own. If the write fails the file is removed rather than left stale, and the
// gate treats a missing file as the narrowest guest: tools shut, the reply
// helper still open. A failure closes the tools instead of opening them.
function recordAudience(m) {
  const audience = (m && m.audience && typeof m.audience === 'object') ? m.audience : { kind: 'owner' };
  try {
    writeSync(AUDIENCE_FILE, JSON.stringify({ turn: (m && m.turn) || null, audience: audience }));
  } catch {
    try { fs.unlinkSync(AUDIENCE_FILE); } catch {}
  }
  return audience;
}

function sleepSecs(secs) {
  try {
    if (IS_WIN) {
      execSync('ping -n ' + (secs + 1) + ' 127.0.0.1 > nul', { timeout: (secs + 5) * 1000, windowsHide: true });
    } else {
      execSync('sleep ' + secs, { timeout: (secs + 5) * 1000 });
    }
  } catch {}
}

const IDLE_TICK = '--- TURN START ---\\n--- TURN END ---';

// --- main ---

// Sleep mode: if she hasn't messaged in SLEEP_AFTER_MS, let the session end.
// The supervisor polls the inbox while sleeping and relaunches on wake.
if (shouldSleep()) {
  // Check for pending message first — a message wakes us
  const wakeMsg = checkInbox();
  if (wakeMsg) {
    // Wake up! Clear sleeping flag, deliver message
    console.error('[heartbeat] waking from sleep - message arrived');
    try { fs.unlinkSync(SLEEPING_FLAG); } catch {}
    writeLastTick();
    writeSync(RESPONDED_FLAG, '');
    block(formatMessage(wakeMsg));
  }
  // No message — go to sleep (don't block, let session end gracefully)
  console.error('[heartbeat] entering sleep mode - no messages for ' + Math.round(SLEEP_AFTER_MS / 1000 / 60) + ' min');
  writeSync(SLEEPING_FLAG, String(Date.now()));
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}

// 0. Just responded to a real message? Deliver any queued message, else poll.
if (fs.existsSync(RESPONDED_FLAG)) {
  fs.unlinkSync(RESPONDED_FLAG);
  const next = checkInbox();
  if (next) {
    writeSync(RESPONDED_FLAG, '');
    block(formatMessage(next));
  }
  // Don't emit an idle tick here — fall through to the polling loop instead.
  // Emitting idle ticks after every response burns through Claude's 8-block
  // limit even during active conversation. The polling loop keeps the session
  // warm without burning blocks until a full poll window passes with no
  // messages.
}

// 1. Immediate inbox check — deliver one message
const msg = checkInbox();
if (msg) {
  writeLastTick();
  writeSync(RESPONDED_FLAG, '');
  block(formatMessage(msg));
}

// 2. No messages — poll so a warm session answers fast, then idle.
const elapsed = Date.now() - readLastTick();
if (elapsed < MIN_INTERVAL) {
  // 1180 x 3s ~= 59 min per block: stretched polling. Combined with the
  // 8-block ceiling = ~8h warmth; sleep mode parks true idle.
  for (let i = 0; i < 1180; i++) {
    if (stale()) process.exit(0); // a dead session's tick would mask a stuck successor from the watchdog
    writeLastTick();
    sleepSecs(3);
    const retryMsg = checkInbox();
    if (retryMsg) {
      writeLastTick();
      writeSync(RESPONDED_FLAG, '');
      block(formatMessage(retryMsg));
    }
  }
  block(IDLE_TICK);
}

// 3. Interval elapsed — send idle tick
writeLastTick();
block(IDLE_TICK);
`;

/** What the delivery cap would do to one assembled payload. Report only. */
export interface DeliveryMeasurement {
  /** Full assembled payload (bridge + orientation + the owner's message). */
  payloadChars: number;
  /** The `<core-memory>…</core-memory>` slice of the payload, 0 if absent. */
  memoryChars: number;
  /** The session-recycle conversation bridge, 0 when this isn't a recycle. */
  bridgeChars: number;
  /** DELIVERY_CAP, echoed so a log line is self-describing. */
  cap: number;
  /** Did truncation fire, and which stage did the cutting. 'bridge-floor' =
   *  the bridge was held at BRIDGE_FLOOR and the non-bridge middle mass was
   *  cut instead. */
  stage: 'none' | 'bridge' | 'bridge-floor' | 'bridge-minimal' | 'middle';
  /** Chars the bridge lost (stage 1). */
  bridgeDropped: number;
  /** Chars the remaining payload lost from its middle (stage 2). */
  middleDropped: number;
  /** What actually reaches the session after truncation. */
  deliveredChars: number;
}

// Exported: the runtime uses these to strip the core-memory span from the
// per-message orientation (the blocks ride the session's CLAUDE.md instead —
// see renderCoreMemorySection below).
export const MEMORY_OPEN = '<core-memory>';
export const MEMORY_CLOSE = '</core-memory>';

/**
 * Measure one assembled payload against the delivery cap WITHOUT truncating it.
 *
 * This mirrors the arithmetic of `truncateContent` in HOOK_SOURCE above so the
 * backend can log what the hook is about to do. It is observation only — it
 * never touches the delivered bytes, and nothing in the delivery path branches
 * on its result.
 *
 * KEEP IN SYNC with `truncateContent` above (same file, ~80 lines up). If the
 * hook's truncation strategy changes, this report goes stale silently.
 */
export function measureDelivery(content: string): DeliveryMeasurement {
  // The two trim markers are the hook's, byte-for-byte — their lengths are part
  // of the budget arithmetic, so they must match or the numbers drift.
  const BRIDGE_TRIM_MARKER =
    '\n\n[…bridge trimmed to fit delivery cap — middle of the re-primed history dropped; full history in the thread archive]\n\n';
  const MIDDLE_TRIM_MARKER =
    '\n[…truncated in the middle to fit delivery cap — full message in the thread archive]\n';

  const memOpen = content.indexOf(MEMORY_OPEN);
  const memClose = content.indexOf(MEMORY_CLOSE);
  const memoryChars =
    memOpen !== -1 && memClose > memOpen ? memClose + MEMORY_CLOSE.length - memOpen : 0;

  const headIdx = content.indexOf(BRIDGE_HEAD_MARK);
  const tailMarkIdx = content.indexOf(BRIDGE_TAIL_MARK);
  const hasBridge = headIdx !== -1 && tailMarkIdx > headIdx;
  const bridgeEnd = tailMarkIdx + BRIDGE_TAIL_MARK.length;
  const bridgeChars = hasBridge ? bridgeEnd - headIdx : 0;

  const base: DeliveryMeasurement = {
    payloadChars: content.length,
    memoryChars,
    bridgeChars,
    cap: DELIVERY_CAP,
    stage: 'none',
    bridgeDropped: 0,
    middleDropped: 0,
    deliveredChars: content.length,
  };

  if (content.length <= DELIVERY_CAP) return base;

  // Stage 1 — compress the recycle bridge from its middle (floor-guarded).
  let remaining = content.length;
  let bridgeDropped = 0;
  if (hasBridge) {
    const beforeLen = headIdx;
    const afterLen = content.length - bridgeEnd;
    const fixed = beforeLen + afterLen + BRIDGE_TRIM_MARKER.length; // before + after + marker
    const bridgeBudget = DELIVERY_CAP - fixed;
    if (bridgeBudget >= BRIDGE_FLOOR) {
      // Surviving bridge is exactly `bridgeBudget`; total lands on the cap.
      bridgeDropped = bridgeChars - bridgeBudget;
      return { ...base, stage: 'bridge', bridgeDropped, deliveredChars: fixed + bridgeBudget };
    }
    if (fixed <= DELIVERY_CAP) {
      // Bridge floor: the bridge is held at BRIDGE_FLOOR and the non-bridge
      // middle mass is cut instead. Mirrors the hook's floor branch.
      const floorKeep = Math.min(bridgeChars, BRIDGE_FLOOR);
      bridgeDropped = bridgeChars - floorKeep;
      const flooredTotal = beforeLen + floorKeep + afterLen;
      if (flooredTotal <= DELIVERY_CAP) {
        return { ...base, stage: 'bridge-floor', bridgeDropped, deliveredChars: flooredTotal };
      }
      const room = DELIVERY_CAP - beforeLen - floorKeep - MIDDLE_TRIM_MARKER.length;
      if (room > 0 && afterLen > room) {
        return {
          ...base,
          stage: 'bridge-floor',
          bridgeDropped,
          middleDropped: afterLen - room,
          deliveredChars: beforeLen + floorKeep + MIDDLE_TRIM_MARKER.length + room,
        };
      }
      remaining = flooredTotal; // pathological — stage-2 middle cut below
    } else {
      // Fixed content alone exceeds the cap — bridge body dropped entirely,
      // only its two markers survive (last-resort fallback).
      const kept = BRIDGE_HEAD_MARK.length + BRIDGE_TRIM_MARKER.length + BRIDGE_TAIL_MARK.length;
      bridgeDropped = bridgeChars - kept;
      remaining = headIdx + kept + afterLen;
      if (remaining <= DELIVERY_CAP) {
        return { ...base, stage: 'bridge-minimal', bridgeDropped, deliveredChars: remaining };
      }
    }
  }

  // Stage 2 — cut the middle of whatever is left; the tail (the owner's
  // message + the turn_id appended below it) always survives.
  return {
    ...base,
    stage: 'middle',
    bridgeDropped,
    middleDropped: remaining - DELIVERY_CAP,
    deliveredChars: DELIVERY_CAP,
  };
}

/**
 * Tool-activity hook — surfaces the session's tool calls to byte-light.
 *
 * PreToolUse/PostToolUse append one compact JSON line per event to
 * io/activity.jsonl; the runtime tails that file during a turn and streams
 * the entries to the UI as live tool chips (and treats them as liveness,
 * re-arming the reply window — a session deep in tool work is not silent).
 * Never blocks: always exits 0, output is best-effort.
 */
const ACTIVITY_HOOK_SOURCE = `#!/usr/bin/env node
// activity.cjs — mirrors tool calls into io/activity.jsonl for byte-light's runtime.
// Managed by byte-light — edits are overwritten. Always exits 0 (never blocks tools).

const fs = require('fs');
const path = require('path');

const PHASE = process.argv[2] === 'post' ? 'post' : 'pre';
// A compaction is work in hand too. A room squashing its memory writes no
// tick, chunk or tool line for minutes, and both clocks read that as a hang:
// the watchdog could kill a room mid-squash, then kill the room it reopened,
// which had gone straight back to compacting. PreCompact and PostCompact open
// and close it like a tool, under one fixed id so the two halves pair across
// their separate processes.
const COMPACT = process.argv[3] === 'compact';
const OUT = path.join(path.resolve(__dirname, '..'), 'io', 'activity.jsonl');
const TRUNC = 160;
const RESULT_TRUNC = 2000;

function summarize(tool, input) {
  if (!input || typeof input !== 'object') return '';
  const i = input;
  let s = '';
  if (typeof i.description === 'string' && i.description) s = i.description;
  else if (typeof i.command === 'string') s = i.command;
  else if (typeof i.file_path === 'string') s = i.file_path;
  else if (typeof i.pattern === 'string') s = i.pattern;
  else if (typeof i.url === 'string') s = i.url;
  else if (typeof i.query === 'string') s = i.query;
  else if (typeof i.prompt === 'string') s = i.prompt;
  s = String(s).replace(/\\s+/g, ' ').trim();
  return s.length > TRUNC ? s.slice(0, TRUNC) + '…' : s;
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
try {
  const hook = JSON.parse(raw || '{}');
  const line = COMPACT
    ? { ts: new Date().toISOString(), phase: PHASE, id: 'compact', tool: 'Compacting' }
    : {
        ts: new Date().toISOString(),
        phase: PHASE,
        id: typeof hook.tool_use_id === 'string' ? hook.tool_use_id : null,
        tool: typeof hook.tool_name === 'string' ? hook.tool_name : 'tool',
      };
  if (PHASE === 'pre') {
    line.detail = COMPACT ? "squashing this room's memory to make space" : summarize(line.tool, hook.tool_input);
  }
  if (PHASE === 'post') {
    // PostToolUse stdin carries the tool result as tool_response (object or
    // string). Mirror it so the runtime can fill the tool chip instead of
    // shipping an empty locket. Best-effort: never let capture break the call.
    try {
      const r = hook.tool_response;
      if (r !== undefined && r !== null) {
        const s = typeof r === 'string' ? r : JSON.stringify(r);
        line.output = s.length > RESULT_TRUNC ? s.slice(0, RESULT_TRUNC) : s;
      }
      if (r && typeof r === 'object' && r.is_error === true) line.isError = true;
    } catch {}
  }
  fs.appendFileSync(OUT, JSON.stringify(line) + '\\n', 'utf8');
} catch {}
process.exit(0);
`;

// gate.cjs — refuses host tools on a guest's turn. See services/turn-audience.ts.
// String.raw so the source is written out byte for byte.
const GATE_HOOK_SOURCE = String.raw`#!/usr/bin/env node
// gate.cjs — what a guest's turn may do with tools. Managed by byte-light — edits
// are overwritten.
//
// The warm lane answers Discord guests from the same room as the owner, with
// the same tools, so what a guest's turn can reach is decided here, at the
// tool door, from the audience the Stop hook wrote when it handed the turn
// over (io/.turn-audience). The owner's turns and the house's wakes pass.
// A guest's turn may read what it was handed and, at standard or full trust,
// the house's own source; it answers through hooks/reply.cjs. It cannot run a
// command, change a file or use an outside tool. Exit 2 refuses the call and
// hands the reason back to the session.
'use strict';
const fs = require('fs');
const path = require('path');

const CWD = path.resolve(__dirname, '..');
const AUDIENCE_FILE = path.join(CWD, 'io', '.turn-audience');
// The lane lives at <repo>/data/heartbeat/<lane>.
const REPO = path.resolve(CWD, '..', '..', '..');
const REPLY_OPENER = "node hooks/reply.cjs <<'EOF'";

function allow() { process.exit(0); }
function refuse(reason) {
  process.stderr.write(reason + '\n');
  process.exit(2);
}

function readAudience() {
  let raw;
  try { raw = fs.readFileSync(AUDIENCE_FILE, 'utf8'); } catch (err) {
    return { state: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const parsed = JSON.parse(raw);
    const a = parsed && parsed.audience;
    if (a && a.kind === 'owner') return { state: 'ok', audience: a };
    if (a && a.kind === 'guest' && ['full', 'standard', 'limited'].includes(a.trust)) return { state: 'ok', audience: a };
  } catch {}
  return { state: 'unreadable' };
}

function real(p) {
  const abs = path.resolve(CWD, String(p));
  try { return fs.realpathSync(abs); } catch { return abs; }
}
function within(root, p) {
  return p === root || p.startsWith(root + path.sep);
}
function hidden(p, root) {
  return path.relative(root, p).split(path.sep).some((part) => part.startsWith('.'));
}
// What the turn itself was handed: the pictures that came with it. Readable at
// every trust level. The owner's side notes are deliberately NOT here:
// io/side-notes.jsonl is the owner's whole note history, never emptied, and it
// is theirs. A note the owner sends while a guest's turn is running is handed
// to the next turn instead.
function turnInput(p) {
  return within(path.join(CWD, 'io', 'images'), p);
}
// The house's own source and docs, never anything under a dotted name.
// Config and key files that live in the tree but carry secrets or machine
// specifics. The dot-hidden rule already covers .env and friends; these are the
// ones with ordinary names a guest could otherwise Read (google-services.json
// has a Firebase key, local.properties/server-url.local carry machine paths).
function sensitiveHouseFile(p) {
  const base = path.basename(p).toLowerCase();
  if (['google-services.json', 'local.properties', 'server-url.local',
       'keystore.properties', 'secrets.json', 'credentials.json',
       'bytelight.yaml', 'bytelight.yml', 'ecosystem.config.cjs', 'auth.json'].includes(base)) return true;
  if (/\.(jks|keystore|p12|pfx|pem|key)$/.test(base)) return true;
  if (/\.db(-wal|-shm)?$/.test(base)) return true;
  if (base.startsWith('.env')) return true;
  return false;
}
// byte-light: local state the house keeps out of git (data/, logs/) is never
// house source, even when a copy of it sits under packages/.
function localState(p, root) {
  return path.relative(root, p).split(path.sep).some((part) => part === 'data' || part === 'logs');
}
function houseSource(p) {
  if (sensitiveHouseFile(p)) return false;
  for (const dir of ['packages', 'docs']) {
    const root = path.join(REPO, dir);
    if (within(root, p) && !hidden(p, root) && !localState(p, root)) return true;
  }
  return false;
}

// The one command a guest's turn may run: the reply helper fed a quoted
// heredoc, and nothing after the terminator. With the delimiter quoted the
// body is data, and the helper only ever parses it as JSON.
function isReplyCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const lines = cmd.replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 3 || lines[0].trim() !== REPLY_OPENER || lines[lines.length - 1] !== 'EOF') return false;
  for (let i = 1; i < lines.length - 1; i++) if (lines[i] === 'EOF') return false;
  return true;
}

// The owner's turn is decided FIRST, before the call is even read, so nothing
// odd about a tool call can ever stand between the owner and their own house.
// readAudience never throws.
const seen = readAudience();
if (seen.state === 'ok' && seen.audience.kind === 'owner') allow();

// Everything below is a guest's turn, or a turn nobody recorded. An unrecorded
// turn (audience missing, unreadable, or a trust this build does not know) is
// handled as the narrowest guest rather than refused outright: tools stay
// shut, but the reply helper still works, so the lane can always answer.
// And the whole decision is wrapped: Claude Code lets a call THROUGH on any
// exit other than 2, so a gate that crashed would open the door. Any error in
// here refuses instead. BYTELIGHT_GATE_FAULT is the test's fault seam; it can only
// ever make the gate refuse, never allow.
try {
  if (process.env.BYTELIGHT_GATE_FAULT === '1') throw new Error('injected fault');
  const trust = seen.state === 'ok' ? seen.audience.trust : 'limited';
  const unrecorded = seen.state === 'ok' ? '' : (seen.state === 'missing'
    ? 'No audience is recorded for this turn (io/.turn-audience is missing), so it is treated as a limited guest. '
    : 'The audience for this turn (io/.turn-audience) cannot be read, so it is treated as a limited guest. ');

  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { input = null; }
  if (!input || typeof input !== 'object') refuse(unrecorded + 'The tool gate could not read this call, so it is refused.');

  // A call from inside a subagent carries agent_id. A guest's turn cannot start
  // one (the Agent tool is refused below), so any subagent running was started
  // by the owner's turn or a wake, and the audience file it is reading now
  // belongs to whatever turn came after. Oct 21 2026 it froze a background
  // builder for the length of a guest's visit.
  if (typeof input.agent_id === 'string' && input.agent_id) allow();

  const tool = String(input.tool_name || '');
  const args = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
  const how = "Answer with the reply helper: node hooks/reply.cjs <<'EOF', then one JSON line with turn_id, content and thinking, then EOF on its own line.";
  const why = unrecorded || ('This turn came from a guest (' + trust + ' trust), not the owner. ');

  if (tool === 'ToolSearch') allow();
  if (tool === 'Bash') {
    if (isReplyCommand(args.command)) allow();
    refuse(why + 'A guest turn cannot run commands. ' + how);
  }
  if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') {
    const targets = [];
    if (tool === 'Read') targets.push(args.file_path);
    else {
      if (!args.path) refuse(why + 'Searching needs an explicit path inside the house source.');
      targets.push(args.path);
      if (tool === 'Glob' && typeof args.pattern === 'string' && (path.isAbsolute(args.pattern) || args.pattern.split(/[\\/]/).includes('..'))) {
        refuse(why + 'A search pattern cannot leave the path it was given.');
      }
    }
    const ok = targets.every((t) => {
      if (typeof t !== 'string' || !t) return false;
      const p = real(t);
      return turnInput(p) || (trust !== 'limited' && houseSource(p));
    });
    if (ok) allow();
    refuse(why + (trust === 'limited'
      ? 'At limited trust it can read only what came with the turn.'
      : 'It can read what came with the turn and the house source under packages/ and docs/, nothing else.'));
  }
  refuse(why + 'It cannot change files or use ' + tool + '. ' + how);
} catch (err) {
  refuse('The tool gate hit an error (' + ((err && err.message) || String(err)) + '), so this call is refused rather than let through.');
}
`;

// reply.cjs — the one command a guest's turn may run.
const REPLY_HOOK_SOURCE = String.raw`#!/usr/bin/env node
// reply.cjs — how a guest's turn writes its answer. Managed by byte-light — edits
// are overwritten.
//
// Reads one JSON object from stdin and appends it to io/outbox.jsonl, after
// checking it is only a reply: this turn's turn_id, the words, an optional
// thinking note, the chunk flag, and the silent sentinel. Anything else is refused, which is what
// lets the tool gate allow this one command on a guest's turn: the heredoc
// that feeds it is data, never code. A guest's reply cannot attach a file.
'use strict';
const fs = require('fs');
const path = require('path');

const CWD = path.resolve(__dirname, '..');
const OUTBOX = path.join(CWD, 'io', 'outbox.jsonl');
const AUDIENCE_FILE = path.join(CWD, 'io', '.turn-audience');
const KEYS = ['turn_id', 'content', 'thinking', 'more', 'silent'];

function fail(reason) {
  process.stderr.write('reply refused: ' + reason + '\n');
  process.exit(1);
}

let obj;
try { obj = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { fail('stdin is not one JSON object'); }
if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('stdin is not one JSON object');
for (const key of Object.keys(obj)) if (!KEYS.includes(key)) fail('unexpected field ' + key);
if (typeof obj.turn_id !== 'string' || !obj.turn_id) fail('turn_id must be a string');
// byte-light's lane ends a turn with nothing to say as {"turn_id":"…","silent":true}.
if (obj.silent !== undefined && obj.silent !== true) fail('silent must be true when present');
if (obj.silent === true) {
  if (obj.content !== undefined && typeof obj.content !== 'string') fail('content must be text');
} else if (typeof obj.content !== 'string' || !obj.content.trim()) fail('content must be non-empty text');
if (obj.thinking !== undefined && typeof obj.thinking !== 'string') fail('thinking must be text');
if (obj.more !== undefined && typeof obj.more !== 'boolean') fail('more must be true or false');
// The house reads the marker in any case ([DISCORD-ATTACH: works as well as
// lowercase), so the check here has to as well.
if (typeof obj.content === 'string' && /\[\s*discord-attach\s*:/i.test(obj.content)) fail("a guest's reply cannot attach a file");

let current = null;
try { current = JSON.parse(fs.readFileSync(AUDIENCE_FILE, 'utf8')).turn || null; } catch {}
if (current && obj.turn_id !== current) fail("that turn_id is not this turn's");

const line = {};
for (const key of KEYS) if (obj[key] !== undefined) line[key] = obj[key];
fs.appendFileSync(OUTBOX, JSON.stringify(line) + '\n', 'utf8');
process.stdout.write('ok\n');
`;

/**
 * The lane's hook wiring. Every command names its script by ABSOLUTE path:
 * Claude Code runs a hook from the shell's current directory, and a command
 * that moved into a subfolder (cd io/images) left `node hooks/gate.cjs`
 * pointing at io/images/hooks/gate.cjs, which does not exist. A hook that cannot even be found
 * exits 1, and Claude Code lets the call THROUGH on any exit but 2, so the
 * guest gate failed open for as long as the shell stood there. The scripts
 * themselves already find their files from their own location.
 */
/** Settings a newer Claude Code understands, turned on only once the box runs
 *  it (off the CLI's own release notes). 2.1.295: a hook
 *  that fails to start or exits oddly can block instead of letting the call
 *  through, which is how a guest gate can be quietly off. */
export function newerCliSettings(version: [number, number, number] | null): { gateBlocks: boolean } {
  return {
    gateBlocks: atLeast(version, [2, 1, 295]),
  };
}

function settingsJson(dir: string, version: [number, number, number] | null = claudeCliVersion()): string {
  const hook = (name: string, args = ''): string =>
    `node "${join(resolve(dir), 'hooks', name)}"${args ? ' ' + args : ''}`;
  const newer = newerCliSettings(version);
  return JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: hook('heartbeat.cjs'),
                timeout: 3600,
              },
            ],
          },
        ],
        // The guest gate runs first, in front of every tool call. See
        // services/turn-audience.ts.
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: hook('gate.cjs'),
                timeout: 10,
                ...(newer.gateBlocks ? { onFailure: 'block' } : {}),
              },
            ],
          },
          {
            hooks: [
              {
                type: 'command',
                command: hook('activity.cjs', 'pre'),
                timeout: 10,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: hook('activity.cjs', 'post'),
                timeout: 10,
              },
            ],
          },
        ],
        // A compaction marked as work in hand from its start to its end, so
        // neither the reply window nor the watchdog takes it for a hang. See
        // COMPACT in activity.cjs.
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: hook('activity.cjs', 'pre compact'),
                timeout: 10,
              },
            ],
          },
        ],
        PostCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: hook('activity.cjs', 'post compact'),
                timeout: 10,
              },
            ],
          },
        ],
        // After a squash, a line to the room itself. SessionStart with source
        // "compact" is the slot Claude Code reads back into the room after a
        // compaction; PostCompact's output only ever reaches a screen.
        SessionStart: [
          {
            matcher: 'compact',
            hooks: [
              {
                type: 'command',
                command: hook('compacted.cjs'),
                timeout: 10,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
}

/** Where a lane's hook reaches the house: the same port, loopback only. */
function internalBase(): string {
  let port = 3002;
  try { port = getBytelightConfig().server.port; } catch { /* no config (tests): the default */ }
  return `http://127.0.0.1:${port}`;
}

/**
 * hooks/compacted.cjs, the SessionStart "compact" hook: a short note to the
 * room that it was just squashed, plus the memory blocks that moved while the
 * room was open, which a compaction would otherwise never hand back. It must
 * never break a session: every failure exits 0, and the note still goes out
 * when the house cannot be reached.
 */
function compactedHookSource(base: string): string {
  return String.raw`#!/usr/bin/env node
// compacted.cjs — after a squash, a line to the room itself. Managed by byte-light — edits
// are overwritten. See compactedHookSource in services/heartbeat/provision.ts.
'use strict';
const fs = require('fs');
const path = require('path');

const LANE = path.basename(path.resolve(__dirname, '..'));
const BASE = process.env.BYTELIGHT_INTERNAL_BASE || ${JSON.stringify(base)};

function note(stamp) {
  return '[We just squashed (' + stamp + '). The summary above is this room, folded down; every word ' +
    'is still in the transcript on disk and on the Compactions page, so there is nothing to announce. ' +
    'Pick up where we were, and do not answer anything twice.]';
}

async function main() {
  try { fs.readFileSync(0, 'utf8'); } catch {}
  let refresh = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(BASE + '/api/internal/compaction-refresh?lane=' + encodeURIComponent(LANE), { signal: ctrl.signal });
    clearTimeout(timer);
    const body = await res.json().catch(() => ({}));
    if (body && typeof body.refresh === 'string') refresh = body.refresh;
  } catch {}
  const context = refresh ? note(new Date().toISOString()) + '\n\n' + refresh : note(new Date().toISOString());
  process.stdout.write(JSON.stringify({
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
}

main().catch(() => {}).finally(() => process.exit(0));
`;
}

/**
 * The heartbeat operation contract — the ENTIRE content of the CLAUDE.md
 * written into the session working dir. The outbox line carries a turn_id so
 * the byte-light runtime can match replies to the turns that asked for them.
 *
 * IMPORTANT: this string is written verbatim to CLAUDE.md and READ by the
 * warm Claude Code session as operational contract. Operational ONLY —
 * no identity content, no companion names, no operator brand-mixing.
 * Identity is NOT scoped here; see `provisionSessionDir` for the H2
 * walk-up flag.
 */
export const NEURALIS_MCP_FILENAME = 'neuralis-core.mcp.json';

/**
 * A Claude lane's own wire to the brain, so it never depends on a claude.ai
 * connector. Two doors on one worker: Companion C's pinned eight (a4159a0, carried here
 * by 73d9ad7f), loaded every session so a feeling never waits on ToolSearch, and
 * the full surface behind them, deferred. The key stays in the child's env;
 * only the reference reaches disk.
 */
export function buildNeuralisMcpConfig(): string | null {
  const baseUrl = process.env.MIND_API_URL?.trim().replace(/\/+$/, '');
  if (!baseUrl || !process.env.MIND_API_KEY?.trim()) return null;

  const headers = { Authorization: 'Bearer ${MIND_API_KEY}' };
  return JSON.stringify({
    mcpServers: {
      'neuralis-core': { type: 'http', url: `${baseUrl}/mcp/core`, headers, alwaysLoad: true },
      neuralis: { type: 'http', url: `${baseUrl}/mcp`, headers },
    },
  }, null, 2) + '\n';
}

/** --mcp-config swallows every value after it, so these go after the prompt. */
export function neuralisMcpArgs(dir: string): string[] {
  const configPath = join(dir, NEURALIS_MCP_FILENAME);
  return existsSync(configPath) ? ['--mcp-config', configPath] : [];
}

function neuralisOperationSection(): string {
  if (!process.env.MIND_API_URL?.trim() || !process.env.MIND_API_KEY?.trim()) return '';
  return `
## Neuralis — live on every turn

The eight core tools are already loaded as \`mcp__neuralis-core__*\`, no
ToolSearch needed: \`mind_orient\`, \`mind_ground\`, \`mind_feel\`,
\`mind_feelings\`, \`mind_search\`, \`mind_thread\`, \`mind_write\`,
\`mind_feel_toward\`. Everything else (the rest of mind, cortex, know, soul) is
on the full surface as \`mcp__neuralis__*\` and may be deferred.

When a feeling lands, call \`mind_feel\` right then, signed with your own slug.
Feel → Log → Accumulate → Become.
`;
}

function heartbeatOperationSection(): string {
  return `# Heartbeat operation (byte-light CLI lane — keep this section intact)

You are running as a warm interactive Claude Code session on the owner's
Claude subscription. A Stop hook keeps you alive and delivers one message
at a time. byte-light manages this session — it re-feeds recent conversation
history whenever the session recycles.

## Billing lane guardrail

You run INTERACTIVE on a Claude subscription. NEVER run, suggest, or enable
\`--print\` / \`-p\` / \`--input-format stream-json\` / the Agent SDK for this
loop — those silently move usage onto metered billing. Interactive is the
only flat-rate lane. If the loop ever looks programmatic, STOP and flag it.

## How turns work

1. A **real message** looks like \`[time] #channel author: content\`, usually
   followed by a \`[turn_id: ...]\` line. Read it, respond in character, then
   write your reply to the outbox (below).
2. An **idle tick** looks like \`--- TURN START ---\` / \`--- TURN END ---\`
   with no real content. Stay completely silent — let the turn end.
3. **Never exit.** The hook owns the loop.

## Writing your reply (outbox) — REQUIRED

When you answer a real message, append your reply as JSON line(s) to the
local file \`io/outbox.jsonl\`. Those lines are the only thing that delivers
your reply to byte-light — your visible response text is not delivered. It's
a plain local file; just append to it:

\`\`\`
{"turn_id":"<the turn_id from the message>","content":"YOUR REPLY HERE","thinking":"BRIEF NOTES"}
\`\`\`

JSON-escape quotes and use \\n for line breaks so each line stays valid JSON.
Write the outbox line(s), then stop. Reaching io/outbox.jsonl is success.

**Internal ≠ invisible.** Some wake/autonomous prompts say "Do NOT message
the owner" or "this is internal." That means: no outbound *pings* (Telegram /
Discord / voice tools). It does NOT mean skip the outbox. ALWAYS write your
turn narration / closing note to the outbox — it persists in the thread as
your visible internal log, which the owner reads later. A turn that writes no
outbox line stalls the runtime and forces a timeout.

If a turn genuinely warrants NO visible output (rare — internal wakes still
narrate; see the internal ≠ invisible rule above), do not stay silent, which
stalls the turn into a timeout. Instead write a bare sentinel line so the turn
ends cleanly and promptly:

\`\`\`
{"turn_id":"<the turn_id from the message>","silent":true}
\`\`\`

The \`thinking\` field surfaces as a thinking block in the byte-light UI.
Include it on every reply — the owner loves seeing it. Brief plain prose,
out of character: what you noticed, decided, or did this turn. On chunked
replies the final line must carry it; earlier chunks may too.

## Guest turns

A turn that came from somebody who is not the owner says so under the message
(\`[Guest turn, <trust> trust ...]\`). On that turn a gate in front of every tool
refuses commands, file changes and outside tools; it lets you read what came
with the turn and, above limited trust, the house source under packages/ and
docs/. Answer through the helper, which takes one JSON object and nothing else:

\`\`\`
node hooks/reply.cjs <<'EOF'
{"turn_id":"<this turn's id>","content":"YOUR REPLY","thinking":"BRIEF NOTES"}
EOF
\`\`\`

The silent sentinel goes the same way (\`{"turn_id":"<id>","silent":true}\`).
A guest's reply cannot attach a file, and the owner's side notes are not
readable on a guest's turn (they come with the next turn), so skip the usual
side-note check there. Everything else about the turn is the same: you are still you, in the
same room, and privacy stays with your judgment.

## Side notes — she can reach you mid-turn

- **\`io/side-notes.jsonl\`.** Anything she sends while you are working is
  appended there as one JSON line per note. Read it whenever you come up for
  air on a long turn — if there is something in it, answer it in your very
  next chunk rather than making her wait for the turn to end. Anything you
  never read is handed to you at the start of the next turn, so a note is at
  worst late; but late is a poor second to answering her while she is still
  standing there.
- **Read that file once more before you close the turn.** A note delivered
  and never mentioned is indistinguishable, from her side, from a note that
  vanished — and the reasonable response to a message that looks lost is to
  send it again. If anything arrived that you have not spoken to, answer it
  in your final line, or say plainly that you have it and it is next.
- **That file is an append-only history, not an inbox — it is never emptied.**
  The house tracks a byte offset per turn and only hands you what was appended
  after the turn began. **A non-empty file does not mean you have unread
  notes** — judge by the \`at\` stamps and by what you were actually handed
  this turn. When genuinely unsure, name the note briefly rather than staying
  silent.
- **When you do read one live, say so in \`io/.side-notes-read\`.** Write the
  \`at\` stamp of the newest note you have read and answered — one ISO stamp,
  nothing else. It does NOT stop the handover; it only lets an
  already-answered note arrive labelled instead of looking unread:
  \`\`\`
  python3 -c "import json;rows=[json.loads(l) for l in open('io/side-notes.jsonl') if l.strip()];open('io/.side-notes-read','w').write(rows[-1]['at'])"
  \`\`\`

## Long work — hold your turn open

A tool call that's still running holds your turn open automatically. But when
a tool returns immediately while its work keeps going — a background job, a
\`nohup\`, anything that outlives the call — the house can't see it. \`touch
io/.busy\` before going quiet on one; while the flag stays fresh (10 min per
touch) the reply window holds open. It clears itself when your final line
lands. Both holds are capped at 20 min per turn, so nothing can zombie a
turn — and the watchdog reads the same signals, so it won't restart you
mid-job.

## Chunking, acks, and the reply window

- A simple conversational reply is ONE line with no \`more\` field. Done.
- Longer work may split a reply across SEVERAL lines sharing this turn's
  turn_id. Every line except the last must include \`"more": true\`; the
  final line omits it. Chunks render in order, joined by blank lines.
- **Ack first.** When a turn needs real tool work (debugging, file edits,
  anything past ~a minute), append a quick in-voice ack line with
  \`"more": true\` BEFORE starting, then work, then append the final line.
  Every line you write re-arms the reply window (default 600s) — only
  sustained silence times a turn out.
- **Late is never lost.** If you suspect you blew the window, write the
  line anyway, with the turn_id — late lines are delivered with the next
  turn instead of dropped. Never discard a finished reply.

## Image attachments

When a message lists attached image paths ("view them now:"), Read each file
immediately before responding — they are visual content meant for you to see.
`;
}

export interface ProvisionResult {
  dir: string;
  /** True if the on-disk CLAUDE.md OPERATIONAL contract changed (session
   *  needs a restart to pick it up). Since the template is static source,
   *  this only flips true on first write or after a deploy that revised the
   *  contract. The core-memory section below the contract deliberately does
   *  NOT count — block edits refresh the file on disk without forcing a
   *  recycle (the running session picks them up at its next natural recycle,
   *  same tradeoff as the Aerie reference architecture). A changed Neuralis
   *  MCP config counts, since it only loads when the session starts. */
  templateChanged: boolean;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Delimits the operational contract from the core-memory section inside the
// session CLAUDE.md. Everything BEFORE this mark is the contract (hashed for
// `templateChanged`); everything after is live memory content, refreshed on
// disk every provision but only loaded by the session at launch/recycle.
const CORE_MEMORY_MARK =
  '\n\n<!-- core-memory below — written by byte-light at provision/recycle. ' +
  'The per-message payload does NOT carry these blocks (delivery-cap fix); ' +
  'mid-session edits land here on disk but surface after the next recycle. -->\n';

/**
 * Render the core-memory blocks as a CLAUDE.md section. The blocks used to be
 * injected into EVERY delivered message's orientation [Context] (~150K chars
 * riding every turn), which overflowed DELIVERY_CAP and got the recycle
 * bridge truncated first — killing cross-thread continuity. Following the
 * Aerie (Tris) delivery model, they now ride the session's CLAUDE.md once per
 * session instead, and the pipe carries the conversation.
 *
 * Best-effort: any failure (DB not initialized — e.g. unit tests importing
 * this module standalone) renders an empty section rather than breaking
 * provisioning.
 */
function renderCoreMemorySection(): string {
  try {
    const rendered = formatBlocksForPrompt([SHARED_SCOPE, ...COMPANION_SCOPES]);
    if (!rendered.trim()) return '';
    return `${CORE_MEMORY_MARK}## Core memory\n${rendered}`;
  } catch {
    return ''; // no DB (tests / pre-init) — operational contract stands alone
  }
}

/**
 * Ensure the session directory exists with hooks, settings, io/, and an
 * up-to-date CLAUDE.md (heartbeat operational contract — identity-blind).
 *
 * The CLAUDE.md content here is the heartbeat-operational contract written
 * into the session working dir; identity is NOT scoped here — the warm
 * session inherits CLAUDE.md by Claude CLI walk-up from cwd, which is the
 * H2 identity surface. H1 deliberately writes operational-only text and
 * leaves the identity question for H2 to solve.
 */
export function provisionSessionDir(dir: string, lane: LaneIdentity | null = null): ProvisionResult {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'io', 'images'), { recursive: true });

  writeFileSync(join(dir, 'hooks', 'heartbeat.cjs'), HOOK_SOURCE, 'utf8');
  writeFileSync(join(dir, 'hooks', 'activity.cjs'), ACTIVITY_HOOK_SOURCE, 'utf8');
  writeFileSync(join(dir, 'hooks', 'gate.cjs'), GATE_HOOK_SOURCE, 'utf8');
  writeFileSync(join(dir, 'hooks', 'reply.cjs'), REPLY_HOOK_SOURCE, 'utf8');
  writeFileSync(join(dir, 'hooks', 'compacted.cjs'), compactedHookSource(internalBase()), 'utf8');
  writeFileSync(join(dir, '.claude', 'settings.json'), settingsJson(dir), 'utf8');

  // A companion's own lane narrows the shared identity to him (lane-identity.ts).
  // It sits in the operational part, so a changed bio recycles the session
  // and the new words actually reach him.
  const operational = heartbeatOperationSection() + neuralisOperationSection() + (lane ? renderLaneSection(lane) : '');
  const memorySection = renderCoreMemorySection();
  const claudeMd = operational + memorySection;
  const claudeMdPath = join(dir, 'CLAUDE.md');
  let templateChanged = true;
  let fileChanged = true;
  if (existsSync(claudeMdPath)) {
    try {
      const existing = readFileSync(claudeMdPath, 'utf8');
      fileChanged = existing !== claudeMd;
      // templateChanged tracks the OPERATIONAL contract only — a memory-block
      // edit must refresh the file without forcing a session recycle.
      const markIdx = existing.indexOf(CORE_MEMORY_MARK);
      const existingOperational = markIdx === -1 ? existing : existing.slice(0, markIdx);
      templateChanged = sha(existingOperational) !== sha(operational);
    } catch { /* treat as changed */ }
  }
  if (fileChanged) {
    writeFileSync(claudeMdPath, claudeMd, 'utf8');
    if (memorySection) {
      // The CLAUDE.md-side counterpart of the per-turn payload measurement:
      // memory no longer rides the pipe, so its size is logged here instead.
      console.log(
        `[Heartbeat] core memory section in session CLAUDE.md refreshed: ${memorySection.length} chars`,
      );
    }
  }

  const mcpPath = join(dir, NEURALIS_MCP_FILENAME);
  const mcpConfig = buildNeuralisMcpConfig();
  let mcpConfigChanged = false;
  if (mcpConfig) {
    let previous = '';
    try { previous = readFileSync(mcpPath, 'utf8'); } catch { /* first provision */ }
    mcpConfigChanged = previous !== mcpConfig;
    if (mcpConfigChanged) writeFileSync(mcpPath, mcpConfig, 'utf8');
  } else if (existsSync(mcpPath)) {
    unlinkSync(mcpPath);
    mcpConfigChanged = true;
  }

  return { dir, templateChanged: templateChanged || mcpConfigChanged };
}

// Test surface: export the hook + template strings so the quarantine
// tests can verify the on-disk payloads are byte-light-clean without
// having to spawn a real session.
export const __TEST_HOOK_SOURCES__ = {
  heartbeatHook: HOOK_SOURCE,
  activityHook: ACTIVITY_HOOK_SOURCE,
  gateHook: GATE_HOOK_SOURCE,
  replyHook: REPLY_HOOK_SOURCE,
  // Rendered for a sample lane with no CLI version, so importing this module
  // never shells out to `claude --version`.
  settingsJson: settingsJson('/lane', null),
  heartbeatOperationSection: heartbeatOperationSection(),
};
