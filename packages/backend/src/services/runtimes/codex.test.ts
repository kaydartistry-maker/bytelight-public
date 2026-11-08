/**
 * Tests for the Codex (ChatGPT OAuth) runtime shell (6B-B Slice 1).
 *
 * Test seam — byte-light convention (`__TEST_PROVIDERS__` + `_resetForTests`):
 *   We swap pi-ai's `streamOpenAICodexResponses` and `getModel` for fake
 *   implementations. The codex-oauth module's pi-ai providers are also
 *   substituted so `getCodexAccessToken()` returns sentinel values
 *   without hitting the network.
 *
 * Sentinels — these strings MUST NOT appear in any serialized runtime
 * event, error message, or log line. The leak tests below assert this
 * on every code path that touches the token.
 *
 * Run with:
 *   npx tsx --test packages/backend/src/services/runtimes/codex.test.ts
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  CodexAgentRuntime,
  CODEX_CAPABILITIES,
  toolDefinitionsToPiAi,
  __TEST_PROVIDERS__,
  _resetForTests,
} from './codex.js';

// Slice 1/2 tests below exercise the BARE (unwired) Codex runtime: no
// `executeTool` callback, so tool calls hit the `provider_diagnostic`
// fallback path. As of Slice 2.6 `codex.ts` no longer exports a
// module-level singleton — the wired production singleton lives in
// `runtimes/index.ts` and the wired-path tests (Slice 2.5 below)
// resolve it through `resolveRuntimeForRef`. Constructing the bare
// runtime here mirrors the prior `export const codexRuntime` lifecycle
// (one instance per test module load) without re-exposing an unwired
// singleton outside the test file.
const codexRuntime = new CodexAgentRuntime();
import type { AgentRuntimeEvent, AgentTurnInput, ToolDefinition } from './types.js';
import {
  __TEST_PROVIDERS__ as OAUTH_TEST_PROVIDERS,
  _resetForTests as resetOAuthForTests,
} from '../auth/codex-oauth.js';
// A 429 test sets the Codex brake; lift it so the next test is not held.
import { releaseCodexHold } from '../codex-breaker.js';

// ─── Sentinels (the operator's S2 rule: never use real-looking secrets) ──────────
const SENTINEL_ACCESS = 'TEST_CODEX_ACCESS_TOKEN_DO_NOT_LEAK_123';
const SENTINEL_REFRESH = 'TEST_CODEX_REFRESH_TOKEN_DO_NOT_LEAK_456';

// ─── Test harness state ─────────────────────────────────────────────────

interface CapturedCallArgs {
  /** Whatever pi-ai received as the `model` argument. */
  model: unknown;
  /** Whatever pi-ai received as the `context` argument. */
  context: unknown;
  /** Whatever pi-ai received as the `options` argument. */
  options: unknown;
}

interface FakeStreamControl {
  /** Args captured from the production call site. */
  calls: CapturedCallArgs[];
  /** Events the next stream call will emit (consumed in FIFO order). */
  events: AssistantMessageEventLike[];
  /** When set, throw this from the stream synchronously. */
  throwOnCall?: Error;
}

let streamControl: FakeStreamControl;
let tmpDir: string;
let authPath: string;

// Minimal shape — we don't import the real type to avoid coupling tests
// to pi-ai internals, but we mirror enough of the union to drive every
// runtime branch.
type AssistantMessageEventLike =
  | { type: 'start'; partial: { responseId?: string } }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: object }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: object }
  | { type: 'text_end'; contentIndex: number; content: string; partial: object }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: object }
  | {
      type: 'done';
      reason: 'stop' | 'length' | 'toolUse';
      message: {
        responseId?: string;
        usage: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          totalTokens: number;
          cost: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
          };
        };
      };
    }
  | {
      type: 'error';
      reason: 'aborted' | 'error';
      error: { errorMessage?: string };
    };

// Async iterable factory matching pi-ai's AssistantMessageEventStream surface.
function makeStream(events: AssistantMessageEventLike[]): AsyncIterable<AssistantMessageEventLike> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= events.length) return { value: undefined as unknown as AssistantMessageEventLike, done: true };
          const value = events[i++];
          return { value, done: false };
        },
      };
    },
  };
}

// Fake pi-ai stream — captures args, returns the queued event sequence.
function fakeStream(
  model: unknown,
  context: unknown,
  options: unknown,
): AsyncIterable<AssistantMessageEventLike> {
  streamControl.calls.push({ model, context, options });
  if (streamControl.throwOnCall) {
    throw streamControl.throwOnCall;
  }
  return makeStream(streamControl.events);
}

// Fake pi-ai model lookup — returns a minimal Model-shaped object.
function fakeGetModel(provider: string, modelId: string): unknown {
  if (provider !== 'openai-codex') {
    throw new Error(`fakeGetModel: unknown provider ${provider}`);
  }
  return {
    id: modelId,
    name: modelId,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.example/backend-api',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  };
}

// ─── OAuth substitution helpers ─────────────────────────────────────────
//
// The runtime calls `isCodexLoggedIn()` (file-existence sync check) and
// `getCodexAccessToken()` (async; calls pi-ai refresh if near expiry).
// We control both by setting CODEX_AUTH_PATH to a tmp file we write
// directly, and substituting the pi-ai refresh fn through the oauth
// module's own test seam so a never-near-expiry token returns the
// sentinel without network.

function writeAuthFile(loggedIn: boolean): void {
  if (!loggedIn) return;
  writeFileSync(
    authPath,
    JSON.stringify({
      refresh: SENTINEL_REFRESH,
      access: SENTINEL_ACCESS,
      expires: Date.now() + 24 * 3600_000, // far future — no refresh
    }),
    'utf8',
  );
}

// ─── AgentTurnInput builder ─────────────────────────────────────────────

function buildInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    thread: {
      id: 'thread-test-1',
      name: 'Test Thread',
      type: 'named',
      current_session_id: null,
    },
    tier: 'interactive',
    modelRef: {
      canonical: 'openai-codex/gpt-5.1',
      provider: 'openai-codex',
      model: 'gpt-5.1',
      runtime: 'codex',
    },
    platform: 'web',
    isAutonomous: false,
    orientation: 'Test orientation block.',
    systemPrompt: { kind: 'text', value: 'You are a test assistant.' },
    messages: [
      {
        role: 'user',
        content: 'Hello, Codex.',
        createdAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

// ─── Event collector ────────────────────────────────────────────────────

async function collect(
  iter: AsyncIterable<AgentRuntimeEvent>,
): Promise<AgentRuntimeEvent[]> {
  const out: AgentRuntimeEvent[] = [];
  for await (const ev of iter) {
    out.push(ev);
  }
  return out;
}

function assertNoSentinelsLeaked(events: AgentRuntimeEvent[]): void {
  const serialized = JSON.stringify(events);
  assert.ok(
    !serialized.includes(SENTINEL_ACCESS),
    `runtime events leaked access token sentinel: ${SENTINEL_ACCESS}`,
  );
  assert.ok(
    !serialized.includes(SENTINEL_REFRESH),
    `runtime events leaked refresh token sentinel: ${SENTINEL_REFRESH}`,
  );
}

// ─── Per-test setup ─────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codex-runtime-test-'));
  authPath = join(tmpDir, 'codex-auth.json');
  process.env.CODEX_AUTH_PATH = authPath;

  resetOAuthForTests();
  _resetForTests();

  streamControl = { calls: [], events: [], throwOnCall: undefined };

  // Substitute pi-ai surface used by the runtime. The casts go through
  // `unknown` because pi-ai's real surface returns concrete class
  // instances (`AssistantMessageEventStream`) while our fakes return
  // plain AsyncIterable objects — same iteration contract, different
  // nominal type. The runtime only consumes via `for await ... of`
  // so the structural compatibility is what matters at runtime.
  __TEST_PROVIDERS__.streamOpenAICodexResponses =
    fakeStream as unknown as typeof __TEST_PROVIDERS__.streamOpenAICodexResponses;
  __TEST_PROVIDERS__.getModel =
    fakeGetModel as unknown as typeof __TEST_PROVIDERS__.getModel;

  // Substitute pi-ai surface used by the oauth module (so a near-expiry
  // refresh would never hit the network — though our auth file is set
  // to far-future so refresh shouldn't fire in these tests).
  OAUTH_TEST_PROVIDERS.refreshOpenAICodexToken = (async () => {
    throw new Error('refresh should not be called in runtime tests');
  }) as typeof OAUTH_TEST_PROVIDERS.refreshOpenAICodexToken;
});

afterEach(() => {
  delete process.env.CODEX_AUTH_PATH;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
  _resetForTests();
  resetOAuthForTests();
  releaseCodexHold();
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('CodexAgentRuntime — capabilities + identity', () => {
  test('runtime id is "codex" and providerId is "openai-codex"', () => {
    const rt = new CodexAgentRuntime();
    assert.equal(rt.id, 'codex');
    assert.equal(rt.providerId, 'openai-codex');
  });

  test('CODEX_CAPABILITIES descriptor is the expected shape', () => {
    assert.equal(CODEX_CAPABILITIES.tools, true);
    assert.equal(CODEX_CAPABILITIES.vision, true);
    assert.equal(CODEX_CAPABILITIES.reasoning, true);
    assert.equal(CODEX_CAPABILITIES.mcp, false);
    assert.equal(CODEX_CAPABILITIES.sessionResume, true);
    assert.equal(CODEX_CAPABILITIES.fileCheckpointing, false);
    assert.equal(CODEX_CAPABILITIES.streaming, true);
  });

  test('createCodexRuntime factory returns a CodexAgentRuntime instance', async () => {
    // Slice 2.6: `codex.ts` no longer exports a module-level singleton.
    // The factory is the documented construction path for callers that
    // can't reach for the wired dispatcher singleton (tests, isolated
    // experiments). The wired production singleton lives in
    // `runtimes/index.ts` and is exercised by the Slice 2.5 wiring
    // tests below.
    const { createCodexRuntime } = await import('./codex.js');
    const rt = createCodexRuntime();
    assert.ok(rt instanceof CodexAgentRuntime);
  });
});

describe('CodexAgentRuntime — auth gate', () => {
  test('emits auth_required + done(error) when not logged in (NO provider call)', async () => {
    // Auth file absent — isCodexLoggedIn() returns false.
    writeAuthFile(false);

    const events = await collect(codexRuntime.runTurn(buildInput()));

    // Sequence: start, auth_required, done(error).
    assert.equal(events[0]?.type, 'start');
    const auth = events.find((e) => e.type === 'auth_required');
    assert.ok(auth, 'expected an auth_required event');
    if (auth?.type === 'auth_required') {
      assert.equal(auth.provider, 'openai-codex');
      assert.match(auth.message, /reconnect|connect|reauth/i);
    }
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done', 'expected a done event');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'error');
    }

    // No provider call.
    assert.equal(streamControl.calls.length, 0);

    assertNoSentinelsLeaked(events);
  });
});

describe('CodexAgentRuntime — connected text path', () => {
  test('retrieves access token and emits text_delta + usage + done', async () => {
    writeAuthFile(true);
    streamControl.events = [
      { type: 'start', partial: { responseId: 'resp-abc' } },
      {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Hello, ',
        partial: {},
      },
      {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'world.',
        partial: {},
      },
      {
        type: 'done',
        reason: 'stop',
        message: {
          responseId: 'resp-abc',
          usage: {
            input: 50,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 60,
            cost: {
              input: 0.001,
              output: 0.001,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.002,
            },
          },
        },
      },
    ];

    const events = await collect(codexRuntime.runTurn(buildInput()));

    // Token reached pi-ai's options.apiKey.
    assert.equal(streamControl.calls.length, 1);
    const opts = streamControl.calls[0].options as { apiKey?: string };
    assert.equal(opts.apiKey, SENTINEL_ACCESS);

    // Event sequence includes start, session, text_deltas, usage, done.
    const types = events.map((e) => e.type);
    assert.equal(types[0], 'start');
    assert.ok(types.includes('session'));
    assert.ok(types.includes('text_delta'));
    assert.ok(types.includes('usage'));
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'stop');
    }

    // Reconstruct the streamed text.
    const reconstructed = events
      .filter((e): e is Extract<AgentRuntimeEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    assert.equal(reconstructed, 'Hello, world.');

    // Session id captured.
    const session = events.find((e) => e.type === 'session');
    if (session?.type === 'session') {
      assert.equal(session.sessionId, 'resp-abc');
    }

    // Token NEVER appears in any serialized event.
    assertNoSentinelsLeaked(events);
  });

  test('round-trips session id through persistSessionId / resumeSessionId', () => {
    const rt = new CodexAgentRuntime();
    const thread = { id: 't1' };
    const ref = { canonical: 'openai-codex/gpt-5.1' };
    assert.equal(rt.resumeSessionId(thread, ref), undefined);
    rt.persistSessionId(thread, ref, 'resp-xyz');
    assert.equal(rt.resumeSessionId(thread, ref), 'resp-xyz');
  });

  test('passes thread+modelRef session id through to pi-ai when present', async () => {
    writeAuthFile(true);
    streamControl.events = [
      { type: 'start', partial: {} },
      {
        type: 'done',
        reason: 'stop',
        message: {
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    ];

    await collect(codexRuntime.runTurn(buildInput({ sessionId: 'prior-session-1' })));
    const opts = streamControl.calls[0].options as { sessionId?: string };
    assert.equal(opts.sessionId, 'prior-session-1');
  });
});

describe('CodexAgentRuntime — abort handling', () => {
  test('aborts cleanly when the caller signal fires mid-stream', async () => {
    writeAuthFile(true);
    const controller = new AbortController();

    // Build a stream that yields, awaits, yields — the second yield is
    // where we'll trip the abort.
    streamControl.events = [
      { type: 'start', partial: {} },
      { type: 'text_delta', contentIndex: 0, delta: 'first', partial: {} },
    ];

    // Custom stream that pauses after the first delta so we can abort.
    // Use a stable assigned-later reference so the closure escape
    // doesn't narrow `resolveSecond` to `null` after construction.
    let resolveSecond: () => void = () => {
      /* assigned below */
    };
    const secondReady = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });

    __TEST_PROVIDERS__.streamOpenAICodexResponses = ((
      _m: unknown,
      _c: unknown,
      opts: unknown,
    ) => {
      streamControl.calls.push({ model: _m, context: _c, options: opts });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: {} } as AssistantMessageEventLike;
          yield {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'first',
            partial: {},
          } as AssistantMessageEventLike;
          await secondReady;
          // pi-ai stream surfaces an abort as a terminal 'error' event
          // with reason 'aborted'.
          yield {
            type: 'error',
            reason: 'aborted',
            error: { errorMessage: 'aborted' },
          } as AssistantMessageEventLike;
        },
      };
    }) as unknown as typeof __TEST_PROVIDERS__.streamOpenAICodexResponses;

    const collectPromise = collect(
      codexRuntime.runTurn(buildInput({ abortSignal: controller.signal })),
    );

    // Give the runtime a tick to emit the first delta.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    resolveSecond();

    const events = await collectPromise;
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'aborted');
    }

    assertNoSentinelsLeaked(events);
  });
});

