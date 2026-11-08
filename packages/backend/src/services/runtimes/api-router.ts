/**
 * ApiRouterRuntime — generic OpenAI-compatible / Ollama-native runtime.
 *
 * Wraps `services/router.ts` (the multi-provider HTTP layer) behind
 * reference implementation `AgentRuntime` interface. Unlike `ClaudeAgentRuntime` (whose
 * `runTurn` is still a stub-that-throws as of byte-light Phase 2 Step 3),
 * this runtime IS the universal-entry-point implementation: callers
 * dispatch through `runTurn(AgentTurnInput)` directly.
 *
 * Sourced from reference implementation @ 1ceb24a `runtimes/api-router.ts` but heavily
 * refactored: reference implementation emits a 12-variant event union; byte-light's canonical
 * is reference implementation 17-variant union (`AgentRuntimeEvent` in `./types.ts`,
 * landed in Step 2). The mapping table:
 *
 *   reference implementation emits          → reference implementation expects
 *   ────────────────────────────────────────────────────────────────
 *   (none)              → `start` (emit at top of `runTurn`)
 *   `text_delta`        → `text_delta` (pass through)
 *   (Ollama cumulative) → `text_snapshot` (reserved for native-Ollama
 *                          streaming when it emits full-text-so-far;
 *                          today byte-light treats every chunk as a delta)
 *   `thinking_delta`    → `thinking_delta` (pass through, buffered
 *                          across <think> tag detection state machine)
 *   `thinking_end`      → (folded into `thinking_delta` — emit one
 *                          consolidated thinking_delta per logical block)
 *   `tool_start`        → `tool_start` (pass through)
 *   `tool_result`       → `tool_result` (pass through)
 *   (none, no streaming Ollama backoff signal)
 *                       → `tool_progress` skipped — ApiRouter doesn't
 *                          surface long-running tool ticks today
 *   (none)              → `context_usage` skipped — reserved for Step 4+
 *   `usage`             → `usage` (provider receipt when available; ~4 chars/token fallback)
 *   (no compaction)     → `compaction_notice` skipped (ApiRouter doesn't compact)
 *   (no rate-limit hint) → `rate_limit` skipped today; recoverable=true
 *                          surfaces via `error` so the outer loop retries
 *   (none)              → `provider_diagnostic` skipped — Step 4+
 *   (none)              → `auth_required` skipped — Codex/OAuth-specific
 *   (none)              → `suppressed` skipped
 *   `done.finishReason: 'complete'`  → `done.finishReason: 'stop'`
 *   `done.finishReason: 'aborted'`   → `done.finishReason: 'aborted'`
 *   `done.finishReason: 'timeout'`   → `done.finishReason: 'error'`
 *   `done.finishReason: 'max_turns'` → `done.finishReason: 'length'`
 *   `error.message`     → `error.message + recoverable: <heuristic>`
 *                          (rate-limit / transient / timeout / network → true;
 *                           auth / config → false)
 *
 * Capability shape: matches reference implementation `AgentRuntime` interface — `id` is
 * the resolved `RuntimeId` ('openai-compat' or 'ollama-native' depending
 * on which dispatch slot picked us), `providerId` is the parsed
 * `ProviderId` from `AgentTurnInput.modelRef.provider`.
 *
 * MCP / tool bridge: when called with `input.tools`, executes via the
 * tools-bridge.executeRouterTool function (delegated through the
 * `ApiRouterOptions.executeTool` callback). This is the same bridge
 * Step 1 wired for Claude SDK path — non-Claude runtimes share the
 * managed-server registry without any duplication.
 */

import {
  streamInference,
  inferenceWithTools,
  loadProviderConfig,
  type RouterMessage,
  type ProviderConfig,
} from '../router.js';
import type { ToolSchema } from '../mcp-bridge.js';  // SLICE-3a ADAPTATION: tag's tools-bridge.ts == main's mcp-bridge.ts
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentTurnInput,
  CapabilityKey,
  NormalizedImage,
} from './types.js';
import type { ProviderId, RuntimeId } from '@bytelight/shared';
import { errMessage } from '../../util/errors.js';

// ─── Image conversion ────────────────────────────────────────────────

