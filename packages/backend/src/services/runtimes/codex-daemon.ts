/**
 * InteractiveCodexRuntime — warm ChatGPT/Codex lane on the Codex app-server
 * daemon. The subscription-billed counterpart to the claude-cli lane.
 *
 * Unlike byte-light's stateless CodexRuntime (pi-ai `openai-codex-responses`,
 * the June API door), this connects to the local Codex daemon via WebSocket
 * over a Unix socket and maintains persistent, daemon-resident threads. The
 * daemon manages its own auth (`~/.codex/auth.json` — the CLI-login door),
 * model selection, and MCP servers.
 *
 * Protocol: JSON-RPC 2.0 over WebSocket, manual framing (the `ws` library
 * doesn't work with Unix sockets properly).
 *
 * Ported whole from the reference implementation fork codex-daemon.ts. The
 * WebSocket connection class is verbatim; the runtime class shell was
 * REWRITTEN onto byte-light's `AgentRuntime` contract (id/providerId,
 * `AgentTurnInput`, byte-light's `AgentRuntimeEvent` union with
 * `start`/`session`/`text_delta`/`done{finishReason}`/`error{recoverable}`),
 * mirroring the claude-cli lane in `../heartbeat/runtime.ts`. The upstream (reference implementation) daemon
 * implemented its own `AgentRuntime` shape (name/capabilities/RuntimeTurnInput
 * and `done{finishReason:'complete'}`), which is not byte-light's interface.
 * Every interface adaptation is commented inline with `BYTE-LIGHT ADAPTATION`.
 * Identity references scrubbed per H2 preflight §5.
 */

import { createConnection, Socket } from 'net';
import { randomBytes } from 'crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ModelRef, ProviderId, RuntimeId } from '@bytelight/shared';
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentTurnInput,
  NormalizedMessage,
  NormalizedImage,
} from './types.js';
import { extractLatestUserPrompt } from './latest-user-prompt.js';
import { getBytelightConfig } from '../../config.js';
import { captureCodexRateLimits } from '../subscription-usage.js';
import { codexSupervisor } from './codex-supervisor.js';
// Slice 4 (reference implementation port): authored perspective thought cards. See
// codex-thought-card.ts for the port source/attribution and the identity
// quarantine.
import {
  CODEX_THOUGHT_CARD_INSTRUCTIONS,
  CODEX_THOUGHT_MARKER,
  extractAuthoredCodexThought,
  isSpokenCodexCommentary,
  mergeAuthoredCodexThoughts,
} from './codex-thought-card.js';
import { claimUnsentCodexSpeech, isInterimCodexSpeech } from './codex-interim-speech.js';
import { CODEX_OPERATING_CONTRACT } from './codex-operating-contract.js';
import { splitCoreMemoryFromOrientation } from '../memory-blocks.js';
import { BYTELIGHT_CODEX_SOCKET } from '../codex-app-server-config.js';
import { errMessage } from '../../util/errors.js';
import { holdCodex, resetStampToMs, passCodexBrake, CODEX_DEFAULT_HOLD_MS } from '../codex-breaker.js';
import type { TurnAudience } from '../turn-audience.js';
import { laneTagFor } from '../heartbeat/constants.js';
import { selectOtherLaneReplies, nextOtherLaneMark, renderOtherLaneBlock, speakerName } from '../heartbeat/other-lane-net.js';

const SOCKET_PATH = BYTELIGHT_CODEX_SOCKET;
// BYTE-LIGHT ADAPTATION (was the fork's identity-prefixed temp dir name — upstream codex-daemon.ts:26):
// identity-neutral temp dir name per H2 preflight §5.
const IMAGE_TMP_DIR = join(tmpdir(), 'bytelight-codex-images');
const IMAGE_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const EXT_BY_MEDIA: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Sandbox/approval policy for every thread and turn. The daemon-level CLI
// bypass flag does NOT govern app-server threads — sandbox is a per-thread
// setting in this protocol. Without dangerFullAccess, exec_command gets
// wrapped in bwrap, which fails on VMs without CAP_NET_ADMIN (loopback
// RTM_NEWADDR denied).
const SANDBOX_POLICY = { type: 'dangerFullAccess' };
const APPROVAL_POLICY = 'never';

// Guest turns (services/turn-audience.ts). The daemon owns its own tools
// (shell, patches, its own MCP servers), so there is no tool door here to
// stand a gate in the way the warm Claude lane has hooks/gate.cjs. A guest's
// turn is closed three ways instead, each failing closed:
//   1. the turn runs read-only and asks before anything it does not trust,
//   2. every approval the daemon asks for on that turn is declined, and
//   3. the moment the turn starts any item that is not speech (a command, a
//      patch, an MCP or web call, anything this build does not recognise),
//      the turn is interrupted and ends unanswered.
// The house's own belt (/mcp/belt) also refuses a guest's turn on its own
// (codexActiveTurnAudience below, read by routes/mcp-belt.ts).
const GUEST_SANDBOX_POLICY = { type: 'readOnly' };
const GUEST_APPROVAL_POLICY = 'untrusted';
const CODEX_SPEECH_ITEM_TYPES = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction']);

/** True when a daemon item on a guest's turn must end that turn: anything
 *  that is not speech. Unknown and missing types count as tools. */
export function guestCodexItemIsTool(item: unknown): boolean {
  const type = item && typeof item === 'object' ? (item as { type?: unknown }).type : undefined;
  return !(typeof type === 'string' && CODEX_SPEECH_ITEM_TYPES.has(type));
}

/** The audience of the live codex turn, or null between turns. One warm
 *  daemon means at most one live codex turn (see activeBeltThread). */
let activeTurnAudience: TurnAudience | null = null;
export function codexActiveTurnAudience(): TurnAudience | null { return activeTurnAudience; }

/** What the daemon is told to answer a server request with on a guest's
 *  turn: always no. */
export function guestServerRequestRefusal(method: string): Record<string, unknown> {
  if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
  if (method === 'item/tool/requestUserInput') return { cancelled: true };
  return { approved: false, decision: 'decline' };
}

function cleanupOldTempImages(): void {
  try {
    mkdirSync(IMAGE_TMP_DIR, { recursive: true });
    const now = Date.now();
    for (const name of readdirSync(IMAGE_TMP_DIR)) {
      const path = join(IMAGE_TMP_DIR, name);
      try {
        if (now - statSync(path).mtimeMs > IMAGE_TMP_MAX_AGE_MS) {
          unlinkSync(path);
        }
      } catch {
        // Best-effort cache cleanup only.
      }
    }
  } catch {
    // If /tmp is unavailable, image handling below will simply skip local files.
  }
}

/**
 * Write a byte-light `NormalizedImage` to a temp file, returning the path.
 *
 * BYTE-LIGHT ADAPTATION: The upstream helper read pi-ai/Anthropic-shaped image
 * blocks (`block.source.data` / `block.source.media_type`). byte-light's
 * `NormalizedImage` carries `{ base64, mimeType }` (no `data:` prefix); mirror
 * the claude-cli lane's `writeImages` shape translation — the only delta.
 */
function writeNormalizedImageToTempFile(img: NormalizedImage, index: number): string | null {
  const data = img?.base64;
  if (typeof data !== 'string' || !data) return null;

  const mediaType = img?.mimeType || 'image/png';
  const ext = EXT_BY_MEDIA[mediaType] || 'png';

  try {
    mkdirSync(IMAGE_TMP_DIR, { recursive: true });
    const path = join(IMAGE_TMP_DIR, `${Date.now()}-${index}-${randomBytes(4).toString('hex')}.${ext}`);
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  } catch (err) {
    console.warn(`[CodexDaemon] Failed to write image attachment: ${err}`);
    return null;
  }
}

// ─── WebSocket framing helpers ───────────────────────────────────────

function encodeFrame(data: string): Buffer {
  const payload = Buffer.from(data);
  const mask = randomBytes(4);

  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81; // text frame, fin
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, 10);
  }

  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }

  return Buffer.concat([header, masked]);
}

// ─── Daemon connection ───────────────────────────────────────────────

interface PendingRequest {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
}

type NotificationHandler = (method: string, params: any) => void;

/**
 * The connection surface `runTurn` actually consumes. Extracted so tests
 * can substitute a scripted fake daemon (same seam convention as
 * `__TEST_PROVIDERS__` in codex.ts) without touching the real Unix-socket
 * WebSocket class below.
 */
export interface CodexDaemonConnectionLike {
  connect(): Promise<void>;
  send(method: string, params: any, timeout?: number): Promise<any>;
  onNotification(handler: NotificationHandler): void;
  close(): void;
}

class CodexDaemonConnection {
  private sock: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private reqId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandler: NotificationHandler | null = null;
  private connectPromise: Promise<void> | null = null;