describe('CodexAgentRuntime — provider error mapping', () => {
  test('401 from provider maps to auth_required + safe message (no token leak)', async () => {
    writeAuthFile(true);
    streamControl.throwOnCall = new Error(
      `Codex 401 Unauthorized — request_id=req_abc, apiKey=${SENTINEL_ACCESS}`,
    );

    const events = await collect(codexRuntime.runTurn(buildInput()));

    const auth = events.find((e) => e.type === 'auth_required');
    assert.ok(auth && auth.type === 'auth_required', 'expected auth_required');
    if (auth?.type === 'auth_required') {
      assert.match(auth.message, /reconnect|expired|auth/i);
    }

    // The raw upstream string contained the sentinel — the emitted
    // event must NOT.
    assertNoSentinelsLeaked(events);
  });

  test('429 from provider maps to rate-limit error (recoverable, no leak)', async () => {
    writeAuthFile(true);
    streamControl.throwOnCall = new Error(
      `Codex 429 Too Many Requests — body=token_${SENTINEL_ACCESS}`,
    );

    const events = await collect(codexRuntime.runTurn(buildInput()));

    const err = events.find((e) => e.type === 'error');
    assert.ok(err && err.type === 'error', 'expected error event');
    if (err?.type === 'error') {
      assert.match(err.message, /rate limit/i);
      assert.equal(err.recoverable, true);
    }

    assertNoSentinelsLeaked(events);
  });

  test('5xx from provider maps to sanitized provider-failure error', async () => {
    writeAuthFile(true);
    streamControl.throwOnCall = new Error(
      `Codex 503 Service Unavailable — internal=${SENTINEL_REFRESH}`,
    );

    const events = await collect(codexRuntime.runTurn(buildInput()));

    const err = events.find((e) => e.type === 'error');
    assert.ok(err && err.type === 'error', 'expected error event');
    if (err?.type === 'error') {
      assert.match(err.message, /codex provider failure|retry shortly/i);
      assert.equal(err.recoverable, true);
    }

    assertNoSentinelsLeaked(events);
  });

  test('unknown provider error emits canonical safe message (no upstream echo)', async () => {
    writeAuthFile(true);
    streamControl.throwOnCall = new Error(
      `mysterious failure containing ${SENTINEL_ACCESS}`,
    );

    const events = await collect(codexRuntime.runTurn(buildInput()));

    const err = events.find((e) => e.type === 'error');
    assert.ok(err && err.type === 'error', 'expected error event');
    if (err?.type === 'error') {
      assert.ok(!err.message.includes(SENTINEL_ACCESS));
      assert.ok(!err.message.includes('mysterious'));
    }

    assertNoSentinelsLeaked(events);
  });

  test('stream-terminal error event maps with sanitized message', async () => {
    writeAuthFile(true);
    streamControl.events = [
      { type: 'start', partial: {} },
      {
        type: 'error',
        reason: 'error',
        error: {
          errorMessage: `Codex 500 Internal Server Error tokens=${SENTINEL_ACCESS}`,
        },
      },
    ];

    const events = await collect(codexRuntime.runTurn(buildInput()));

    const err = events.find((e) => e.type === 'error');
    assert.ok(err && err.type === 'error', 'expected error event');
    if (err?.type === 'error') {
      assert.match(err.message, /codex provider failure|retry shortly/i);
    }
    assertNoSentinelsLeaked(events);
  });
});

