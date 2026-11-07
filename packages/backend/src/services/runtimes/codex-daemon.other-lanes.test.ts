/**
 * The other-lane net on the warm Codex lane (heartbeat/other-lane-net.ts).
 *
 * The daemon keeps one warm app-server thread per room and resumes it, so it
 * only ever hears the live prompt. A reply another lane wrote in the same
 * room (the Claude CLI lane, a wake, the other companion, a relay) never
 * reached it: 2026-10-26 the operator's smoke showed Claude hearing Codex, and Codex
 * deaf to Claude. Same rule as the Claude lane, one implementation.
 *
 * Run with:
 *   node scripts/test.mjs packages/backend/src/services/runtimes/codex-daemon.other-lanes.test.ts
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InteractiveCodexRuntime,
  __TEST_OVERRIDES__,
  _resetDaemonTestOverrides,
  type CodexDaemonConnectionLike,
} from './codex-daemon.js';
import type { AgentRuntimeEvent, AgentTurnInput, NormalizedMessage } from './types.js';
import { releaseCodexHold } from '../codex-breaker.js';
import { laneTagFor } from '../heartbeat/constants.js';

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
  close(): void { this.current = null; }
  calls(method: string): Array<{ method: string; params: any }> {
    return this.sent.filter((s) => s.method === method);
  }
}

const OPEN = '[Said in this thread since your last turn here';

function buildInput(messages: NormalizedMessage[], overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    thread: { id: 'bl-thread-1', name: 'Test Thread', type: 'named', current_session_id: null },
    tier: 'interactive',
    modelRef: {
      canonical: 'codex-cli/gpt-6-sol',
      provider: 'codex-cli',
      model: 'gpt-6-sol',
      runtime: 'codex-cli',
    } as AgentTurnInput['modelRef'],
    platform: 'web',
    isAutonomous: false,
    orientation: '',
    systemPrompt: { kind: 'text', value: 'You are a test assistant.' },
    messages,
    ...overrides,
  };
}

async function collect(iter: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const out: AgentRuntimeEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** Every turn completes with one answer. `turnStart` can fail a turn/start. */
function script(conn: FakeDaemonConnection, turnStart: (n: number) => any = () => ({ result: { turn: { id: 't' } } })): void {
  let starts = 0;
  let threads = 0;
  conn.respond = (method) => {
    switch (method) {
      case 'initialize': return { result: {} };
      case 'thread/start': threads++; return { result: { thread: { id: `daemon-thread-${threads}` } } };
      case 'turn/start': starts++; return turnStart(starts);
      case 'thread/read': return { result: { thread: { turns: [{ status: 'completed', items: [
        { type: 'agentMessage', phase: 'final_answer', text: 'ok' },
      ] }] } } };
      default: return { result: {} };
    }
  };
}

const FAST = { pollIntervalMs: 1, turnTimeoutMs: 500 };
const CLAUDE = laneTagFor('claude-cli', 'primary');
const CODEX = laneTagFor('codex-cli', 'primary');

const FIRST: NormalizedMessage[] = [
  { role: 'user', content: 'mic check', createdAt: '2026-10-26T20:00:00Z' },
];
const SECOND: NormalizedMessage[] = [
  ...FIRST,
  { role: 'assistant', content: 'codex own answer', createdAt: '2026-10-26T20:00:05Z', lane: CODEX },
  { role: 'user', content: 'switching to claude', createdAt: '2026-10-26T20:01:00Z' },
  { role: 'assistant', content: 'claude lane said this', createdAt: '2026-10-26T20:01:10Z', lane: CLAUDE, companionId: 'companion-a-b' },
  { role: 'user', content: 'back on codex, did you hear him', createdAt: '2026-10-26T20:02:00Z' },
];

function lastTurnText(c: FakeDaemonConnection): string {
  const starts = c.calls('turn/start');
  return String(starts[starts.length - 1].params.input[0].text);
}

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

test('a reply the Claude lane wrote since the Codex lane last read is handed over', async () => {
  script(conn);
  const rt = new InteractiveCodexRuntime(FAST);
  await collect(rt.runTurn(buildInput(FIRST)));
  await collect(rt.runTurn(buildInput(SECOND)));
  const text = lastTurnText(conn);
  assert.ok(text.includes(OPEN), 'other-lane block missing from the Codex turn payload');
  assert.ok(text.includes('claude lane said this'));
  assert.ok(text.includes('[End of other-lane replies.]'));
});