/**
 * Convert byte-light's NormalizedImage[] (base64 + mime) to OpenAI-compat
 * content parts. Mirrors reference implementation `imageBlocksToOpenAIParts` but consumes
 * reference implementation `NormalizedImage` shape (different field names than
 * Anthropic's `ImageBlock`).
 *
 * OpenAI vision expects:
 *   { type: 'image_url', image_url: { url: 'data:<mime>;base64,<bytes>' } }
 *
 * reference implementation NormalizedImage already has:
 *   { base64: '<bytes>', mimeType: '<mime>' }
 *
 * — no Anthropic `source.media_type` indirection needed.
 */
function imagesToOpenAIParts(
  images: NormalizedImage[],
): Array<{ type: 'image_url'; image_url: { url: string } }> {
  return images.map(b => ({
    type: 'image_url' as const,
    image_url: {
      url: `data:${b.mimeType};base64,${b.base64}`,
    },
  }));
}

// ─── Error classification ────────────────────────────────────────────

/**
 * Heuristic for `error.recoverable` per reference implementation spec. True for
 * rate-limit / transient / timeout / network errors (the user can retry
 * and probably succeed); false for auth / config / 4xx-not-429 errors
 * (the user must fix something first).
 */
function classifyErrorRecoverability(message: string): boolean {
  const lower = message.toLowerCase();
  // Recoverable signals
  if (lower.includes('rate limit') || lower.includes('429')) return true;
  if (lower.includes('timeout') || lower.includes('timed out')) return true;
  if (lower.includes('network') || lower.includes('econnreset') || lower.includes('econnrefused')) return true;
  if (lower.includes('socket hang up') || lower.includes('etimedout')) return true;
  if (lower.includes('502') || lower.includes('503') || lower.includes('504')) return true;
  // Unrecoverable signals
  if (lower.includes('401') || lower.includes('403')) return false;
  if (lower.includes('unauthorized') || lower.includes('forbidden')) return false;
  if (lower.includes('invalid api key') || lower.includes('authentication')) return false;
  if (lower.includes('400') || lower.includes('404')) return false;
  // Default: treat unknown errors as unrecoverable so they surface
  return false;
}

// ─── Options ─────────────────────────────────────────────────────────

export interface ApiRouterOptions {
  /**
   * Execute tools when the model requests them. byte-light's tools-bridge
   * provides this — see `services/tools-bridge.ts:executeRouterTool`.
   * When omitted, ApiRouter runs without tools (streamInference path
   * instead of inferenceWithTools).
   */
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<{ result: string; ok: boolean }>;
  /**
   * Static tool schemas to offer the model. Combined with `input.tools`
   * (per-turn schemas) at runTurn time. Typically supplied at construction
   * for a stable global tool set; per-turn diffs go through AgentTurnInput.
   */
  tools?: ToolSchema[];
}

// ─── Provider/runtime mapping ────────────────────────────────────────

/**
 * Translate a `ProviderId` (reference implementation manifest namespace) to the legacy
 * router.ts provider string (reference implementation `'ollama' | 'openai' | 'groq' | ...`).
 *
 * reference implementation router uses unprefixed provider names (`'ollama'`, `'openrouter'`,
 * `'anthropic'`, ...); reference implementation manifest uses canonical `ProviderId`
 * (`'claude'`, `'openai-codex'`, `'openrouter'`, `'ollama'`). The intersection
 * relevant to ApiRouter today is small — Ollama uses the same string in both,
 * OpenRouter ditto. Codex doesn't go through ApiRouter (it has its own runtime),
 * and Claude under `routing='api'` mode would map to `'anthropic'` (reference implementation
 * direct-API path).
 */