describe('CodexAgentRuntime — token sentinel hygiene', () => {
  test('access token never appears in serialized event stream across all branches', async () => {
    writeAuthFile(true);
    streamControl.events = [
      { type: 'start', partial: { responseId: 'r1' } },
      { type: 'text_delta', contentIndex: 0, delta: 'normal text', partial: {} },
      {
        type: 'done',
        reason: 'stop',
        message: {
          responseId: 'r1',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    ];

    const events = await collect(codexRuntime.runTurn(buildInput()));
    assertNoSentinelsLeaked(events);

    // Sanity: the token DID flow through to pi-ai (we want it there,
    // just not in our events).
    const opts = streamControl.calls[0].options as { apiKey?: string };
    assert.equal(opts.apiKey, SENTINEL_ACCESS);
  });
});

describe('runtimes/index — codex runtime registration', () => {
  test('resolveRuntimeForRef returns codex runtime + capabilities for codex modelRef', async () => {
    // `resolveRuntimeForRef` reads `cfg.agent.routing` for the
    // Claude/api branch; the cfg must be loaded before the switch
    // dispatches. Tests in byte-light call `loadConfig()` directly to
    // hydrate the in-memory singleton with YAML + env defaults.
    const { loadConfig } = await import('../../config.js');
    loadConfig();

    // Lazy import to avoid pulling the dispatcher's transitive
    // dependency graph at module load.
    const { resolveRuntimeForRef } = await import('./index.js');

    const packet = resolveRuntimeForRef({
      canonical: 'openai-codex/gpt-5.1',
      provider: 'openai-codex',
      model: 'gpt-5.1',
      runtime: 'codex',
    });

    assert.equal(packet.runtime.id, 'codex');
    assert.equal(packet.runtime.providerId, 'openai-codex');
    assert.equal(packet.capabilities, CODEX_CAPABILITIES);
  });
});

// ─── Slice 2: tool-calling loop ────────────────────────────────────────
//
// These tests extend Slice 1's harness (same fake stream, same auth
// substitution, same beforeEach/afterEach) with multi-iteration stream
// queuing so a single fake provider can drive a tool loop: each call to
// `streamControl.queueIteration([...])` enqueues one round of events.
// The fake stream pops the head of the queue per pi-ai call, so a 3-
// iteration loop pre-queues 3 event sequences.

// ─── Slice 2 sentinel (added per Slice 2 spec) ───────────────────────
const SENTINEL_TOOL_SECRET = 'TEST_CODEX_TOOL_SECRET_DO_NOT_LEAK_789';

interface MultiIterationStreamControl {
  /** FIFO of event sequences — one per pi-ai stream call. */
  iterations: AssistantMessageEventLike[][];
  /** Args captured per stream call (mirrors streamControl.calls). */
  calls: CapturedCallArgs[];
  /** How many parallel calls are in-flight at peak (dispatch invariant). */
  inFlightPeak: number;
}

let multiCtl: MultiIterationStreamControl;

/**
 * Install a multi-iteration fake. The first call to pi-ai consumes
 * `iterations[0]`; the second consumes `iterations[1]`; etc. When
 * iterations are exhausted, subsequent calls return an empty event
 * stream (the runtime synthesizes a final message in that case).
 *
 * Tools tests use this instead of the Slice 1 single-shot fake because
 * the tool loop calls pi-ai multiple times per turn (one per loop
 * iteration), and each iteration must drive its own event sequence.
 */
function installMultiIterationStream(): void {
  multiCtl = { iterations: [], calls: [], inFlightPeak: 0 };
  __TEST_PROVIDERS__.streamOpenAICodexResponses = ((
    model: unknown,
    context: unknown,
    options: unknown,
  ) => {
    multiCtl.calls.push({ model, context, options });
    const events = multiCtl.iterations.shift() ?? [];
    return makeStream(events);
  }) as unknown as typeof __TEST_PROVIDERS__.streamOpenAICodexResponses;
}

/**
 * Build a `done` event with the given content blocks. Most Slice 2
 * tests need a `done` event carrying ToolCall content blocks; the
 * Slice 1 helpers only built text-only `done` events.
 */
function doneWithContent(
  content: Array<
    { type: 'text'; text: string } | {
      type: 'toolCall';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  >,
  opts: { responseId?: string; reason?: 'stop' | 'length' | 'toolUse' } = {},
): AssistantMessageEventLike {
  return {
    type: 'done',
    reason: opts.reason ?? (content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop'),
    message: {
      responseId: opts.responseId,
      // Spread `content` onto the message so it survives JSON round-
      // trips and the runtime's `.filter()` call finds the tool calls.
      ...(content.length > 0 ? { content } : {}),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as unknown as AssistantMessageEventLike extends { type: 'done'; message: infer M } ? M : never,
  };
}

/**
 * Build a synthetic AgentTurnInput that includes a tool definition.
 * Same shape as buildInput() but with a tools array — needed for the
 * tool loop to engage.
 */
function buildInputWithTools(
  tools: ToolDefinition[],
  overrides: Partial<AgentTurnInput> = {},
): AgentTurnInput {
  return buildInput({ tools, ...overrides });
}

// ─── Tool-definition translation ─────────────────────────────────────

describe('CodexAgentRuntime — tool definition translation', () => {
  test('toolDefinitionsToPiAi preserves name/description/inputSchema', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'echo',
        description: 'Echo the input back.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ];
    const out = toolDefinitionsToPiAi(defs);
    assert.ok(out !== undefined);
    assert.equal(out!.length, 1);
    assert.equal(out![0].name, 'echo');
    assert.equal(out![0].description, 'Echo the input back.');
    // Parameters round-trip the inputSchema verbatim — required fields,
    // additionalProperties, etc. are not rewritten.
    assert.deepEqual(
      out![0].parameters as unknown,
      defs[0].inputSchema,
    );
  });

  test('toolDefinitionsToPiAi returns undefined for empty list', () => {
    assert.equal(toolDefinitionsToPiAi([]), undefined);
    assert.equal(toolDefinitionsToPiAi(undefined), undefined);
  });

  test('toolDefinitionsToPiAi defaults missing description to empty string', () => {
    const out = toolDefinitionsToPiAi([{ name: 'bare' }]);
    assert.equal(out![0].description, '');
    assert.deepEqual(out![0].parameters as unknown, {});
  });

  test('translation does NOT expose secret-bearing tool metadata fields', () => {
    // Slice 2 contract: only name/description/inputSchema cross the
    // wire. The ToolDefinition type doesn't carry server_url, api_key,
    // env, or _transport, but we lock this property structurally by
    // asserting the translated Tool's keys are exactly the three
    // documented ones.
    const out = toolDefinitionsToPiAi([
      { name: 't', description: 'd', inputSchema: { type: 'object' } },
    ]);
    const keys = Object.keys(out![0]).sort();
    assert.deepEqual(keys, ['description', 'name', 'parameters']);
  });
});

// ─── One tool call ───────────────────────────────────────────────────

describe('CodexAgentRuntime — tool loop (single call)', () => {
  test('one tool call → execute → continuation returns text + done(stop)', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    // Iteration 0: model requests one tool call.
    multiCtl.iterations.push([
      { type: 'start', partial: { responseId: 'r1' } },
      doneWithContent([
        { type: 'toolCall', id: 'tc1', name: 'echo', arguments: { text: 'hi' } },
      ], { responseId: 'r1' }),
    ]);
    // Iteration 1: model finalizes with text after seeing the tool result.
    multiCtl.iterations.push([
      { type: 'start', partial: { responseId: 'r2' } },
      { type: 'text_delta', contentIndex: 0, delta: 'Got it.', partial: {} },
      doneWithContent([{ type: 'text', text: 'Got it.' }], { responseId: 'r2' }),
    ]);

    const executeTool = async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, 'echo');
      assert.equal(args.text, 'hi');
      return { ok: true, result: `echoed:${args.text}` };
    };

    const runtime = new CodexAgentRuntime({ executeTool });
    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // Two pi-ai calls (one per iteration).
    assert.equal(multiCtl.calls.length, 2);

    // Expected event sequence: start, session, tool_start, tool_result,
    // text_delta, usage, done(stop).
    const types = events.map((e) => e.type);
    assert.ok(types.includes('tool_start'));
    assert.ok(types.includes('tool_result'));
    assert.ok(types.includes('text_delta'));

    const toolStart = events.find((e) => e.type === 'tool_start');
    if (toolStart?.type === 'tool_start') {
      assert.equal(toolStart.name, 'echo');
      assert.equal(toolStart.id, 'tc1');
    }
    const toolResult = events.find((e) => e.type === 'tool_result');
    if (toolResult?.type === 'tool_result') {
      assert.equal(toolResult.name, 'echo');
      assert.equal(toolResult.id, 'tc1');
      assert.equal(toolResult.isError, false);
      assert.match(String(toolResult.output), /echoed:hi/);
    }
    const done = events.find((e) => e.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'stop');
    }

    assertNoSentinelsLeaked(events);
  });
});

// ─── Multiple tool calls ─────────────────────────────────────────────

describe('CodexAgentRuntime — tool loop (multiple calls per iteration)', () => {
  test('three tool calls dispatched in one chunk; all results reach continuation', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'a', name: 'echo', arguments: { v: 1 } },
        { type: 'toolCall', id: 'b', name: 'echo', arguments: { v: 2 } },
        { type: 'toolCall', id: 'c', name: 'echo', arguments: { v: 3 } },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'done' }]),
    ]);

    const dispatched: string[] = [];
    const executeTool = async (name: string, args: Record<string, unknown>) => {
      dispatched.push(`${name}:${args.v}`);
      return { ok: true, result: `r:${args.v}` };
    };
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'echo', description: 'e', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // All three calls executed.
    assert.equal(dispatched.length, 3);
    assert.ok(dispatched.includes('echo:1'));
    assert.ok(dispatched.includes('echo:2'));
    assert.ok(dispatched.includes('echo:3'));

    // All three tool_result events emitted.
    const toolResultIds = events
      .filter((e): e is Extract<AgentRuntimeEvent, { type: 'tool_result' }> => e.type === 'tool_result')
      .map((e) => e.id);
    assert.deepEqual(toolResultIds.sort(), ['a', 'b', 'c']);

    // Continuation iteration's pi-ai context must include 3 toolResult
    // messages (one per dispatched call) so the protocol invariant
    // holds — without them the next pi-ai call would reject.
    const secondCallCtx = multiCtl.calls[1].context as { messages: unknown[] };
    const toolResultsInCtx = secondCallCtx.messages.filter(
      (m) => (m as { role: string }).role === 'toolResult',
    );
    assert.equal(toolResultsInCtx.length, 3);

    assertNoSentinelsLeaked(events);
  });
});

// ─── MAX_PARALLEL invariant (6 simultaneous → 5 + 1 chunks) ─────────

