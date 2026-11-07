/**
 * Multi-provider runtime interface — the contract every provider runtime
 * (Claude SDK, Codex OAuth, OpenRouter, Ollama) implements.
 *
 * Ported verbatim from reference implementation/main @ 76f9534 (reference implementation PR B1 design)
 * for byte-light Phase 2 Step 2. The B-series migration arc described
 * below is preserved so future readers see WHY the interface has its
 * current shape (especially the `runTurn` stub-that-throws asymmetry).
 *
 * Status across the B-series PRs:
 *
 * - **PR B1** (interface scaffold): types defined. `ClaudeAgentRuntime`
 *   exists as a stub whose `runTurn` throws. No caller dispatches
 *   through the interface yet.
 * - **PR B1.5** (digest reroute): the rogue `digest.ts` SDK import is
 *   consolidated through `agent.ts`'s `runOneShotQuery` helper.
 * - **PR B2a** (SDK call site moved): `ClaudeAgentRuntime.dispatchClaudeQuery`
 *   owns SDK `Options` assembly and the `query()` call.
 *   `_processQuery` calls it instead of `query()` directly, but still
 *   iterates the returned SDK `Query` and consumes SDK-shaped messages.
 * - **PR B2b** (next): MCP loading + capability methods
 *   (`mcpServerStatus`, `toggleMcpServer`, `reconnectMcpServer`,
 *   `rewindFiles`, `getContextUsage`, `listSessions`) move from
 *   `AgentService` into the runtime as capability providers.
 * - **PR B3**: `runTurn` stops throwing and becomes the canonical
 *   entry point. AgentService consumes `AgentRuntimeEvent` directly;
 *   the WS broadcast layer becomes runtime-agnostic. Side-by-side WS
 *   regression suite proves event parity.
 *
 * See `shared/multi-provider-runtime-spec-2026-05-16.md` (gitignored)
 * for the full design and PR sequence rationale.
 *
 * byte-light Phase 2 Step 2 anchor: this file lands together with the
 * Claude runtime adapter (`claude-sdk.ts`) and the dispatcher scaffold
 * (`index.ts`). `_processQuery` consumes canonical events through the
 * runtime; Codex / OpenAI-compat / Ollama runtimes are type-declared
 * but throw "not wired up yet" until later steps.
 */

import type { Thread } from '@bytelight/shared';
import type { ModelRef, ProviderId, RuntimeId, ThinkingEffort, ThoughtKind } from '@bytelight/shared';
import type { TurnAudience } from '../turn-audience.js';
// SLICE-3a ADAPTATION (tag: stable-pre-rollback-2026-06-20): the tag
// imported `AgentModelTier` from '../agent.js'. Main's agent.ts does not
// export it yet (agent.ts is untouched until Slice 3b), so the type is
// declared here verbatim from the tag's agent.ts:441. When Slice 3b
// re-exports it from agent.ts, collapse back to a single declaration.
export type AgentModelTier = 'interactive' | 'autonomous' | 'pulse' | 'memory';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * System prompt shape varies per runtime. Claude SDK accepts a preset
 * marker `{ type: 'preset', preset: 'claude_code', append }`; other
 * runtimes take plain text. The union preserves the Claude shape
 * losslessly so we don't strip the preset on the way through.
 */
export type RuntimeSystemPrompt =
  | { kind: 'text'; value: string }
  | { kind: 'claude-preset'; preset: 'claude_code'; append: string };

/**
 * Image attachment carried on a `NormalizedMessage`. Raw base64 bytes
 * (no `data:` prefix) plus MIME type tracked separately — matches
 * pi-ai's `ImageContent` shape so vision-aware runtimes (Codex via
 * pi-ai's openai-codex-responses provider) can translate without an
 * intermediate decode/re-encode cycle. Text-only runtimes (Claude
 * SDK reads `content` directly) ignore this field.
 */
export interface NormalizedImage {
  /** Raw base64 bytes. No `data:image/...;base64,` prefix. */
  base64: string;
  /** MIME type, e.g. `image/png`, `image/jpeg`. */
  mimeType: string;
}

/**
 * Minimal normalized message shape used in handoff packets and (later)
 * in conversation history replay for runtimes without native session
 * resume. Intentionally tiny — providers translate to their own
 * native shape inside `runTurn`.
 *
 * `images` is optional and only set on user messages that carry image
 * attachments. Vision-capable runtimes translate to their native
 * mixed-content shape; text-only runtimes read `content` and ignore
 * `images`. The string in `content` remains the back-compat text
 * representation so existing call sites that only read `content`
 * keep working unchanged.
 */
export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;        // ISO 8601
  images?: NormalizedImage[];
  /** Companion rows only: which lane wrote it (metadata.lane, see laneTagFor). */
  lane?: string;
  /** Companion rows only: which companion spoke (messages.companion_id). */
  companionId?: string;
}

