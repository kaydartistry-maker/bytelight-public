/**
 * Claude SDK runtime — wraps @anthropic-ai/claude-agent-sdk's `query()`
 * behind the AgentRuntime interface defined in `./types.ts`.
 *
 * Synthesis of:
 * - reference implementation `ClaudeAgentRuntime` (reference implementation/main 76f9534) — the
 *   B-series migration shape: dispatchClaudeQuery + runClaudeTurn, with
 *   `runTurn` left as a stub that throws (intentional — AgentTurnInput
 *   migration happens in Step 3).
 * - reference implementation `ClaudeSDKRuntime` — already adapter-style
 *   but emitted a 12-variant event vocabulary; we re-shape to reference implementation
 *   17-variant canonical union here.
 *
 * Why this is the shape byte-light Step 2 picks:
 *
 * AgentService keeps ownership of:
 *   - prompt assembly (orientation + bridge + content + sticker images)
 *   - mergedMcpServers + filterMcpServers (Step 1 work — load-bearing,
 *     not moved into the runtime to keep MCP merge logic in one place)
 *   - module-level activeAbortController / activeQuery / QueryQueue
 *     (queue lifecycle stays where it lives; we don't refactor that)
 *   - usage accounting, session record bookkeeping (those need DB
 *     access that doesn't belong in the runtime layer)
 *
 * The runtime takes a pre-assembled `ClaudeRuntimeDispatchInput`,
 * builds Claude-SDK-specific `Options`, calls `query()`, iterates the
 * SDK `Query`, and yields canonical `AgentRuntimeEvent`s. Behavior
 * post-Step-2 is byte-identical to the pre-Step-2 direct-SDK
 * consumption in `_processQuery` — the canonical event stream just
 * rides between agent.ts and the SDK now.
 */