describe('CodexAgentRuntime — MAX_PARALLEL invariant', () => {
  test('six simultaneous calls dispatch as one chunk of 5 + one chunk of 1', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    // Iteration 0: 6 tool calls.
    const calls = Array.from({ length: 6 }, (_, i) => ({
      type: 'toolCall' as const,
      id: `c${i}`,
      name: 'slow',
      arguments: { i },
    }));
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent(calls),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'done' }]),
    ]);

    // Slow tool — peaks at MAX_PARALLEL=5 in flight if the loop chunks
    // correctly; would peak at 6 if it ran them all at once.
    let inFlight = 0;
    let peakInFlight = 0;
    const dispatchOrder: number[] = [];
    const executeTool = async (_name: string, args: Record<string, unknown>) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      dispatchOrder.push(args.i as number);
      // Microtask yield so all chunk-0 calls actually overlap before
      // any resolve. Without this, JS could synchronously resolve each
      // promise and inFlight would never exceed 1.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, result: `r:${args.i}` };
    };
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'slow', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // The CORE invariant: peak parallelism is exactly 5 — never 6
    // (would mean no chunking) and not 1 (would mean serial). The
    // chunked dispatch pattern: first 5 calls overlap (chunk 0 of 5),
    // then the 6th runs alone (chunk 1 of 1).
    assert.equal(
      peakInFlight,
      5,
      `expected peak in-flight = 5 (MAX_PARALLEL), got ${peakInFlight}`,
    );

    // All 6 calls eventually executed.
    assert.equal(dispatchOrder.length, 6);

    // The first 5 calls (indices 0..4) start before any of the 6th
    // chunk resolves. Verify by checking that the 6th call's index
    // appears AFTER all 5 chunk-0 calls in dispatch order.
    const sixthIndex = dispatchOrder.indexOf(5);
    const firstChunkIndices = dispatchOrder.slice(0, 5);
    assert.ok(
      !firstChunkIndices.includes(5),
      'sixth call (index 5) must not appear in the first 5 dispatches',
    );
    assert.equal(sixthIndex, 5, 'sixth call must be the 6th dispatch');

    // Every call surfaced a tool_result.
    const toolResults = events.filter((e) => e.type === 'tool_result');
    assert.equal(toolResults.length, 6);

    assertNoSentinelsLeaked(events);
  });
});

// ─── Unknown tool ────────────────────────────────────────────────────

describe('CodexAgentRuntime — unknown tool', () => {
  test('unknown tool returns safe error result; runtime continues to finalize', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'u1', name: 'nope', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'sorry' }]),
    ]);

    const executeTool = async (name: string, _args: Record<string, unknown>) => {
      // tools-bridge's executeRouterTool returns this shape for unknown
      // tool names — we mirror it here for parity.
      return { ok: false, result: `Unknown tool: ${name}` };
    };
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'nope', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.ok(toolResult && toolResult.type === 'tool_result');
    if (toolResult?.type === 'tool_result') {
      assert.equal(toolResult.isError, true);
      assert.match(String(toolResult.output), /unknown_tool|Unknown tool/i);
    }
    // Runtime continues to finalize cleanly.
    const done = events.find((e) => e.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'stop');
    }
    assertNoSentinelsLeaked(events);
  });
});

// ─── Tool execution failure (throw) ──────────────────────────────────

describe('CodexAgentRuntime — tool throw', () => {
  test('thrown tool error becomes safe tool_result; no stack/secret leak', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'x1', name: 'boom', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'sorry' }]),
    ]);

    const executeTool = async () => {
      // Include the sentinel in the error to assert it gets sanitized.
      // The runtime maps thrown errors through `safeToolErrorResult`
      // which JSON-envelopes the message. The sentinel WILL appear in
      // the tool_result event (the runtime intentionally passes thrown
      // .message through so the model can adapt) — the operator's spec is that
      // tokens / secrets must not appear; tool-handler-author bugs
      // (leaking their own secrets in error messages) are the handler
      // author's responsibility. So we DO NOT sentinel-check the tool
      // result here; we DO sentinel-check the runtime events for the
      // ACCESS / REFRESH tokens (which the runtime owns).
      throw new Error(`boom from inside the tool ${SENTINEL_TOOL_SECRET}`);
    };
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'boom', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.ok(toolResult && toolResult.type === 'tool_result');
    if (toolResult?.type === 'tool_result') {
      assert.equal(toolResult.isError, true);
      // Output is the structured JSON envelope — no raw stack frames.
      const parsed = JSON.parse(String(toolResult.output));
      assert.equal(parsed.error.code, 'tool_threw');
      // No "at Object.<anonymous>" / "at TestContext" stack frame
      // markers — only the .message propagates.
      assert.ok(!String(toolResult.output).includes(' at '));
    }
    // Runtime's access/refresh tokens never appear.
    assertNoSentinelsLeaked(events);
  });
});

// ─── Max iterations cap ──────────────────────────────────────────────

describe('CodexAgentRuntime — max iterations cap', () => {
  test('repeated tool calls hit MAX_TOOL_ITERATIONS=20 cap; runtime stops with done(length)', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    // Pre-queue 25 iterations all requesting a tool — far more than
    // the 20-iteration cap. After 20 iterations the loop should
    // terminate even though the model is still requesting tools.
    for (let i = 0; i < 25; i++) {
      multiCtl.iterations.push([
        { type: 'start', partial: {} },
        doneWithContent([
          // Vary argument so the repeated-call guard does NOT trip
          // (we want the iteration cap to be the failure mode, not
          // the repeated-call cap).
          { type: 'toolCall', id: `t${i}`, name: 'echo', arguments: { i } },
        ]),
      ]);
    }

    const executeTool = async (_n: string, args: Record<string, unknown>) =>
      ({ ok: true, result: `r:${args.i}` });
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'echo', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // The runtime hit the iteration cap.
    const err = events.find((e) => e.type === 'error');
    assert.ok(err && err.type === 'error');
    if (err?.type === 'error') {
      assert.match(err.message, /tool-loop ceiling|20 iterations/i);
    }
    const done = events.find((e) => e.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'length');
    }
    // Exactly 20 pi-ai calls — the runtime never made the 21st.
    assert.equal(multiCtl.calls.length, 20);

    assertNoSentinelsLeaked(events);
  });
});

// ─── Stuck / repeated-call guard ─────────────────────────────────────

describe('CodexAgentRuntime — repeated-call guard', () => {
  test('two consecutive identical tool-call sets terminate the loop', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    // Iteration 0 and 1 request the EXACT same tool+args set. The
    // second iteration triggers the guard.
    for (let i = 0; i < 2; i++) {
      multiCtl.iterations.push([
        { type: 'start', partial: {} },
        doneWithContent([
          { type: 'toolCall', id: `t${i}`, name: 'echo', arguments: { x: 1 } },
        ]),
      ]);
    }

    const executeTool = async () => ({ ok: true, result: 'r' });
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'echo', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    const err = events.find((e) => e.type === 'error');
    assert.ok(err && err.type === 'error');
    if (err?.type === 'error') {
      assert.match(err.message, /repeated the same tool call|infinite loop/i);
    }
    const done = events.find((e) => e.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'error');
    }
    assertNoSentinelsLeaked(events);
  });
});

// ─── Output budget per turn ──────────────────────────────────────────

describe('CodexAgentRuntime — output budget', () => {
  test('large tool result is truncated to per-result cap (UTF-8 bytes)', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'big', name: 'dump', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'done' }]),
    ]);

    const executeTool = async () => ({
      ok: true,
      result: 'a'.repeat(100_000), // 100KB — exceeds the 50KB per-result cap
    });
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'dump', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    const tr = events.find((e) => e.type === 'tool_result');
    if (tr?.type === 'tool_result') {
      const output = String(tr.output);
      // Per-result cap (50_000 UTF-8 bytes) enforced.
      assert.ok(
        Buffer.byteLength(output, 'utf8') <= 50_000,
        `output bytes=${Buffer.byteLength(output, 'utf8')} > 50000`,
      );
      assert.match(output, /truncated/);
    }
  });

  test('base64-looking payload is byte-counted, not char-counted', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'b64', name: 'enc', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'done' }]),
    ]);

    const executeTool = async () => ({
      ok: true,
      result: 'A'.repeat(200 * 1024), // 200KB ASCII (would-be base64)
    });
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'enc', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    const tr = events.find((e) => e.type === 'tool_result');
    if (tr?.type === 'tool_result') {
      assert.ok(Buffer.byteLength(String(tr.output), 'utf8') <= 50_000);
    }
  });

  test('per-turn cap (200KB) trips and synthesizes skipped results for remaining calls', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    // Five 49KB tool calls = 245KB total, well over the 200KB per-turn
    // cap. After a few succeed the budget should trip and the rest get
    // synthesized as skipped-budget errors so the next pi-ai request
    // stays protocol-valid (every toolCallId needs a matching result).
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'a', name: 'b', arguments: {} },
        { type: 'toolCall', id: 'b', name: 'b', arguments: {} },
        { type: 'toolCall', id: 'c', name: 'b', arguments: {} },
        { type: 'toolCall', id: 'd', name: 'b', arguments: {} },
        { type: 'toolCall', id: 'e', name: 'b', arguments: {} },
      ]),
    ]);
    // No second iteration needed — budget trip ends the turn.

    const executeTool = async () => ({
      ok: true,
      result: 'x'.repeat(49 * 1024), // 49KB (just under the per-result cap)
    });
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'b', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // All 5 tool_result events emitted (some real, some skipped) —
    // protocol invariant: every toolCallId got a matching toolResult.
    const trIds = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e as Extract<AgentRuntimeEvent, { type: 'tool_result' }>).id);
    assert.deepEqual(trIds.sort(), ['a', 'b', 'c', 'd', 'e']);

    // Budget-trip error event surfaced.
    const err = events.find((e) => e.type === 'error');
    assert.ok(err && err.type === 'error');
    if (err?.type === 'error') {
      assert.match(err.message, /budget exceeded/i);
    }
    const done = events.find((e) => e.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'length');
    }
  });
});

// ─── summarize_mcp_config concrete test — REMOVED (SLICE-3a ADAPTATION) ──
// The tag's test here exercised `buildMcpConfigSummary` from tools-bridge.ts.
// Main renamed/reshaped that module into mcp-bridge.ts WITHOUT porting
// buildMcpConfigSummary (the summarize_mcp_config tool is not on main).
// Expected tag-vs-main drift, not a behavioral regression in the codex
// runtime; restore the test when/if the summary tool returns.

// ─── Token / secret redaction across all tool-loop branches ──────────