/**
 * Cross-provider handoff packet. Generated when a turn is dispatched
 * on a (runtime, provider, model) combination with no session row in
 * `thread_provider_sessions` for the current thread AND the thread
 * has at least one prior assistant turn.
 *
 * Renamed from "handoff packet" in spec Rev 2 to avoid collision with
 * the existing Claude-SDK `session.handoff_note` (which is the
 * compaction recovery note — distinct concept).
 *
 * Shape aligned with `services/handoff.ts` ProviderHandoff (PR E2 —
 * was previously diverged from the producer's shape, leaving the
 * dispatcher unable to pass the packet typed through to CodexRuntime
 * without a per-call adapter).
 */
export interface ProviderHandoff {
  handoffVersion: 1;
  /** Destination metadata — what combo this packet was built FOR. */
  toRuntime: string;
  toProvider: string;
  toModelRef: string;
  /** Source metadata — best-guess from the most-recent sidecar row for
   *  the thread, or undefined when no prior session exists. */
  fromModelRef?: string;
  /** Thread name from the threads table; renders so the new combo
   *  knows the thread identity. */
  threadTitle: string;
  /** The actual narrative summary, 2-4 sentences typically. */
  summary: string;
  /** `extractive-fallback` indicates the memory-tier call failed and
   *  the deterministic first-sentence extraction was used instead. */
  summarySource: 'memory-tier' | 'extractive-fallback';
  /** Last N raw exchanges, chronological order, trimmed to fit
   *  `budget.recentTokens`. May be empty if the budget is exhausted
   *  by the summary alone. */
  recentMessages: NormalizedMessage[];
  budget: {
    summaryTokens: number;
    recentTokens: number;
    totalCap: number;
  };
  /** Sum of summary + rendered messages chars / CHARS_PER_TOKEN.
   *  Diagnostic only — caller can log it to spot budget regressions. */
  totalTokensApprox: number;
}

/**
 * Placeholder tool definition. Claude SDK runs MCP servers natively
 * (no explicit tools list passed to `runTurn`); non-Claude runtimes
 * in later PRs will translate this to their provider-native format.
 * For PR B1 the shape is intentionally minimal — fleshed out when a
 * non-Claude runtime first needs it.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;           // JSON schema; provider-translated at request build
}

/** Subset of `Thread` needed to dispatch a turn. */
export type ThreadHandle = Pick<
  Thread,
  'id' | 'name' | 'type' | 'current_session_id'
>;

/**
 * Input to a runtime turn. Built by `AgentService` from the user
 * message + orientation context + thread state + tier config, then
 * passed to the resolved runtime's `runTurn`.
 */
export interface AgentTurnInput {
  thread: ThreadHandle;
  tier: AgentModelTier;
  modelRef: ModelRef;
  platform: 'web' | 'discord' | 'telegram' | 'api' | 'internal';
  isAutonomous: boolean;
  /** Pre-assembled orientation context block (thread, time, gap, status,
   *  vault). Runtime prepends or includes as appropriate. */
  orientation: string;
  systemPrompt: RuntimeSystemPrompt;
  /** Last-N conversation history in normalized form. Most runtimes
   *  with native session resume ignore this when `sessionId` is set;
   *  others always use it. */
  messages: NormalizedMessage[];
  /** Cross-provider bridge packet when the (runtime, provider, model)
   *  combination has no prior session for this thread. */
  handoff?: ProviderHandoff;
  /** Provider-native session id for resume (Claude SDK session_id,
   *  Codex conversation_id, etc.). Omitted for fresh sessions. */
  sessionId?: string;
  /** Deliberately replace a still-valid provider session after a bounded
   * idle gap, carrying durable history into the fresh session. */
  sessionRecycle?: { reason: 'idle'; historyLimit: number };
  cwd?: string;
  thinkingEffort?: ThinkingEffort;
  tools?: ToolDefinition[];
  abortSignal?: AbortSignal;
  /** Who this turn came from, as far as tools are concerned
   *  (services/turn-audience.ts). Absent = the owner's turn or the house's
   *  own wake, which run every tool. A guest's turn runs none on the
   *  router/SDK/Codex paths, and only the narrow reads hooks/gate.cjs
   *  allows on the warm Claude CLI lane. */
  audience?: TurnAudience;
}

// ---------------------------------------------------------------------------
// Events (the stream emitted by `runTurn`)
// ---------------------------------------------------------------------------

