/**
 * CodexAgentRuntime — Codex (ChatGPT) OAuth runtime shell.
 *
 * Wraps pi-ai's `streamOpenAICodexResponses` (the OAuth-authed ChatGPT
 * backend at `https://chatgpt.com/backend-api`) behind reference implementation canonical
 * `AgentRuntime` interface. Auth comes from `services/auth/codex-oauth.ts`
 * (the 6B-A substrate landed in commits 7046e65 / d264a7d / b101c5d /
 * 0ad8eea). Streaming is text-only: this slice is the **runtime shell**.
 *
 * Slice scope — what THIS file does:
 *   - Implements `AgentRuntime` for `runtime: 'codex'`.
 *   - Translates `AgentTurnInput` (reference implementation normalized shape) to a pi-ai
 *     `Context` (system prompt + messages, no tools yet).
 *   - Streams `text_delta` events from pi-ai's `AssistantMessageEvent`
 *     stream, plus `thinking_delta` for reasoning blocks.
 *   - Guards auth: when `isCodexLoggedIn()` is false, emits a single
 *     `auth_required` event and a clean `done { finishReason: 'error' }`
 *     with NO provider call.
 *   - Maps provider failures (401 / 429 / 5xx) to safe error messages
 *     that never include the OAuth access token.
 *   - Handles abort via `AbortController` plus a re-check on the stream
 *     loop boundary (mirrors `ApiRouterRuntime` for shape parity).
 *
 * Slice scope — what this file does NOT do (deferred to later slices):
 *   - Tool loop: tools are not wired through to pi-ai's `Context.tools`.
 *     The constructor-callback `executeTool` lands later per spec.
 *   - Model picker / public selectability: not yet visible to UI.
 *   - Compaction, MCP toggle, file rewind, listSessions capabilities.
 *
 * Test seam — byte-light convention (`__TEST_PROVIDERS__` + `_resetForTests`):
 *   Production code reads `providers.streamOpenAICodexResponses` and
 *   `providers.getModel`. Tests substitute these via property assignment
 *   on the same exported object. `_resetForTests` restores the real
 *   pi-ai imports. Same pattern used in `services/auth/codex-oauth.ts`
 *   (Slice 6B-A) — kept identical so a future reader sees one mental model.
 *
 * Token safety — the OAuth access token is fetched once per turn via
 * `getCodexAccessToken()` and passed straight to pi-ai's `options.apiKey`.
 * It is never written to a log line, never included in an emitted event,
 * and never appears in an error message: error mapping uses HTTP status
 * codes parsed from provider exceptions, not the request payload. Tests
 * assert this with sentinel strings (see codex.test.ts).
 *
 * Out-of-scope diff guard (Slice 1):
 *   This file MUST NOT pull `agent.ts`, `tools-bridge.ts`, frontend, or
 *   schema changes into its dependency graph. Only `runtimes/types.ts`,
 *   `auth/codex-oauth.ts`, the shared model-manifest types, and pi-ai.
 */

import {
  type Context,
  type Message,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Tool as PiTool,
  type ToolCall,
} from '@earendil-works/pi-ai';
// pi-ai 0.80.6 moved the static catalog read (`getModel`) and the legacy
// per-provider stream alias (`streamOpenAICodexResponses`) off the top-level
// barrel into the `/compat` entrypoint. Types stay on the main entrypoint.
import {
  streamOpenAICodexResponses as realStreamOpenAICodexResponses,
  getModel as realGetModel,
} from '@earendil-works/pi-ai/compat';
import type { ProviderId, RuntimeId, ThinkingEffort } from '@bytelight/shared';
import {
  CodexAuthRequiredError,
  getCodexAccessToken,
  isCodexLoggedIn,
} from '../auth/codex-oauth.js';
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentTurnInput,
  CapabilityKey,
  NormalizedImage,
  ToolDefinition,
} from './types.js';
import {
  applyOutputBudget,
  MAX_TOOL_OUTPUT_BYTES,
  utf8ByteLength,
} from './output-budget.js';
import {
  buildToolResultImageFollowup,
  redactedImageMarker,
  splitToolResultForCodex,
} from './codex-images.js';
import { errMessage } from '../../util/errors.js';
import { getBytelightConfig } from '../../config.js';
import { holdCodex, holdFromText, passCodexBrake, CODEX_DEFAULT_HOLD_MS } from '../codex-breaker.js';

// ─────────────────────────────────────────────────────────────────────────
// Capabilities descriptor
//
// Codex via pi-ai's openai-codex-responses provider gives us tools (in
// future slices — the `tools` capability remains `true` because the
// PROVIDER supports them; this slice just doesn't wire them yet), vision
// (gpt-5.1+ accept `image` input), reasoning (thinkingLevelMap is set on
// the codex models), streaming. No native MCP (tools-bridge handles MCP at
// a higher layer for non-Claude runtimes — same posture as ApiRouter).
// `sessionResume` is true: pi-ai accepts `options.sessionId` to enable
// the backend's session-affinity caching. The runtime exposes the
// `resumeSessionId` / `persistSessionId` hooks to round-trip ids through
// `thread_provider_sessions` — but the underlying session persistence is
// best-effort. No file checkpointing.
// ─────────────────────────────────────────────────────────────────────────

export const CODEX_CAPABILITIES = {
  tools: true,
  vision: true,
  reasoning: true,
  mcp: false,
  sessionResume: true,
  fileCheckpointing: false,
  streaming: true,
} as const;

// ─────────────────────────────────────────────────────────────────────────
// byte-light test seam — pi-ai surface substitution.
//
// Mirrors the pattern in services/auth/codex-oauth.ts: production code
// reads `providers.X`, tests reassign `providers.X = mockX`, and
// `_resetForTests()` restores the original imports. byte-light's test
// runner (`tsx --test` on Node 20) lacks ES module mocking, so this is
// the canonical substitution shape across the codebase.
// ─────────────────────────────────────────────────────────────────────────

const providers = {
  streamOpenAICodexResponses: realStreamOpenAICodexResponses,
  getModel: realGetModel,
};

/** Test seam: tests substitute these to mock pi-ai's stream / model lookup. */
export const __TEST_PROVIDERS__ = providers;

/** Test seam: clear module state and restore real pi-ai imports. */
export function _resetForTests(): void {
  providers.streamOpenAICodexResponses = realStreamOpenAICodexResponses;
  providers.getModel = realGetModel;
}

// ─────────────────────────────────────────────────────────────────────────
// Image translation
//
// pi-ai's `ImageContent` shape is { type: 'image', data: '<base64>',
// mimeType: '<mime>' }. byte-light's `NormalizedImage` already carries
// base64 + mime separately, so the translation is a 1:1 rename (no
// decode / re-encode, no `data:` prefix concatenation). Matches the
// shape codex.openai.com expects in its `input_image` content parts.
// ─────────────────────────────────────────────────────────────────────────