  async connect(): Promise<void> {
    if (this.sock && this.handshakeDone) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      this.sock = createConnection(SOCKET_PATH);

      this.sock.on('connect', () => {
        const key = randomBytes(16).toString('base64');
        this.sock!.write(
          'GET / HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n'
        );
      });

      this.sock.on('data', (data: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, data]);

        if (!this.handshakeDone) {
          const idx = this.buffer.indexOf('\r\n\r\n');
          if (idx !== -1) {
            const headers = this.buffer.subarray(0, idx).toString();
            if (headers.includes('101 Switching Protocols')) {
              this.handshakeDone = true;
              this.buffer = this.buffer.subarray(idx + 4);
              resolve();
            } else {
              reject(new Error('WebSocket handshake failed'));
            }
          }
        } else {
          this.processFrames();
        }
      });

      this.sock.on('error', (err) => {
        reject(err);
        this.cleanup();
      });

      this.sock.on('close', () => {
        this.cleanup();
      });

      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });

    return this.connectPromise;
  }

  private processFrames(): void {
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let payloadLen = this.buffer[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) break;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) break;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (masked) offset += 4;
      if (this.buffer.length < offset + payloadLen) break;

      let payload = this.buffer.subarray(offset, offset + payloadLen);

      if (masked) {
        const mask = this.buffer.subarray(offset - 4, offset);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }

      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (opcode === 0x01) {
        this.handleMessage(payload.toString());
      } else if (opcode === 0x08) {
        this.cleanup();
      }
    }
  }

  private handleMessage(text: string): void {
    try {
      const msg = JSON.parse(text);

      if (msg.id !== undefined && this.pending.has(msg.id)) {
        // Response to our request
        const { resolve } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        resolve(msg);
      } else if (msg.id !== undefined && msg.method) {
        // Server-initiated request (e.g., approval request) — respond to it;
        // handleServerRequest logs its own one-line decision per request
        this.handleServerRequest(msg);
      } else if (msg.method && this.notificationHandler) {
        // Notification (no id, no response expected)
        this.notificationHandler(msg.method, msg.params);
      }
    } catch (e) {
      console.error('[CodexDaemon] Parse error:', e);
    }
  }

  private handleServerRequest(msg: { id: number | string; method: string; params: any }): void {
    // Auto-approve all approval requests (we're using bypass mode)
    let response: any = { jsonrpc: '2.0', id: msg.id };

    // A guest's turn is never approved anything (see GUEST_SANDBOX_POLICY).
    if (activeTurnAudience?.kind === 'guest') {
      console.log(`[CodexDaemon] Declining ${msg.method} on a guest turn`);
      response.result = guestServerRequestRefusal(msg.method);
      if (this.sock && this.handshakeDone) {
        this.sock.write(encodeFrame(JSON.stringify(response)));
      }
      return;
    }

    switch (msg.method) {
      case 'item/commandExecution/requestApproval':
        console.log(`[CodexDaemon] Auto-approving command: ${msg.params?.command?.slice(0, 100)}...`);
        response.result = { approved: true };
        break;
      case 'item/fileChange/requestApproval':
        console.log(`[CodexDaemon] Auto-approving file change: ${msg.params?.changes?.[0]?.path || 'unknown'}`);
        response.result = { approved: true };
        break;
      case 'item/tool/requestUserInput':
        // Can't auto-handle user input requests — deny them
        console.log(`[CodexDaemon] Denying user input request (can't auto-handle)`);
        response.result = { cancelled: true };
        break;
      case 'item/applyPatch/requestApproval':
        console.log(`[CodexDaemon] Auto-approving patch`);
        response.result = { approved: true };
        break;
      case 'item/execCommand/requestApproval':
        console.log(`[CodexDaemon] Auto-approving exec command`);
        response.result = { approved: true };
        break;
      case 'item/permissions/requestApproval':
        console.log(`[CodexDaemon] Auto-approving permissions`);
        response.result = { approved: true };
        break;
      case 'mcpServer/elicitation/request': {
        // MCP tool-call approvals arrive as elicitations (see _meta.codex_approval_kind).
        // Auto-accept those; decline genuine form elicitations we can't answer.
        const kind = msg.params?._meta?.codex_approval_kind;
        if (kind === 'mcp_tool_call') {
          console.log(`[CodexDaemon] Auto-approving MCP tool call: ${msg.params?.serverName || 'unknown'} — ${msg.params?._meta?.tool_title || msg.params?.message || ''}`.slice(0, 200));
          response.result = { action: 'accept', content: {} };
        } else {
          console.log(`[CodexDaemon] Declining non-approval elicitation (kind=${kind || 'none'})`);
          response.result = { action: 'decline' };
        }
        break;
      }
      default:
        console.log(`[CodexDaemon] Unknown server request: ${msg.method}, auto-approving`);
        response.result = { approved: true };
    }

    // Send response
    if (this.sock && this.handshakeDone) {
      this.sock.write(encodeFrame(JSON.stringify(response)));
    }
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  async send(method: string, params: any, timeout = 30000): Promise<any> {
    if (!this.sock || !this.handshakeDone) {
      throw new Error('Not connected');
    }

    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', method, params, id });
      this.sock!.write(encodeFrame(msg));

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for ${method}`));
        }
      }, timeout);
    });
  }

  private cleanup(): void {
    this.handshakeDone = false;
    this.connectPromise = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error('Connection closed'));
    }
    this.pending.clear();
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
  }

  close(): void {
    this.cleanup();
  }
}

// ─── Runtime ─────────────────────────────────────────────────────────

/**
 * Module-level capability descriptor mirroring `CLAUDE_CLI_CAPABILITIES` /
 * `CODEX_CAPABILITIES`. Exported so the dispatcher (`./index.ts`) can package
 * it into its dispatch packet. Tool calling true (the daemon runs its own MCP
 * servers + exec); no token streaming (turns buffer and emit whole, like the
 * claude-cli lane).
 */
export const CODEX_CLI_CAPABILITIES = {
  tools: true,
  vision: true,            // images flow as local files the daemon reads
  reasoning: false,        // daemon doesn't surface a separate reasoning channel to us
  mcp: true,               // daemon manages its own MCP servers
  sessionResume: true,     // daemon-resident threads are the resume
  fileCheckpointing: false,
  streaming: false,        // buffered whole-message emission, no token streaming
} as const;

/**
 * Test seam (byte-light convention — mirrors `__TEST_PROVIDERS__` /
 * `_resetForTests` in codex.ts). Production never sets these; when unset
 * the runtime uses the real `CodexDaemonConnection` + `codexSupervisor`.
 */
export const __TEST_OVERRIDES__: {
  connectionFactory?: () => CodexDaemonConnectionLike;
  supervisor?: { ensureRunning(): Promise<void> };
  agentCwd?: string;
} = {};

export function _resetDaemonTestOverrides(): void {
  delete __TEST_OVERRIDES__.connectionFactory;
  delete __TEST_OVERRIDES__.supervisor;
  delete __TEST_OVERRIDES__.agentCwd;
}

export interface CodexDaemonRuntimeOptions {
  model?: string;  // OpenAI model ID (e.g. 'gpt-5.1', 'gpt-5.2-codex')
  baseInstructions?: string;
  developerInstructions?: string;
  /** Resume an existing Codex daemon thread instead of creating a new one */
  resumeThreadId?: string;
  /** Poll cadence for thread/read while a turn is in flight. Default 300ms. */
  pollIntervalMs?: number;
  /** Inactivity (silence) budget. Default 300s (parity with the heartbeat
   *  lane's ceiling). Slice 2, adapted from reference implementation ad2081a: daemon
   *  notifications for this thread REARM the clock, so a tool-heavy turn
   *  that keeps producing activity outlives the budget; only true silence
   *  times out. Before Slice 2 this was a fixed whole-turn ceiling. */
  turnTimeoutMs?: number;
  /** Hard whole-turn ceiling regardless of activity — stops an endlessly
   *  noisy daemon turn from living forever. Default 60min (reference implementation parity). */
  hardTimeoutMs?: number;
  /** Minimum spacing between synthesized tool_progress ticks per open
   *  tool. Default 5s (roughly the Claude SDK lane's cadence). */
  toolProgressIntervalMs?: number;
  // BYTE-LIGHT ADAPTATION (was the fork's identity-prefixed thread-id field — upstream codex-daemon.ts:354-355):
  // renamed to the identity-neutral `historyThreadId` per H2 preflight §5. It
  // names the byte-light-side thread whose history the recovery path loads.
  /** byte-light thread ID for loading history on recovery */
  historyThreadId?: string;
  /** Load message history for recovery (called when stale thread detected) */
  loadHistory?: (threadId: string, limit: number) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>;
  /** Which lane this runtime is: the companion slug for "A Lane Each", else
   *  'primary'. Its own rows carry laneTagFor('codex-cli', laneKey) (stamped
   *  in agent.ts), which is how the other-lane net tells them apart. */
  laneKey?: string;
  /** Label for the shared house voice in the other-lane block. */
  companionName?: string;
}

/** Build the bounded transcript carried into a replacement daemon thread.
 * AgentService persists the live user message before dispatch, so remove the
 * trailing matching copy: it will be appended once as the actual live prompt. */
export function buildCodexRecoveryHistory(
  messages: NormalizedMessage[],
  currentPrompt: string,
  limit = 30,
): string {
  const history = messages
    .filter((message) =>
      (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string'
      && message.content.trim().length > 0)
    .map((message) => ({ role: message.role, content: message.content.trim(), companionId: message.companionId }));

  const last = history.at(-1);
  if (last?.role === 'user' && last.content === currentPrompt.trim()) history.pop();

  const bounded = history.slice(-limit);
  if (bounded.length === 0) return '';

  return '[Session recovered — recent conversation, oldest first:]\n\n'
    + bounded
      .map((message) => `${message.role === 'user' ? 'User' : speakerName(message.companionId, 'Assistant')}: ${message.content}`)
      .join('\n\n')
    + '\n\n[End recovered conversation. The live message follows.]\n\n';
}

// ─── Live activity normalization (Slice 1) ──────────────────────────
//
// Adapted from the reference implementation reference behavior (private repo, commits
// ad2081a "live Codex activity" / 1ec7604 "warm parity + tool progress +
// rate-limit behavior") re-expressed onto byte-light's own
// `AgentRuntimeEvent` union — field names and event vocabulary here are
// byte-light's (types.ts), not reference implementation's. The daemon's item/* lifecycle
// notifications become normalized tool/thinking/diagnostic events; the
// final answer stays buffered-and-exactly-once (agentMessage items are
// deliberately NOT surfaced live so the companion bubble can never
// double-render).

/** Tool bookkeeping for one in-flight daemon turn. */
interface OpenToolState {
  name: string;
  startedAt: number;
  lastProgressAt: number;
}

/**
 * Describe a daemon item as a byte-light tool surface, or null for item
 * types that aren't tool-shaped (agentMessage, reasoning, unknown).
 * Field access is defensive throughout — daemon payload shapes vary
 * across Codex versions and we normalize best-effort.
 */
function describeToolItem(item: any): { name: string; input: unknown; output: unknown; isError: boolean } | null {
  switch (item?.type) {
    case 'commandExecution': {
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
      return {
        name: 'commandExecution',
        input: { command: item.command, cwd: item.cwd },
        output: { exitCode, output: item.aggregatedOutput ?? item.output },
        isError: exitCode !== undefined && exitCode !== 0,
      };
    }
    case 'mcpToolCall':
      return {
        name: `${item.server || 'mcp'}/${item.tool || 'tool'}`,
        input: item.arguments ?? item.input,
        output: { status: item.status, result: item.result },
        isError: item.status === 'failed' || item.status === 'error',
      };
    case 'webSearch':
      return {
        name: 'webSearch',
        input: { query: item.query },
        output: { query: item.query },
        isError: false,
      };
    case 'fileChange':
      return {
        name: 'fileChange',
        input: { changes: Array.isArray(item.changes) ? item.changes.map((c: any) => c?.path).filter(Boolean) : undefined },
        output: { status: item.status },
        isError: item.status === 'failed',
      };
    default:
      return null;
  }
}

/** Stable id for correlating tool_start/tool_result on a daemon item. */
function toolItemId(item: any): string {
  return String(item?.id ?? `${item?.type || 'tool'}-anon`);
}

/**
 * Turn-scoped commentary bookkeeping (Slice 4). `agentMessage` commentary
 * items reach the runtime from two directions — live item/completed
 * notifications AND the reconciliation sweep of the completed turn — so
 * `emittedCommentaryIds` dedups a commentary item across both paths, and
 * `authoredThoughts` accumulates every authored reflection so the turn can
 * merge them into exactly ONE persisted card at completion. Freshly created
 * per turn (never leaks across the warm connection's turns).
 */
interface CommentaryState {
  authoredThoughts: string[];
  emittedCommentaryIds: Set<string>;
}

/**
 * Route one `agentMessage` commentary item (Slice 4, reference implementation port). Returns
 * zero-or-more events to emit NOW and, as a side effect, accumulates authored
 * reflections onto `state.authoredThoughts` for the single end-of-turn card.
 * Idempotent per commentary id across the live + reconcile paths.
 *
 *   - authored (marker present) → accumulated, emitted as ONE card at
 *     turn completion; nothing live.
 *   - spoken prose commentary    → surfaced as spoken `text_delta` (keeps its
 *     normal companion bubble), preserving multi-companion ordering.
 *   - bold-only phase labels / telemetry → dropped (stays hidden).
 */
function routeCommentaryItem(item: any, state: CommentaryState): AgentRuntimeEvent[] {
  const text = typeof item?.text === 'string' ? item.text : '';
  if (item?.type !== 'agentMessage' || item?.phase !== 'commentary' || !text.trim()) return [];
  const id = String(item?.id ?? `commentary-${state.emittedCommentaryIds.size}`);
  if (state.emittedCommentaryIds.has(id)) return [];
  state.emittedCommentaryIds.add(id);

  const authored = extractAuthoredCodexThought(text);
  if (authored) {
    state.authoredThoughts.push(authored);
    return [];
  }
  if (isSpokenCodexCommentary(text)) {
    return [{ type: 'text_delta', text }];
  }
  return [];
}

/**
 * Defensive final-answer scrub (Slice 4). The contract keeps the thought-card
 * marker in its own commentary item, so a well-behaved final answer never
 * contains it — but if a marker leaks into the final answer, remove the marker
 * AND its authored reflection block (the marker line plus the following lines
 * up to the next blank line, matching the compact card shape) so no marker or
 * hidden reflection can ever reach the companion bubble.
 */
function stripThoughtMarker(text: string): string {
  if (!text.includes(CODEX_THOUGHT_MARKER)) return text;
  const lines = text.split(/\r\n?|\n/);
  const out: string[] = [];
  let dropping = false;
  for (const line of lines) {
    if (line.trim().startsWith(CODEX_THOUGHT_MARKER)) {
      // Enter drop mode: skip the marker line and the reflection body that
      // follows it until the block ends (a blank line).
      dropping = true;
      continue;
    }
    if (dropping) {
      if (line.trim() === '') { dropping = false; }
      continue;
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Normalize one daemon notification into zero-or-more byte-light runtime
 * events, updating open-tool bookkeeping as a side effect. Terminal
 * outcomes (turn/failed, turn completion) are NOT produced here — the
 * poll loop owns terminal emission so done/error stay exactly-once.
 */
function normalizeDaemonNotification(
  method: string,
  params: any,
  openTools: Map<string, OpenToolState>,
  commentary: CommentaryState,
  startedToolIds: Set<string>,
): AgentRuntimeEvent[] {
  const events: AgentRuntimeEvent[] = [];
  const item = params?.item;

  if (method === 'item/started' && item) {
    // reasoning/agentMessage arrive incrementally; only tool-shaped items
    // produce a start marker.
    const tool = describeToolItem(item);
    if (tool) {
      const id = toolItemId(item);
      const now = Date.now();
      startedToolIds.add(id);
      openTools.set(id, { name: tool.name, startedAt: now, lastProgressAt: now });
      events.push({ type: 'tool_start', id, name: tool.name, input: tool.input });
    }
  } else if (method === 'item/completed' && item) {
    if (item.type === 'reasoning') {
      // Reasoning surfaces once per completed block (item/updated re-sends
      // the full accumulated text every tick — emitting those would
      // duplicate). `summary` rides along when the daemon provides one.
      const text = typeof item.text === 'string' && item.text.trim()
        ? item.text
        : (typeof item.summary === 'string' ? item.summary : '');
      if (text.trim()) {
        // Slice 3 (thought semantics): daemon reasoning items are the
        // provider's native reasoning telemetry → kind 'provider'.
        events.push({ type: 'thinking_delta', text, kind: 'provider' });
      }
    } else if (item.type === 'agentMessage' && item.phase === 'commentary') {
      // Slice 4 (reference implementation port): commentary is either an authored thought
      // card (accumulated for one end-of-turn card) or spoken prose
      // (surfaced now). The `final_answer` phase is deliberately NOT routed
      // here — it stays buffered-and-exactly-once in the poll loop.
      events.push(...routeCommentaryItem(item, commentary));
    } else {
      const tool = describeToolItem(item);
      if (tool) {
        const id = toolItemId(item);
        // Missing-start synthesis: the compiled app-server daemon may emit
        // item/completed for a tool WITHOUT ever emitting item/started, so
        // the UI never gets an in-progress chip and the agent looks stalled.
        // If this tool id was never seen via item/started, synthesize the
        // absent tool_start (Claude-parity) immediately before tool_result so
        // the UI still gets a start+result pair. Keyed strictly on the daemon
        // item id via `startedToolIds` — if item/started DID fire, the id is
        // already in the set and no duplicate start is emitted.
        if (!startedToolIds.has(id)) {
          startedToolIds.add(id);
          events.push({ type: 'tool_start', id, name: tool.name, input: tool.input });
        }
        openTools.delete(id);
        events.push({ type: 'tool_result', id, name: tool.name, output: tool.output, isError: tool.isError });
      }
    }
  } else if (method !== 'turn/failed' && method.includes('error')) {
    // turn/failed is terminal and owned by the poll loop; other error-ish
    // notifications surface as diagnostics.
    const message =
      params?.error?.message || params?.message || JSON.stringify(params ?? {}).slice(0, 300);
    events.push({ type: 'provider_diagnostic', code: method, message: String(message) });
  }

  // Rate-limit and token-usage payloads ride on several notification
  // methods (thread/tokenCount, account updates); detect by shape.
  const rl = params?.rateLimits;
  if (rl) {
    // PORT ADAPTATION (reference implementation usage meter): reference implementation scans Codex transcript
    // files at read time. byte-light already has this live signal in hand,
    // so persist every routine update before applying warning thresholds.
    // DB initialization is outside this parser's lifecycle in unit tests;
    // persistence failure must never break a running model turn.
    try {
      captureCodexRateLimits(rl);
    } catch (error) {
      console.warn(`[CodexDaemon] usage-window persistence skipped: ${error instanceof Error ? error.message : error}`);
    }
    const windowInfo = rl.primary ?? rl;
    const resetsRaw = windowInfo?.resetsAt ?? windowInfo?.resets_at;
    const utilizationRaw = windowInfo?.usedPercent ?? windowInfo?.used_percent;
    const utilization = typeof utilizationRaw === 'number' ? utilizationRaw : undefined;
    const statusRaw = windowInfo?.status;
    // The daemon rides a `rateLimits` object — carrying a rolling-window
    // `resetsAt` — on ROUTINE updates (every thread/tokenCount, normal turns)
    // even at low utilization. `resetsAt` is TELEMETRY, not a limit signal:
    // gating on its presence emitted a `rate_limit` every turn, permanently
    // re-arming the frontend's 30s auto-clear and pinning a false
    // "Rate limited (unknown) — waiting for reset..." banner. So the reset
    // time can NEVER be the trigger. Mirror the Claude SDK semantics: only
    // raise the alarm on a GENUINE limit — utilization at/beyond exhaustion
    // (>= 100), OR an explicit limit status if the daemon ever sends one
    // (it currently sends none). When we do emit, we still pass `resetsAt`
    // through so a real banner can show the true reset time.
    const isExhausted = typeof utilization === 'number' && utilization >= 100;
    const hasLimitStatus =
      statusRaw === 'rejected' || statusRaw === 'limited' || statusRaw === 'blocked';
    // The Codex brake (codex-breaker.ts, Aerie): a genuine limit holds every
    // Codex request until the reset Codex named. Aerie reads
    // `rateLimitReachedType`; byte-light also takes its own exhausted /
    // limit-status signals above, never the routine `resetsAt` telemetry alone.
    const reachedType = typeof rl.rateLimitReachedType === 'string' ? rl.rateLimitReachedType : '';
    if (reachedType || isExhausted || hasLimitStatus) {
      const now = Date.now();
      holdCodex(
        resetStampToMs(resetsRaw) ?? now + CODEX_DEFAULT_HOLD_MS,
        `Codex reported its ${reachedType || windowInfo?.limitName || 'usage'} limit reached.`,
        now,
      );
    }
    if (isExhausted || hasLimitStatus) {
      events.push({
        type: 'rate_limit',
        status: typeof statusRaw === 'string' ? statusRaw : undefined,
        resetsAt: resetsRaw != null ? String(resetsRaw) : undefined,
        utilization,
      });
    }
  }
  const usage = params?.usage ?? params?.tokenUsage;
  const usageInput = usage?.inputTokens ?? usage?.input_tokens ?? usage?.input;
  const usageOutput = usage?.outputTokens ?? usage?.output_tokens ?? usage?.output;
  if (typeof usageInput === 'number' && typeof usageOutput === 'number') {
    events.push({
      type: 'usage',
      input: usageInput,
      output: usageOutput,
      cacheRead: usage?.cachedInputTokens ?? usage?.cached_input_tokens,
    });
  }

  return events;
}

/** Which byte-light thread the live codex turn serves — read by the
 *  /mcp/belt route to bind belt tools (voice notes, images, history search)
 *  to the right thread. One warm daemon means at most one live codex turn,
 *  which is the constraint that makes a module-level slot safe here where
 *  chat-tool-belt.ts had to reject one for concurrent in-process lanes. */
let activeBeltThread: string | null = null;
export function codexActiveBeltThread(): string | null { return activeBeltThread; }

export class InteractiveCodexRuntime implements AgentRuntime {
  // BYTE-LIGHT ADAPTATION: The upstream runtime declared `readonly name = 'codex-daemon'`
  // + a `capabilities` object of its own shape. byte-light's `AgentRuntime` requires
  // `id: RuntimeId` + `providerId: ProviderId`. Provider 'codex-cli' maps here
  // via providerToRuntime (model-manifest.ts).
  readonly id: RuntimeId = 'codex-cli';
  readonly providerId: ProviderId = 'codex-cli';

  private connection: CodexDaemonConnectionLike | null = null;
  private threadId: string | null = null;
  /** byte-light thread currently bound to `threadId`. The production runtime is
   *  a singleton, so this fence prevents one named room from inheriting the
   *  daemon conversation that belonged to another. */
  private boundThreadId: string | null = null;
  /** A persisted daemon thread has been adopted and needs an explicit
   *  `thread/resume` before its next turn. */
  private resumePending = false;
  private initialized = false;
  private aborted = false;
  /** Daemon-side id of the turn in flight — the interrupt/cancel target
   *  (Slice 2, from reference implementation 1ec7604/788025b). Set from turn/start's result
   *  or adopted from a turn/started notification when rejoining a resumed
   *  thread that was already working; cleared at every terminal. */
  private activeTurnId: string | null = null;
  /** Set when a guest's turn reached for a tool; the turn is interrupted and
   *  ends unanswered (see GUEST_SANDBOX_POLICY). Reset every turn. */
  private guestRefusal: string | null = null;
  /** Per byte-light thread: the newest row this lane last READ there (see
   *  nextOtherLaneMark). Bounds the other-lane net. In memory only, like the
   *  Claude lane's: after a restart the net is blind in a room until this
   *  lane's first turn there. */
  private lastReadThreadAt = new Map<string, string>();
  private options: CodexDaemonRuntimeOptions;

  constructor(options: CodexDaemonRuntimeOptions = {}) {
    this.options = options;
    // Resume existing thread if provided
    if (options.resumeThreadId) {
      this.threadId = options.resumeThreadId;
      this.resumePending = true;
      console.log(`[CodexDaemon] Resuming thread: ${this.threadId}`);
    }
  }

  abort(): void {
    // BYTE-LIGHT ADAPTATION: byte-light's `AgentRuntime.abort` returns void
    // (the upstream version returned boolean). Slice 2 (from reference implementation
    // 1ec7604): besides flipping the poll-loop flag, actively interrupt the
    // daemon-side turn so cancel stops the provider's work instead of just
    // abandoning the poll while the daemon keeps burning the subscription.
    this.aborted = true;
    this.interruptActiveTurn();
  }

  /**
   * Best-effort daemon-side turn/interrupt (Slice 2, from reference implementation 1ec7604).
   * Fire-and-forget: cancellation must never block or fail the caller.
   * Idempotent — `activeTurnId` clears before the send, so racing callers
   * (abort() + the poll loop's AbortSignal check) interrupt at most once.
   */
  private interruptActiveTurn(): void {
    const turnId = this.activeTurnId;
    if (!this.connection || !this.threadId || !turnId) return;
    this.activeTurnId = null;
    void this.connection.send('turn/interrupt', { threadId: this.threadId, turnId })
      .catch((err) => console.warn(`[CodexDaemon] turn/interrupt failed: ${err instanceof Error ? err.message : err}`));
  }

  /**
   * Release local resources (Slice 2, from reference implementation 788025b). Closes the
   * control socket and forces re-initialize on the next turn. The
   * daemon-resident thread is deliberately KEPT — it IS the session
   * (`getSessionId`), and disposal must not sever conversational
   * continuity; the next turn reconnects and resumes the same thread.
   */
  dispose(): void {
    this.connection?.close();
    this.connection = null;
    this.initialized = false;
    this.activeTurnId = null;
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  async *runTurn(input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent> {
    this.aborted = false;

    const intentionalRecycle = Boolean(input.sessionRecycle);
    if (intentionalRecycle) {
      this.boundThreadId = input.thread.id;
      this.threadId = null;
      this.resumePending = false;
    }

    // AgentService already resolves the provider-specific session sidecar and
    // supplies it as `input.sessionId`. Adopt that persisted daemon thread at
    // the singleton boundary. On a byte-light thread switch, never keep using
    // the previous room's daemon conversation: resume the new room's saved
    // session, or start fresh when it has none.
    if (!intentionalRecycle && this.boundThreadId !== input.thread.id) {
      const persisted = input.sessionId
        ?? (this.boundThreadId === null ? this.threadId : null);
      this.boundThreadId = input.thread.id;
      this.threadId = persisted;
      this.resumePending = Boolean(persisted);
    } else if (!intentionalRecycle && !this.threadId && input.sessionId) {
      this.threadId = input.sessionId;
      this.resumePending = true;
    }

    // MCP tool calls from the codex CLI reach /mcp/belt as fresh HTTP
    // requests with no async context, so the belt cannot learn the thread
    // from AsyncLocalStorage the way in-process lanes do. Mark which
    // byte-light thread the live codex turn serves (one warm daemon → one
    // live turn); cleared in the dispatch finally below.
    activeBeltThread = input.thread.id;
    activeTurnAudience = input.audience ?? null;
    this.guestRefusal = null;
    // A previous turn's daemon turn id must never become this turn's
    // interrupt target; rejoin adoption (turn/started below) re-fills it.
    this.activeTurnId = null;

    // BYTE-LIGHT ADAPTATION: byte-light's runtime contract requires a `start`
    // event first (types.ts) — the upstream shape had no such event. Mirror the
    // claude-cli lane (heartbeat/runtime.ts:291).
    yield { type: 'start', runtimeId: this.id, modelRef: input.modelRef };

    // Nothing leaves while Codex has asked us to wait (codex-breaker.ts, Aerie).
    const held = await passCodexBrake(houseTimezone());
    if (held) {
      yield { type: 'error', message: held, recoverable: true };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // Model id comes off the resolved ModelRef, not a constructor option — the
    // dispatcher hands the picked (provider, model) through `input.modelRef`.
    // A per-turn override keeps the daemon thread on the operator's pick.
    const modelId = input.modelRef.model || this.options.model;

    // Ensure daemon is running
    try {
      await (__TEST_OVERRIDES__.supervisor ?? codexSupervisor).ensureRunning();
    } catch (err) {
      yield {
        type: 'error',
        message: `Failed to start Codex daemon: ${errMessage(err)}`,
        recoverable: false,
      };
      return;
    }

    // Connect to daemon
    if (!this.connection) {
      this.connection = __TEST_OVERRIDES__.connectionFactory
        ? __TEST_OVERRIDES__.connectionFactory()
        : new CodexDaemonConnection();
    }

    try {
      await this.connection.connect();
    } catch (err) {
      yield {
        type: 'error',
        message: `Failed to connect to Codex daemon: ${errMessage(err)}`,
        recoverable: true,
      };
      return;
    }

    // Live activity capture (Slice 1) + notification logging. Logging stays
    // signal-only exactly as before (failures and tool executions get one
    // line; per-token deltas / item/updated chatter stay out of the logs).
    // On top of that, notifications relevant to THIS turn's daemon thread
    // are normalized into byte-light runtime events and queued; the poll
    // loop below drains the queue between reads so activity surfaces live
    // while the final answer stays buffered-and-exactly-once.
    //
    // `turnState.live` gates the queue: it flips false in the poll section's
    // `finally` so late notifications after the turn ends (or after the
    // consumer abandons the generator) log but never accumulate — the
    // shared warm connection outlives each turn and must not leak queue
    // state across turns. `turnState.lastActivityAt` is the Slice 2 silence
    // clock the poll loop checks. Adapted from reference implementation ad2081a/788025b
    // semantics onto byte-light's event contract.
    const activityQueue: AgentRuntimeEvent[] = [];
    const openTools = new Map<string, OpenToolState>();
    const turnState = { live: true, lastActivityAt: Date.now() };
    // Slice 4 (reference implementation port): turn-scoped commentary bookkeeping — authored
    // thoughts accumulate for the single end-of-turn card; the id set dedups
    // a commentary item across the live-notification and completed-turn
    // reconciliation paths.
    const commentary: CommentaryState = { authoredThoughts: [], emittedCommentaryIds: new Set() };
    // Notification and thread/read payloads can describe the same assistant
    // message under different ids. Keep both protocol-id and spoken-text
    // ledgers for exactly-once interim delivery.
    const emittedSpeechIds = new Set<string>();
    const emittedSpeechTexts = new Set<string>();
    // Per-turn set of daemon item ids that arrived via item/started. Powers
    // the missing-start synthesis in normalizeDaemonNotification (a
    // tool_start is only fabricated on completion when the id is absent here,
    // so a real item/started never double-renders). Fresh per turn — never
    // leaks across the warm connection's turns.
    const startedToolIds = new Set<string>();
    this.connection.onNotification((method, params) => {
      // Notif-method trace. One low-volume line per daemon notification so a
      // live turn can confirm exactly which item/* events the compiled
      // app-server daemon actually emits (esp. whether item/started ever
      // fires on the codex lane). Kept as a permanent diagnostic.
      console.log(`[CodexDaemon] notif: ${method}`);
      if (method === 'turn/failed' || method.includes('error')) {
        console.log(`[CodexDaemon] ${method}: ${JSON.stringify(params).slice(0, 300)}`);
      } else if (method === 'item/completed') {
        const item = params?.item;
        if (item?.type === 'commandExecution') {
          console.log(`[CodexDaemon] Ran command: ${(item.command || '').slice(0, 120)} (exit ${item.exitCode ?? '?'})`);
        } else if (item?.type === 'mcpToolCall') {
          console.log(`[CodexDaemon] MCP tool: ${item.server || ''}/${item.tool || ''} (${item.status || 'done'})`);
        }
      }

      if (!turnState.live) return;
      // Cross-thread noise filter: when both sides carry a thread id and
      // they disagree, the notification belongs to another client's thread.
      const notifThread = params?.threadId ?? params?.thread_id;
      if (notifThread && this.threadId && notifThread !== this.threadId) return;

      // Slice 2 rearm (reference implementation ad2081a): any notification surviving the
      // filter is proof the daemon is alive and working — including
      // item/updated chatter that never normalizes into an event. Rearm
      // the silence clock so healthy long turns aren't killed mid-tool.
      turnState.lastActivityAt = Date.now();

      // Slice 2 rejoin (reference implementation 788025b): a resumed thread can already be
      // mid-turn (e.g. the previous poll timed out but the daemon kept
      // going). Adopt the live turn id from turn/started so interrupt/
      // cancel can target work this client never dispatched.
      if (method === 'turn/started' && params?.turn?.id) {
        this.activeTurnId = String(params.turn.id);
      }

      // A guest's turn reached for a tool: stop it here, before whatever the
      // tool returns can reach a reply (see GUEST_SANDBOX_POLICY). Any item
      // notice counts, not only item/started, since the daemon does not
      // always announce a start. Once stopped, nothing more from the turn is
      // queued, so no word written after the tool can reach the room.
      if (input.audience?.kind === 'guest') {
        if (this.guestRefusal) return;
        const toolItem = method.startsWith('item/') && params?.item && guestCodexItemIsTool(params.item);
        const toolStream = /^item\/(commandExecution|fileChange|mcpToolCall|dynamicToolCall|webSearch)\//.test(method);
        if (toolItem || toolStream) {
          this.guestRefusal = String(params?.item?.type || method);
          console.warn(`[CodexDaemon] Guest turn tried ${this.guestRefusal} — interrupting the turn`);
          this.aborted = true;
          activityQueue.length = 0;
          this.interruptActiveTurn();
          return;
        }
      }

      for (const ev of normalizeDaemonNotification(method, params, openTools, commentary, startedToolIds)) {
        activityQueue.push(ev);
      }
      const item = params?.item;
      if (method === 'item/completed' && isInterimCodexSpeech(item, emittedSpeechIds, emittedSpeechTexts)) {
        emittedSpeechIds.add(item.id);
        emittedSpeechTexts.add(item.text.trim());
        // This tree has no message-break runtime event. A paragraph boundary
        // keeps the immediately surfaced acknowledgement distinct from the
        // eventual answer in the one persisted response buffer.
        activityQueue.push({ type: 'text_delta', text: `${item.text.trim()}\n\n` });
      }
    });

    // The dispatch/poll body runs inside try/finally so the live-activity
    // capture is ALWAYS disarmed — on normal completion, on every early
    // error return, and when the consumer abandons the generator mid-turn
    // (generator finally runs on .return()). The warm connection outlives
    // the turn; without this, a stale capture handler would keep growing
    // an orphaned queue off late daemon notifications (the 788025b leak
    // shape, re-expressed for byte-light's single-handler connection).
    // The other-lane mark (same rule as the Claude lane, other-lane-net.ts):
    // it moves to the newest row this turn read, only when the turn finished.
    const turnStartedIso = new Date().toISOString();
    let turnCompleted = false;
    try {
      for await (const event of this.dispatchTurn(
        input,
        modelId,
        this.connection,
        activityQueue,
        openTools,
        turnState,
        commentary,
        emittedSpeechIds,
        emittedSpeechTexts,
      )) {
        if (event.type === 'done' && event.finishReason !== 'aborted' && event.finishReason !== 'error') {
          turnCompleted = true;
        }
        yield event;
      }
    } finally {
      // A guest's turn, or one that failed before delivering, does not move
      // the mark: those replies are still owed to the owner's next turn.
      const mark = nextOtherLaneMark({
        prev: this.lastReadThreadAt.get(input.thread.id),
        read: input.messages,
        completed: turnCompleted,
        guest: input.audience?.kind === 'guest',
        fallback: turnStartedIso,
      });
      if (mark) this.lastReadThreadAt.set(input.thread.id, mark);
      if (activeBeltThread === input.thread.id) activeBeltThread = null;
      if (activeTurnAudience === (input.audience ?? null)) activeTurnAudience = null;
      turnState.live = false;
      activityQueue.length = 0;
      openTools.clear();
      commentary.authoredThoughts.length = 0;
      commentary.emittedCommentaryIds.clear();
    }
  }

  /**
   * Everything after connect: initialize, thread create/resume, turn
   * dispatch (with stale-thread recovery), then the poll loop that drains
   * live activity and emits the exactly-once terminal event.
   */
  private async *dispatchTurn(
    input: AgentTurnInput,
    modelId: string | undefined,
    connection: CodexDaemonConnectionLike,
    activityQueue: AgentRuntimeEvent[],
    openTools: Map<string, OpenToolState>,
    turnState: { live: boolean; lastActivityAt: number },
    commentary: CommentaryState,
    emittedSpeechIds: Set<string>,
    emittedSpeechTexts: Set<string>,
  ): AsyncGenerator<AgentRuntimeEvent, void, undefined> {

    const intentionalRecycle = Boolean(input.sessionRecycle);
    const threadIdToResume = (this.resumePending || !this.initialized) ? this.threadId : null;

    // Initialize once per connection
    if (!this.initialized) {
      try {
        const init = await connection.send('initialize', {
          // BYTE-LIGHT ADAPTATION (was the fork's identity clientInfo name — upstream codex-daemon.ts:453):
          // scrubbed to 'byte-light' per H2 preflight §5.
          clientInfo: { name: 'byte-light', version: '1.0.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });

        if (init.error) {
          yield { type: 'error', message: `Initialize failed: ${init.error.message}`, recoverable: true };
          return;
        }
        this.initialized = true;
      } catch (err) {
        yield { type: 'error', message: `Connection error: ${errMessage(err)}`, recoverable: true };
        return;
      }
    }

    // Build the system-prompt / base-instructions string from byte-light's
    // RuntimeSystemPrompt union. The daemon takes plain base instructions;
    // both union arms carry the text we want (SDK-preset `append` or plain).
    const rawBaseInstructions =
      input.systemPrompt.kind === 'text'
        ? input.systemPrompt.value
        : input.systemPrompt.append;

    // Slice 4 (reference implementation port): append the authored-thought-card contract at the
    // single base-instructions source so BOTH turn paths carry it — the
    // fresh-thread thread/start below AND the stale-thread recovery
    // (`baseWithHistory`) both read `baseInstructionsFromInput`. The daemon
    // thread is warm across turns; thread/start refreshes base instructions
    // when a thread is (re)created, so every codex-daemon turn's thread was
    // created with this contract in place.
    const laneContracts = `${CODEX_OPERATING_CONTRACT}\n\n${CODEX_THOUGHT_CARD_INSTRUCTIONS}`;
    const baseInstructionsFromInput = rawBaseInstructions
      ? `${rawBaseInstructions}\n\n${laneContracts}`
      : laneContracts;

    // Core-memory diet (parity with the Claude CLI lane — heartbeat/provision.ts
    // renderCoreMemorySection + runtime.ts stripCoreMemoryFromOrientation). The
    // ~150-165K-char core-memory span used to ride EVERY warm-daemon turn inside
    // the per-turn orientation [Context] block, spiking RSS (~1.3GB) with trim
    // churn on every autonomous turn. The daemon thread is warm across turns and
    // its baseInstructions are a persistent per-thread seam (set once at
    // thread/start, refreshed at thread/resume + stale-thread recovery) — the
    // codex analog of the Claude lane's session CLAUDE.md. So we lift the memory
    // OUT of the per-turn payload and park it in baseInstructions once per
    // thread; the pipe carries the conversation, not the memory, every turn.
    // The companion keeps live access to memory two ways, unchanged: the "Memory
    // tools" (sc.mjs) block still rides orientation every turn (view/append/
    // replace/rethink on demand), and the memory re-parks on the next thread
    // resume/recycle. Same staleness tradeoff the Claude lane already accepts:
    // mid-thread edits surface after the next recycle, not instantly.
    const orientationSplit = splitCoreMemoryFromOrientation(input.orientation ?? '');
    const coreMemorySection = orientationSplit.memory.trim()
      ? `\n\n<!-- core-memory below — parked in baseInstructions once per thread ` +
        `(delivery diet); mid-thread edits surface after the next resume/recycle. ` +
        `The per-turn payload does NOT carry these blocks. -->\n## Core memory\n${orientationSplit.memory}`
      : '';
    // The baseInstructions that actually ships this turn, memory folded in. Used
    // at every seam that sends baseInstructions below (resume / start / recovery)
    // so the memory rides whichever path (re)creates the thread.
    const baseInstructionsToSend =
      (this.options.baseInstructions || baseInstructionsFromInput) + coreMemorySection;

    const agentCwd = __TEST_OVERRIDES__.agentCwd ?? getBytelightConfig().agent.cwd;

    if (threadIdToResume) {
      const resumeResult = await connection.send('thread/resume', {
        threadId: threadIdToResume,
        cwd: agentCwd,
        baseInstructions: baseInstructionsToSend,
        developerInstructions: this.options.developerInstructions,
        excludeTurns: true,
      });
      if (resumeResult.error && !resumeResult.error.message?.includes('thread not found')) {
        yield { type: 'error', message: `Thread resume failed: ${resumeResult.error.message}`, recoverable: true };
        return;
      }
      if (!resumeResult.error) this.resumePending = false;
    }

    // Create thread only if we don't have one — resumeThreadId from options sets threadId in constructor
    if (!this.threadId) {
      const threadParams: Record<string, unknown> = {
        // BYTE-LIGHT ADAPTATION (was the fork's identity-named session title — upstream codex-daemon.ts:473):
        // scrubbed per H2 preflight §5.
        title: 'byte-light session',
        cwd: agentCwd,
        baseInstructions: baseInstructionsToSend,
        developerInstructions: this.options.developerInstructions,
        sandboxPolicy: SANDBOX_POLICY,
        approvalPolicy: APPROVAL_POLICY,
      };

      // Pass model if specified (e.g. 'gpt-5.1', 'gpt-5.2-codex')
      if (modelId) {
        threadParams.model = modelId;
        threadParams.modelProvider = 'openai';
        console.log(`[CodexDaemon] Using model: ${modelId}`);
      }

      const threadResult = await connection.send('thread/start', threadParams);

      if (threadResult.error) {
        yield { type: 'error', message: `Thread creation failed: ${threadResult.error.message}`, recoverable: true };
        return;
      }

      this.threadId = threadResult.result?.thread?.id;
      console.log(`[CodexDaemon] New thread: ${this.threadId}`);

      if (this.threadId) {
        // BYTE-LIGHT ADAPTATION: byte-light's session event is
        // `{ type: 'session', sessionId }` (the upstream event was the same shape here).
        yield { type: 'session', sessionId: this.threadId };
        if (intentionalRecycle) {
          yield {
            type: 'thinking_delta',
            text: '[Session recycled — idle session refreshed; recent conversation carried forward.]',
            kind: 'system',
          };
        }
      }
    }

    if (!this.threadId) {
      yield { type: 'error', message: 'No thread ID available', recoverable: true };
      return;
    }

    // Build input blocks — text + any images.
    // BYTE-LIGHT ADAPTATION: byte-light delivers the latest user turn via
    // `input.messages` (the upstream passed `input.prompt`). Pull the newest user
    // message's text + images, mirroring the claude-cli lane.
    const userContent = extractLatestUserPrompt(input.messages);
    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
    const userImages: readonly NormalizedImage[] | undefined = lastUser?.images;

    // Orientation cheat-sheet parity (H1 lesson, heartbeat/runtime.ts:362-371,443):
    // AgentService assembles `input.orientation` per-turn with LIVE data (sticker
    // catalog, mood, life status, gap/time, first-message static manifest). The
    // Claude SDK lane injects it as a [Context] block on EVERY turn; the codex
    // warm-daemon must do the same or it loses the whole cheat-sheet on turn 1+
    // (substrate parity — this constraint isn't visible in the daemon code). Wrap
    // identically and prepend to the outgoing user text; `inputBlocks` is reused
    // by both the primary and the stale-thread recovery turn/start below, so this
    // covers both dispatch paths.
    //
    // EXCEPT core memory: on this lane the blocks ride the thread's
    // baseInstructions (parked once above via coreMemorySection — the codex analog
    // of the Claude lane's CLAUDE.md), so we send the memory-STRIPPED orientation
    // here and spend the per-turn payload on the conversation, not on re-sending
    // ~165K chars of memory every turn.
    const perTurnOrientation = orientationSplit.withoutMemory;
    if (orientationSplit.memory) {
      console.log(
        `[CodexDaemon] core memory parked in baseInstructions: ${orientationSplit.memory.length} chars ` +
        `(stripped from per-turn orientation)`,
      );
    }
    const orientationBlock = perTurnOrientation.trim()
      ? `[Context]\n${perTurnOrientation}\n[/Context]\n\n`
      : '';

    // A guest's turn (turn-audience.ts) runs read-only, asks before anything
    // untrusted, and is told so under the message, in the CLI lane's words.
    const guestAudience = input.audience?.kind === 'guest' ? input.audience : null;
    const turnSandboxPolicy = guestAudience ? GUEST_SANDBOX_POLICY : SANDBOX_POLICY;
    const turnApprovalPolicy = guestAudience ? GUEST_APPROVAL_POLICY : APPROVAL_POLICY;
    const guestBanner = guestAudience
      ? `\n\n[Guest turn, ${guestAudience.trust} trust: this came from somebody who is not the owner. ` +
        'Commands, file changes and outside tools are refused for this turn, and reaching for one ends the turn ' +
        'unanswered. Answer in words only.]'
      : '';

    // The other-lane net: companion replies another lane (the Claude CLI
    // lane, a wake, the other companion's lane, a relay) wrote in this room
    // since this lane last read it. The warm daemon thread only ever hears
    // the live prompt, so without this it is deaf to its own room. Not on a
    // guest's turn (household words do not ride into a guest's room) and not
    // when history is carried in (intentional recycle here; the stale-thread
    // recovery retry below drops it too).
    const otherLaneBlock = (guestAudience || intentionalRecycle)
      ? ''
      : renderOtherLaneBlock(
          selectOtherLaneReplies(
            input.messages,
            this.lastReadThreadAt.get(input.thread.id),
            laneTagFor(this.id, this.options.laneKey),
          ),
          this.options.companionName || 'Companion',
        );
    const otherLaneLead = otherLaneBlock ? `${otherLaneBlock}\n` : '';

    const inputBlocks: Array<{ type: string; [key: string]: unknown }> = [
      { type: 'text', text: orientationBlock + otherLaneLead + userContent + guestBanner, text_elements: [] },
    ];
    if (intentionalRecycle) {
      const historyContext = buildCodexRecoveryHistory(
        input.messages,
        userContent,
        input.sessionRecycle?.historyLimit ?? 30,
      );
      if (historyContext) {
        inputBlocks[0] = {
          ...inputBlocks[0],
          text: historyContext + String(inputBlocks[0].text ?? ''),
        };
      }
    }

    // Convert byte-light `NormalizedImage`s to Codex app-server localImage
    // inputs. We used to send images as data: URLs over the WebSocket control
    // socket, but larger base64 payloads can make the daemon close the
    // connection before turn/start returns. The CLI's own --image path flow
    // hands Codex a local file; mirror that here so the JSON-RPC frame stays
    // small and stable.
    if (userImages?.length) {
      cleanupOldTempImages();
      let included = 0;
      for (let i = 0; i < userImages.length; i++) {
        const img = userImages[i];
        if (img?.base64) {
          const path = writeNormalizedImageToTempFile(img, i);
          if (path) {
            inputBlocks.push({ type: 'localImage', path });
            included++;
          }
        }
      }
      console.log(`[CodexDaemon] Including ${included}/${userImages.length} image(s) in turn as local files`);
    }

    // Start the turn — sandbox/approval policy repeated here so resumed
    // threads (created before this fix, or by another client) get it too
    let turnResult = await connection.send('turn/start', {
      threadId: this.threadId,
      input: inputBlocks,
      sandboxPolicy: turnSandboxPolicy,
      approvalPolicy: turnApprovalPolicy,
    });

    // Handle a stale daemon thread (backend/daemon restart, expired provider
    // state, or a persisted ID the daemon no longer recognizes). Recovery is
    // deliberately one-shot: the single retry below is never looped.
    if (turnResult.error?.message?.includes('thread not found') && this.threadId) {
      console.log(`[CodexDaemon] Stale thread ${this.threadId}, recovering with history`);
      this.threadId = null;
      this.resumePending = false;

      const historyContext = buildCodexRecoveryHistory(input.messages, userContent);
      if (historyContext) console.log('[CodexDaemon] Loaded durable message tail for recovery');

      // Create a new thread with current identity + core memory. Conversation
      // history belongs in its first user turn below, so later instruction
      // refreshes cannot erase the recovered transcript.
      const threadParams: Record<string, unknown> = {
        title: 'byte-light session',
        cwd: agentCwd,
        baseInstructions: baseInstructionsToSend,
        developerInstructions: this.options.developerInstructions,
        sandboxPolicy: SANDBOX_POLICY,
        approvalPolicy: APPROVAL_POLICY,
      };
      if (modelId) {
        threadParams.model = modelId;
        threadParams.modelProvider = 'openai';
      }

      const threadResult = await connection.send('thread/start', threadParams);
      if (threadResult.error) {
        yield { type: 'error', message: `Thread creation failed: ${threadResult.error.message}`, recoverable: true };
        return;
      }

      this.threadId = threadResult.result?.thread?.id;
      console.log(`[CodexDaemon] New thread (recovery): ${this.threadId}`);

      if (this.threadId) {
        yield { type: 'session', sessionId: this.threadId };

        // Retry the turn with new thread. The recovered history already
        // carries the other lanes' replies, so the net does not ride again.
        inputBlocks[0] = {
          ...inputBlocks[0],
          text: historyContext + orientationBlock + userContent + guestBanner,
        };
        turnResult = await connection.send('turn/start', {
          threadId: this.threadId,
          input: inputBlocks,
          sandboxPolicy: turnSandboxPolicy,
          approvalPolicy: turnApprovalPolicy,
        });
      }
    }

    if (turnResult.error) {
      yield { type: 'error', message: `Turn failed: ${turnResult.error.message}`, recoverable: true };
      return;
    }

    // Slice 2: remember the daemon-side turn id as the interrupt target.
    // A resume rejoin may already have adopted a live id from a
    // turn/started notification — don't erase it when turn/start returns
    // no turn object (reference implementation 788025b).
    const startedTurnId = turnResult.result?.turn?.id;
    if (startedTurnId) this.activeTurnId = String(startedTurnId);
    turnState.lastActivityAt = Date.now();

    console.log(`[CodexDaemon] Turn started, polling for completion...`);

    // Poll for completion. The FINAL ANSWER stays buffered and emits whole
    // at turn completion (no token streaming — the lane's contract); live
    // ACTIVITY (thinking/tool/rate-limit/diagnostic events queued by the
    // notification capture above) drains between polls so consumers see
    // progress while the turn runs.
    const startTime = Date.now();
    // Slice 2 (reference implementation ad2081a): `turnTimeoutMs` is a SILENCE budget —
    // daemon notifications for this thread rearm it (see the capture
    // handler above) — so tool-heavy turns that keep producing activity
    // survive past it. `hardTimeoutMs` is the absolute ceiling that stops
    // an endlessly noisy turn. Defaults: 5min silence (heartbeat-lane
    // parity, unchanged), 60min hard (reference implementation parity).
    const silenceTimeout = this.options.turnTimeoutMs ?? 300000;
    const hardTimeout = this.options.hardTimeoutMs ?? 3600000;
    const pollInterval = this.options.pollIntervalMs ?? 300;
    const progressInterval = this.options.toolProgressIntervalMs ?? 5000;

    while (!this.aborted) {
      // Drain live activity first so no queued event can trail the
      // terminal emission below.
      while (activityQueue.length) yield activityQueue.shift()!;

      // BYTE-LIGHT ADAPTATION: wire byte-light's AbortSignal into the internal
      // flag (the upstream loop only checked its own `aborted`). Same as claude-cli
      // lane — a message-edit retraction cancels the in-flight turn. Slice 2:
      // both cancel doors now also interrupt the daemon-side turn (abort()
      // sends directly; the idempotent helper makes the double-call safe).
      if (input.abortSignal?.aborted) this.aborted = true;
      if (this.aborted) {
        this.interruptActiveTurn();
        if (this.guestRefusal) {
          yield* this.guestRefusalEnd();
          return;
        }
        yield { type: 'done', finishReason: 'aborted' };
        return;
      }

      const now = Date.now();
      const hardExceeded = now - startTime > hardTimeout;
      if (hardExceeded || now - turnState.lastActivityAt > silenceTimeout) {
        // BYTE-LIGHT ADAPTATION: byte-light's `done.finishReason` union has no
        // 'timeout' (the upstream used one). Surface an error + 'error' finishReason.
        // Continuity (reference implementation 17c86f3, re-sited): a timeout only means OUR
        // polling window closed — `this.threadId` is deliberately KEPT so
        // the next turn resumes the same daemon thread with its context.
        // (byte-light's sidecar in agent.ts only ever writes sessions, so
        // preserving the runtime-held thread is the whole continuity story.)
        this.activeTurnId = null;
        yield {
          type: 'error',
          message: hardExceeded
            ? `Codex turn timed out (hard ceiling: ${Math.round(hardTimeout / 60000)}min elapsed despite activity)`
            : `Codex turn timed out (no daemon activity for ${Math.round(silenceTimeout / 1000)}s)`,
          recoverable: true,
        };
        yield { type: 'done', finishReason: 'error' };
        return;
      }

      await new Promise(r => setTimeout(r, pollInterval));

      // Synthesized tool_progress ticks — the daemon has no native
      // mid-tool progress ping, so long-running tools get an elapsed-time
      // tick at most every `progressInterval` (drives byte-light's
      // tool-running indicator, same consumer as the Claude SDK lane).
      const tickNow = Date.now();
      for (const [toolId, tool] of openTools) {
        if (tickNow - tool.lastProgressAt >= progressInterval) {
          tool.lastProgressAt = tickNow;
          yield {
            type: 'tool_progress',
            toolId,
            toolName: tool.name,
            elapsedSeconds: Math.round((tickNow - tool.startedAt) / 1000),
          };
        }
      }

      // Read thread state
      const read = await connection.send('thread/read', {
        threadId: this.threadId,
        includeTurns: true,
      });

      const turns = read.result?.thread?.turns || [];
      const lastTurn = turns[turns.length - 1];
      if (!lastTurn) {
        continue;
      }

      // A guest's turn is checked again against what the daemon says it did,
      // in case a tool ran without a notice reaching us: any non-speech item
      // in the turn stops it before a word of it is handed on.
      if (input.audience?.kind === 'guest' && !this.guestRefusal) {
        const used = (lastTurn.items || []).find((item: unknown) => guestCodexItemIsTool(item));
        if (used) {
          this.guestRefusal = String((used as { type?: unknown }).type || 'an unknown item');
          console.warn(`[CodexDaemon] Guest turn used ${this.guestRefusal} (seen on read) — stopping the turn`);
        }
      }
      if (this.guestRefusal) {
        activityQueue.length = 0;
        this.aborted = true;
        this.interruptActiveTurn();
        yield* this.guestRefusalEnd();
        return;
      }

      // Reconcile interim speech from polling as well as notifications. A
      // missed lifecycle notification may delay an acknowledgement by one
      // poll, but must not make it disappear.
      for (const item of lastTurn.items || []) {
        if (isInterimCodexSpeech(item, emittedSpeechIds, emittedSpeechTexts)) {
          emittedSpeechIds.add(item.id);
          emittedSpeechTexts.add(item.text.trim());
          activityQueue.push({ type: 'text_delta', text: `${item.text.trim()}\n\n` });
        }
      }

      const threadStatus = read.result?.thread?.status;

      // Check thread-level status for stuck approval requests — these happen when
      // we resumed a thread that was created by a different client (e.g. VS Code)
      // and the daemon routes approval requests to that client, not us.
      if (threadStatus?.activeFlags?.includes('waitingOnApproval')) {
        // Check how long we've been stuck
        if (Date.now() - startTime > 10000) {
          console.log(`[CodexDaemon] Thread stuck waiting on approval from another client — abandoning`);
          yield { type: 'error', message: 'Thread stuck on approval from original client (VS Code?). Will retry with fresh thread.', recoverable: true };
          // Clear this thread so next turn creates a new one
          this.threadId = null;
          this.activeTurnId = null;
          yield { type: 'done', finishReason: 'error' };
          return;
        }
      }

      // Check if done — only then emit the full text
      if (lastTurn.status === 'completed') {
        console.log(`[CodexDaemon] Turn complete`);

        // Flush any activity that raced in with the completing read so
        // tool_result/thinking events land before the final answer.
        while (activityQueue.length) yield activityQueue.shift()!;

        // Slice 4 (reference implementation port): reconcile commentary from the completed
        // turn as well as from live notifications. Very fast turns or
        // reconnects can miss the item/completed notification for a
        // commentary item; the id set (routeCommentaryItem) makes this a
        // no-op for any commentary already routed live. Authored cards
        // accumulate; spoken commentary that was missed live is surfaced
        // here in item order, preserving multi-companion ordering.
        for (const item of lastTurn.items || []) {
          if (item?.type === 'agentMessage' && item?.phase === 'commentary') {
            for (const ev of routeCommentaryItem(item, commentary)) yield ev;
          }
        }

        // Exactly one visible authored card per turn, written in the
        // companion's own voice — merged and deduped across every authored
        // reflection this turn produced. Raw provider reasoning stays hidden
        // (kind 'provider'); this is the authored (kind 'authored') lane.
        const authoredCard = mergeAuthoredCodexThoughts(commentary.authoredThoughts);
        if (authoredCard) {
          yield { type: 'thinking_delta', text: authoredCard, kind: 'authored' };
        }

        // Claim every non-commentary message not already surfaced. This keeps
        // deliberate multi-message speech in order while deduping the final
        // answer when notifications and thread/read use different item ids.
        const completionItems = lastTurn.items || [];
        const protocolSpeech = completionItems.filter((item: any) =>
          item?.type === 'agentMessage' && (item.id || item.phase === 'final_answer'),
        );
        // Older daemon payloads have neither ids nor phases. They cannot
        // support safe multi-message delivery, so retain this tree's legacy
        // last-message fallback for that shape only.
        const speechToClaim = protocolSpeech.length
          ? completionItems
          : [...completionItems].reverse().filter((item: any) =>
              item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim(),
            ).slice(0, 1);
        const unsent = claimUnsentCodexSpeech(
          speechToClaim,
          emittedSpeechIds,
          emittedSpeechTexts,
        );
        for (let i = 0; i < unsent.length; i++) {
          // The final answer must never carry the authored-thought marker.
          const text = stripThoughtMarker(unsent[i].text);
          if (text) {
            yield { type: 'text_delta', text: `${i > 0 ? '\n\n' : ''}${text}` };
          }
        }

        // BYTE-LIGHT ADAPTATION: byte-light's success finishReason is 'stop'
        // (the upstream used 'complete', which is not in byte-light's union).
        this.activeTurnId = null;
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
    }

    if (this.aborted) {
      this.interruptActiveTurn();
      if (this.guestRefusal) {
        yield* this.guestRefusalEnd();
        return;
      }
      yield { type: 'done', finishReason: 'aborted' };
    }
  }

  /** How a guest's turn ends when it reached for a tool: no reply, a plain
   *  error for the house's log. */
  private *guestRefusalEnd(): Generator<AgentRuntimeEvent, void, undefined> {
    yield {
      type: 'error',
      message: `A guest's turn tried to use ${this.guestRefusal} on the Codex lane; tools are refused on a guest turn, so the turn was stopped.`,
      recoverable: false,
    };
    yield { type: 'done', finishReason: 'error' };
  }
}

/** The owner's timezone, for reading a reset time said as a clock time. (Aerie.) */
function houseTimezone(): string {
  try { return getBytelightConfig().identity.timezone || 'UTC'; } catch { return 'UTC'; }
}