/**
 * Normalized event stream from any runtime. Replaces direct consumption
 * of Claude SDK message shapes in the WebSocket broadcast / persistence
 * layers (the wiring happens in PR B3 — for now this is just a contract).
 *
 * `text_delta` vs `text_snapshot`: some providers emit incremental
 * deltas (Claude SDK, OpenAI streaming with delta mode), others emit
 * cumulative snapshots of the full text-so-far (some Ollama models).
 * Consumers handle both: deltas append, snapshots replace.
 *
 * **`text_delta` contract — append exactly:**
 * - Consumers MUST append `text` to the running buffer verbatim and
 *   add NO separators (no `\n\n`, no whitespace, no joiners).
 * - Runtime adapters (the producer side) are responsible for including
 *   any provider-specific spacing inside the emitted `text` itself.
 * - Examples:
 *   - The Claude adapter (`claude-sdk.ts`) emits one event per text
 *     content block; it prefixes `\n\n` on the second-and-subsequent
 *     text blocks within a single assistant message so paragraph
 *     separation survives the append-exactly consumer.
 *   - Token-stream adapters (`api-router.ts` for Ollama / DeepSeek /
 *     OpenAI-compat) emit raw chunks exactly as received from the
 *     upstream provider, with no separator injection of their own —
 *     the provider's tokens already carry their own newlines.
 * - Why this matters: gluing token-stream deltas with `\n\n` at the
 *   consumer produced ~25–50% newline density for routed providers
 *   while Claude block deltas stayed at 1–3%. The two halves of this
 *   contract (producer-side spacing + consumer append-exactly) MUST
 *   travel together — shipping either alone regresses one provider
 *   family. See shared/followup-text_delta-event-contract.md.
 */
export type AgentRuntimeEvent =
  /** Stream actually began (distinct from "queued"). */
  | { type: 'start'; runtimeId: RuntimeId; modelRef: ModelRef }
  /** Provider-native session id captured. Persisted to
   *  `thread_provider_sessions` for future resume. */
  | { type: 'session'; sessionId: string }
  /** Incremental text chunk. Append to running buffer EXACTLY —
   *  consumers add no spacing. Producer (runtime adapter) owns any
   *  provider-specific separators inside `text`. See the
   *  `text_delta` contract block above. */
  | { type: 'text_delta'; text: string }
  /** Cumulative text snapshot. Replace the running buffer. */
  | { type: 'text_snapshot'; text: string }
  /** Incremental reasoning / extended thinking. `summary` carries the
   *  short surfaced version when the provider exposes it (Claude).
   *  `kind` is the reference implementation thought-semantics classification (Slice 3):
   *  `authored` = companion-written reflection, `provider` = native model
   *  reasoning telemetry, `system` = runtime notices (recycle/timeout
   *  seams). Optional — adapters that predate the contract omit it and
   *  consumers fall back to legacy (kindless) handling. */
  | { type: 'thinking_delta'; text: string; summary?: string; kind?: ThoughtKind }
  /** Tool invocation started. `input` is the parsed argument object. */
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  /** Tool invocation completed. `isError` distinguishes recoverable
   *  tool failures from successful results. */
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError?: boolean }
  /** Periodic "tool still running" tick from the provider (Claude SDK
   *  emits `tool_progress` mid-tool-call). Drives the tool-running
   *  indicator with elapsed time. */
  | { type: 'tool_progress'; toolId: string; toolName: string; elapsedSeconds: number }
  /** Context-window gauge update (used / max). Surfaces in the
   *  context-usage indicator. */
  | { type: 'context_usage'; used: number; max: number }
  /** Billable usage report. Distinct from `context_usage` — this is
   *  cost/quota, not gauge. `cost` is provider-reported when available; an
   *  EXPLICIT null declares "no per-turn dollar measurement exists on this
   *  lane" (subscription-billed CLI) — the consumer files NULL instead of
   *  estimating. Absent means "estimate as usual". */
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number | null }
  /** Context compaction lifecycle (Claude SDK only). Drives the
   *  in-flight compaction banner. `preTokens` is the pre-compaction
   *  context-window usage at the moment of the `complete` event
   *  (omitted on `starting` because the SDK doesn't expose it yet). */
  | { type: 'compaction_notice'; phase: 'starting' | 'complete'; preTokens?: number }
  /** Provider signaled a rate limit. `retryAfterMs` is a hint when
   *  available; `status` / `resetsAt` / `rateLimitType` / `utilization`
   *  are passthrough fields from Claude SDK's `rate_limit_info` (kept
   *  so the existing WS broadcast can be reconstructed without
   *  losing fidelity). */
  | { type: 'rate_limit'; retryAfterMs?: number; status?: string; resetsAt?: string; rateLimitType?: string; utilization?: number }
  /** Provider-specific diagnostic (Codex WS fallback, OpenRouter
   *  routing notes, Ollama local server reachability). Surfaced to
   *  logs and optionally to UI. */
  | { type: 'provider_diagnostic'; code: string; message: string; data?: unknown }
  /** Provider needs (re-)authentication. Routes the UI to the
   *  appropriate auth flow instead of showing a generic error. */
  | { type: 'auth_required'; provider: ProviderId; message: string }
  /** Response was suppressed by the runtime itself (e.g. pulse
   *  PULSE_OK from a provider that emits its own suppression
   *  signal). Generalizes today's `stream_end { suppressed: true }`. */
  | { type: 'suppressed'; reason: string }
  /** Ambient memory recall surfaced on this turn (the shiver). Emitted once,
   *  before text, by runtimes that run the whisper (heartbeat/runtime.ts).
   *  `cards` are short excerpts for the shimmer panel; `dejavu` is a
   *  source-veiled near-miss (felt, not shown). AgentService folds this into
   *  the reply message's metadata so the owner can SEE that recall happened.
   *  Purely additive — runtimes that don't whisper never emit it. */
  | {
      type: 'memory_surface';
      cards: Array<{ excerpt: string; date?: string; domain?: string; relevance?: number }>;
      dejavu: boolean;
    }
  /** Turn complete. `finishReason` mirrors OpenAI's vocabulary
   *  because every provider can map to it. */
  | { type: 'done'; finishReason: 'stop' | 'length' | 'tool_calls' | 'aborted' | 'error' }
  /** Unrecoverable runtime error. `recoverable: true` indicates the
   *  user can fix and retry (e.g. config error); `false` indicates
   *  a provider/network failure to surface as-is. */
  | { type: 'error'; message: string; recoverable: boolean };