function imagesToPiAi(
  images: NormalizedImage[],
): Array<{ type: 'image'; data: string; mimeType: string }> {
  return images.map((img) => ({
    type: 'image' as const,
    data: img.base64,
    mimeType: img.mimeType,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Reasoning effort mapping
//
// Ported pattern from reference implementation's codex runtime (mapEffort +
// reasoningEffort/reasoningSummary options). The thread's resolved
// `ThinkingEffort` maps 1:1 onto pi-ai's `reasoningEffort` union
// ('none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max');
// 'auto' returns undefined so pi-ai applies its own provider default.
// ─────────────────────────────────────────────────────────────────────────

function mapReasoningEffort(
  effort: ThinkingEffort | undefined,
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!effort || effort === 'auto') return undefined;
  return effort;
}

// ─────────────────────────────────────────────────────────────────────────
// User-image input validation
//
// `NormalizedMessage.images?: NormalizedImage[]` is typed at the surface
// but at the JS runtime layer a caller can pass a malformed entry
// (empty base64, missing mimeType, wrong shape inside an array slot
// because TS got cast away). The runtime emits a single
// `provider_diagnostic` with code `image_conversion_failed` per malformed
// shape encountered and DROPS the bad entry rather than aborting the
// turn. Dropping is safer than aborting because the user's text content
// usually carries the actual ask — losing one bad image is a degraded
// experience but not a fatal one.
//
// Diagnostic data payload:
//   - `mimeType` if present (helps the user understand "we couldn't
//     handle the WebP you uploaded").
//   - `reason` enumerated string.
//   - NEVER the raw base64 (would flood logs); only the byte length,
//     wrapped through `redactedImageMarker`.
// ─────────────────────────────────────────────────────────────────────────

interface ImageValidationResult {
  good: NormalizedImage[];
  diagnostics: Array<{ message: string; data: Record<string, unknown> }>;
}

function validateUserImages(
  images: NormalizedImage[] | undefined,
): ImageValidationResult {
  if (!images || images.length === 0) return { good: [], diagnostics: [] };
  const good: NormalizedImage[] = [];
  const diagnostics: Array<{ message: string; data: Record<string, unknown> }> = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i] as unknown as Record<string, unknown> | null | undefined;
    if (!img || typeof img !== 'object') {
      diagnostics.push({
        message: `User image at index ${i} is not an object — dropped.`,
        data: { index: i, reason: 'not_object' },
      });
      continue;
    }
    const base64 = (img as Record<string, unknown>).base64;
    const mimeType = (img as Record<string, unknown>).mimeType;
    if (typeof base64 !== 'string' || base64.length === 0) {
      diagnostics.push({
        message: `User image at index ${i} has empty base64 — dropped.`,
        data: {
          index: i,
          reason: 'empty_base64',
          mimeType: typeof mimeType === 'string' ? mimeType : null,
        },
      });
      continue;
    }
    if (typeof mimeType !== 'string' || !/^image\//.test(mimeType)) {
      diagnostics.push({
        message: `User image at index ${i} has missing/invalid mimeType — dropped.`,
        data: {
          index: i,
          reason: 'invalid_mime',
          marker: redactedImageMarker(
            typeof mimeType === 'string' ? mimeType : 'unknown',
            base64.length,
          ),
        },
      });
      continue;
    }
    good.push({ base64, mimeType });
  }
  return { good, diagnostics };
}

// ─────────────────────────────────────────────────────────────────────────
// Tool loop constants
//
// Mirrors reference implementation E3b's loop driver caps (Codex P1 review catch):
//   - MAX_TOOL_ITERATIONS bounds the assistant↔tool-result round trips
//     so a model stuck in a request-tool loop terminates gracefully.
//   - MAX_PARALLEL bounds intra-iteration tool dispatch concurrency so
//     a single iteration with 50 simultaneous tool calls doesn't fork
//     50 promises at once (we chunk into waves of 5).
//   - MAX_TURN_OUTPUT_BYTES is the per-TURN total budget summing every
//     tool result emitted in this turn. The per-RESULT cap lives in
//     `output-budget.ts` (MAX_TOOL_OUTPUT_BYTES = 50KB). The turn cap
//     is 4x the per-result cap so a turn can comfortably surface ~4
//     full-sized results before clipping.
//
// All counts are UTF-8 bytes. JS char counts would let multi-byte
// content (emoji, CJK) sneak past — see `output-budget.ts` rationale.
// ─────────────────────────────────────────────────────────────────────────

const MAX_TOOL_ITERATIONS = 20;
const MAX_PARALLEL = 5;
const MAX_TURN_OUTPUT_BYTES = 200 * 1024;

// ─────────────────────────────────────────────────────────────────────────
// Tool definition translation
//
// AgentTurnInput surfaces tool definitions in a provider-agnostic shape
// (`ToolDefinition = { name, description?, inputSchema? }`). pi-ai's
// `Tool` shape is `{ name, description, parameters: TSchema }`. The
// `parameters` field carries a JSON Schema object that pi-ai sends to
// the OpenAI Codex Responses API verbatim as the tool's parameter
// schema.
//
// Translation policy — what crosses the wire to the provider:
//   - name: passed through unchanged
//   - description: passed through; empty string when caller omitted it
//   - parameters (== inputSchema): passed through as-is; we DO NOT
//     rewrite `required`, `properties`, or `additionalProperties` — the
//     tool author defines the schema and we don't second-guess it.
//
// What does NOT cross the wire (defense in depth alongside the
// tools-bridge contract):
//   - server_url, _transport, api_key, env values — these are
//     tools-bridge internals; they live on `ToolSchema` (the
//     tools-bridge shape) but NOT on `ToolDefinition` (the runtime
//     input shape). Even if a caller upstream accidentally widened the
//     type, the translator below only reads `name`/`description`/
//     `inputSchema` so the extra fields can't leak.
//   - any field with secret-looking content the caller may have packed
//     into description — this is the caller's responsibility (the
//     tools-bridge `summarize_mcp_config` tool's description is already
//     redaction-aware; see services/tools-bridge.ts:480).
//
// Exported for direct testing — the leak test injects a description
// with a sentinel and asserts the sentinel survives translation
// (proving the description IS passed through; the no-leak property is
// then verified at the runtime-event level where leakage would matter).
//
// Type assertion rationale: pi-ai's `Tool.parameters` is typed as
// `TSchema` (typebox), but the runtime contract sends JSON Schema
// objects on the wire. typebox's `TSchema` is structurally compatible
// with JSON Schema for the fields we care about (`type`, `properties`,
// `required`, etc.); the cast goes through `unknown` to bypass the
// typebox brand check, which is safe because the wire format is what
// the provider actually consumes.
// ─────────────────────────────────────────────────────────────────────────

export function toolDefinitionsToPiAi(
  tools: ToolDefinition[] | undefined,
): PiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    // The JSON Schema is opaque to us — pass through. pi-ai's `Tool`
    // declares `parameters: TSchema` (typebox brand); on the wire it's
    // a plain JSON Schema object. Cast through `unknown` to satisfy
    // the structural narrowing without unsafely losing the field.
    parameters: (t.inputSchema ?? {}) as unknown as PiTool['parameters'],
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Tool error safety
//
// Tool execution errors come from three sources:
//   1. Unknown tool name (executeTool callback returns ok:false).
//   2. Tool handler threw (executeTool callback returns ok:false with
//      caller's safe message OR throws).
//   3. Tool succeeded but produced over-budget output.
//
// In all three cases we MUST return a structured tool_result back to
// the model — dropping the result would leave the assistant message's
// toolCallId without a matching toolResult, which OpenAI's Responses
// API rejects with "No tool call found for function call output with
// call_id ..." on the next iteration. (reference implementation E3b/4 review P1 catch.)
//
// The sanitized error payload:
//   - has a stable JSON shape (code + message) so the model can parse
//     and adapt rather than parroting raw stack frames
//   - never contains stack traces (callers' .message only)
//   - never contains the access token (the runtime never lets the
//     token reach a tool callback; defense-in-depth, not the primary
//     guarantee)
// ─────────────────────────────────────────────────────────────────────────

function safeToolErrorResult(code: string, message: string): string {
  // JSON.stringify is the safest serializer — escapes control chars,
  // closes quotes, no template injection. The model's tool-result
  // parser handles JSON natively.
  return JSON.stringify({ error: { code, message } });
}

// ─────────────────────────────────────────────────────────────────────────
// Error classification
//
// Provider errors arrive as `Error` instances thrown out of the
// `streamOpenAICodexResponses` event loop, OR as terminal `error` events
// on the AssistantMessage stream itself. In both cases we need:
//   1. A user-facing message that does NOT include the access token.
//   2. A discrimination between auth (401), rate-limit (429), and
//      server-side (5xx) failures so the UI can route accordingly.
//
// Parsing is heuristic — pi-ai's error messages embed HTTP status codes
// in plain text. We MUST NOT echo the original error message verbatim
// when it might contain headers, query params, or other secret-adjacent
// data. The classified message is canonical safe text.
// ─────────────────────────────────────────────────────────────────────────

type CodexErrorKind = 'auth' | 'rate_limit' | 'server' | 'aborted' | 'unknown';

interface ClassifiedCodexError {
  kind: CodexErrorKind;
  safeMessage: string;
  recoverable: boolean;
}

function classifyCodexError(raw: unknown): ClassifiedCodexError {
  const message = errMessage(raw);
  const lower = message.toLowerCase();

  // Abort signal (DOMException-like) — exposed by fetch / WHATWG AbortController.
  if (
    lower.includes('aborted') ||
    lower.includes('the operation was aborted') ||
    (raw instanceof Error && raw.name === 'AbortError')
  ) {
    return {
      kind: 'aborted',
      safeMessage: 'Codex request aborted.',
      recoverable: true,
    };
  }

  // 401: re-auth required. We do NOT echo the upstream message because
  // some providers reflect parts of the request back in 401 bodies.
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid_grant') ||
    lower.includes('expired')
  ) {
    return {
      kind: 'auth',
      safeMessage:
        'Codex authentication expired. Reconnect via Settings → Provider Health.',
      recoverable: false,
    };
  }

  // 429: rate-limited. Recoverable — the user can retry.
  if (lower.includes('429') || lower.includes('rate limit')) {
    return {
      kind: 'rate_limit',
      safeMessage: 'Codex rate limit reached. Please wait before retrying.',
      recoverable: true,
    };
  }

  // 5xx: server-side. Recoverable but not the user's fault.
  if (
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('internal server error') ||
    lower.includes('bad gateway') ||
    lower.includes('service unavailable') ||
    lower.includes('gateway timeout')
  ) {
    return {
      kind: 'server',
      safeMessage: 'Codex provider failure. Please retry shortly.',
      recoverable: true,
    };
  }

  // Default: surface a canonical "provider failure" rather than the raw
  // upstream string. Keeps tokens / urls / headers out of error UI.
  return {
    kind: 'unknown',
    safeMessage: 'Codex provider failure.',
    recoverable: false,
  };
}

