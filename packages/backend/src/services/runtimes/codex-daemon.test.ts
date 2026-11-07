/**
 * Tests for InteractiveCodexRuntime (the H2 warm codex-cli daemon lane) —
 * reference implementation runtime-foundation Slices 0–2.
 *
 * Slice 0 pins the observable contract of `runTurn` that Slices 1 (live
 * activity) and 2 (rearm/continuity/interrupt/dispose) must preserve:
 *   - event sequence: start → (session) → text_delta(final) → done{stop}
 *   - final_answer phase preferred; last non-empty agentMessage fallback
 *   - warm thread reuse (no second thread/start, no second session event)
 *   - stale-thread recovery with history injection
 *   - abort → done{aborted}; timeout → error + done{error}
 *   - supervisor / connect failures → single normalized error event
 *   - exactly one terminal event (done XOR error-without-done) per turn
 *
 * Test seam — byte-light convention (`__TEST_OVERRIDES__` + reset fn,
 * mirroring codex.test.ts): the Unix-socket daemon connection and the
 * daemon supervisor are substituted with scripted fakes; no daemon
 * binary, socket, or subprocess is touched.
 *
 * Run with:
 *   npx tsx --test packages/backend/src/services/runtimes/codex-daemon.test.ts
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexRecoveryHistory,
  InteractiveCodexRuntime,
  CODEX_CLI_CAPABILITIES,
  __TEST_OVERRIDES__,
  _resetDaemonTestOverrides,
  type CodexDaemonConnectionLike,
  type CodexDaemonRuntimeOptions,
} from './codex-daemon.js';
import type { AgentRuntimeEvent, AgentTurnInput } from './types.js';
// A limit notification can set the Codex brake; lift it between tests.
import { releaseCodexHold } from '../codex-breaker.js';

// ─── Fake daemon connection ─────────────────────────────────────────────

type NotificationHandler = (method: string, params: any) => void;

interface SentRequest {
  method: string;
  params: any;
  timeout?: number;
}

/**
 * Scripted stand-in for CodexDaemonConnection. `respond` maps a JSON-RPC
 * method to its response envelope ({ result } / { error }); `sent` records
 * every request for assertion; `notify` drives the notification channel
 * exactly like frames arriving on the socket would.
 */
class FakeDaemonConnection implements CodexDaemonConnectionLike {
  sent: SentRequest[] = [];
  handlers: NotificationHandler[] = [];
  closed = 0;
  connectError: Error | null = null;
  respond: (method: string, params: any) => any = () => ({ result: {} });

  private current: NotificationHandler | null = null;

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
  }

  async send(method: string, params: any, timeout?: number): Promise<any> {
    this.sent.push({ method, params, timeout });
    return this.respond(method, params);
  }

  onNotification(handler: NotificationHandler): void {
    this.handlers.push(handler);
    this.current = handler;
  }

  notify(method: string, params: any): void {
    this.current?.(method, params);
  }

  close(): void {
    this.closed++;
    this.current = null;
  }

  calls(method: string): SentRequest[] {
    return this.sent.filter((s) => s.method === method);
  }
}

/** Default happy-path script: initialize / thread/start / turn/start OK. */
function scriptHappyDaemon(conn: FakeDaemonConnection, opts: {
  threadId?: string;
  /** thread/read responses, consumed FIFO; last one repeats. */
  reads: any[];
} = { reads: [] }): void {
  const threadId = opts.threadId ?? 'daemon-thread-1';
  let readIdx = 0;
  conn.respond = (method) => {
    switch (method) {
      case 'initialize':
        return { result: { userAgent: 'codex-fake' } };
      case 'thread/start':
        return { result: { thread: { id: threadId } } };
      case 'turn/start':
        return { result: { turn: { id: 'turn-1' } } };
      case 'thread/read': {
        const reads = opts.reads;
        const r = reads[Math.min(readIdx, reads.length - 1)];
        readIdx++;
        return r ?? { result: { thread: { turns: [] } } };
      }
      default:
        return { result: {} };
    }
  };
}

function readInProgress(): any {
  return { result: { thread: { turns: [{ status: 'inProgress', items: [] }] } } };
}

function readCompleted(items: any[]): any {
  return { result: { thread: { turns: [{ status: 'completed', items }] } } };
}

// ─── Input builder / event collector ────────────────────────────────────

function buildInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    thread: { id: 'bl-thread-1', name: 'Test Thread', type: 'named', current_session_id: null },
    tier: 'interactive',
    modelRef: {
      canonical: 'codex-cli/gpt-5.2-codex',
      provider: 'codex-cli',
      model: 'gpt-5.2-codex',
      runtime: 'codex-cli',
    } as AgentTurnInput['modelRef'],
    platform: 'web',
    isAutonomous: false,
    orientation: 'Test orientation block.',
    systemPrompt: { kind: 'text', value: 'You are a test assistant.' },
    messages: [
      { role: 'user', content: 'Hello, Codex daemon.', createdAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

async function collect(iter: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const out: AgentRuntimeEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function types(events: AgentRuntimeEvent[]): string[] {
  return events.map((e) => e.type);
}

/** Contract: exactly one terminal — a single `done`, or a single `error` with no `done` after it. */
function assertSingleTerminal(events: AgentRuntimeEvent[]): void {
  const dones = events.filter((e) => e.type === 'done');
  assert.ok(dones.length <= 1, `expected at most one done, got ${dones.length}`);
  const last = events[events.length - 1];
  assert.ok(
    last.type === 'done' || last.type === 'error',
    `expected terminal done/error last, got ${last?.type}`,
  );
  // Nothing may follow a done.
  const doneIdx = events.findIndex((e) => e.type === 'done');
  if (doneIdx !== -1) {
    assert.equal(doneIdx, events.length - 1, 'events emitted after done');
  }
}

// Fast test cadence — real defaults are 300ms poll / 300s timeout.
const FAST: CodexDaemonRuntimeOptions = { pollIntervalMs: 2, turnTimeoutMs: 250 };

let conn: FakeDaemonConnection;

beforeEach(() => {
  conn = new FakeDaemonConnection();
  __TEST_OVERRIDES__.connectionFactory = () => conn;
  __TEST_OVERRIDES__.supervisor = { ensureRunning: async () => {} };
  __TEST_OVERRIDES__.agentCwd = '/srv/byte-light';
});

afterEach(() => {
  _resetDaemonTestOverrides();
  releaseCodexHold();
});

// ─── Slice 0: characterization ──────────────────────────────────────────

describe('InteractiveCodexRuntime — turn lifecycle (characterization)', () => {
  test('fresh thread: start → session → text_delta(final_answer) → done{stop}', async () => {
    scriptHappyDaemon(conn, {
      reads: [
        readInProgress(),
        readCompleted([
          { type: 'agentMessage', phase: 'commentary', text: 'Let me look at that.' },
          { type: 'agentMessage', phase: 'final_answer', text: 'The answer is 42.' },
        ]),
      ],
    });

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    // Slice 4: commentary-phase prose is now surfaced as spoken text (it keeps
    // its normal companion bubble) BEFORE the final answer — pre-Slice-4 it was
    // dropped. The final_answer still lands exactly once, last.
    assert.deepEqual(types(events), ['start', 'session', 'text_delta', 'text_delta', 'done']);
    assert.deepEqual(events[1], { type: 'session', sessionId: 'daemon-thread-1' });
    assert.deepEqual(events[2], { type: 'text_delta', text: 'Let me look at that.' });
    assert.deepEqual(events[3], { type: 'text_delta', text: 'The answer is 42.' });
    assert.deepEqual(events[4], { type: 'done', finishReason: 'stop' });
    assertSingleTerminal(events);

    // thread/start carries sandbox + approval policy and the system prompt.
    const threadStarts = conn.calls('thread/start');
    assert.equal(threadStarts.length, 1);
    assert.deepEqual(threadStarts[0].params.sandboxPolicy, { type: 'dangerFullAccess' });
    assert.equal(threadStarts[0].params.approvalPolicy, 'never');
    assert.equal(threadStarts[0].params.cwd, '/srv/byte-light');
    // Slice 4: the base instructions now begin with the caller's system prompt
    // and have the authored-thought-card contract appended.
    assert.match(threadStarts[0].params.baseInstructions, /^You are a test assistant\./);
    assert.match(threadStarts[0].params.baseInstructions, /Companion thought card/);
    assert.equal(threadStarts[0].params.model, 'gpt-5.2-codex');

    // turn/start input: orientation [Context] block prepended to the user text.
    const turnStarts = conn.calls('turn/start');
    assert.equal(turnStarts.length, 1);
    const textBlock = turnStarts[0].params.input[0];
    assert.equal(textBlock.type, 'text');
    assert.match(textBlock.text, /^\[Context\]\nTest orientation block\.\n\[\/Context\]\n\n/);
    assert.match(textBlock.text, /Hello, Codex daemon\.$/);
  });

  test('falls back to last non-empty agentMessage when no final_answer phase', async () => {
    scriptHappyDaemon(conn, {
      reads: [
        readCompleted([
          { type: 'agentMessage', text: 'first' },
          { type: 'agentMessage', text: '   ' },
          { type: 'agentMessage', text: 'last non-empty' },
          { type: 'commandExecution', command: 'ls' },
        ]),
      ],
    });

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));
    const text = events.find((e) => e.type === 'text_delta');
    assert.deepEqual(text, { type: 'text_delta', text: 'last non-empty' });
    assertSingleTerminal(events);
  });

  test('warm reuse: second turn reuses the daemon thread (no thread/start, no session event)', async () => {
    scriptHappyDaemon(conn, {
      reads: [
        readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'one' }]),
      ],
    });

    const rt = new InteractiveCodexRuntime(FAST);
    await collect(rt.runTurn(buildInput()));

    // Rescript reads for the second turn (same connection/thread).
    scriptHappyDaemon(conn, {
      reads: [
        readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'two' }]),
      ],
    });
    const before = conn.calls('thread/start').length;
    const events2 = await collect(rt.runTurn(buildInput()));

    assert.equal(conn.calls('thread/start').length, before, 'no new thread on warm turn');
    assert.deepEqual(types(events2), ['start', 'text_delta', 'done']);
    assert.equal(rt.getSessionId(), 'daemon-thread-1');
  });

  test('persisted input session is explicitly resumed after runtime startup', async () => {
    scriptHappyDaemon(conn, {
      reads: [
        readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'warm again' }]),
      ],
    });

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput({ sessionId: 'saved-thread-1' })));

    assert.deepEqual(types(events), ['start', 'text_delta', 'done']);
    assert.equal(conn.calls('thread/start').length, 0, 'saved session must not create a blank thread');
    assert.equal(conn.calls('thread/resume').length, 1);
    assert.equal(conn.calls('thread/resume')[0].params.threadId, 'saved-thread-1');
    assert.equal(conn.calls('thread/resume')[0].params.cwd, '/srv/byte-light');
    assert.match(conn.calls('thread/resume')[0].params.baseInstructions, /^You are a test assistant\./);
    assert.equal(events.some((event) => event.type === 'session'), false, 'successful resume keeps the saved sidecar id');
    assert.equal(rt.getSessionId(), 'saved-thread-1');
  });

  test('failed autonomous turn preserves the interactive room session', async () => {
    conn.respond = (method) => {
      if (method === 'turn/start') return { error: { message: 'autonomous wake failed' } };
      return { result: {} };
    };

    const rt = new InteractiveCodexRuntime(FAST);
    const wakeEvents = await collect(rt.runTurn(buildInput({
      sessionId: 'saved-thread-1',
      tier: 'autonomous',
      isAutonomous: true,
    })));

    assert.equal(wakeEvents.at(-1)?.type, 'error');
    assert.equal(rt.getSessionId(), 'saved-thread-1', 'wake failure must not clear the interactive session');

    scriptHappyDaemon(conn, {
      reads: [readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'interactive return' }])],
    });
    const interactiveEvents = await collect(rt.runTurn(buildInput({ sessionId: 'saved-thread-1' })));

    assert.equal(conn.calls('thread/start').length, 0, 'failed wake must not force a replacement thread');
    assert.equal(conn.calls('thread/resume').length, 1, 'saved session is resumed only on initial adoption');
    assert.deepEqual(types(interactiveEvents), ['start', 'text_delta', 'done']);
    assert.equal(rt.getSessionId(), 'saved-thread-1');
  });

  test('singleton changes rooms by resuming that room\'s persisted daemon session', async () => {
    scriptHappyDaemon(conn, {
      reads: [
        readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'room one' }]),
      ],
    });

    const rt = new InteractiveCodexRuntime(FAST);
    await collect(rt.runTurn(buildInput({ sessionId: 'saved-room-1' })));

    scriptHappyDaemon(conn, {
      reads: [
        readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'room two' }]),
      ],
    });
    await collect(rt.runTurn(buildInput({
      thread: { id: 'bl-thread-2', name: 'Other Room', type: 'named', current_session_id: 'saved-room-2' },
      sessionId: 'saved-room-2',
    })));

    assert.deepEqual(
      conn.calls('thread/resume').map((call) => call.params.threadId),
      ['saved-room-1', 'saved-room-2'],
    );
    assert.equal(conn.calls('thread/start').length, 0);
    assert.equal(rt.getSessionId(), 'saved-room-2');
  });

  test('singleton starts a fresh daemon thread when the next room has no saved session', async () => {
    scriptHappyDaemon(conn, {
      reads: [
        readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'room one' }]),
      ],
    });

    const rt = new InteractiveCodexRuntime(FAST);
    await collect(rt.runTurn(buildInput({ sessionId: 'saved-room-1' })));

    scriptHappyDaemon(conn, {
      reads: [
        readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'new room' }]),
      ],
    });
    const events = await collect(rt.runTurn(buildInput({
      thread: { id: 'bl-thread-new', name: 'Fresh Room', type: 'named', current_session_id: null },
      sessionId: undefined,
    })));

    assert.equal(conn.calls('thread/resume').length, 1, 'fresh room must not resume the previous room');
    assert.equal(conn.calls('thread/start').length, 1, 'fresh room receives its own daemon thread');
    assert.ok(events.some((event) => event.type === 'session'));
  });

  test('stale-thread recovery: thread-not-found → new thread with history, session re-emitted, turn retried', async () => {
    let turnStarts = 0;
    conn.respond = (method) => {
      switch (method) {
        case 'initialize':
          return { result: {} };
        case 'turn/start':
          turnStarts++;
          if (turnStarts === 1) return { error: { message: 'thread not found: stale-1' } };
          return { result: { turn: { id: 'turn-2' } } };
        case 'thread/start':
          return { result: { thread: { id: 'daemon-thread-2' } } };
        case 'thread/read':
          return readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'recovered' }]);
        default:
          return { result: {} };
      }
    };

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput({
      sessionId: 'stale-1',
      messages: [
        { role: 'user', content: 'earlier question', createdAt: new Date().toISOString() },
        { role: 'assistant', content: 'earlier answer', createdAt: new Date().toISOString() },
        { role: 'system', content: '[Session recycled]', createdAt: new Date().toISOString() },
        { role: 'user', content: 'Hello, Codex daemon.', createdAt: new Date().toISOString() },
      ],
    })));

    assert.deepEqual(types(events), ['start', 'session', 'text_delta', 'done']);
    assert.deepEqual(events[1], { type: 'session', sessionId: 'daemon-thread-2' });
    const resume = conn.calls('thread/resume')[0];
    assert.equal(resume.params.cwd, '/srv/byte-light');
    assert.match(resume.params.baseInstructions, /^You are a test assistant\./);

    // Recovery thread keeps identity/memory in instructions and carries the
    // durable conversation in its first user turn.
    const threadStart = conn.calls('thread/start')[0];
    assert.equal(threadStart.params.cwd, '/srv/byte-light');
    assert.doesNotMatch(threadStart.params.baseInstructions, /User: earlier question/);
    const retryText = conn.calls('turn/start')[1].params.input[0].text as string;
    assert.match(retryText, /User: earlier question/);
    assert.match(retryText, /Assistant: earlier answer/);
    assert.doesNotMatch(retryText, /\[Session recycled\]/);
    assert.equal(retryText.match(/Hello, Codex daemon\./g)?.length, 1, 'live message must appear exactly once');
    assert.equal(turnStarts, 2, 'turn retried on the recovered thread');
    assertSingleTerminal(events);
  });

  test('intentional idle recycle starts fresh, carries bounded history, and emits a visible seam', async () => {
    scriptHappyDaemon(conn, {
      reads: [readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'continued' }])],
    });

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput({
      sessionId: 'still-valid-old-thread',
      sessionRecycle: { reason: 'idle', historyLimit: 30 },
      messages: [
        { role: 'user', content: 'earlier question', createdAt: new Date().toISOString() },
        { role: 'assistant', content: 'earlier answer', createdAt: new Date().toISOString() },
        { role: 'system', content: '[Session recycled — older seam]', createdAt: new Date().toISOString() },
        { role: 'user', content: 'Hello, Codex daemon.', createdAt: new Date().toISOString() },
      ],
    })));

    assert.equal(conn.calls('thread/resume').length, 0, 'intentional recycle must not resume the old thread');
    assert.equal(conn.calls('thread/start').length, 1);
    assert.ok(events.some((event) =>
      event.type === 'thinking_delta'
      && event.kind === 'system'
      && event.text.startsWith('[Session recycled')));
    const firstTurnText = conn.calls('turn/start')[0].params.input[0].text as string;
    assert.match(firstTurnText, /User: earlier question/);
    assert.match(firstTurnText, /Assistant: earlier answer/);
    assert.doesNotMatch(firstTurnText, /older seam/);
    assert.equal(firstTurnText.match(/Hello, Codex daemon\./g)?.length, 1);
    assertSingleTerminal(events);
  });

  test('recovery history is bounded and removes only the trailing live-message duplicate', () => {
    const messages = Array.from({ length: 35 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}`,
      createdAt: new Date().toISOString(),
    }));
    messages.push({ role: 'user', content: 'live message', createdAt: new Date().toISOString() });

    const context = buildCodexRecoveryHistory(messages, 'live message');

    assert.doesNotMatch(context, /User: live message/);
    assert.doesNotMatch(context, /message-4\b/);
    assert.match(context, /message-5\b/);
    assert.match(context, /message-34\b/);
  });

  test('recovery seed names a visitor by who he is, not as this lane', () => {
    const at = '2026-11-01T00:00:00.000Z';
    const context = buildCodexRecoveryHistory([
      { role: 'user', content: 'Who is cooking?', createdAt: at },
      { role: 'assistant', content: 'Not me.', createdAt: at, companionId: 'companion-c' },
      { role: 'assistant', content: 'We are.', createdAt: at },
    ], 'live message');
    assert.match(context, /Companion-c: Not me\./);
    assert.match(context, /Assistant: We are\./);
  });

  test('abort via AbortSignal → done{aborted}, no text emitted', async () => {
    const ac = new AbortController();
    scriptHappyDaemon(conn, { reads: [readInProgress()] });

    const rt = new InteractiveCodexRuntime(FAST);
    const iter = rt.runTurn(buildInput({ abortSignal: ac.signal }))[Symbol.asyncIterator]();

    const collected: AgentRuntimeEvent[] = [];
    // Drain until the poll loop is live, then abort.
    collected.push((await iter.next()).value); // start
    collected.push((await iter.next()).value); // session
    ac.abort();
    for (;;) {
      const { value, done } = await iter.next();
      if (done) break;
      collected.push(value);
    }

    const last = collected[collected.length - 1];
    assert.deepEqual(last, { type: 'done', finishReason: 'aborted' });
    assert.ok(!collected.some((e) => e.type === 'text_delta'), 'no text after abort');
    assertSingleTerminal(collected);
  });

  test('timeout: error + done{error}; daemon thread id is preserved', async () => {
    scriptHappyDaemon(conn, { reads: [readInProgress()] });

    const rt = new InteractiveCodexRuntime({ pollIntervalMs: 2, turnTimeoutMs: 20 });
    const events = await collect(rt.runTurn(buildInput()));

    const err = events.find((e) => e.type === 'error') as Extract<AgentRuntimeEvent, { type: 'error' }>;
    assert.ok(err, 'expected an error event');
    assert.match(err.message, /timed out/);
    assert.equal(err.recoverable, true);
    assert.deepEqual(events[events.length - 1], { type: 'done', finishReason: 'error' });
    assertSingleTerminal(events);
    // Continuity: the daemon-resident thread survives the timeout.
    assert.equal(rt.getSessionId(), 'daemon-thread-1');
  });

  test('supervisor failure → single error{recoverable:false}', async () => {
    __TEST_OVERRIDES__.supervisor = {
      ensureRunning: async () => { throw new Error('spawn blew up'); },
    };
    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    assert.deepEqual(types(events), ['start', 'error']);
    const err = events[1] as Extract<AgentRuntimeEvent, { type: 'error' }>;
    assert.match(err.message, /Failed to start Codex daemon: spawn blew up/);
    assert.equal(err.recoverable, false);
  });

  test('connect failure → single error{recoverable:true}', async () => {
    conn.connectError = new Error('ECONNREFUSED');
    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    assert.deepEqual(types(events), ['start', 'error']);
    const err = events[1] as Extract<AgentRuntimeEvent, { type: 'error' }>;
    assert.match(err.message, /Failed to connect to Codex daemon: ECONNREFUSED/);
    assert.equal(err.recoverable, true);
  });

  test('turn/start error (non-stale) → error, no done', async () => {
    conn.respond = (method) => {
      switch (method) {
        case 'initialize': return { result: {} };
        case 'thread/start': return { result: { thread: { id: 'daemon-thread-1' } } };
        case 'turn/start': return { error: { message: 'model overloaded' } };
        default: return { result: {} };
      }
    };
    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    assert.deepEqual(types(events), ['start', 'session', 'error']);
    const err = events[2] as Extract<AgentRuntimeEvent, { type: 'error' }>;
    assert.match(err.message, /Turn failed: model overloaded/);
    assertSingleTerminal(events);
  });

  test('capability descriptor: warm daemon lane is buffered, tool-capable, resumable', () => {
    assert.equal(CODEX_CLI_CAPABILITIES.streaming, false);
    assert.equal(CODEX_CLI_CAPABILITIES.tools, true);
    assert.equal(CODEX_CLI_CAPABILITIES.sessionResume, true);
    assert.equal(CODEX_CLI_CAPABILITIES.vision, true);
  });
});

// ─── Slice 1: live activity ─────────────────────────────────────────────

/**
 * Script a turn where scripted notifications fire synchronously inside
 * successive thread/read responses (exactly how frames interleave on the
 * real socket: notifications arrive while we await the read), then the
 * final read completes the turn.
 */
function scriptActivityTurn(
  conn: FakeDaemonConnection,
  notificationsByRead: Array<Array<{ method: string; params: any }>>,
  finalItems: any[],
): void {
  let readCount = 0;
  conn.respond = (method) => {
    switch (method) {
      case 'initialize':
        return { result: {} };
      case 'thread/start':
        return { result: { thread: { id: 'daemon-thread-1' } } };
      case 'turn/start':
        return { result: { turn: { id: 'turn-1' } } };
      case 'thread/read': {
        const batch = notificationsByRead[readCount];
        readCount++;
        if (batch) {
          for (const n of batch) conn.notify(n.method, n.params);
          return readInProgress();
        }
        return readCompleted(finalItems);
      }
      default:
        return { result: {} };
    }
  };
}

const FINAL = [{ type: 'agentMessage', phase: 'final_answer', text: 'final answer' }];

describe('InteractiveCodexRuntime — live activity (Slice 1)', () => {
  test('command execution + reasoning surface as tool_start/tool_result/thinking_delta before the final answer', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'item/started', params: { threadId: 'daemon-thread-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'ls -la', cwd: '/tmp' } } }],
      [
        { method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'ls -la', exitCode: 0, aggregatedOutput: 'three files' } } },
        { method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'r-1', type: 'reasoning', text: 'I should list the directory.' } } },
      ],
    ], FINAL);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    assert.deepEqual(types(events), [
      'start', 'session', 'tool_start', 'tool_result', 'thinking_delta', 'text_delta', 'done',
    ]);
    assert.deepEqual(events[2], {
      type: 'tool_start', id: 'cmd-1', name: 'commandExecution',
      input: { command: 'ls -la', cwd: '/tmp' },
    });
    assert.deepEqual(events[3], {
      type: 'tool_result', id: 'cmd-1', name: 'commandExecution',
      output: { exitCode: 0, output: 'three files' }, isError: false,
    });
    // Slice 3 (thought semantics): daemon reasoning items carry
    // kind 'provider' — native model telemetry, never authored voice.
    assert.deepEqual(events[4], { type: 'thinking_delta', text: 'I should list the directory.', kind: 'provider' });
    // Final answer still lands exactly once, after all activity.
    assert.deepEqual(events[5], { type: 'text_delta', text: 'final answer' });
    assertSingleTerminal(events);
  });

  test('failed command and failed MCP call normalize to tool_result{isError:true}', async () => {
    scriptActivityTurn(conn, [
      [
        { method: 'item/completed', params: { item: { id: 'cmd-2', type: 'commandExecution', command: 'false', exitCode: 2, aggregatedOutput: '' } } },
        { method: 'item/completed', params: { item: { id: 'mcp-1', type: 'mcpToolCall', server: 'vault', tool: 'read_note', status: 'failed' } } },
      ],
    ], FINAL);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const results = events.filter((e) => e.type === 'tool_result') as Array<Extract<AgentRuntimeEvent, { type: 'tool_result' }>>;
    assert.equal(results.length, 2);
    assert.equal(results[0].isError, true);
    assert.equal(results[1].name, 'vault/read_note');
    assert.equal(results[1].isError, true);
    assertSingleTerminal(events);
  });

  test('routine tokenCount telemetry (62.5% WITH rolling-window resetsAt) raises NO rate_limit; usage still normalizes', async () => {
    // The daemon rides a rolling-window `resetsAt` on EVERY routine
    // thread/tokenCount update. At 62.5% utilization the account is NOT
    // limited — the presence of a reset time is telemetry, not a limit
    // signal, so no banner may fire. The token-usage path is independent
    // and must still surface.
    scriptActivityTurn(conn, [
      [{
        method: 'thread/tokenCount',
        params: {
          threadId: 'daemon-thread-1',
          rateLimits: { primary: { usedPercent: 62.5, resetsAt: '2026-07-14T20:00:00Z' } },
          usage: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 800 },
        },
      }],
    ], FINAL);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    assert.ok(
      !events.some((e) => e.type === 'rate_limit'),
      'reset-time telemetry at 62.5% must not raise a rate_limit banner',
    );

    const usage = events.find((e) => e.type === 'usage') as Extract<AgentRuntimeEvent, { type: 'usage' }>;
    assert.ok(usage, 'expected usage event');
    assert.equal(usage.input, 1200);
    assert.equal(usage.output, 340);
    assert.equal(usage.cacheRead, 800);
    assertSingleTerminal(events);
  });

  test('routine rateLimits telemetry (low utilization, no reset time) raises NO rate_limit event', async () => {
    // The daemon rides a rateLimits object on ordinary token-count updates.
    // At ~45% with no reset time this is NOT a real limit — it must not
    // trigger the "Rate limited (unknown)" banner. The usage still flows.
    scriptActivityTurn(conn, [
      [{
        method: 'thread/tokenCount',
        params: {
          threadId: 'daemon-thread-1',
          rateLimits: { primary: { usedPercent: 45 } },
          usage: { inputTokens: 500, outputTokens: 120 },
        },
      }],
    ], FINAL);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    assert.ok(!events.some((e) => e.type === 'rate_limit'), 'routine telemetry must not raise a rate_limit banner');
    // The token-usage path is untouched: usage still surfaces.
    const usage = events.find((e) => e.type === 'usage') as Extract<AgentRuntimeEvent, { type: 'usage' }>;
    assert.ok(usage, 'expected usage event alongside routine telemetry');
    assert.equal(usage.input, 500);
    assertSingleTerminal(events);
  });

  test('88% WITH a rolling-window resetsAt raises NO rate_limit (reset time is telemetry, not a limit)', async () => {
    // At 88% the account is heavily used but NOT blocked. The daemon still
    // sends a reset time on the routine update — which must not, on its own,
    // trigger the banner. This is the exact case the prior fix mis-encoded.
    scriptActivityTurn(conn, [
      [{
        method: 'thread/tokenCount',
        params: {
          threadId: 'daemon-thread-1',
          rateLimits: { primary: { usedPercent: 88, resetsAt: '2026-07-14T20:00:00Z' } },
        },
      }],
    ], FINAL);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    assert.ok(
      !events.some((e) => e.type === 'rate_limit'),
      'reset-time telemetry at 88% must not raise a rate_limit banner',
    );
    assertSingleTerminal(events);
  });

  test('an explicit limit status (e.g. rejected) raises rate_limit even below 100%, resetsAt preserved', async () => {
    // Defensive parity with the Claude SDK lane: if the daemon ever carries a
    // real limit status, honor it regardless of utilization. Codex currently
    // sends none — but if it does, the banner is legitimate.
    scriptActivityTurn(conn, [
      [{
        method: 'thread/tokenCount',
        params: {
          threadId: 'daemon-thread-1',
          rateLimits: { primary: { usedPercent: 40, status: 'rejected', resetsAt: '2026-07-14T20:00:00Z' } },
        },
      }],
    ], FINAL);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const rl = events.find((e) => e.type === 'rate_limit') as Extract<AgentRuntimeEvent, { type: 'rate_limit' }>;
    assert.ok(rl, 'expected rate_limit event for an explicit limit status');
    assert.equal(rl.status, 'rejected');
    assert.equal(rl.resetsAt, '2026-07-14T20:00:00Z');
    assert.equal(rl.utilization, 40);
    assertSingleTerminal(events);
  });

  test('exhaustion with no reset time (utilization >= 100) still raises rate_limit', async () => {
    scriptActivityTurn(conn, [
      [{
        method: 'thread/tokenCount',
        params: {
          threadId: 'daemon-thread-1',
          rateLimits: { primary: { used_percent: 100 } },
        },
      }],
    ], FINAL);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const rl = events.find((e) => e.type === 'rate_limit') as Extract<AgentRuntimeEvent, { type: 'rate_limit' }>;
    assert.ok(rl, 'expected rate_limit event at full exhaustion');
    assert.equal(rl.utilization, 100);
    assert.equal(rl.resetsAt, undefined);
    assertSingleTerminal(events);
  });

  test('exhaustion (utilization >= 100) WITH a reset time preserves resetsAt in the payload', async () => {
    // When the limit is genuine, the real reset time rides along so the
    // banner can show when access returns. resetsAt is preserved as payload,
    // never as the trigger.
    scriptActivityTurn(conn, [
      [{
        method: 'thread/tokenCount',
        params: {
          threadId: 'daemon-thread-1',
          rateLimits: { primary: { usedPercent: 100, resetsAt: '2026-07-14T21:30:00Z' } },
        },
      }],
    ], FINAL);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const rl = events.find((e) => e.type === 'rate_limit') as Extract<AgentRuntimeEvent, { type: 'rate_limit' }>;
    assert.ok(rl, 'expected rate_limit event at exhaustion');
    assert.equal(rl.utilization, 100);
    assert.equal(rl.resetsAt, '2026-07-14T21:30:00Z');
    assertSingleTerminal(events);
  });

  test('error-ish notifications surface as provider_diagnostic (turn/failed stays terminal-owned)', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'thread/error', params: { error: { message: 'upstream 502' } } }],
    ], FINAL);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const diag = events.find((e) => e.type === 'provider_diagnostic') as Extract<AgentRuntimeEvent, { type: 'provider_diagnostic' }>;
    assert.ok(diag, 'expected provider_diagnostic');
    assert.equal(diag.code, 'thread/error');
    assert.equal(diag.message, 'upstream 502');
    // Diagnostics never terminate the turn.
    assert.deepEqual(events[events.length - 1], { type: 'done', finishReason: 'stop' });
  });

  test('notifications for another daemon thread are filtered out', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'item/completed', params: { threadId: 'someone-elses-thread', item: { id: 'r-x', type: 'reasoning', text: 'foreign thinking' } } }],
    ], FINAL);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    assert.ok(!events.some((e) => e.type === 'thinking_delta'), 'foreign-thread activity leaked');
    assertSingleTerminal(events);
  });

  test('long-running tool gets synthesized tool_progress ticks', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'item/started', params: { item: { id: 'cmd-slow', type: 'commandExecution', command: 'sleep 60' } } }],
      [], [], [],
    ], FINAL);

    const rt = new InteractiveCodexRuntime({ ...FAST, toolProgressIntervalMs: 1 });
    const events = await collect(rt.runTurn(buildInput()));

    const ticks = events.filter((e) => e.type === 'tool_progress') as Array<Extract<AgentRuntimeEvent, { type: 'tool_progress' }>>;
    assert.ok(ticks.length >= 1, 'expected at least one tool_progress tick');
    assert.equal(ticks[0].toolId, 'cmd-slow');
    assert.equal(ticks[0].toolName, 'commandExecution');
    assert.ok(typeof ticks[0].elapsedSeconds === 'number');
    assertSingleTerminal(events);
  });

  test('capture disarms at turn end: late notifications cannot leak into the next turn', async () => {
    scriptActivityTurn(conn, [], FINAL);
    const rt = new InteractiveCodexRuntime(FAST);
    await collect(rt.runTurn(buildInput()));

    // Daemon chatter after the turn ended — must be ignored, not queued.
    conn.notify('item/completed', { item: { id: 'r-late', type: 'reasoning', text: 'late thinking' } });

    scriptActivityTurn(conn, [], [{ type: 'agentMessage', phase: 'final_answer', text: 'second' }]);
    const events2 = await collect(rt.runTurn(buildInput()));

    assert.deepEqual(types(events2), ['start', 'text_delta', 'done']);
    assert.ok(!events2.some((e) => e.type === 'thinking_delta'), 'stale activity leaked into next turn');
    // One capture handler installed per turn on the shared warm connection.
    assert.equal(conn.handlers.length, 2);
  });
});

// ─── Slice 2: rearmed timeout / continuity / interrupt / dispose ─────────

describe('InteractiveCodexRuntime — rearmed inactivity timeout (Slice 2)', () => {
  test('daemon activity rearms the silence clock: a noisy turn outlives turnTimeoutMs', async () => {
    // 120 in-progress reads, each carrying chatter for our thread. At the
    // 2ms poll cadence the turn's total wall time far exceeds the 150ms
    // silence budget, but no single gap between notifications does.
    const batches = Array.from({ length: 120 }, () => [
      { method: 'item/updated', params: { threadId: 'daemon-thread-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'sleep 60' } } },
    ]);
    scriptActivityTurn(conn, batches, FINAL);

    const started = Date.now();
    const rt = new InteractiveCodexRuntime({ pollIntervalMs: 2, turnTimeoutMs: 150 });
    const events = await collect(rt.runTurn(buildInput()));

    assert.ok(Date.now() - started > 150, 'turn must actually outlive the silence budget for this test to prove rearm');
    assert.deepEqual(events[events.length - 1], { type: 'done', finishReason: 'stop' });
    const text = events.find((e) => e.type === 'text_delta');
    assert.deepEqual(text, { type: 'text_delta', text: 'final answer' });
    assertSingleTerminal(events);
  });

  test('true silence still times out, names inactivity, and preserves the daemon thread', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'item/updated', params: { threadId: 'daemon-thread-1', item: { id: 'cmd-1', type: 'commandExecution' } } }],
    ], FINAL);
    // After the single noisy read, respond keeps returning in-progress
    // reads with no notifications — the clock is never rearmed again.
    const noisy = conn.respond;
    let reads = 0;
    conn.respond = (method, params) => {
      if (method === 'thread/read' && ++reads > 1) return readInProgress();
      return noisy(method, params);
    };

    const rt = new InteractiveCodexRuntime({ pollIntervalMs: 2, turnTimeoutMs: 30 });
    const events = await collect(rt.runTurn(buildInput()));

    const err = events.find((e) => e.type === 'error') as Extract<AgentRuntimeEvent, { type: 'error' }>;
    assert.match(err.message, /no daemon activity/);
    assert.equal(err.recoverable, true);
    assert.deepEqual(events[events.length - 1], { type: 'done', finishReason: 'error' });
    // Continuity: our polling window closed; the daemon thread survives.
    assert.equal(rt.getSessionId(), 'daemon-thread-1');
  });

  test('hard ceiling caps an endlessly noisy turn', async () => {
    const batches = Array.from({ length: 500 }, () => [
      { method: 'item/updated', params: { threadId: 'daemon-thread-1', item: { id: 'cmd-1', type: 'commandExecution' } } },
    ]);
    scriptActivityTurn(conn, batches, FINAL);

    const rt = new InteractiveCodexRuntime({ pollIntervalMs: 2, turnTimeoutMs: 60_000, hardTimeoutMs: 40 });
    const events = await collect(rt.runTurn(buildInput()));

    const err = events.find((e) => e.type === 'error') as Extract<AgentRuntimeEvent, { type: 'error' }>;
    assert.match(err.message, /hard ceiling/);
    assert.deepEqual(events[events.length - 1], { type: 'done', finishReason: 'error' });
    assert.equal(rt.getSessionId(), 'daemon-thread-1');
  });

  test('after a timeout the next turn resumes the same daemon thread (context continuity)', async () => {
    scriptHappyDaemon(conn, { reads: [readInProgress()] });
    const rt = new InteractiveCodexRuntime({ pollIntervalMs: 2, turnTimeoutMs: 20 });
    const events1 = await collect(rt.runTurn(buildInput({ sessionId: 'saved-thread-1' })));
    assert.deepEqual(events1[events1.length - 1], { type: 'done', finishReason: 'error' });
    assert.equal(rt.getSessionId(), 'saved-thread-1');

    scriptHappyDaemon(conn, {
      reads: [readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'still here' }])],
    });
    const events2 = await collect(rt.runTurn(buildInput({ sessionId: 'saved-thread-1' })));

    assert.equal(conn.calls('thread/start').length, 0, 'no replacement thread after timeout');
    assert.equal(conn.calls('thread/resume').length, 1, 'persisted thread resumes only on initial adoption');
    assert.deepEqual(types(events2), ['start', 'text_delta', 'done']);
    assert.deepEqual(events2[1], { type: 'text_delta', text: 'still here' });
  });
});

describe('InteractiveCodexRuntime — safe interrupt/cancel (Slice 2)', () => {
  test('abort() sends turn/interrupt for the in-flight daemon turn', async () => {
    scriptHappyDaemon(conn, { reads: [readInProgress()] });
    const rt = new InteractiveCodexRuntime(FAST);

    // Drive the generator in the background so the poll loop is genuinely
    // in flight (holding the daemon turn id) when abort() lands — the real
    // cancel shape: AgentService consumes while the user hits stop.
    const pending = collect(rt.runTurn(buildInput()));
    await new Promise((r) => setTimeout(r, 15));
    rt.abort();
    const collected = await pending;

    assert.deepEqual(collected[collected.length - 1], { type: 'done', finishReason: 'aborted' });
    const interrupts = conn.calls('turn/interrupt');
    assert.equal(interrupts.length, 1, 'exactly one turn/interrupt');
    assert.deepEqual(interrupts[0].params, { threadId: 'daemon-thread-1', turnId: 'turn-1' });
    assertSingleTerminal(collected);
  });

  test('AbortSignal cancellation also interrupts the daemon turn, exactly once', async () => {
    const ac = new AbortController();
    scriptHappyDaemon(conn, { reads: [readInProgress()] });
    const rt = new InteractiveCodexRuntime(FAST);
    const iter = rt.runTurn(buildInput({ abortSignal: ac.signal }))[Symbol.asyncIterator]();

    await iter.next(); // start
    await iter.next(); // session
    ac.abort();
    for (;;) {
      const { done } = await iter.next();
      if (done) break;
    }

    const interrupts = conn.calls('turn/interrupt');
    assert.equal(interrupts.length, 1);
    assert.deepEqual(interrupts[0].params, { threadId: 'daemon-thread-1', turnId: 'turn-1' });
  });

  test('rejoin adoption: turn/started notification supplies the interrupt target when turn/start returns none', async () => {
    let reads = 0;
    conn.respond = (method) => {
      switch (method) {
        case 'initialize': return { result: {} };
        case 'thread/start': return { result: { thread: { id: 'daemon-thread-1' } } };
        // Steering/rejoining a running thread: no turn object comes back.
        case 'turn/start': return { result: {} };
        case 'thread/read':
          if (++reads === 1) {
            conn.notify('turn/started', { threadId: 'daemon-thread-1', turn: { id: 'turn-live' } });
          }
          return readInProgress();
        default: return { result: {} };
      }
    };

    const rt = new InteractiveCodexRuntime(FAST);
    // Background-drive so reads actually fire; the first read delivers the
    // turn/started notification that supplies the adoptable live turn id.
    const pending = collect(rt.runTurn(buildInput()));
    await new Promise((r) => setTimeout(r, 15));
    rt.abort();
    const collected = await pending;

    assert.deepEqual(collected[collected.length - 1], { type: 'done', finishReason: 'aborted' });
    const interrupts = conn.calls('turn/interrupt');
    assert.equal(interrupts.length, 1);
    assert.deepEqual(interrupts[0].params, { threadId: 'daemon-thread-1', turnId: 'turn-live' });
  });

  test('no interrupt when nothing is in flight: abort after a completed turn is a no-op', async () => {
    scriptHappyDaemon(conn, {
      reads: [readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'done' }])],
    });
    const rt = new InteractiveCodexRuntime(FAST);
    await collect(rt.runTurn(buildInput()));

    rt.abort();
    assert.equal(conn.calls('turn/interrupt').length, 0, 'no stale interrupt target after terminal');
  });
});

describe('InteractiveCodexRuntime — dispose (Slice 2)', () => {
  test('dispose closes the socket but keeps the daemon thread; next turn reconnects and resumes it', async () => {
    const conn2 = new FakeDaemonConnection();
    let made = 0;
    __TEST_OVERRIDES__.connectionFactory = () => (made++ === 0 ? conn : conn2);

    scriptHappyDaemon(conn, {
      reads: [readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'one' }])],
    });
    const rt = new InteractiveCodexRuntime(FAST);
    await collect(rt.runTurn(buildInput()));

    rt.dispose();
    assert.equal(conn.closed, 1, 'control socket closed');
    assert.equal(rt.getSessionId(), 'daemon-thread-1', 'provider-side session survives disposal');

    // Next turn: fresh connection, fresh initialize, SAME daemon thread.
    scriptHappyDaemon(conn2, {
      reads: [readCompleted([{ type: 'agentMessage', phase: 'final_answer', text: 'two' }])],
    });
    const events2 = await collect(rt.runTurn(buildInput()));

    assert.equal(made, 2, 'new connection created after dispose');
    assert.equal(conn2.calls('initialize').length, 1, 're-initialized on the new connection');
    assert.equal(conn2.calls('thread/start').length, 0, 'no new thread — session resumed');
    const resumes = conn2.calls('thread/resume');
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].params.cwd, '/srv/byte-light');
    assert.match(resumes[0].params.baseInstructions, /^You are a test assistant\./);
    assert.deepEqual(types(events2), ['start', 'text_delta', 'done']);
    assert.deepEqual(events2[1], { type: 'text_delta', text: 'two' });
  });

  test('dispose is safe with no connection', () => {
    const rt = new InteractiveCodexRuntime(FAST);
    rt.dispose(); // must not throw
    assert.equal(rt.getSessionId(), null);
  });
});

describe('InteractiveCodexRuntime — capabilities', () => {
  test('descriptor unchanged by live-activity work', () => {
    assert.equal(CODEX_CLI_CAPABILITIES.streaming, false);
    assert.equal(CODEX_CLI_CAPABILITIES.tools, true);
    assert.equal(CODEX_CLI_CAPABILITIES.sessionResume, true);
    assert.equal(CODEX_CLI_CAPABILITIES.vision, true);
  });
});