function providerIdToRouterProvider(providerId: ProviderId): string {
  switch (providerId) {
    case 'ollama':       return 'ollama';
    case 'openrouter':   return 'openrouter';
    case 'groq':         return 'groq';       // H3b-1 — BYOK via openai-compat (router.ts resolves it)
    case 'xai':          return 'xai';        // H3b-1 — BYOK via openai-compat (router.ts resolves it)
    case 'openai':       return 'openai';    // Step 6A — direct BYOK via openai-compat
    case 'claude':       return 'anthropic'; // routing='api' Claude direct
    case 'claude-cli':   return 'anthropic'; // exhaustiveness only — CLI lane dispatches via InteractiveCliRuntime, never the api-router (no [1m] handling touched)
    case 'codex-cli':    return 'codex';     // exhaustiveness only — codex-cli lane dispatches via InteractiveCodexRuntime (warm daemon), never the api-router (H2)
    case 'openai-codex': return 'codex';     // throws in resolveProvider (Step 6B)
  }
}

/** Prefer provider receipts; estimate only when the provider emitted none. */
export function usageOrEstimate(
  providerUsage: Extract<AgentRuntimeEvent, { type: 'usage' }> | undefined,
  messages: RouterMessage[],
  outputChars: number,
): Extract<AgentRuntimeEvent, { type: 'usage' }> {
  if (providerUsage) return providerUsage;
  const inputChars = messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
    0,
  );
  return {
    type: 'usage',
    input: Math.ceil(inputChars / 4),
    output: Math.ceil(outputChars / 4),
  };
}

// ─── Class ───────────────────────────────────────────────────────────

export class ApiRouterRuntime implements AgentRuntime {
  readonly id: RuntimeId;
  readonly providerId: ProviderId;

  private abortController: AbortController | null = null;
  private aborted = false;
  private readonly options: ApiRouterOptions;

  /**
   * Constructor takes the canonical `RuntimeId` for this instance so the
   * dispatcher can spin up separate instances for `'openai-compat'` vs
   * `'ollama-native'` if needed — both share this class today but they
   * surface different ids upstream so caps tables / usage attribution
   * can distinguish them.
   */
  constructor(opts: { runtimeId: RuntimeId; providerId: ProviderId } & ApiRouterOptions) {
    this.id = opts.runtimeId;
    this.providerId = opts.providerId;
    this.options = { executeTool: opts.executeTool, tools: opts.tools };
  }

  abort(): void {
    this.aborted = true;
    this.abortController?.abort();
  }

  // No session resume on this runtime — ApiRouter is stateless. The
  // `resumeSessionId` / `persistSessionId` capabilities are intentionally
  // not implemented (reference implementation interface declares them optional).

  // No capability provider for Step 3 — MCP toggle / rewindFiles /
  // listSessions remain on the Claude-SDK direct concrete methods today.
  getCapabilityProvider<T>(_cap: CapabilityKey): T | undefined {
    return undefined;
  }