/**
 * The first thing to hear a Codex limit sets the brake for every Codex
 * request (codex-breaker.ts, Aerie). The reset time is read from the
 * upstream words; the reason kept on the hold is the classified safe text,
 * never the raw upstream message (BYTE-LIGHT ADAPTATION: Aerie keeps the raw
 * text, byte-light never echoes it).
 */
function brakeOnRateLimit(classified: ClassifiedCodexError, rawText: string): void {
  if (classified.kind !== 'rate_limit') return;
  holdCodex(holdFromText(rawText, Date.now(), houseTimezone()) ?? Date.now() + CODEX_DEFAULT_HOLD_MS, classified.safeMessage);
}

/** The owner's timezone, for reading a reset time said as a clock time. */
function houseTimezone(): string {
  try { return getBytelightConfig().identity.timezone || 'UTC'; } catch { return 'UTC'; }
}

// ─────────────────────────────────────────────────────────────────────────
// Message translation
//
// reference implementation `NormalizedMessage` (role + content + optional images) maps
// directly to pi-ai's `Message`. The role vocabulary is identical
// ('user' | 'assistant' | 'system'), but pi-ai splits the system prompt
// into its own `Context.systemPrompt` field rather than a message row.
// We honor that: anything tagged 'system' is folded into the system
// prompt; only 'user' / 'assistant' rows become Messages.
// ─────────────────────────────────────────────────────────────────────────

function buildContext(input: AgentTurnInput): Context {
  // System prompt: combine the runtime system prompt (preset or text)
  // with the orientation block. Codex doesn't speak Claude's preset
  // marker, so the preset path coerces to its `.append` text body.
  let systemPrompt = '';
  if (input.systemPrompt.kind === 'text') {
    systemPrompt = input.systemPrompt.value;
  } else if (input.systemPrompt.kind === 'claude-preset') {
    systemPrompt = input.systemPrompt.append;
  }
  if (input.orientation) {
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${input.orientation}`
      : input.orientation;
  }

  // Conversation history.
  const now = Date.now();
  const messages: Message[] = [];
  for (const msg of input.messages) {
    const ts = Date.parse(msg.createdAt);
    const timestamp = Number.isFinite(ts) ? ts : now;
    if (msg.role === 'system') {
      // Additional system messages concatenate to the systemPrompt
      // rather than landing as their own row (pi-ai's Context doesn't
      // accept system-role Messages).
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${msg.content}`
        : msg.content;
      continue;
    }
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      // Pre-validated by `validateUserImages` in runTurn — bad entries
      // were filtered out before we got here and surfaced as
      // `image_conversion_failed` diagnostics. What lands here is
      // guaranteed to be well-shaped { base64, mimeType }.
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: msg.content },
          ...imagesToPiAi(msg.images),
        ],
        timestamp,
      });
    } else if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content, timestamp });
    } else {
      // 'assistant'
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: msg.content }],
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        model: input.modelRef.model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: 'stop',
        timestamp,
      });
    }
  }

  const context: Context = { messages };
  if (systemPrompt) context.systemPrompt = systemPrompt;
  return context;
}

// ─────────────────────────────────────────────────────────────────────────
// Class
// ─────────────────────────────────────────────────────────────────────────