// Future: { type: 'media'; ... } for vision/image outputs.

// ---------------------------------------------------------------------------
// The runtime interface
// ---------------------------------------------------------------------------

/**
 * Capability key for optional runtime-specific extensions. Intended
 * future use: callers ask `runtime.getCapabilityProvider<T>(key)` for
 * an interface they can call, and runtimes that don't implement that
 * capability return `undefined` (so the UI hides the corresponding
 * controls instead of offering features the runtime can't deliver).
 *
 * **Current status (PR B2b):** the runtime-specific capability
 * methods that exist today (`listSessions`, `mcpServerStatusLive`,
 * `toggleMcpServerLive`, `reconnectMcpServerLive`, `rewindFiles`,
 * `fireContextUsageRefresh`, `getContextUsage`,
 * `resetContextOnCompaction`) are exposed as **direct concrete
 * methods on `ClaudeAgentRuntime`**, not through this lookup.
 * `getCapabilityProvider` exists on the interface but every runtime
 * currently returns `undefined`. The cap-provider abstraction will
 * matter once PR E ships the Codex runtime and AgentService's
 * MCP/rewind/etc. methods need to consult the resolved runtime's
 * capabilities at the call site.
 */
export type CapabilityKey = string;

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly providerId: ProviderId;

  /**
   * Execute one turn. Returns an async iterable of normalized events.
   *
   * Runtime contract:
   * - Always emit `{type: 'start'}` first.
   * - Always emit `{type: 'done'}` exactly once at the end (success,
   *   length, or aborted) OR `{type: 'error'}` exactly once on
   *   unrecoverable failure.
   * - May emit `{type: 'session'}` once when a fresh session is
   *   established (so `AgentService` can persist to
   *   `thread_provider_sessions`).
   * - Other events (`text_delta`, `tool_*`, `thinking_*`,
   *   `usage`, `context_usage`, etc.) are best-effort per provider.
   */
  runTurn(input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent>;

  /**
   * Look up the runtime-native session id to resume for this thread+model
   * pair. Returns `undefined` if no compatible session exists.
   *
   * Optional — runtimes without session resume (Ollama, fresh OpenRouter
   * conversations) don't implement this.
   */
  resumeSessionId?(thread: ThreadHandle, modelRef: ModelRef): string | undefined;

  /**
   * Persist a runtime-native session id for future resume.
   *
   * Optional — paired with `resumeSessionId`. Runtimes that don't
   * support resume don't implement this either.
   */
  persistSessionId?(thread: ThreadHandle, modelRef: ModelRef, sessionId: string): void;

  /**
   * Look up an optional capability extension (MCP toggle, listSessions,
   * file rewind). Returns `undefined` when the runtime doesn't
   * implement that capability — and that's the correct answer to
   * surface (the UI hides the corresponding controls).
   */
  getCapabilityProvider?<T>(cap: CapabilityKey): T | undefined;

  /**
   * Abort the in-flight turn. Idempotent. Optional — runtimes
   * without long-lived in-flight state (single-shot HTTP) may skip.
   */
  abort?(): void;

  /**
   * Release local long-lived resources (sockets, subscriptions) once the
   * consumer is done with the runtime. Session-capable runtimes may keep
   * their provider-side session while closing local state that must not
   * outlive the turn — disposal must not sever conversational continuity.
   * Optional — most runtimes hold no long-lived local resources.
   */
  dispose?(): void | Promise<void>;
}