describe('CodexAgentRuntime — token redaction (tool loop)', () => {
  test('access/refresh sentinels never appear in any tool-loop event', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    // Pre-queue iterations that exercise multiple code paths:
    //   - one successful tool dispatch
    //   - one failure path (tool throws)
    //   - finalization with text
    multiCtl.iterations.push([
      { type: 'start', partial: { responseId: 'r1' } },
      doneWithContent([
        { type: 'toolCall', id: 't1', name: 'ok', arguments: {} },
        { type: 'toolCall', id: 't2', name: 'fail', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: { responseId: 'r2' } },
      { type: 'text_delta', contentIndex: 0, delta: 'final.', partial: {} },
      doneWithContent([{ type: 'text', text: 'final.' }], { responseId: 'r2' }),
    ]);

    const executeTool = async (name: string) => {
      if (name === 'fail') {
        throw new Error('intentional');
      }
      return { ok: true, result: 'ok-result' };
    };
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'ok', description: '', inputSchema: { type: 'object' } },
          { name: 'fail', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // Sentinels NEVER in runtime events.
    assertNoSentinelsLeaked(events);
    // Also verify the Slice 2 tool-secret sentinel.
    const serialized = JSON.stringify(events);
    assert.ok(
      !serialized.includes(SENTINEL_TOOL_SECRET),
      'runtime events leaked tool secret sentinel',
    );

    // Token DID reach pi-ai's options.apiKey (sanity check that we
    // measured the right thing).
    const opts0 = multiCtl.calls[0].options as { apiKey?: string };
    assert.equal(opts0.apiKey, SENTINEL_ACCESS);
  });
});

describe('out-of-scope guard (Slice 1)', () => {
  test('codex module does not import agent.ts, tools-bridge, frontend, or sensitive-paths', async () => {
    const { readFile } = await import('fs/promises');
    const source = await readFile(
      new URL('./codex.ts', import.meta.url),
      'utf8',
    );

    // String-level import guard. The module SHOULD import:
    //   - pi-ai
    //   - ../auth/codex-oauth.js
    //   - @bytelight/shared
    //   - ./types.js
    // It MUST NOT pull these:
    assert.ok(
      !/from\s+['"][^'"]*agent\.js['"]/.test(source) ||
        /import\s+type\s+[^;]*from\s+['"][^'"]*agent\.js['"]/.test(source),
      'codex.ts must not import (non-type) from agent.ts',
    );
    assert.ok(
      !/from\s+['"][^'"]*tools-bridge\.js['"]/.test(source),
      'codex.ts must not import from tools-bridge.ts',
    );
    assert.ok(
      !/from\s+['"][^'"]*sensitive-paths\.js['"]/.test(source),
      'codex.ts must not import from sensitive-paths.ts',
    );
    assert.ok(
      !/from\s+['"][^'"]*frontend[^'"]*['"]/.test(source),
      'codex.ts must not import from frontend',
    );
  });
});

// ─── Slice 2.5: runtime tool bridge wiring ─────────────────────────────
//
// Slice 2 added the tool loop + constructor `executeTool` option, but the
// production `codexRuntime` exported by `runtimes/index.ts` was still
// constructed without a callback wired — so tool calls in production hit
// the `provider_diagnostic` + `done(tool_calls)` fallback.
//
// Slice 2.5 closes that gap: the dispatcher constructs a NEW singleton
// with `executeTool` bound to `tools-bridge.executeRouterTool`, mirroring
// the ApiRouter wiring pattern at runtimes/index.ts:78-98.
//
// These tests prove the dispatcher's wired singleton:
//   1. Has an `executeTool` callback present (no provider_diagnostic).
//   2. Routes tool calls through tools-bridge.executeRouterTool.
//   3. Still completes safely when no tools are configured.
//   4. Does NOT create a parallel registry — bridge is the single source.
//   5. Never leaks Slice 2 sentinels through the wired path.
//
// Test pattern: lazy-import `./index.js` to grab the dispatcher's
// wired singleton via `resolveRuntimeForRef`, then drive it with the
// multi-iteration fake stream the same way Slice 2 tests do.

describe('CodexAgentRuntime — Slice 2.5 dispatcher wiring', () => {
  test('dispatcher singleton has executeTool wired (no provider_diagnostic on tool call)', async () => {
    // The dispatcher's wired callback is `(name, args) =>
    // executeRouterTool(name, args)` — `executeRouterTool` is an ESM
    // import bound at module-load time, so we can't intercept the
    // bridge surface after the fact (ESM exports are read-only).
    // Instead we route the wired path through `executeRouterTool`'s
    // deterministic "unknown tool" branch: a tool name that doesn't
    // exist in any registry returns `{ ok: false, result: 'Unknown
    // tool: <name>' }` (tools-bridge.ts:733). That return shape
    // surviving the loop proves end-to-end wiring without needing
    // tool-registry hydration or a stub.
    writeAuthFile(true);
    installMultiIterationStream();

    const { loadConfig } = await import('../../config.js');
    loadConfig();
    const { resolveRuntimeForRef } = await import('./index.js');

    const packet = resolveRuntimeForRef({
      canonical: 'openai-codex/gpt-5.1',
      provider: 'openai-codex',
      model: 'gpt-5.1',
      runtime: 'codex',
    });

    // A tool name that's guaranteed not to exist in any registry path
    // — both in-process and MCP. The dispatcher's wired bridge will
    // hit the "Unknown tool" branch and return ok:false.
    const unknownToolName = 'codex_slice25_wired_probe_tool';

    // Iteration 0: model requests the unknown probe tool.
    multiCtl.iterations.push([
      { type: 'start', partial: { responseId: 'rA' } },
      doneWithContent([
        { type: 'toolCall', id: 'probe-1', name: unknownToolName, arguments: { x: 7 } },
      ], { responseId: 'rA' }),
    ]);
    // Iteration 1: model finalizes.
    multiCtl.iterations.push([
      { type: 'start', partial: { responseId: 'rB' } },
      doneWithContent([{ type: 'text', text: 'done.' }], { responseId: 'rB' }),
    ]);

    const events = await collect(
      packet.runtime.runTurn(
        buildInputWithTools([
          { name: unknownToolName, description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // The Slice-1 fallback path (provider_diagnostic +
    // finishReason='tool_calls') must NOT fire — that would mean the
    // dispatcher singleton lacked the callback.
    const diag = events.find((e) => e.type === 'provider_diagnostic');
    assert.equal(diag, undefined, 'unexpected provider_diagnostic fired — executeTool not wired');

    // tool_start + tool_result both surfaced — proves the callback ran.
    const toolStart = events.find((e) => e.type === 'tool_start');
    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.ok(toolStart, 'expected tool_start');
    assert.ok(toolResult, 'expected tool_result');

    // The result is the bridge's "Unknown tool" branch — isError true
    // and a JSON envelope (the runtime wraps ok:false bridge returns
    // through `safeToolErrorResult`).
    if (toolResult?.type === 'tool_result') {
      assert.equal(toolResult.isError, true);
      // The output is a JSON envelope; bridge's "Unknown tool: <name>"
      // string is embedded inside the structured error.
      assert.match(
        String(toolResult.output),
        /Unknown tool|tool_error/,
        `expected wired bridge response to flow through, got: ${String(toolResult.output)}`,
      );
    }

    // Continuation completed cleanly — runtime re-entered iteration 1
    // and the model produced text after seeing the tool result.
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'stop');
    }

    assertNoSentinelsLeaked(events);
    const serialized = JSON.stringify(events);
    assert.ok(
      !serialized.includes(SENTINEL_TOOL_SECRET),
      'wired path leaked tool secret sentinel',
    );
  });

  test('end-to-end: dispatcher-wired callback receives (name, args) verbatim', async () => {
    // Pin the callback signature with a synthetic local construction
    // that mirrors the dispatcher's wiring shape: `executeTool:
    // (name, args) => executeRouterTool(name, args)`. The dispatcher
    // uses this exact pattern (verified structurally below in the
    // single-source-of-truth test). Constructing a fresh runtime
    // through the same wiring shape lets us assert (name, args)
    // arrive verbatim at the bridge surface — the same property the
    // production singleton has.
    writeAuthFile(true);
    installMultiIterationStream();

    const { executeRouterTool } = await import('../mcp-bridge.js');  // SLICE-3a ADAPTATION: tag's tools-bridge.ts == main's mcp-bridge.ts

    // Spy that mirrors the dispatcher's wired-callback signature.
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const wiredLikeDispatcher = async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      calls.push({ name, args });
      // Forward to the real bridge to prove the call shape survives
      // the bridge boundary (unknown tool → ok:false structured error).
      return executeRouterTool(name, args);
    };

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'a1', name: 'codex_probe_alpha', arguments: { k: 'v' } },
        { type: 'toolCall', id: 'b1', name: 'codex_probe_beta', arguments: { n: 42 } },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'final.' }]),
    ]);

    const runtime = new CodexAgentRuntime({ executeTool: wiredLikeDispatcher });
    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'codex_probe_alpha', description: '', inputSchema: { type: 'object' } },
          { name: 'codex_probe_beta', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // Both calls reached the bridge with exact (name, args) — proves
    // the constructor-callback contract.
    assert.equal(calls.length, 2);
    const byName = new Map(calls.map((c) => [c.name, c.args]));
    assert.deepEqual(byName.get('codex_probe_alpha'), { k: 'v' });
    assert.deepEqual(byName.get('codex_probe_beta'), { n: 42 });

    // Bridge returned ok:false for both — runtime emits tool_result
    // events with isError=true and continues to the finalization
    // iteration. Provider continuation completes normally.
    const toolResults = events.filter(
      (e): e is Extract<AgentRuntimeEvent, { type: 'tool_result' }> =>
        e.type === 'tool_result',
    );
    assert.equal(toolResults.length, 2);
    for (const tr of toolResults) {
      assert.equal(tr.isError, true);
    }

    const done = events.find((e) => e.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'stop');
    }
  });

  test('no-tool path: dispatcher singleton completes safely with no tools configured', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    const { loadConfig } = await import('../../config.js');
    loadConfig();
    const { resolveRuntimeForRef } = await import('./index.js');
    const packet = resolveRuntimeForRef({
      canonical: 'openai-codex/gpt-5.1',
      provider: 'openai-codex',
      model: 'gpt-5.1',
      runtime: 'codex',
    });

    // Single iteration: pure text reply, no tool calls. The runtime
    // takes the no-tool path (input.tools undefined → context.tools
    // unset → no toolCall content blocks in the final message).
    multiCtl.iterations.push([
      { type: 'start', partial: { responseId: 'rN' } },
      { type: 'text_delta', contentIndex: 0, delta: 'hi', partial: {} },
      doneWithContent([{ type: 'text', text: 'hi' }], { responseId: 'rN' }),
    ]);

    // buildInput() — no `tools` field, so the no-tool path engages.
    const events = await collect(packet.runtime.runTurn(buildInput()));

    // Clean finish, no diagnostic, no error, no tool events.
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'stop');
    }
    assert.equal(events.find((e) => e.type === 'provider_diagnostic'), undefined);
    assert.equal(events.find((e) => e.type === 'error'), undefined);
    assert.equal(events.find((e) => e.type === 'tool_start'), undefined);
    assert.equal(events.find((e) => e.type === 'tool_result'), undefined);

    assertNoSentinelsLeaked(events);
  });

  test('single source of truth: dispatcher wires getRouterTools (no parallel registry)', async () => {
    // Slice 2.5 contract: the dispatcher imports `executeRouterTool` and
    // `getRouterTools` from the SAME tools-bridge module the rest of
    // byte-light uses (ApiRouter, AgentService warm-up). There is no
    // duplicate tool registry, no per-runtime registry, no reference implementation
    // `tools/registry` port.
    //
    // We assert this structurally by reading the dispatcher source
    // and confirming:
    //   - exactly one import line references tools-bridge
    //   - it pulls the canonical names (`executeRouterTool`,
    //     `getRouterTools`)
    //   - no imports from `tools/registry` or a parallel registry
    const { readFile } = await import('fs/promises');
    const source = await readFile(
      new URL('./index.js', import.meta.url).pathname.replace(/\.js$/, '.ts'),
      'utf8',
    );

    const bridgeImports = source.match(
      /import\s+\{[^}]*\}\s+from\s+['"][^'"]*(?:tools|mcp)-bridge[^'"]*['"]/g,  // SLICE-3a ADAPTATION: main renamed tools-bridge → mcp-bridge
    );
    assert.ok(bridgeImports, 'dispatcher must import from tools-bridge');
    assert.equal(
      bridgeImports.length,
      1,
      'dispatcher must import from tools-bridge exactly once (single source)',
    );
    // executeForeignLaneTool is the bridge's entry for lanes that carry
    // their own tool list: .mcp.json tools first, then executeRouterTool.
    // Still one bridge, one registry.
    assert.match(
      bridgeImports[0],
      /executeForeignLaneTool/,
      'dispatcher must import executeForeignLaneTool from tools-bridge',
    );

    // No reference implementation-style parallel registry import.
    assert.ok(
      !/from\s+['"][^'"]*tools\/registry[^'"]*['"]/.test(source),
      'dispatcher must not import a reference implementation-style tools/registry',
    );

    // Dispatcher constructs the Codex runtime with the bridge callback
    // (the literal `executeTool:` keyword paired with `executeRouterTool`
    // — same wiring shape as the ApiRouter site above).
    assert.match(
      source,
      /new\s+CodexAgentRuntime\s*\(\s*\{[\s\S]*executeTool\s*:[\s\S]*executeForeignLaneTool[\s\S]*\}/,
      'dispatcher must construct CodexAgentRuntime with executeTool wired to executeForeignLaneTool',
    );
  });

  test('Slice 2 sentinels never leak through dispatcher-wired path', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    // Same pattern as the first wiring test: route through the
    // dispatcher's singleton with an unknown tool name. The wired
    // bridge returns ok:false; the runtime envelopes it through
    // safeToolErrorResult. Then verify Slice 2's three sentinels
    // never appear in any event the wired path emits.
    const { loadConfig } = await import('../../config.js');
    loadConfig();
    const { resolveRuntimeForRef } = await import('./index.js');
    const packet = resolveRuntimeForRef({
      canonical: 'openai-codex/gpt-5.1',
      provider: 'openai-codex',
      model: 'gpt-5.1',
      runtime: 'codex',
    });

    multiCtl.iterations.push([
      { type: 'start', partial: { responseId: 'rS' } },
      doneWithContent([
        { type: 'toolCall', id: 's1', name: 'codex_sentinel_probe_safe', arguments: {} },
      ], { responseId: 'rS' }),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'ok.' }]),
    ]);

    const events = await collect(
      packet.runtime.runTurn(
        buildInputWithTools([
          { name: 'codex_sentinel_probe_safe', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // None of the three Slice 2 sentinels (access / refresh / tool
    // secret) appear anywhere in the wired event stream.
    const serialized = JSON.stringify(events);
    assert.ok(
      !serialized.includes(SENTINEL_ACCESS),
      'wired path leaked SENTINEL_ACCESS',
    );
    assert.ok(
      !serialized.includes(SENTINEL_REFRESH),
      'wired path leaked SENTINEL_REFRESH',
    );
    assert.ok(
      !serialized.includes(SENTINEL_TOOL_SECRET),
      'wired path leaked SENTINEL_TOOL_SECRET',
    );

    // Token DID reach pi-ai (sanity — wired path didn't break auth).
    const opts0 = multiCtl.calls[0].options as { apiKey?: string };
    assert.equal(opts0.apiKey, SENTINEL_ACCESS);
  });
});

// ─── Slice 3: images in turns and tool results ───────────────────────────
//
// Surfaces under test:
//   - User-image input via `NormalizedMessage.images` lands as pi-ai
//     `ImageContent` blocks in the user message's `content` array.
//   - Multi-image / multipart text+image preserves order.
//   - Malformed user images surface `image_conversion_failed`
//     diagnostics WITHOUT taking down the turn.
//   - Tool results carrying JSON-wrapped MCP images get extracted:
//     `function_call_output` stays text-only, and a follow-up user
//     message carries the image blocks. Order is preserved.
//   - Base64 / data URIs are detected and isolated from text payloads.
//   - The image-base64 sentinel never appears in serialized events.
//
// Sentinel: SENTINEL_IMAGE_B64 is the base64-encoding of the literal
// 'TEST_IMAGE_BASE64_DO_NOT_LEAK_000'. Padded to >= 256 chars so it
// passes the image-detection threshold. Any test that DOES extract an
// image will see this string in the pi-ai context payload (that's the
// point — pi-ai needs the bytes); the assertion is that the same
// string NEVER appears in the runtime's emitted events.

const SENTINEL_IMAGE_B64 = 'TUVTVF9JTUFHRV9CQVNFNjRfRE9fTk9UX0xFQUtfMDAw';

function bigImagePayload(): string {
  const seed = SENTINEL_IMAGE_B64.replace(/=+$/, '');
  let payload = '';
  while (payload.length < 300) payload += seed;
  return payload;
}

function assertImageSentinelAbsent(events: AgentRuntimeEvent[]): void {
  const serialized = JSON.stringify(events);
  assert.ok(
    !serialized.includes(SENTINEL_IMAGE_B64),
    'runtime events leaked image base64 sentinel',
  );
}

describe('CodexAgentRuntime — user image input (Slice 3)', () => {
  test('user image block maps to Codex/pi-ai image input', async () => {
    writeAuthFile(true);
    const data = bigImagePayload();
    streamControl.events = [
      { type: 'start', partial: {} },
      {
        type: 'done',
        reason: 'stop',
        message: {
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    ];

    const events = await collect(
      codexRuntime.runTurn(
        buildInput({
          messages: [
            {
              role: 'user',
              content: 'Look at this',
              createdAt: new Date().toISOString(),
              images: [{ base64: data, mimeType: 'image/png' }],
            },
          ],
        }),
      ),
    );

    // The user message in the pi-ai context should be multipart:
    // [text, image]. pi-ai's ImageContent shape is
    // { type: 'image', data, mimeType }.
    const ctx = streamControl.calls[0].context as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMsg = ctx.messages.find((m) => m.role === 'user');
    assert.ok(userMsg, 'expected a user message in pi-ai context');
    assert.ok(Array.isArray(userMsg!.content));
    const content = userMsg!.content as Array<{ type: string; data?: string; mimeType?: string }>;
    const imageBlock = content.find((c) => c.type === 'image');
    assert.ok(imageBlock, 'expected an image block in user content');
    assert.equal(imageBlock!.mimeType, 'image/png');
    assert.equal(imageBlock!.data, data);

    // Sentinel hygiene — events never carry the raw image base64.
    assertImageSentinelAbsent(events);
    assertNoSentinelsLeaked(events);
  });

  test('text + image multipart turn preserves both', async () => {
    writeAuthFile(true);
    streamControl.events = [
      { type: 'start', partial: {} },
      {
        type: 'done',
        reason: 'stop',
        message: {
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    ];

    await collect(
      codexRuntime.runTurn(
        buildInput({
          messages: [
            {
              role: 'user',
              content: 'Captioned text',
              createdAt: new Date().toISOString(),
              images: [{ base64: bigImagePayload(), mimeType: 'image/png' }],
            },
          ],
        }),
      ),
    );

    const ctx = streamControl.calls[0].context as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMsg = ctx.messages.find((m) => m.role === 'user');
    const content = userMsg!.content as Array<{ type: string; text?: string }>;
    const textBlock = content.find((c) => c.type === 'text');
    assert.ok(textBlock);
    assert.equal(textBlock!.text, 'Captioned text');
    assert.ok(content.find((c) => c.type === 'image'));
  });

  test('multiple user images preserve order', async () => {
    writeAuthFile(true);
    streamControl.events = [
      { type: 'start', partial: {} },
      {
        type: 'done',
        reason: 'stop',
        message: {
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    ];

    const a = bigImagePayload() + 'AAAA';
    const b = bigImagePayload() + 'BBBB';
    const c = bigImagePayload() + 'CCCC';

    await collect(
      codexRuntime.runTurn(
        buildInput({
          messages: [
            {
              role: 'user',
              content: 'Three images',
              createdAt: new Date().toISOString(),
              images: [
                { base64: a, mimeType: 'image/png' },
                { base64: b, mimeType: 'image/jpeg' },
                { base64: c, mimeType: 'image/webp' },
              ],
            },
          ],
        }),
      ),
    );

    const ctx = streamControl.calls[0].context as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMsg = ctx.messages.find((m) => m.role === 'user');
    const content = userMsg!.content as Array<{ type: string; data?: string }>;
    const imageDatas = content
      .filter((c) => c.type === 'image')
      .map((c) => c.data);
    assert.deepEqual(imageDatas, [a, b, c]);
  });

  test('malformed user image emits image_conversion_failed diagnostic and drops the image', async () => {
    writeAuthFile(true);
    streamControl.events = [
      { type: 'start', partial: {} },
      {
        type: 'done',
        reason: 'stop',
        message: {
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    ];

    const good = bigImagePayload();
    const events = await collect(
      codexRuntime.runTurn(
        buildInput({
          messages: [
            {
              role: 'user',
              content: 'Mixed: good + bad images',
              createdAt: new Date().toISOString(),
              images: [
                // 1. Empty base64
                { base64: '', mimeType: 'image/png' } as unknown as NonNullable<
                  AgentTurnInput['messages'][number]['images']
                >[number],
                // 2. Missing/invalid mime
                { base64: good, mimeType: 'text/plain' } as unknown as NonNullable<
                  AgentTurnInput['messages'][number]['images']
                >[number],
                // 3. Good — should land.
                { base64: good, mimeType: 'image/png' },
              ],
            },
          ],
        }),
      ),
    );

    const diagnostics = events.filter(
      (e): e is Extract<AgentRuntimeEvent, { type: 'provider_diagnostic' }> =>
        e.type === 'provider_diagnostic',
    );
    const imageDiagnostics = diagnostics.filter(
      (d) => d.code === 'image_conversion_failed',
    );
    assert.equal(
      imageDiagnostics.length,
      2,
      'expected one diagnostic per malformed image',
    );

    // The good image still made it through.
    const ctx = streamControl.calls[0].context as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMsg = ctx.messages.find((m) => m.role === 'user');
    const content = userMsg!.content as Array<{ type: string; data?: string }>;
    const images = content.filter((c) => c.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].data, good);

    // Diagnostics MUST NOT include raw base64 in their `data` payload.
    for (const d of imageDiagnostics) {
      const serialized = JSON.stringify(d);
      // The good image's base64 sentinel must not surface; only the
      // marker shape.
      assert.ok(!serialized.includes(SENTINEL_IMAGE_B64));
    }
    assertImageSentinelAbsent(events);
    assertNoSentinelsLeaked(events);
  });

  test('no images on user message → no multipart conversion, no diagnostic', async () => {
    // Regression guard: the Slice 3 validation step MUST be a no-op
    // when no images are present (preserves Slice 1 behavior).
    writeAuthFile(true);
    streamControl.events = [
      { type: 'start', partial: {} },
      {
        type: 'done',
        reason: 'stop',
        message: {
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    ];

    const events = await collect(codexRuntime.runTurn(buildInput()));

    const diagnostics = events.filter((e) => e.type === 'provider_diagnostic');
    assert.equal(diagnostics.length, 0);

    const ctx = streamControl.calls[0].context as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMsg = ctx.messages.find((m) => m.role === 'user');
    // No images → content is a plain string (Slice 1 shape).
    assert.equal(typeof userMsg!.content, 'string');
  });
});

describe('CodexAgentRuntime — tool-result image extraction (Slice 3)', () => {
  test('JSON-wrapped MCP image is extracted into a follow-up user message', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    const imageData = bigImagePayload();
    const mcpToolResult = JSON.stringify({
      type: 'image',
      data: imageData,
      mimeType: 'image/png',
    });

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'screenshot-1', name: 'screenshot', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'Got it.' }]),
    ]);

    const executeTool = async () => ({ ok: true, result: mcpToolResult });
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'screenshot', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // Second pi-ai call's context: should have:
    //   - assistant message with toolCall (appended in (loop) step)
    //   - toolResult message — content text-only, NO image in content
    //   - follow-up user message with image content blocks
    const secondCtx = multiCtl.calls[1].context as {
      messages: Array<{ role: string; content: unknown; toolCallId?: string }>;
    };
    const toolResultMsg = secondCtx.messages.find(
      (m) => m.role === 'toolResult',
    );
    assert.ok(toolResultMsg, 'expected a toolResult message in context');
    const trContent = toolResultMsg!.content as Array<{ type: string }>;
    // function_call_output is text-only — no image block here.
    assert.ok(
      trContent.every((c) => c.type === 'text'),
      'toolResult content must stay text-only (function_call_output safety)',
    );

    // Find the follow-up user message (after the toolResult).
    const toolResultIdx = secondCtx.messages.indexOf(toolResultMsg!);
    const followUp = secondCtx.messages
      .slice(toolResultIdx + 1)
      .find((m) => m.role === 'user');
    assert.ok(followUp, 'expected a follow-up user message carrying images');
    const followContent = followUp!.content as Array<{ type: string; data?: string; mimeType?: string }>;
    const followImg = followContent.find((c) => c.type === 'image');
    assert.ok(followImg, 'expected an image block in the follow-up user message');
    assert.equal(followImg!.mimeType, 'image/png');
    assert.equal(followImg!.data, imageData);

    // Runtime events: tool_result output is TEXT — no raw base64.
    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.ok(toolResult && toolResult.type === 'tool_result');

    // The original tool result the runtime received DOES contain the
    // sentinel (it's in `result` from executeTool). The runtime
    // surfaces that raw output back to the consumer via the
    // tool_result event for downstream logging/display — and the
    // raw output budget caps it. Spec exception: the consumer-facing
    // tool_result.output is the SAME raw string the tool produced;
    // the event-stream sentinel guard only excludes auth tokens and
    // the runtime's own internal state, NOT inputs that the tool
    // chose to emit. Image base64 follows the same rule for the
    // tool_result event specifically, but the safety guarantee is
    // that downstream pi-ai context (function_call_output text) is
    // image-stripped. Validate that:
    if (toolResult?.type === 'tool_result') {
      // The toolResult message inside the NEXT pi-ai context must be
      // text-only — no raw base64 surfaces in function_call_output.
      const trCtxBlock = (toolResultMsg!.content as Array<{ type: string; text?: string }>)[0];
      assert.equal(trCtxBlock.type, 'text');
      // The text in function_call_output MUST NOT include the raw
      // image base64 (which is the actual Slice 3 contract).
      assert.ok(
        !String(trCtxBlock.text).includes(SENTINEL_IMAGE_B64),
        'function_call_output text leaked image base64',
      );
    }

    assertNoSentinelsLeaked(events);
  });

  test('mixed text + image MCP content array: text in function_call_output, image follow-up', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    const imageData = bigImagePayload();
    const mcpToolResult = JSON.stringify([
      { type: 'text', text: 'Diagram of the workflow.' },
      { type: 'image', data: imageData, mimeType: 'image/png' },
    ]);

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'diag-1', name: 'diagram', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'Got it.' }]),
    ]);

    const executeTool = async () => ({ ok: true, result: mcpToolResult });
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'diagram', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    const secondCtx = multiCtl.calls[1].context as {
      messages: Array<{ role: string; content: unknown; toolCallId?: string }>;
    };
    const toolResultMsg = secondCtx.messages.find((m) => m.role === 'toolResult');
    const trContent = toolResultMsg!.content as Array<{ type: string; text?: string }>;
    // Useful text summary preserved — NOT replaced by '(image returned)'.
    assert.match(String(trContent[0].text), /Diagram of the workflow/);
    // function_call_output text MUST NOT contain image base64.
    assert.ok(!String(trContent[0].text).includes(SENTINEL_IMAGE_B64));

    // Follow-up user message has the image.
    const followUp = secondCtx.messages
      .slice(secondCtx.messages.indexOf(toolResultMsg!) + 1)
      .find((m) => m.role === 'user');
    assert.ok(followUp);
    const followContent = followUp!.content as Array<{ type: string }>;
    assert.ok(followContent.some((c) => c.type === 'image'));

    assertNoSentinelsLeaked(events);
  });

  test('multiple extracted images preserve order in follow-up user message', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    const a = bigImagePayload() + 'AAAA';
    const b = bigImagePayload() + 'BBBB';
    const c = bigImagePayload() + 'CCCC';
    const mcpToolResult = JSON.stringify([
      { type: 'image', data: a, mimeType: 'image/png' },
      { type: 'image', data: b, mimeType: 'image/jpeg' },
      { type: 'image', data: c, mimeType: 'image/webp' },
    ]);

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'gallery-1', name: 'gallery', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'Reviewed.' }]),
    ]);

    const executeTool = async () => ({ ok: true, result: mcpToolResult });
    const runtime = new CodexAgentRuntime({ executeTool });

    await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'gallery', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    const secondCtx = multiCtl.calls[1].context as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const followUp = secondCtx.messages.reverse().find((m) => m.role === 'user');
    const followContent = followUp!.content as Array<{ type: string; data?: string }>;
    const datas = followContent
      .filter((cc) => cc.type === 'image')
      .map((cc) => cc.data);
    assert.deepEqual(datas, [a, b, c]);
  });

  test('error tool result is NOT image-extracted (no follow-up user message)', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 't-err', name: 'flaky', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'sorry' }]),
    ]);

    const executeTool = async () => ({ ok: false, result: 'tool blew up' });
    const runtime = new CodexAgentRuntime({ executeTool });

    await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'flaky', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // Second pi-ai context: a toolResult exists, but NO follow-up user
    // message (errors aren't image-extracted).
    const secondCtx = multiCtl.calls[1].context as {
      messages: Array<{ role: string }>;
    };
    const toolResultIdx = secondCtx.messages.findIndex(
      (m) => m.role === 'toolResult',
    );
    assert.ok(toolResultIdx >= 0);
    const after = secondCtx.messages.slice(toolResultIdx + 1);
    const hasFollowUp = after.some((m) => m.role === 'user');
    assert.equal(hasFollowUp, false, 'error tool result must not inject follow-up user message');
  });

  test('plain-text tool result yields no follow-up user message; function_call_output preserves text', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 't1', name: 'echo', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'ok' }]),
    ]);

    const plainResult = 'just plain text from the tool';
    const executeTool = async () => ({ ok: true, result: plainResult });
    const runtime = new CodexAgentRuntime({ executeTool });

    await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'echo', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    const secondCtx = multiCtl.calls[1].context as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolResultMsg = secondCtx.messages.find((m) => m.role === 'toolResult');
    const trContent = toolResultMsg!.content as Array<{ type: string; text?: string }>;
    assert.equal(trContent[0].type, 'text');
    assert.equal(trContent[0].text, plainResult);

    // No follow-up user message.
    const toolResultIdx = secondCtx.messages.indexOf(toolResultMsg!);
    const after = secondCtx.messages.slice(toolResultIdx + 1);
    assert.ok(!after.some((m) => m.role === 'user'));
  });

  test('data URI in plain-text tool result is extracted to follow-up user message', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    const imageData = bigImagePayload();
    const plainWithDataUri =
      `Here is the chart: data:image/png;base64,${imageData} (end of result)`;

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'chart-1', name: 'chart', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'reviewed' }]),
    ]);

    const executeTool = async () => ({ ok: true, result: plainWithDataUri });
    const runtime = new CodexAgentRuntime({ executeTool });

    await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'chart', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    const secondCtx = multiCtl.calls[1].context as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // Follow-up user message has the image block.
    const followUp = secondCtx.messages.reverse().find((m) => m.role === 'user');
    const followContent = followUp!.content as Array<{ type: string; data?: string }>;
    const img = followContent.find((c) => c.type === 'image');
    assert.ok(img);
    assert.equal(img!.data, imageData);

    // function_call_output text must NOT contain the raw base64.
    secondCtx.messages.reverse(); // restore order
    const toolResultMsg = secondCtx.messages.find((m) => m.role === 'toolResult');
    const trContent = toolResultMsg!.content as Array<{ type: string; text?: string }>;
    assert.ok(!String(trContent[0].text).includes(SENTINEL_IMAGE_B64));
  });

  test('image-base64 sentinel never appears in serialized runtime events', async () => {
    // Slice 3 contract: even when the tool returns an image whose
    // base64 content IS the sentinel, the emitted event stream is
    // image-base64-free. The base64 goes into the pi-ai context
    // (function_call_output text was stripped of it, but the
    // follow-up user-message content carries it for the provider).
    // The runtime's OWN event stream MUST NOT carry raw base64 in
    // any text-bearing event (provider_diagnostic, error, etc.) —
    // tool_result.output is the one exception (it's the upstream's
    // raw output by contract — see tool-throw test for the same
    // pattern with tool secrets). We test the strict guard for
    // diagnostic / error / text_delta paths here.
    writeAuthFile(true);
    installMultiIterationStream();

    const mcpToolResult = JSON.stringify({
      type: 'image',
      data: bigImagePayload(),
      mimeType: 'image/png',
    });
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 's1', name: 'screenshot', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'ok' }]),
    ]);

    const executeTool = async () => ({ ok: true, result: mcpToolResult });
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools([
          { name: 'screenshot', description: '', inputSchema: { type: 'object' } },
        ]),
      ),
    );

    // Strict path-by-path guard: every event EXCEPT tool_result.output
    // must be base64-sentinel-free.
    for (const ev of events) {
      if (ev.type === 'tool_result') continue;
      const serialized = JSON.stringify(ev);
      assert.ok(
        !serialized.includes(SENTINEL_IMAGE_B64),
        `event type=${ev.type} leaked image base64 sentinel`,
      );
    }
    assertNoSentinelsLeaked(events);
  });

  test('Slice 3 token sentinels (access/refresh/tool) never appear in image paths', async () => {
    writeAuthFile(true);
    installMultiIterationStream();

    // Drive an image-extraction + diagnostic + follow-up path that
    // exercises EVERY new code path Slice 3 introduces.
    const imageData = bigImagePayload();
    const mcpToolResult = JSON.stringify([
      { type: 'text', text: 'diagram' },
      { type: 'image', data: imageData, mimeType: 'image/png' },
    ]);

    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([
        { type: 'toolCall', id: 'img1', name: 'diagram', arguments: {} },
      ]),
    ]);
    multiCtl.iterations.push([
      { type: 'start', partial: {} },
      doneWithContent([{ type: 'text', text: 'done' }]),
    ]);

    const executeTool = async () => ({ ok: true, result: mcpToolResult });
    const runtime = new CodexAgentRuntime({ executeTool });

    const events = await collect(
      runtime.runTurn(
        buildInputWithTools(
          [{ name: 'diagram', description: '', inputSchema: { type: 'object' } }],
          {
            messages: [
              {
                role: 'user',
                content: 'Draw it',
                createdAt: new Date().toISOString(),
                images: [
                  // One good image, one malformed → exercises validator.
                  { base64: imageData, mimeType: 'image/png' },
                  { base64: '', mimeType: 'image/jpeg' } as unknown as NonNullable<
                    AgentTurnInput['messages'][number]['images']
                  >[number],
                ],
              },
            ],
          },
        ),
      ),
    );

    // Auth + tool-secret sentinels MUST NOT appear anywhere.
    assertNoSentinelsLeaked(events);
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(SENTINEL_TOOL_SECRET));
  });
});