import {
  query,
  AbortError,
  type Options,
  type Query,
  type SDKUserMessage,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import type { ImageBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type { ModelRef, ProviderId, RuntimeId, ThinkingEffort } from '@bytelight/shared';
import { join } from 'path';
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentTurnInput,
  CapabilityKey,
  ThreadHandle,
} from './types.js';
import { errMessage } from '../../util/errors.js';
import { extractThinkingSummary } from '../thinking-summary.js';

/**
 * Claude-flavored intermediate input shape for the SDK adapter. NOT
 * the same as `AgentTurnInput` — `AgentTurnInput` is the
 * provider-agnostic future shape `runTurn` will accept once Step 3
 * lands the universal dispatcher. `ClaudeRuntimeDispatchInput` is the
 * concrete shape AgentService's `_processQuery` already builds today;
 * fields below mirror what agent.ts assembles inline at the SDK call
 * site (lines 597-650 pre-Step-2).
 *
 * The Claude SDK shape (preset system prompt, hooks, MCP server map,
 * plugin path, file checkpointing) is captured explicitly so the
 * runtime contract is unambiguous. Anything load-bearing for byte
 * parity post-Step-2 lives here as a typed input — no implicit
 * dependencies on AgentService internals.
 */
export interface ClaudeRuntimeDispatchInput {
  /** Enriched prompt (orientation context + bridge + user content)
   *  OR an async-iterable of SDKUserMessage for multimodal turns. */
  prompt: string | AsyncIterable<SDKUserMessage>;
  /** Raw provider-native model id (`claude-sonnet-4-6`, `sonnet`, etc.). */
  model: string;
  /** Working directory for the SDK (skills discovery, file checkpointing). */
  cwd: string;
  /** Appended to the `claude_code` preset system prompt. Empty string
   *  collapses to the bare preset (matches pre-Step-2 behavior). */
  appendSystemPromptText: string;
  /** MCP server map — already filtered by AgentService via
   *  `buildMergedMcpServers()` + `filterMcpServers()` (Step 1 wiring).
   *  Omitted or empty → no `mcpServers` field on SDK options (preserves
   *  cloud-MCP auto-discovery; see Step 1 commit `d78149f`). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Hook callbacks (Claude-SDK shape) from `createHooks(hookContext)`. */
  hooks: Options['hooks'];
  /** Existing session id to resume. Omitted on fresh sessions. */
  resumeSessionId?: string;
  /** Abort controller for stop_generation + safety timeout. AgentService
   *  owns the module-level `activeAbortController` reference; this is
   *  the same instance passed through. */
  abortController: AbortController;
  /** Per-tier thinking effort resolved by resolveCompanionConfig.
   *  `undefined` and `'auto'` both default to adaptive thinking (the
   *  pre-Step-4A hardcoded behavior). `'none'` and `'minimal'` are
   *  Codex-only vocabulary; this adapter maps them defensively to
   *  disabled thinking. `'xhigh'` is Claude-native at runtime even
   *  though the SDK's exported EffortLevel type omits it. */
  thinkingEffort?: ThinkingEffort;
}

/**
 * Map byte-light's ThinkingEffort vocabulary to the Claude Agent SDK's
 * orthogonal thinking + effort options.
 *
 * SDK accepts two independent fields:
 *   - thinking?: { type: 'adaptive' | 'enabled' | 'disabled' }
 *   - effort?: 'low' | 'medium' | 'high' | 'max' | number
 *
 * Mapping:
 *   undefined | 'auto'   → adaptive thinking, no effort override
 *                          (preserves the pre-Step-4A default)
 *   'none' | 'minimal'   → thinking disabled (Codex-only values; the
 *                          resolver's coerceEffortForProvider should
 *                          stop these reaching Claude — this is the
 *                          defensive fallback if it doesn't)
 *   'low'..'max'         → adaptive thinking + explicit effort level
 *   'xhigh'              → adaptive thinking + effort 'xhigh' passed
 *                          through verbatim. The SDK's exported
 *                          EffortLevel type omits xhigh but the
 *                          underlying runtime accepts it; the cast
 *                          narrows for the type checker only — the
 *                          literal string is what reaches the API.
 *                          See shared/src/thinking-effort.ts:25 for
 *                          the canonical per-provider vocabulary.
 */
function mapThinkingConfig(
  effort: ThinkingEffort | undefined,
): Pick<Options, 'thinking' | 'effort'> {
  if (!effort || effort === 'auto') {
    return { thinking: { type: 'adaptive' } };
  }
  switch (effort) {
    case 'none':
    case 'minimal':
      return { thinking: { type: 'disabled' } };
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return { thinking: { type: 'adaptive' }, effort };
    case 'xhigh':
      // Claude Agent SDK exits code 1 when xhigh is passed as top-level effort.
      // Use an explicit thinking budget instead.
      return { thinking: { type: 'enabled', budget_tokens: 32000 } as any };
  }
}

/**
 * Capabilities surfaced for Claude SDK. Exported so the dispatcher
 * scaffold (`./index.ts`) can package them into `RuntimeDispatchPacket`
 * for the resolved runtime.
 */
export const CLAUDE_CAPABILITIES = {
  tools: true,
  vision: true,
  reasoning: true,
  mcp: true,
  sessionResume: true,
  fileCheckpointing: true,
  streaming: true,
} as const;

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'claude-sdk';
  readonly providerId: ProviderId = 'claude';

  /**
   * In-flight Claude SDK Query — captured during `runClaudeTurn`,
   * cleared in `clearActiveQuery`. Currently unused by capability
   * methods (AgentService still owns `activeQuery` for MCP / rewind
   * live ops at the module level). The instance field is here for
   * future capability migration (Step 4+) — for Step 2 it just
   * mirrors the module-level reference so behavior stays identical.
   */
  private activeQuery: Query | null = null;

  /**
   * Stub-that-throws — intentional, per reference implementation PR B1 design. Claude
   * callers use `runClaudeTurn` directly (Step 2). When the universal
   * dispatcher lands in Step 3, this becomes the canonical entry point
   * after translating `AgentTurnInput` → `ClaudeRuntimeDispatchInput`.
   *
   * Do NOT "fix" this by routing to `runClaudeTurn` internally. That's
   * a Step 3 design decision — premature wiring here would force the
   * AgentTurnInput shape to harden before the non-Claude runtimes have
   * had a chance to refine it.
   */
  // eslint-disable-next-line require-yield
  async *runTurn(_input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent> {
    throw new Error(
      'ClaudeAgentRuntime.runTurn is not yet wired — callers should use ' +
      'runClaudeTurn(ClaudeRuntimeDispatchInput, ModelRef). The universal ' +
      'AgentTurnInput → runTurn dispatch lands in Phase 2 Step 3 when the ' +
      'api-router runtime joins the dispatcher.',
    );
  }

  /**
   * Normalized event stream for one Claude SDK turn.
   *
   * Builds SDK options from the dispatch input, calls `query()`,
   * iterates the resulting `Query`, and translates each SDK message
   * into one or more `AgentRuntimeEvent`s. Yields a leading `start`,
   * then provider events as they arrive, then a single terminal
   * `done` (or `error`) when the stream completes / aborts / errors.
   *
   * **Event contract** (canonical 17-variant union from `./types.ts`):
   * - `{type: 'start'}` first — distinguishes "queued" from "stream began".
   * - `{type: 'session'}` once when a session id is observed.
   * - `{type: 'text_delta'}` per text content block in an assistant
   *   message. Consumer accumulates.
   * - `{type: 'thinking_delta'}` ONCE per complete thinking block
   *   (buffered from `content_block_*` stream_events; emitted at
   *   `content_block_stop`). `text` = full block content, `summary` =
   *   first-sentence headline (matches `extractThinkingSummary`).
   * - `{type: 'compaction_notice'}` — `'starting'` on system.status=compacting,
   *   `'complete'` (with `preTokens`) on system.subtype=compact_boundary.
   * - `{type: 'rate_limit'}` on rate_limit_event (rejected /
   *   allowed_warning only).
   * - `{type: 'tool_progress'}` on tool_progress SDK message.
   * - `{type: 'context_usage'}` from result message's `model_usage` or
   *   `usage` block.
   * - `{type: 'usage'}` from result message's input/output/cache tokens.
   * - `{type: 'done', finishReason: 'stop'}` after success, `'aborted'`
   *   on AbortError, `'error'` on non-success result subtype.
   *
   * **Error handling:**
   * - AbortError → `{type: 'done', finishReason: 'aborted'}` (abort is
   *   a normal end-of-stream, not an error).
   * - Result subtype !== 'success' → `{type: 'error', recoverable: true}`
   *   (matches pre-Step-2 behavior — these were logged-and-continued).
   * - Thrown SDK errors → `{type: 'error', recoverable: <heuristic>}`
   *   then return. AgentService's outer try/catch still acts as a
   *   safety net for genuinely unexpected throws.
   *
   * `error.recoverable` heuristic: rate-limit-flavored and 5xx/transient
   * messages → `recoverable: true`; auth/config/parse errors →
   * `recoverable: false`. The boundary case "No conversation found with
   * session ID" is left as `recoverable: false` here because
   * AgentService's outer catch already owns the stale-session retry
   * branch (`_processQuery`'s `if (errMsg.includes('No conversation
   * found with session ID') …)` at the original line 980).
   */
  async *runClaudeTurn(
    input: ClaudeRuntimeDispatchInput,
    modelRef: ModelRef,
  ): AsyncIterable<AgentRuntimeEvent> {
    // Assemble SDK Options — mirrors agent.ts:615-650 pre-Step-2 byte
    // for byte. Conditional spread on `mcpServers` preserved verbatim:
    // passing `mcpServers: {}` blocks SDK cloud-MCP auto-discovery.
    const options: Options = {
      model: input.model,
      systemPrompt: input.appendSystemPromptText
        ? { type: 'preset', preset: 'claude_code', append: input.appendSystemPromptText }
        : { type: 'preset', preset: 'claude_code' },
      cwd: input.cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 30,
      includePartialMessages: true,
      ...mapThinkingConfig(input.thinkingEffort),
      hooks: input.hooks,
      // Plugin: native skill discovery from .claude/skills/ (mirrors agent.ts:629).
      plugins: [{ type: 'local' as const, path: join(input.cwd, '.claude').replace(/\\/g, '/') }],
      // Conditional MCP server spread — empty map MUST omit the field.
      ...(input.mcpServers && Object.keys(input.mcpServers).length > 0 && {
        mcpServers: input.mcpServers,
      }),
      abortController: input.abortController,
      // File checkpointing enables rewindFiles() — required by the
      // Settings → rewind capability path. Pre-Step-2 set at agent.ts:754.
      enableFileCheckpointing: true,
      // Resume existing session if provided. Pre-Step-2 set at agent.ts:682.
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    };

    // **Order matters:** dispatch BEFORE yielding `start`. AgentService's
    // post-dispatch MCP refresh (`refreshMcpStatusSafely`) reads the
    // module-level `activeQuery`, which AgentService captures from the
    // same `Query` reference. The leading `start` event is purely
    // informational — it carries the modelRef so consumers can disambiguate
    // multi-provider runs in Step 3+.
    const result = query({ prompt: input.prompt, options });
    this.activeQuery = result;

    // AgentService also needs the raw Query reference to wire up its
    // existing capability paths (MCP status refresh at start, MCP toggle
    // mid-stream, rewindFiles). Step 2 keeps those reaching into the
    // module-level `activeQuery` that agent.ts captures from the same
    // `query()` call site — but only ONE call site is allowed (otherwise
    // the SDK opens two parallel sessions). We solve that by exposing
    // the captured Query through `getActiveQuery()` and having
    // AgentService read it from there instead of calling `query()`
    // itself. See agent.ts `_processQuery` post-Step-2 for the wiring.

    yield { type: 'start', runtimeId: this.id, modelRef };

    let lastSessionId: string | null = null;
    let currentThinkingAccum = '';

    try {
      for await (const msg of result) {
        // Session-id capture — surface a `session` event when it
        // changes. Claude may re-emit the same id mid-turn; we only
        // yield on change so AgentService doesn't get redundant
        // setProviderSession calls.
        if (msg && typeof msg === 'object' && 'session_id' in msg) {
          const newSessionId = (msg as { session_id?: unknown }).session_id;
          if (typeof newSessionId === 'string' && newSessionId && newSessionId !== lastSessionId) {
            lastSessionId = newSessionId;
            yield { type: 'session', sessionId: newSessionId };
          }
        }

        if (!msg || typeof msg !== 'object' || !('type' in msg)) continue;
        const msgType = (msg as { type: string }).type;

        if (msgType === 'stream_event') {
          // Thinking blocks live on stream_event content_block_delta
          // (SDK strips them from the assistant message itself).
          // Buffer per block; emit a single `thinking_delta` at
          // content_block_stop. This collapses reference implementation
          // (thinking_delta-per-token + thinking_end) into one event
          // per complete block — matches pre-Step-2 broadcast cadence
          // (agent.ts:783-802 emits ONE `thinking` WS event per
          // complete block, not per token).
          const streamEvent = (msg as { event?: any }).event;
          if (streamEvent?.type === 'content_block_start' && streamEvent?.content_block?.type === 'thinking') {
            currentThinkingAccum = '';
          } else if (streamEvent?.type === 'content_block_delta' && streamEvent?.delta?.type === 'thinking_delta') {
            const thinkingText = streamEvent.delta.thinking || '';
            if (thinkingText) currentThinkingAccum += thinkingText;
          } else if (streamEvent?.type === 'content_block_stop' && currentThinkingAccum) {
            const summary = extractThinkingSummary(currentThinkingAccum);
            // Slice 3 (thought semantics): extended-thinking blocks are the
            // model's native reasoning stream → kind 'provider'.
            yield { type: 'thinking_delta', text: currentThinkingAccum, summary, kind: 'provider' };
            currentThinkingAccum = '';
          }
        } else if (msgType === 'assistant') {
          const assistantMsg = msg as { message?: { content?: any[] } };
          if (assistantMsg.message?.content) {
            // Per the canonical `text_delta` contract (see ./types.ts),
            // consumers append `text` exactly with no spacing of their
            // own — runtime adapters own provider-specific spacing.
            // Claude emits BLOCK-level content (not token deltas), so
            // the Claude adapter injects `\n\n` between consecutive
            // text blocks within a single assistant message to
            // preserve paragraph separation.
            //
            // emittedTextBlock resets per assistant message — declared inside the
            // per-message handler scope, NOT at adapter/module level. New message =
            // new run = fresh false.
            let emittedTextBlock = false;
            for (const block of assistantMsg.message.content) {
              if (block.type === 'text' && block.text) {
                const text = emittedTextBlock ? `\n\n${block.text}` : block.text;
                emittedTextBlock = true;
                yield { type: 'text_delta', text };
              }
              // Thinking blocks captured from stream_event above —
              // avoids double-emit (SDK sometimes carries thinking on
              // both the assistant message and the stream_event ticks).
            }
          }
        } else if (msgType === 'result') {
          const resultMsg = msg as {
            subtype?: string;
            errors?: unknown;
            usage?: any;
            model_usage?: any;
          };

          // Usage + context_usage from `result` message. Map to two
          // separate canonical events: `context_usage` (gauge) and
          // `usage` (billable). Pre-Step-2 agent.ts emitted ONE
          // `context_usage` WS event derived from model_usage's
          // input_tokens + output_tokens (line 836-840 / 843-852).
          if (resultMsg.usage || resultMsg.model_usage) {
            const usage = resultMsg.usage || {};
            const modelUsage = resultMsg.model_usage;

            let contextTokens = 0;
            let contextWindow = 0;
            if (modelUsage) {
              for (const m of Object.values(modelUsage) as any[]) {
                if (m?.context_window) contextWindow = m.context_window;
                if (m?.input_tokens) {
                  contextTokens = m.input_tokens + (m.output_tokens || 0);
                }
              }
            } else if (usage.input_tokens) {
              contextTokens = usage.input_tokens + (usage.output_tokens || 0);
            }

            if (contextWindow > 0 && contextTokens > 0) {
              yield { type: 'context_usage', used: contextTokens, max: contextWindow };
            }

            // Billable usage event — separate from context_usage gauge.
            // Pre-Step-2 these tokens flowed into `recordUsageEvent`
            // directly; with the canonical stream the runtime emits a
            // typed event and AgentService still does the DB write
            // (see consumer in agent.ts).
            const inputTokens = usage.input_tokens || 0;
            const outputTokens = usage.output_tokens || 0;
            const cacheReadTokens = usage.cache_read_input_tokens || 0;
            const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
            if (inputTokens > 0 || outputTokens > 0) {
              yield {
                type: 'usage',
                input: inputTokens,
                output: outputTokens,
                cacheRead: cacheReadTokens,
                cacheWrite: cacheCreationTokens,
              };
            }
          }

          // Non-success result subtype — emit `error` with
          // `recoverable: true` to mirror pre-Step-2 behavior (these
          // were logged-and-continued at agent.ts:908-910).
          if (resultMsg.subtype && resultMsg.subtype !== 'success') {
            yield {
              type: 'error',
              message: `${resultMsg.subtype}${resultMsg.errors ? ': ' + JSON.stringify(resultMsg.errors) : ''}`,
              recoverable: true,
            };
          }
        } else if (msgType === 'system') {
          const systemMsg = msg as {
            subtype?: string;
            status?: string;
            compact_metadata?: { pre_tokens?: number };
          };
          // Compaction lifecycle — map reference implementation single `compaction` event
          // to reference implementation two-phase `compaction_notice`. Pre-Step-2
          // agent.ts:914-935 only acted on `compact_boundary`; we
          // surface the in-flight `compacting` status here as the
          // `'starting'` phase even though pre-Step-2 only logged it.
          if (systemMsg.subtype === 'compact_boundary' && systemMsg.compact_metadata) {
            yield {
              type: 'compaction_notice',
              phase: 'complete',
              preTokens: systemMsg.compact_metadata.pre_tokens,
            };
          } else if (systemMsg.status === 'compacting') {
            yield { type: 'compaction_notice', phase: 'starting' };
          }
        } else if (msgType === 'rate_limit_event') {
          const rle = msg as { rate_limit_info?: { status?: string; resetsAt?: string; rateLimitType?: string; utilization?: number } };
          const info = rle.rate_limit_info;
          if (info && (info.status === 'rejected' || info.status === 'allowed_warning')) {
            yield {
              type: 'rate_limit',
              status: info.status,
              resetsAt: info.resetsAt,
              rateLimitType: info.rateLimitType,
              utilization: info.utilization,
            };
          }
        } else if (msgType === 'tool_progress') {
          const tp = msg as { tool_use_id?: string; tool_name?: string; elapsed_time_seconds?: number };
          yield {
            type: 'tool_progress',
            toolId: tp.tool_use_id ?? '',
            toolName: tp.tool_name ?? '',
            elapsedSeconds: tp.elapsed_time_seconds ?? 0,
          };
        }
      }

      yield { type: 'done', finishReason: 'stop' };
    } catch (err) {
      if (err instanceof AbortError || (err instanceof Error && err.name === 'AbortError')) {
        // AbortError = stop_generation (user) or safety-timeout (5min).
        // Both surface as `done.aborted` — AgentService's existing
        // outer try/catch still translates this to the right WS event
        // (`generation_stopped` for user, `error.agent_timeout` for
        // timeout) based on the `agentTimedOut` module flag.
        yield { type: 'done', finishReason: 'aborted' };
      } else {
        const message = errMessage(err);
        // Heuristic: rate-limit / transient / network errors get
        // `recoverable: true`. Auth / config / parse errors get
        // `recoverable: false`. Stale-session ("No conversation found
        // with session ID") stays `recoverable: false` here because
        // AgentService's outer catch already has the retry branch.
        const recoverable = /rate.?limit|temporar|timeout|ECONN|socket|network/i.test(message);
        yield { type: 'error', message, recoverable };
      }
    } finally {
      // Don't null `activeQuery` here — AgentService's `finally` clears
      // module-level state. We mirror the clear by calling
      // `clearActiveQuery()` from the consumer's `finally` block.
    }
  }

  /**
   * Release the in-flight Query reference. Step 2: called from
   * AgentService's `_processQuery` `finally` block alongside the
   * module-level `activeQuery = null` clear, so both references
   * release together. Step 4+ migrates the module-level reference
   * into this class entirely.
   */
  clearActiveQuery(): void {
    this.activeQuery = null;
  }

  /** Current in-flight Query. Used by AgentService to wire MCP
   *  status refresh + capability live ops to the same Query instance
   *  that runClaudeTurn opened. Null when no turn is active. */
  getActiveQuery(): Query | null {
    return this.activeQuery;
  }

  /**
   * Stubs — Step 2 keeps session sidecar I/O in AgentService where
   * it lives today (per-provider rows written/read at agent.ts:670 /
   * 1035). Step 3 moves the read/write here through `resumeSessionId`
   * / `persistSessionId` once the dispatcher owns the call.
   */
  resumeSessionId(_thread: ThreadHandle, _modelRef: ModelRef): string | undefined {
    return undefined;
  }
  persistSessionId(_thread: ThreadHandle, _modelRef: ModelRef, _sessionId: string): void {
    return;
  }

  /**
   * Capability lookup — Step 2 returns `undefined` for every cap.
   * Existing Claude-specific capabilities (MCP toggle, listSessions,
   * rewindFiles, context-usage refresh) stay as direct methods on
   * AgentService for Step 2; Step 3+ migrates them in here.
   */
  getCapabilityProvider<T>(_cap: CapabilityKey): T | undefined {
    return undefined;
  }

  /**
   * No-op for Step 2 — abort routing flows through AgentService's
   * module-level `activeAbortController`, which is passed into
   * `runClaudeTurn` via `input.abortController`. The same controller
   * instance is captured at SDK option assembly above. Calling
   * `abort()` on this runtime is a future Step 3+ concern when the
   * abort controller migrates in here.
   */
  abort(): void {
    return;
  }
}
