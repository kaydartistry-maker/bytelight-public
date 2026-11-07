// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * Guest turns on the warm Codex CLI lane (services/turn-audience.ts).
 *
 * The daemon owns its own tools, so a guest's turn is closed three ways: it
 * runs read-only and asks before anything untrusted, every approval asked on
 * it is declined, and the first item that is not speech interrupts the turn.
 * The owner's turns keep full hands, byte for byte as before.
 *
 * Run with:
 *   npx tsx --test packages/backend/src/services/runtimes/codex-daemon.guest.test.ts
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InteractiveCodexRuntime,
  __TEST_OVERRIDES__,
  _resetDaemonTestOverrides,
  codexActiveTurnAudience,
  guestCodexItemIsTool,
  guestServerRequestRefusal,
  type CodexDaemonConnectionLike,
} from './codex-daemon.js';
import type { AgentRuntimeEvent, AgentTurnInput } from './types.js';
import { releaseCodexHold } from '../codex-breaker.js';

type NotificationHandler = (method: string, params: any) => void;

class FakeDaemonConnection implements CodexDaemonConnectionLike {
  sent: Array<{ method: string; params: any }> = [];
  respond: (method: string, params: any) => any = () => ({ result: {} });
  private current: NotificationHandler | null = null;
  async connect(): Promise<void> {}
  async send(method: string, params: any): Promise<any> {
    this.sent.push({ method, params });
    return this.respond(method, params);
  }
  onNotification(handler: NotificationHandler): void { this.current = handler; }
  notify(method: string, params: any): void { this.current?.(method, params); }
  close(): void { this.current = null; }
  calls(method: string): Array<{ method: string; params: any }> {
    return this.sent.filter((s) => s.method === method);
  }
}

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
    platform: 'discord',
    isAutonomous: false,
    orientation: 'Test orientation block.',
    systemPrompt: { kind: 'text', value: 'You are a test assistant.' },
    messages: [{ role: 'user', content: 'Hello, Codex daemon.', createdAt: new Date().toISOString() }],
    ...overrides,
  };
}

async function collect(iter: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const out: AgentRuntimeEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** A daemon whose turn completes with one final answer. `onRead` runs on
 *  every thread/read, before it answers, so a test can push notifications
 *  into the live turn. */
function script(conn: FakeDaemonConnection, onRead: (n: number) => void = () => {}): void {
  let reads = 0;
  conn.respond = (method) => {
    switch (method) {
      case 'initialize': return { result: { userAgent: 'codex-fake' } };
      case 'thread/start': return { result: { thread: { id: 'daemon-thread-1' } } };
      case 'turn/start': return { result: { turn: { id: 'turn-1' } } };
      case 'thread/read': {
        reads++;
        onRead(reads);
        if (reads < 3) return { result: { thread: { turns: [{ status: 'inProgress', items: [] }] } } };
        return { result: { thread: { turns: [{ status: 'completed', items: [
          { type: 'agentMessage', phase: 'final_answer', text: 'Hi there.' },
        ] }] } } };
      }
      default: return { result: {} };
    }
  };
}

const FAST = { pollIntervalMs: 2, turnTimeoutMs: 500 };
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

test("the owner's turn keeps full hands and carries no guest banner", async () => {
  script(conn);
  const events = await collect(new InteractiveCodexRuntime(FAST).runTurn(buildInput()));
  assert.deepEqual(events[events.length - 1], { type: 'done', finishReason: 'stop' });
  const start = conn.calls('turn/start')[0].params;
  assert.deepEqual(start.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(start.approvalPolicy, 'never');
  assert.doesNotMatch(start.input[0].text, /Guest turn/);
});

test("a guest's turn runs read-only, asks first, and is told so", async () => {
  script(conn);
  const events = await collect(new InteractiveCodexRuntime(FAST).runTurn(buildInput({
    audience: { kind: 'guest', trust: 'standard' },
  })));
  assert.deepEqual(events[events.length - 1], { type: 'done', finishReason: 'stop' }, 'speech alone still answers');
  const start = conn.calls('turn/start')[0].params;
  assert.deepEqual(start.sandboxPolicy, { type: 'readOnly' });
  assert.equal(start.approvalPolicy, 'untrusted');
  assert.match(start.input[0].text, /\[Guest turn, standard trust:/);
  assert.equal(codexActiveTurnAudience(), null, 'the audience is cleared when the turn ends');
});

test("a guest's turn that reaches for a tool is interrupted and ends unanswered", async () => {
  script(conn, (n) => {
    if (n === 1) conn.notify('item/started', { item: { type: 'commandExecution', id: 'cmd-1', command: 'cat ~/.codex/auth.json' } });
  });
  const events = await collect(new InteractiveCodexRuntime(FAST).runTurn(buildInput({
    audience: { kind: 'guest', trust: 'full' },
  })));
  const last = events[events.length - 1];
  assert.deepEqual(last, { type: 'done', finishReason: 'error' });
  const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
  assert.ok(err && /guest/.test(err.message), 'a plain error for the log');
  assert.ok(!events.some((e) => e.type === 'text_delta' && /Hi there/.test((e as { text: string }).text)), 'no reply');
  assert.equal(conn.calls('turn/interrupt').length, 1, 'the daemon-side turn is interrupted');
});

test("the owner's turn is never interrupted for using a tool", async () => {
  script(conn, (n) => {
    if (n === 1) conn.notify('item/started', { item: { type: 'commandExecution', id: 'cmd-1', command: 'ls' } });
  });
  const events = await collect(new InteractiveCodexRuntime(FAST).runTurn(buildInput()));
  assert.deepEqual(events[events.length - 1], { type: 'done', finishReason: 'stop' });
  assert.equal(conn.calls('turn/interrupt').length, 0);
});

test('only speech is speech: anything else on a guest turn counts as a tool', () => {
  for (const type of ['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction']) {
    assert.equal(guestCodexItemIsTool({ type }), false, type);
  }
  for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'somethingNew']) {
    assert.equal(guestCodexItemIsTool({ type }), true, type);
  }
  assert.equal(guestCodexItemIsTool(undefined), true, 'a missing item is not speech');
  assert.equal(guestCodexItemIsTool({}), true, 'a missing type is not speech');
});

test('every approval the daemon asks for on a guest turn is a no', () => {
  assert.deepEqual(guestServerRequestRefusal('item/commandExecution/requestApproval'), { approved: false, decision: 'decline' });
  assert.deepEqual(guestServerRequestRefusal('item/fileChange/requestApproval'), { approved: false, decision: 'decline' });
  assert.deepEqual(guestServerRequestRefusal('mcpServer/elicitation/request'), { action: 'decline' });
  assert.deepEqual(guestServerRequestRefusal('item/tool/requestUserInput'), { cancelled: true });
  assert.deepEqual(guestServerRequestRefusal('some/new/request'), { approved: false, decision: 'decline' });
});