/** In-memory session-resume map keyed by `<threadId>|<modelRef.canonical>`. */
type SessionKey = string;
// Cap for the in-memory resume map — generous for a single-user deployment
// (hundreds of live thread×model pairs) while keeping the map bounded.
const MAX_RESUME_SESSIONS = 500;
function sessionKey(threadId: string, modelRefCanonical: string): SessionKey {
  return `${threadId}|${modelRefCanonical}`;
}

/**
 * Constructor options. The runtime is a long-lived singleton instantiated
 * once in `runtimes/index.ts`, but the singleton needs a way to reach
 * byte-light's tool surface (tools-bridge.executeRouterTool) without
 * importing tools-bridge directly (that would violate the Slice 1
 * out-of-scope guard — codex.ts is forbidden from depending on
 * tools-bridge so future readers can audit the dep graph at a glance).
 *
 * The solution is the same constructor-callback pattern ApiRouter uses
 * (`ApiRouterOptions.executeTool`, api-router.ts:137): the dispatcher
 * site that owns both runtimes and tools-bridge wires the callback in
 * during runtime construction. Tools-bridge never appears in this file's
 * import list — the type signature is the only contract.
 *
 * When `executeTool` is omitted (no-arg constructor, used by the
 * Slice 1 singleton at the bottom of this file), the runtime falls back
 * to Slice 1 behavior: it emits a `provider_diagnostic` if the model
 * somehow returns tool calls (e.g. tools were configured at the manifest
 * layer but the dispatcher forgot to wire the callback) and finishes
 * with `tool_calls` finish reason rather than executing anything.
 */
export interface CodexAgentRuntimeOptions {
  /**
   * Execute a tool by name and return its result. Same contract as
   * `ApiRouterOptions.executeTool` so a single tools-bridge surface
   * serves both runtimes. The callback owns:
   *   - tool name resolution (in-process registry, .mcp.json HTTP, DB-
   *     managed MCP servers)
   *   - argument validation (the model can send malformed args)
   *   - per-tool security policy (path guards, scope roots, etc.)
   *   - secret hygiene (callbacks must never include the runtime's
   *     access token in the returned result; this runtime never lets
   *     the token reach a callback anyway — defense in depth)
   *
   * Returns `{ result, ok }` where `result` is the string the model
   * sees as the tool's output. `ok` distinguishes successful execution
   * from failure (the loop driver maps `ok:false` to `isError:true`
   * on the emitted `tool_result` event).
   */
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ result: string; ok: boolean }>;
}