// ─── Slice 4.5: unsupported-model guard ─────────────────────────────────
//
// Slice 4's live smoke harness uncovered a runtime hole:
// `providers.getModel('openai-codex', unknownId)` returns `undefined`
// (it does NOT throw), the `as unknown as Model<...>` cast hid the gap,
// and pi-ai then crashed inside its streamer with a raw
// `TypeError: Cannot read properties of undefined (reading 'provider')`.
// The fix in `codex.ts` adds an explicit `if (!model)` guard that emits
// a `provider_diagnostic { code: 'unsupported_model' }` and a clean
// `done(error)` instead of letting the undefined model reach the pi-ai
// stream call. This test pins that contract.

describe('CodexAgentRuntime — unsupported model guard (Slice 4.5)', () => {
  test('runTurn emits unsupported_model diagnostic when getModel returns undefined', async () => {
    writeAuthFile(true);

    // Override the per-test getModel fake to return undefined for the
    // sentinel id (matches pi-ai's real behavior when the id isn't in
    // the generated provider registry — it silently returns undefined
    // rather than throwing).
    __TEST_PROVIDERS__.getModel = ((provider: string, modelId: string) => {
      if (provider !== 'openai-codex') {
        throw new Error(`fakeGetModel: unknown provider ${provider}`);
      }
      if (modelId === 'nonexistent-model-for-test-do-not-register') {
        return undefined;
      }
      return fakeGetModel(provider, modelId);
    }) as unknown as typeof __TEST_PROVIDERS__.getModel;

    const events = await collect(
      codexRuntime.runTurn(
        buildInput({
          modelRef: {
            canonical:
              'openai-codex/nonexistent-model-for-test-do-not-register',
            provider: 'openai-codex',
            model: 'nonexistent-model-for-test-do-not-register',
            runtime: 'codex',
          },
        }),
      ),
    );

    // Locked event sequence: start → provider_diagnostic → done.
    const types = events.map((e) => e.type);
    assert.deepEqual(
      types,
      ['start', 'provider_diagnostic', 'done'],
      `unexpected event sequence: ${JSON.stringify(types)}`,
    );

    // No text/tool/image events at all on this path.
    assert.equal(
      events.find((e) => e.type === 'text_delta'),
      undefined,
    );
    assert.equal(
      events.find((e) => e.type === 'tool_start'),
      undefined,
    );

    // Diagnostic shape (the operator's lock — code must be exactly 'unsupported_model').
    const diag = events.find((e) => e.type === 'provider_diagnostic');
    assert.ok(diag && diag.type === 'provider_diagnostic');
    if (diag?.type === 'provider_diagnostic') {
      assert.equal(diag.code, 'unsupported_model');
      const data = diag.data as {
        requested_model?: unknown;
        requested_runtime?: unknown;
      };
      assert.equal(
        data.requested_model,
        'nonexistent-model-for-test-do-not-register',
      );
      assert.equal(data.requested_runtime, 'codex');
      // Message is user-safe (no token / no path / no internals).
      assert.match(diag.message, /Codex model/);
      assert.match(diag.message, /not available/i);
    }

    // done.finishReason === 'error'.
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    if (done?.type === 'done') {
      assert.equal(done.finishReason, 'error');
    }

    // pi-ai's streamer must NOT be invoked when the model is unsupported.
    assert.equal(
      streamControl.calls.length,
      0,
      'streamOpenAICodexResponses was called despite unsupported model',
    );

    // The four standard sentinels must NOT appear anywhere in the
    // emitted event payload (token hygiene).
    const serialized = JSON.stringify(events);
    assert.ok(
      !serialized.includes(SENTINEL_ACCESS),
      'unsupported-model diagnostic leaked access-token sentinel',
    );
    assert.ok(
      !serialized.includes(SENTINEL_REFRESH),
      'unsupported-model diagnostic leaked refresh-token sentinel',
    );
    assert.ok(
      !serialized.includes('TEST_CODEX_TOOL_SECRET_DO_NOT_LEAK_789'),
      'unsupported-model diagnostic leaked tool-secret sentinel',
    );
    assert.ok(
      !serialized.includes('TUVTVF9JTUFHRV9CQVNFNjRfRE9fTk9UX0xFQUtfMDAw'),
      'unsupported-model diagnostic leaked image-base64 sentinel',
    );
  });
});