test('the Codex lane never gets its own reply back', async () => {
  script(conn);
  const rt = new InteractiveCodexRuntime(FAST);
  await collect(rt.runTurn(buildInput(FIRST)));
  await collect(rt.runTurn(buildInput(SECOND)));
  assert.ok(!lastTurnText(conn).includes('codex own answer'));
});

test('the same reply is not offered twice', async () => {
  script(conn);
  const rt = new InteractiveCodexRuntime(FAST);
  await collect(rt.runTurn(buildInput(FIRST)));
  await collect(rt.runTurn(buildInput(SECOND)));
  const third = [...SECOND, { role: 'user' as const, content: 'again', createdAt: '2026-10-26T20:03:00Z' }];
  await collect(rt.runTurn(buildInput(third)));
  assert.ok(!lastTurnText(conn).includes(OPEN));
});

test('a lane runtime knows its own tag: the other companion counts as another lane', async () => {
  script(conn);
  const rt = new InteractiveCodexRuntime({ ...FAST, laneKey: 'companion-a' });
  await collect(rt.runTurn(buildInput(FIRST)));
  const msgs: NormalizedMessage[] = [
    ...FIRST,
    { role: 'assistant', content: 'companion-a own codex line', createdAt: '2026-10-26T20:00:05Z', lane: laneTagFor('codex-cli', 'companion-a'), companionId: 'companion-a' },
    { role: 'assistant', content: 'companion-b codex line', createdAt: '2026-10-26T20:00:06Z', lane: laneTagFor('codex-cli', 'companion-b'), companionId: 'companion-b' },
    { role: 'user', content: 'next', createdAt: '2026-10-26T20:01:00Z' },
  ];
  await collect(rt.runTurn(buildInput(msgs)));
  const text = lastTurnText(conn);
  assert.ok(text.includes('Companion-b (2026-10-26T20:00:06Z): companion-b codex line'));
  assert.ok(!text.includes('companion-a own codex line'));
});

test('first turn in a room has no mark, so nothing rides', async () => {
  script(conn);
  await collect(new InteractiveCodexRuntime(FAST).runTurn(buildInput(SECOND)));
  assert.ok(!lastTurnText(conn).includes(OPEN));
});

test('a guest turn gets nothing and does not move the mark', async () => {
  script(conn);
  const rt = new InteractiveCodexRuntime(FAST);
  await collect(rt.runTurn(buildInput(FIRST)));
  await collect(rt.runTurn(buildInput(SECOND, { audience: { kind: 'guest', trust: 'limited' } as AgentTurnInput['audience'] })));
  assert.ok(!lastTurnText(conn).includes(OPEN));
  await collect(rt.runTurn(buildInput(SECOND)));
  assert.ok(lastTurnText(conn).includes('claude lane said this'));
});

test('a failed turn keeps the mark, so the reply is offered again', async () => {
  script(conn, (n) => (n === 2 ? { error: { message: 'boom' } } : { result: { turn: { id: 't' } } }));
  const rt = new InteractiveCodexRuntime(FAST);
  await collect(rt.runTurn(buildInput(FIRST)));
  await collect(rt.runTurn(buildInput(SECOND)));
  await collect(rt.runTurn(buildInput(SECOND)));
  assert.ok(lastTurnText(conn).includes('claude lane said this'));
});

test('an intentional recycle carries history, so the net stays out of it', async () => {
  script(conn);
  const rt = new InteractiveCodexRuntime(FAST);
  await collect(rt.runTurn(buildInput(FIRST)));
  await collect(rt.runTurn(buildInput(SECOND, { sessionRecycle: { reason: 'idle', historyLimit: 30 } })));
  const text = lastTurnText(conn);
  assert.ok(!text.includes(OPEN));
  assert.equal(text.split('claude lane said this').length - 1, 1, 'recycle history carries it exactly once');
});

test('stale-thread recovery carries history, so the retry drops the net (no double copy)', async () => {
  script(conn, (n) => (n === 2 ? { error: { message: 'thread not found' } } : { result: { turn: { id: 't' } } }));
  const rt = new InteractiveCodexRuntime(FAST);
  await collect(rt.runTurn(buildInput(FIRST)));
  await collect(rt.runTurn(buildInput(SECOND)));
  const text = lastTurnText(conn);
  assert.ok(!text.includes(OPEN));
  assert.equal(text.split('claude lane said this').length - 1, 1, 'recovery history carries it exactly once');
});