  async *runTurn(input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent> {
    // ── Canonical contract: emit `start` first ─────────────────────────
    yield { type: 'start', runtimeId: this.id, modelRef: input.modelRef };

    // Pull the parsed model + provider out of the typed ModelRef. The
    // dispatcher already did the parse; we just consume the result.
    const modelId = input.modelRef.model;
    const routerProvider = providerIdToRouterProvider(this.providerId);

    // Allow caller-supplied AbortSignal to thread through. reference implementation stored
    // the controller on the instance for `abort()` — we mirror that.
    this.abortController = new AbortController();
    if (input.abortSignal) {
      input.abortSignal.addEventListener('abort', () => this.abort(), { once: true });
    }
    this.aborted = false;

    const config: ProviderConfig = loadProviderConfig();

    // ── Build message array ─────────────────────────────────────────────
    // System: prepend orientation block (if any) to whatever the runtime
    // system prompt resolved to. Claude SDK takes a preset marker; non-
    // Claude runtimes get the text equivalent.
    const messages: RouterMessage[] = [];

    // System prompt + orientation. reference implementation RuntimeSystemPrompt union has
    // text or claude-preset; we coerce to text. The orientation block from
    // `input.orientation` is folded into the system prompt for non-Claude
    // runtimes (Claude SDK handles orientation natively via context_window).
    let systemText = '';
    if (input.systemPrompt.kind === 'text') {
      systemText = input.systemPrompt.value;
    } else if (input.systemPrompt.kind === 'claude-preset') {
      systemText = input.systemPrompt.append;
    }
    if (input.orientation) {
      systemText = systemText
        ? `${systemText}\n\n${input.orientation}`
        : input.orientation;
    }
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }

    // Conversation history — ApiRouter has no native session resume, so
    // every prior turn must be replayed. `input.messages` is the typed
    // NormalizedMessage[]; we translate to RouterMessage.
    for (const msg of input.messages) {
      if (msg.role === 'system') {
        // Additional system messages (rare) concatenate to the existing
        // system text rather than producing multiple system rows.
        const existing = messages.find(m => m.role === 'system');
        if (existing) {
          existing.content = `${existing.content}\n\n${msg.content}`;
        } else {
          messages.push({ role: 'system', content: msg.content });
        }
        continue;
      }
      if (msg.images && msg.images.length > 0 && msg.role === 'user') {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: msg.content },
            ...imagesToOpenAIParts(msg.images),
          ],
        });
      } else {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Effective tool schemas: per-turn diffs (`input.tools`) override the
    // ctor-supplied static set. Step 3 only consults this for the
    // tool-calling path below.
    const inputToolDefs = input.tools ?? [];
    const ctorTools = this.options.tools ?? [];
    const effectiveTools: ToolSchema[] = inputToolDefs.length > 0
      ? // AgentTurnInput.ToolDefinition has {name, description?, inputSchema?};
        // ToolSchema requires {name, description, input_schema}. Coerce.
        inputToolDefs.map(t => ({
          name: t.name,
          description: t.description ?? '',
          input_schema: (t.inputSchema ?? {}) as Record<string, unknown>,
        }))
      : ctorTools;

    const useThinking = input.thinkingEffort
      ? (input.thinkingEffort !== 'none' && input.thinkingEffort !== 'auto')
      : false;

    try {
      if (effectiveTools.length > 0 && this.options.executeTool) {
        // Tool-calling path: non-streaming inferenceWithTools loop.
        // reference implementation event union expects: text_delta or thinking_delta
        // emitted at the END (the loop is non-streaming, content arrives
        // whole on `done`). Translate reference implementation per-iteration tool_start /
        // tool_result events through as-is.
        let content = '';
        let providerUsage: Extract<AgentRuntimeEvent, { type: 'usage' }> | undefined;

        for await (const ev of inferenceWithTools(
          messages,
          modelId,
          routerProvider,
          config,
          effectiveTools,
          (name, args) => this.options.executeTool!(name, args),
          useThinking,
        )) {
          if (this.aborted) {
            yield { type: 'done', finishReason: 'aborted' };
            return;
          }
          if (ev.type === 'tool_start') {
            yield { type: 'tool_start', id: ev.id, name: ev.name, input: ev.input };
          } else if (ev.type === 'tool_result') {
            yield {
              type: 'tool_result',
              id: ev.id,
              name: ev.name,
              output: ev.output,
              isError: ev.isError,
            };
          } else if (ev.type === 'done') {
            content = ev.content;
          } else if (ev.type === 'usage') {
            providerUsage = { type: 'usage', ...ev.usage };
          }
        }

        // Parse <think>...</think> wrapper from the final content. reference implementation
        // emitted `thinking_delta` then `thinking_end` separately; reference implementation
        // canonical is one consolidated `thinking_delta` per block (text
        // = full block content, summary = first sentence).
        const thinkMatch = content.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
        if (thinkMatch) {
          const thinkingText = thinkMatch[1];
          const responseText = thinkMatch[2];
          const firstSentence = thinkingText.split(/[.!?]\s/)[0] ?? '';
          // Slice 3 (thought semantics): <think> blocks are the model's
          // native reasoning stream → kind 'provider'.
          yield {
            type: 'thinking_delta',
            text: thinkingText,
            summary: firstSentence.trim().slice(0, 200),
            kind: 'provider',
          };
          if (responseText) {
            yield { type: 'text_delta', text: responseText };
          }
        } else {
          if (content) yield { type: 'text_delta', text: content };
        }

        // Prefer the provider's billing receipt. Keep reference implementation ~4 chars/token
        // heuristic only for providers that emit no usage telemetry.
        yield usageOrEstimate(providerUsage, messages, content.length);

        // 'stop' (reference implementation vocabulary) maps to reference implementation 'complete'.
        yield { type: 'done', finishReason: 'stop' };
        return;
      }

      // No-tools path: streaming inference. Yield text_delta /
      // thinking_delta incrementally as tokens arrive. The <think>
      // state machine matches reference implementation verbatim logic, with the
      // thinking_end event folded into one consolidated thinking_delta
      // per logical close-tag.
      let fullThinking = '';
      let inThinking = false;
      let thinkBuffer = '';
      let outputChars = 0;
      let providerUsage: Extract<AgentRuntimeEvent, { type: 'usage' }> | undefined;

      for await (const streamEvent of streamInference(messages, modelId, routerProvider, config, useThinking)) {
        if (this.aborted) {
          yield { type: 'done', finishReason: 'aborted' };
          return;
        }

        if (streamEvent.type === 'usage') {
          providerUsage = { type: 'usage', ...streamEvent.usage };
          continue;
        }
        const token = streamEvent.text;
        thinkBuffer += token;

        if (!inThinking && thinkBuffer.includes('<think>')) {
          inThinking = true;
          const beforeThink = thinkBuffer.split('<think>')[0];
          if (beforeThink) {
            outputChars += beforeThink.length;
            yield { type: 'text_delta', text: beforeThink };
          }
          thinkBuffer = thinkBuffer.split('<think>').slice(1).join('<think>');
          continue;
        }

        if (inThinking) {
          if (thinkBuffer.includes('</think>')) {
            const parts = thinkBuffer.split('</think>');
            fullThinking += parts[0];
            // Consolidated thinking_delta on close — text is the full
            // accumulated block, summary is the first sentence.
            const firstSentence = fullThinking.split(/[.!?]\s/)[0] ?? '';
            yield {
              type: 'thinking_delta',
              text: fullThinking,
              summary: firstSentence.trim().slice(0, 200),
              kind: 'provider',
            };
            inThinking = false;
            fullThinking = '';
            const after = parts.slice(1).join('</think>').replace(/^\s*\n?/, '');
            if (after) {
              outputChars += after.length;
              yield { type: 'text_delta', text: after };
            }
            thinkBuffer = '';
          } else {
            // Still inside thinking — accumulate to fullThinking, keep
            // thinkBuffer small. We do NOT emit intermediate
            // thinking_delta events here because reference implementation canonical is
            // one event per complete block. (reference implementation streamed multiple
            // deltas mid-thinking; that was useful for the typing
            // indicator but reference implementation UI expects one consolidated event.)
            if (thinkBuffer.length > 100) {
              fullThinking += thinkBuffer;
              thinkBuffer = '';
            }
          }
          continue;
        }

        // Regular text — flush buffer when safe (no partial < open-tag).
        if (thinkBuffer.length > 0 && !thinkBuffer.includes('<')) {
          outputChars += thinkBuffer.length;
          yield { type: 'text_delta', text: thinkBuffer };
          thinkBuffer = '';
        } else if (thinkBuffer.length > 20 && !thinkBuffer.includes('<think')) {
          // Not a think tag (just a stray '<') — flush.
          outputChars += thinkBuffer.length;
          yield { type: 'text_delta', text: thinkBuffer };
          thinkBuffer = '';
        }
      }

      // Flush trailing buffer.
      if (thinkBuffer) {
        if (inThinking) {
          fullThinking += thinkBuffer;
          const firstSentence = fullThinking.split(/[.!?]\s/)[0] ?? '';
          yield {
            type: 'thinking_delta',
            text: fullThinking,
            summary: firstSentence.trim().slice(0, 200),
            kind: 'provider',
          };
        } else {
          outputChars += thinkBuffer.length;
          yield { type: 'text_delta', text: thinkBuffer };
        }
      }

      yield usageOrEstimate(providerUsage, messages, outputChars);

      yield { type: 'done', finishReason: 'stop' };
    } catch (err) {
      if (this.aborted) {
        yield { type: 'done', finishReason: 'aborted' };
        return;
      }
      const message = errMessage(err);
      yield {
        type: 'error',
        message,
        recoverable: classifyErrorRecoverability(message),
      };
    } finally {
      this.abortController = null;
    }
  }
}