export class CodexAgentRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'codex';
  readonly providerId: ProviderId = 'openai-codex';

  private abortController: AbortController | null = null;
  private aborted = false;
  private readonly sessions = new Map<SessionKey, string>();
  private readonly options: CodexAgentRuntimeOptions;

  /**
   * No-arg constructor preserves Slice 1's instantiation site
   * (`new CodexAgentRuntime()` for the module-level singleton). The
   * options-bearing form is what runtimes/index.ts would use in a
   * later slice when it wires the tools-bridge callback in. For now
   * the singleton runs without `executeTool` — the dispatcher hasn't
   * been touched in Slice 2 — so the singleton emits the same
   * Slice-1 diagnostic on unexpected tool calls.
   */
  constructor(options: CodexAgentRuntimeOptions = {}) {
    this.options = options;
  }

  abort(): void {
    this.aborted = true;
    this.abortController?.abort();
  }

  /**
   * Optional session resume. Returns the pi-ai session id previously
   * captured for this thread+model pair (or undefined when no session
   * exists). Storage is in-memory only at the runtime level — the
   * outer `thread_provider_sessions` persistence layer lives in
   * `agent.ts` and is unchanged by this slice. Tests exercise the
   * round-trip directly via the runtime's own map.
   */
  resumeSessionId(
    thread: { id: string },
    modelRef: { canonical: string },
  ): string | undefined {
    return this.sessions.get(sessionKey(thread.id, modelRef.canonical));
  }

  persistSessionId(
    thread: { id: string },
    modelRef: { canonical: string },
    sessionId: string,
  ): void {
    const key = sessionKey(thread.id, modelRef.canonical);
    // Refresh insertion order on re-set so eviction below drops the
    // longest-untouched pair, and cap the map — it lives on a process-
    // lifetime singleton and previously grew one entry per thread×model
    // forever. The durable store is thread_provider_sessions in agent.ts;
    // an evicted pair costs one DB read, never a lost session.
    this.sessions.delete(key);
    this.sessions.set(key, sessionId);
    while (this.sessions.size > MAX_RESUME_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  // No capability provider in this slice — MCP toggle / rewindFiles /
  // listSessions remain Claude-SDK-only direct methods today.
  getCapabilityProvider<T>(_cap: CapabilityKey): T | undefined {
    return undefined;
  }

  async *runTurn(input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent> {
    // ── Canonical contract: emit `start` first ─────────────────────────
    yield { type: 'start', runtimeId: this.id, modelRef: input.modelRef };

    // Nothing leaves while Codex has asked us to wait (codex-breaker.ts, Aerie).
    const held = await passCodexBrake(houseTimezone());
    if (held) {
      yield { type: 'error', message: held, recoverable: true };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // ── Auth gate ─────────────────────────────────────────────────────
    // Check before we touch pi-ai at all. If the user isn't logged in,
    // emit `auth_required` and a clean `done` so the WS layer can route
    // to the reconnect UI instead of showing a generic error.
    if (!isCodexLoggedIn()) {
      yield {
        type: 'auth_required',
        provider: 'openai-codex',
        message:
          'Codex authentication required. Connect via Settings → Provider Health.',
      };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // Fetch the access token. This either returns a fresh string or
    // throws `CodexAuthRequiredError` (the file was deleted mid-turn,
    // refresh failed, etc.). We never log the token; it lives strictly
    // in the local `accessToken` variable until pi-ai consumes it.
    let accessToken: string;
    try {
      accessToken = await getCodexAccessToken();
    } catch (err) {
      if (err instanceof CodexAuthRequiredError) {
        yield {
          type: 'auth_required',
          provider: 'openai-codex',
          message:
            'Codex authentication required. Connect via Settings → Provider Health.',
        };
        yield { type: 'done', finishReason: 'error' };
        return;
      }
      // Unexpected failure path — classify and emit a safe error.
      const classified = classifyCodexError(err);
      yield {
        type: 'error',
        message: classified.safeMessage,
        recoverable: classified.recoverable,
      };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // ── Resolve the pi-ai Model descriptor ────────────────────────────
    // The dispatcher already parsed the canonical ref into ModelRef
    // (model + provider). We pass the bare model id to pi-ai's
    // `getModel('openai-codex', id)`. The pi-ai surface has two failure
    // modes for an unknown id:
    //   1. It throws — caught below and classified.
    //   2. It silently returns `undefined` — the runtime contract
    //      cast (`as unknown as Model<...>`) hides this hole, and
    //      pi-ai's streamer would later crash on `model.provider`
    //      with a raw `TypeError`. We guard with an explicit
    //      `if (!model)` check and emit a `provider_diagnostic`
    //      with code `unsupported_model` so the caller (and UI)
    //      sees a clean diagnostic instead of an opaque stream
    //      crash. The diagnostic includes ONLY the requested model
    //      id and runtime label — no token, auth path, or
    //      provider-internal state.
    let model: Model<'openai-codex-responses'> | undefined;
    try {
      // The cast is intentional: pi-ai's overloaded `getModel` is keyed
      // on a literal-typed `modelId`, but at this layer we only have
      // the runtime string from the ModelRef. The Codex provider's
      // generated models are a closed set; an unknown id either throws
      // (caught below) or returns undefined (guarded immediately after).
      model = providers.getModel(
        'openai-codex',
        input.modelRef.model as never,
      ) as unknown as Model<'openai-codex-responses'> | undefined;
    } catch (err) {
      const classified = classifyCodexError(err);
      yield {
        type: 'error',
        message: `Unknown Codex model: ${input.modelRef.model}. ${classified.safeMessage}`,
        recoverable: false,
      };
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    if (!model) {
      yield {
        type: 'provider_diagnostic',
        code: 'unsupported_model',
        message: `Codex model "${input.modelRef.model}" is not available through ChatGPT OAuth. Choose a supported Codex model.`,
        data: {
          requested_model: input.modelRef.model,
          requested_runtime: 'codex',
        },
      };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // ── Wire abort ────────────────────────────────────────────────────
    this.abortController = new AbortController();
    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        this.abort();
      } else {
        input.abortSignal.addEventListener('abort', () => this.abort(), {
          once: true,
        });
      }
    }
    this.aborted = false;
    if (input.abortSignal?.aborted) {
      this.aborted = true;
      this.abortController.abort();
    }

    // ── Validate user-image input ─────────────────────────────────────
    // Each `NormalizedMessage.images` entry is checked for
    // well-formedness (non-empty base64 + `image/<subtype>` mimeType).
    // Malformed entries are dropped and surfaced as one
    // `provider_diagnostic { code: 'image_conversion_failed' }` event
    // per dropped entry. The diagnostic data NEVER includes the raw
    // base64 — only a redacted marker (mime + byte length). Dropping
    // is preferred over aborting the turn because the user's text
    // content typically carries the actual ask; losing a bad image
    // is degraded but recoverable, while aborting is total failure.
    let validatedInput: AgentTurnInput = input;
    {
      let touched = false;
      const newMessages = input.messages.map((msg) => {
        if (msg.role !== 'user' || !msg.images || msg.images.length === 0) {
          return msg;
        }
        const { good, diagnostics } = validateUserImages(msg.images);
        if (diagnostics.length === 0) return msg;
        // We'll re-emit later (after constructing the cleaned message)
        // so the start/auth events still come first.
        (msg as { __imageDiagnostics?: typeof diagnostics }).__imageDiagnostics =
          diagnostics;
        touched = true;
        return {
          ...msg,
          images: good.length > 0 ? good : undefined,
        };
      });
      // Emit one diagnostic per malformed image across all messages.
      for (const msg of input.messages) {
        const dx = (msg as { __imageDiagnostics?: Array<{
          message: string;
          data: Record<string, unknown>;
        }> }).__imageDiagnostics;
        if (!dx) continue;
        for (const d of dx) {
          yield {
            type: 'provider_diagnostic',
            code: 'image_conversion_failed',
            message: d.message,
            data: d.data,
          };
        }
        // Clean up the stash so the diagnostic field doesn't leak
        // into downstream payloads.
        delete (msg as { __imageDiagnostics?: unknown }).__imageDiagnostics;
      }
      if (touched) {
        validatedInput = { ...input, messages: newMessages };
      }
    }

    // ── Build the pi-ai Context ───────────────────────────────────────
    // `context.messages` is the running history we mutate across tool-
    // loop iterations: each iteration appends the assistant's reply +
    // any toolResult messages so the next request shows the model what
    // it just said and the tool outputs it requested. The Slice 1 build
    // produces the initial state; the loop below extends it.
    const context = buildContext(validatedInput);

    // Tool definitions for the model. Translated once; pi-ai's `Tool`
    // shape stays stable across iterations. `undefined` means "no
    // tools" (covers both the no-callback singleton path AND the
    // executeTool-but-no-tool-defs case — pi-ai rejects an empty array
    // on some providers, so we normalize to undefined for safety).
    const piTools = toolDefinitionsToPiAi(input.tools);
    const hasToolsConfigured = piTools !== undefined && piTools.length > 0;
    const canExecuteTools =
      hasToolsConfigured && typeof this.options.executeTool === 'function';
    if (hasToolsConfigured) {
      context.tools = piTools;
    }

    // ── Resolve session id for resume ─────────────────────────────────
    // Prefer the caller-provided sessionId (the outer
    // thread_provider_sessions lookup in agent.ts); fall back to our
    // own in-memory map. Either way, never invent one — pi-ai
    // tolerates omission.
    let sessionId =
      input.sessionId ??
      this.resumeSessionId(input.thread, input.modelRef);

    // ── Stream + tool loop ────────────────────────────────────────────
    // Slice 1 had a single straight-line pi-ai stream consumption.
    // Slice 2 wraps that consumption in a tool-calling loop:
    //   - per iteration: open a stream, consume deltas, capture the
    //     final AssistantMessage from the `done` event.
    //   - if the final message contains `toolCall` content blocks,
    //     dispatch them through the constructor `executeTool` callback,
    //     append `toolResult` messages to `context.messages`, increment
    //     the iteration counter, and re-run.
    //   - if the final message has no tool calls, emit usage + done and
    //     return — same terminal sequence as Slice 1.
    //
    // Guards (reference implementation E3b parity):
    //   - MAX_TOOL_ITERATIONS bounds the loop (model stuck in a tool-
    //     request loop terminates cleanly with finishReason='length').
    //   - MAX_PARALLEL bounds intra-iteration concurrency (chunked
    //     dispatch — see the chunk loop below).
    //   - MAX_TURN_OUTPUT_BYTES bounds total tool output across the
    //     whole turn (per-result cap lives in output-budget.ts).
    //   - Repeated-call detection: if iteration N+1 issues the exact
    //     same tool+args set as iteration N, terminate (the model is
    //     stuck in a recursive request loop).
    //
    // Output accounting uses UTF-8 byte counting throughout — see
    // output-budget.ts for the rationale.
    let outputChars = 0;
    let inputChars = (context.systemPrompt?.length ?? 0);
    for (const msg of context.messages) {
      if (typeof msg.content === 'string') {
        inputChars += msg.content.length;
      } else {
        inputChars += JSON.stringify(msg.content).length;
      }
    }
    let sessionEmitted = false;
    let totalToolOutputBytes = 0;
    let previousIterationToolKey: string | null = null;

    // Thread-resolved thinking effort → pi-ai `reasoningEffort`. Resolved
    // once per turn; 'auto' maps to undefined so pi-ai picks its default.
    const reasoningEffort = mapReasoningEffort(input.thinkingEffort);

    // Per-iteration outcome type lives at module scope (see
    // `IterationOutcomeReturn` near the bottom of the file). The outer
    // loop branches on `outcome.kind` to decide between continuing the
    // tool loop, emitting a terminal error, or finalizing.

    try {
      let iteration = 0;
      while (iteration < MAX_TOOL_ITERATIONS) {
        if (this.aborted) {
          yield { type: 'done', finishReason: 'aborted' };
          return;
        }

        // Open the per-iteration stream. pi-ai's StreamFunction returns
        // synchronously; errors during request setup throw here and are
        // caught by the outer try/catch (classified + emitted as one of
        // auth_required / rate_limit / error). Errors mid-stream surface
        // as a terminal `error` event inside the consumer.
        const stream = providers.streamOpenAICodexResponses(
          model as Model<'openai-codex-responses'>,
          context,
          {
            apiKey: accessToken,
            signal: this.abortController.signal,
            ...(sessionId ? { sessionId } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            reasoningSummary: 'auto',
          },
        );

        // Consume one iteration of the stream. The consumer captures
        // the final AssistantMessage so the outer loop can inspect it
        // for tool calls.
        const outcome: IterationOutcomeReturn = yield* this.consumeOneIteration(
          stream as AsyncIterable<AssistantMessageEvent>,
          input,
          { setSession: (id) => { sessionEmitted = true; sessionId = id; } },
          sessionEmitted,
        );

        if (outcome.kind === 'aborted') {
          yield { type: 'done', finishReason: 'aborted' };
          return;
        }
        if (outcome.kind === 'auth_required') {
          yield {
            type: 'auth_required',
            provider: 'openai-codex',
            message:
              outcome.classifiedError?.safeMessage ??
              'Codex authentication required.',
          };
          yield { type: 'done', finishReason: 'error' };
          return;
        }
        if (outcome.kind === 'error') {
          yield {
            type: 'error',
            message:
              outcome.classifiedError?.safeMessage ??
              'Codex provider failure.',
            recoverable: outcome.classifiedError?.recoverable ?? false,
          };
          yield { type: 'done', finishReason: 'error' };
          return;
        }

        // outcome.kind === 'final'
        const finalMessage = outcome.finalMessage!;
        const finishReason = outcome.finishReason!;

        // Extract tool calls from the final message. This is the
        // authoritative source — streaming toolcall_* events are
        // best-effort and can drop on transport hiccup.
        //
        // Defensive: `content` is required on pi-ai's `AssistantMessage`
        // shape, but test fakes (and provider edge cases — e.g. a stream
        // that ends without a proper `done` event whose final-message
        // synthesis path runs) may omit it. Treat missing content as
        // "no tool calls + no text" rather than throwing — a throw here
        // would land in the outer catch and emit an error event, which
        // is the wrong UX for "stream ended cleanly with empty content".
        const finalContent = Array.isArray(finalMessage.content)
          ? finalMessage.content
          : [];
        const toolCalls: ToolCall[] = finalContent.filter(
          (c): c is ToolCall => c.type === 'toolCall',
        );

        // Update text/usage accounting from this iteration's final.
        for (const block of finalContent) {
          if (block.type === 'text') outputChars += block.text.length;
        }

        // ── No tool calls → final iteration ──────────────────────────
        if (toolCalls.length === 0) {
          // Stuck detection: if iteration > 0 and the model produced
          // no text AND no tool calls, the loop is making no progress.
          // Mid-loop empty turns are model bugs; surface them so the
          // user understands why we stopped rather than silently
          // returning a blank answer.
          const producedAnyText = finalContent.some(
            (c) => c.type === 'text' && c.text.length > 0,
          );
          if (iteration > 0 && !producedAnyText) {
            yield {
              type: 'error',
              message:
                'Codex produced an empty turn during the tool loop ' +
                '(no text, no tool calls). Terminating to avoid an ' +
                'infinite loop.',
              recoverable: true,
            };
            yield { type: 'done', finishReason: 'error' };
            return;
          }

          // Usage report from the final iteration. Provider-reported.
          const u = finalMessage.usage;
          yield {
            type: 'usage',
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            cost: u.cost.total,
          };
          yield { type: 'done', finishReason };
          return;
        }

        // ── Tool calls present ───────────────────────────────────────
        // No callback wired → preserve Slice 1 behavior: emit a
        // diagnostic and end the turn with finishReason='tool_calls'.
        // This branch covers two cases:
        //   1. The Slice-1 singleton (constructed with no options) and
        //      a manifest that somehow surfaced tools.
        //   2. A future caller that wires tools but not executeTool
        //      (a config bug — fail loud rather than spinning).
        if (!canExecuteTools) {
          yield {
            type: 'provider_diagnostic',
            code: 'codex_tool_call_unsupported',
            message:
              'Codex emitted a tool call but no executeTool callback is ' +
              'wired into this runtime instance.',
          };
          const u = finalMessage.usage;
          yield {
            type: 'usage',
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            cost: u.cost.total,
          };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }

        // Repeated-call guard: build a stable key from the requested
        // tool+args set. If two consecutive iterations request the
        // exact same set, the model is stuck (same input → same
        // output, no progress). Terminate gracefully.
        const iterationKey = JSON.stringify(
          toolCalls
            .map((c) => ({ n: c.name, a: c.arguments }))
            .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)),
        );
        if (previousIterationToolKey === iterationKey && iteration > 0) {
          yield {
            type: 'error',
            message:
              'Codex repeated the same tool call set across consecutive ' +
              'iterations — terminating to avoid an infinite loop.',
            recoverable: true,
          };
          yield { type: 'done', finishReason: 'error' };
          return;
        }
        previousIterationToolKey = iterationKey;

        // Append the assistant turn to the running context BEFORE
        // dispatching tool calls — every toolCall in this message MUST
        // have a matching toolResult message before the next pi-ai
        // request (OpenAI Responses API protocol invariant; reference implementation
        // E3b/4 review P1 catch).
        context.messages.push(finalMessage);

        // Dispatch tool calls in chunks of MAX_PARALLEL. Each chunk:
        //   1. Emit `tool_start` for every call in the chunk (before
        //      dispatch; async-gen `yield` can't live inside Promise.all).
        //   2. Execute the chunk in parallel.
        //   3. Emit `tool_result` for every result in the chunk.
        //   4. Append `toolResult` messages to context.messages.
        // After all chunks: budget check.
        const executions: Array<{
          call: ToolCall;
          outputText: string;
          isError: boolean;
        }> = [];
        let budgetTrippedDuringDispatch = false;

        for (
          let chunkStart = 0;
          chunkStart < toolCalls.length;
          chunkStart += MAX_PARALLEL
        ) {
          const chunk = toolCalls.slice(chunkStart, chunkStart + MAX_PARALLEL);

          // (a) tool_start events
          for (const call of chunk) {
            yield {
              type: 'tool_start',
              id: call.id,
              name: call.name,
              input: call.arguments,
            };
          }

          // (b) Parallel execution within the chunk.
          const executeTool = this.options.executeTool!;
          const chunkResults = await Promise.all(
            chunk.map(async (call) => {
              try {
                const res = await executeTool(call.name, call.arguments);
                if (!res.ok) {
                  // Tool ran and reported failure — surface the safe
                  // message from the bridge as the result content
                  // (bridge is responsible for not leaking secrets;
                  // see tools-bridge.executeRouterTool contract).
                  const safeMessage = res.result ?? 'Tool returned an error.';
                  return {
                    call,
                    outputText: applyOutputBudget(
                      safeToolErrorResult('tool_error', safeMessage),
                      MAX_TOOL_OUTPUT_BYTES,
                    ),
                    isError: true,
                  };
                }
                // Success path — clip per-result budget. The tools-
                // bridge bridge usually self-caps but we apply the
                // budget here as a structural guarantee regardless.
                return {
                  call,
                  outputText: applyOutputBudget(
                    res.result,
                    MAX_TOOL_OUTPUT_BYTES,
                  ),
                  isError: false,
                };
              } catch (err) {
                // Tool threw — turn the throw into a safe structured
                // error result. NEVER include stack frames in the
                // model-visible output (they can carry file paths,
                // env values, transient secrets). The .message field
                // is the only thing we propagate, and even that goes
                // through `safeToolErrorResult`'s JSON envelope so
                // it can't break out of its quoting.
                const message =
                  errMessage(err);
                return {
                  call,
                  outputText: applyOutputBudget(
                    safeToolErrorResult('tool_threw', message),
                    MAX_TOOL_OUTPUT_BYTES,
                  ),
                  isError: true,
                };
              }
            }),
          );

          // (c) tool_result events + budget accounting.
          for (const { call, outputText, isError } of chunkResults) {
            totalToolOutputBytes += utf8ByteLength(outputText);
            yield {
              type: 'tool_result',
              id: call.id,
              name: call.name,
              output: outputText,
              isError,
            };
          }

          executions.push(...chunkResults);

          // Mid-chunk budget tripwire. If we crossed the per-turn cap
          // partway through the call list, synthesize "skipped due to
          // budget" results for every remaining call so the next pi-ai
          // request stays protocol-valid (every toolCallId from
          // finalMessage.content needs a matching toolResult, even
          // when the budget cut us short).
          if (totalToolOutputBytes > MAX_TURN_OUTPUT_BYTES) {
            budgetTrippedDuringDispatch = true;
            const dispatchedIds = new Set(executions.map((e) => e.call.id));
            for (const call of toolCalls) {
              if (dispatchedIds.has(call.id)) continue;
              const skipped = {
                call,
                outputText: safeToolErrorResult(
                  'skipped_budget',
                  'Tool call skipped — turn output budget exceeded before this call ran.',
                ),
                isError: true,
              };
              executions.push(skipped);
              yield {
                type: 'tool_result',
                id: skipped.call.id,
                name: skipped.call.name,
                output: skipped.outputText,
                isError: true,
              };
            }
            break;
          }

          // Abort between chunks — bail without synthesizing skipped
          // results because the whole turn ends with done(aborted).
          if (this.aborted) break;
        }

        if (this.aborted) {
          yield { type: 'done', finishReason: 'aborted' };
          return;
        }

        // (d) Append toolResult messages for every executed/synthesized
        // result. The set of toolCallIds in context.messages now
        // exactly matches the set in finalMessage.content — protocol
        // invariant satisfied for the next pi-ai turn.
        //
        // Image extraction (6B-B Slice 3): for SUCCESSFUL results we
        // parse the output via `splitToolResultForCodex` to separate
        // text from any base64-embedded images. The text goes into
        // the `toolResult` message (which becomes `function_call_output`
        // in the Responses API — text-only by spec). The images get
        // collected and injected as a follow-up `user` message AFTER
        // all toolResult messages — the Responses API accepts
        // `input_image` blocks in user messages natively. This is the
        // proven reference implementation pattern and stays safe even on providers that
        // don't tolerate images inside `function_call_output`.
        //
        // Error / synthesized results (isError=true OR
        // skipped_budget envelope) are NEVER image-extracted: those
        // outputs are short JSON envelopes that won't contain images,
        // and running them through the extractor would pollute the
        // text breadcrumb with a JSON re-wrap.
        //
        // Failure handling: `splitToolResultForCodex` never throws,
        // but we wrap defensively so a future refactor that adds a
        // throwable code path can't take down the whole turn —
        // instead we emit `image_extraction_failed` and fall back to
        // the raw text. The diagnostic data NEVER contains raw base64
        // (we use the redacted marker shape).
        const collectedToolImages: Array<{
          type: 'image';
          data: string;
          mimeType: string;
        }> = [];
        for (const { call, outputText, isError } of executions) {
          let toolMessageText = outputText;
          if (!isError) {
            try {
              const split = splitToolResultForCodex(outputText);
              toolMessageText = split.toolResultText;
              collectedToolImages.push(...split.images);
            } catch (err) {
              const message =
                errMessage(err);
              yield {
                type: 'provider_diagnostic',
                code: 'image_extraction_failed',
                message:
                  `Image extraction failed for tool ${call.name}: ${message}. ` +
                  `Falling back to raw text.`,
                data: {
                  toolName: call.name,
                  toolCallId: call.id,
                },
              };
            }
          }
          context.messages.push({
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: toolMessageText }],
            isError,
            timestamp: Date.now(),
          });
        }

        // (d.2) If any tool result yielded image content, inject ONE
        // follow-up user message carrying every extracted image after
        // all the toolResult messages. Each image is a proper pi-ai
        // `ImageContent` block — the openai-codex-responses provider
        // converts these to `input_image` parts. Order across results
        // is preserved (tool A's images come before tool B's). The
        // banner text is a short fixed string — never includes raw
        // base64.
        if (collectedToolImages.length > 0) {
          context.messages.push({
            role: 'user',
            content: buildToolResultImageFollowup(collectedToolImages),
            timestamp: Date.now(),
          });
        }

        if (budgetTrippedDuringDispatch) {
          // Turn ended because we ran out of output budget. Emit one
          // error + done; do NOT continue to another iteration (the
          // model has all the results we could fit; further calls
          // would just spend more budget on cascading errors).
          yield {
            type: 'error',
            message:
              `Codex tool output budget exceeded ` +
              `(${totalToolOutputBytes} / ${MAX_TURN_OUTPUT_BYTES} bytes). ` +
              `Ending turn.`,
            recoverable: true,
          };
          yield { type: 'done', finishReason: 'length' };
          return;
        }

        iteration++;
      }

      // Iteration ceiling hit — the model is still requesting tools
      // after MAX_TOOL_ITERATIONS rounds. Stop here; the user can
      // see what we have and re-prompt with a tighter task if they
      // want to continue.
      yield {
        type: 'error',
        message:
          `Codex reached the tool-loop ceiling (${MAX_TOOL_ITERATIONS} ` +
          `iterations) and was still requesting tools. Ending turn.`,
        recoverable: true,
      };
      yield { type: 'done', finishReason: 'length' };
    } catch (err) {
      if (this.aborted) {
        yield { type: 'done', finishReason: 'aborted' };
        return;
      }
      const classified = classifyCodexError(err);
      brakeOnRateLimit(classified, errMessage(err));
      if (classified.kind === 'aborted') {
        yield { type: 'done', finishReason: 'aborted' };
        return;
      }
      if (classified.kind === 'auth') {
        yield {
          type: 'auth_required',
          provider: 'openai-codex',
          message: classified.safeMessage,
        };
      } else {
        yield {
          type: 'error',
          message: classified.safeMessage,
          recoverable: classified.recoverable,
        };
      }
      yield { type: 'done', finishReason: 'error' };
    } finally {
      this.abortController = null;
      // Silence unused-var warning when the type-only `inputChars` /
      // `outputChars` accounting isn't consumed (Slice 1 used them for
      // a fallback usage event; Slice 2's usage comes from pi-ai's
      // structured `finalMessage.usage` instead).
      void inputChars;
      void outputChars;
    }
  }

  /**
   * Consume one pi-ai stream iteration. Yields normalized runtime events
   * for every text/thinking delta the stream emits; returns the captured
   * AssistantMessage so the outer loop can inspect it for tool calls.
   *
   * Why this is a separate method:
   *   - The runTurn generator's outer loop runs N iterations; each
   *     iteration needs to consume a stream AND inspect its final
   *     message. Inlining all of that produced an unreadable 200-line
   *     for-await block; lifting the per-iteration logic out gives the
   *     outer loop a clean "execute one round" call.
   *   - The return shape (`IterationOutcome`) explicitly captures the
   *     branches (final / auth / error / aborted) so the outer loop's
   *     control flow is a flat switch rather than nested try/catch.
   *   - This is an async generator method so `yield*` from the outer
   *     loop's `yield* this.consumeOneIteration(...)` produces a flat
   *     event stream — consumers see one continuous sequence of
   *     normalized events across iterations.
   */
  private async *consumeOneIteration(
    stream: AsyncIterable<AssistantMessageEvent>,
    input: AgentTurnInput,
    sessionHooks: { setSession: (id: string) => void },
    sessionAlreadyEmitted: boolean,
  ): AsyncGenerator<AgentRuntimeEvent, IterationOutcomeReturn> {
    let sessionEmittedHere = sessionAlreadyEmitted;
    let finalMessage: AssistantMessage | null = null;
    let finishReason: 'stop' | 'length' | 'tool_calls' = 'stop';

    for await (const ev of stream) {
      if (this.aborted) {
        return { kind: 'aborted' };
      }

      switch (ev.type) {
        case 'start': {
          const responseId = ev.partial.responseId;
          if (responseId && !sessionEmittedHere) {
            sessionEmittedHere = true;
            sessionHooks.setSession(responseId);
            this.persistSessionId(input.thread, input.modelRef, responseId);
            yield { type: 'session', sessionId: responseId };
          }
          break;
        }
        case 'text_delta': {
          yield { type: 'text_delta', text: ev.delta };
          break;
        }
        case 'thinking_delta': {
          // Slice 3 (thought semantics): pi-ai reasoning deltas are native
          // model telemetry → kind 'provider'.
          yield { type: 'thinking_delta', text: ev.delta, kind: 'provider' };
          break;
        }
        case 'thinking_end':
        case 'text_start':
        case 'text_end':
        case 'thinking_start': {
          // Boundary events — payload comes via the deltas; we don't
          // re-emit. Matches Slice 1 behavior.
          break;
        }
        case 'toolcall_start':
        case 'toolcall_delta':
        case 'toolcall_end': {
          // Tool events from the stream are silenced — the outer loop
          // sources tool calls from `finalMessage.content` instead
          // (authoritative; reference implementation E3b parity). The stream events
          // are best-effort UI surfaces that can drop on transport
          // hiccup; we'd duplicate `tool_start` if we surfaced them
          // here too because the outer loop emits `tool_start` from
          // the captured final message before dispatch.
          break;
        }
        case 'done': {
          // Capture session id from final message if not yet emitted.
          const responseId = ev.message.responseId;
          if (responseId && !sessionEmittedHere) {
            sessionEmittedHere = true;
            sessionHooks.setSession(responseId);
            this.persistSessionId(input.thread, input.modelRef, responseId);
            yield { type: 'session', sessionId: responseId };
          }
          finalMessage = ev.message;
          finishReason =
            ev.reason === 'stop'
              ? 'stop'
              : ev.reason === 'length'
                ? 'length'
                : 'tool_calls';
          return { kind: 'final', finalMessage, finishReason };
        }
        case 'error': {
          if (ev.reason === 'aborted') {
            return { kind: 'aborted' };
          }
          const classified = classifyCodexError(
            new Error(ev.error.errorMessage ?? 'Codex provider failure'),
          );
          brakeOnRateLimit(classified, ev.error.errorMessage ?? '');
          if (classified.kind === 'auth') {
            return { kind: 'auth_required', classifiedError: classified };
          }
          return { kind: 'error', classifiedError: classified };
        }
      }
    }

    // Stream ended without an explicit `done` event — defensive close.
    // Most likely the provider iterator was exhausted by an abort.
    if (this.aborted) {
      return { kind: 'aborted' };
    }
    if (finalMessage) {
      return { kind: 'final', finalMessage, finishReason };
    }
    // No final message and no abort — synthesize a 'stop' outcome
    // with an empty AssistantMessage so the outer loop terminates
    // cleanly rather than re-entering the stream with stale state.
    const synthetic: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: input.modelRef.model,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    return { kind: 'final', finalMessage: synthetic, finishReason: 'stop' };
  }
}

/**
 * Return shape of `consumeOneIteration`. The outer loop switches on
 * `.kind` to decide whether to continue (final + tool calls), terminate
 * cleanly (final + no tool calls), or emit an error + terminate.
 *
 * Top-level so the method's signature can reference it without inlining
 * a long return type at the method head.
 */
type IterationOutcomeReturn =
  | {
      kind: 'final';
      finalMessage: AssistantMessage;
      finishReason: 'stop' | 'length' | 'tool_calls';
    }
  | { kind: 'auth_required'; classifiedError: ClassifiedCodexError }
  | { kind: 'error'; classifiedError: ClassifiedCodexError }
  | { kind: 'aborted' };

// Factory for `CodexAgentRuntime`. The wired production singleton lives
// in `runtimes/index.ts`, which constructs it with the tools-bridge
// `executeTool` callback. This file deliberately does NOT export a
// module-level singleton: a bare-constructed runtime (no `executeTool`)
// would route real tool calls into the `provider_diagnostic` fallback
// path, which is the wrong production behavior. Any code that needs a
// Codex runtime must either go through the barrel (`runtimes/index.ts`)
// or construct one explicitly via this factory (tests do the latter to
// exercise the unwired code paths in isolation).
export function createCodexRuntime(
  options?: CodexAgentRuntimeOptions,
): CodexAgentRuntime {
  return new CodexAgentRuntime(options);
}

// Convenience re-export so callers that already imported the auth gate
// from this barrel don't have to thread a second path. The runtime
// dispatcher uses `isCodexLoggedIn()` directly via index.ts — exporting
// here is purely a stylistic convenience for downstream slices.
export { isCodexLoggedIn as isCodexAuthed } from '../auth/codex-oauth.js';
