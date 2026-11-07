/**
 * The owner's message never expires behind a wake (2026-10-25).
 *
 * A watcher turn ran longer than 90s; the owner's "hey...." sat in the queue,
 * hit the 90s interactive timeout and was resolved as QUEUE_TIMEOUT_MESSAGE,
 * which ws.ts ignored — the message vanished until a sweep found it 32 min
 * later. These pin: owner turns wait at least as long as a wake does, a
 * timed-out owner turn is surfaced (never silent), and a memory card alone is
 * not enough to keep an otherwise empty wake bubble.
 */
import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  QueryQueue,
  PRIORITIES,
  queuePriorityFor,
  queueTimeoutFor,
  hasDurableTurnArtifacts,
  AUTONOMOUS_QUEUE_TIMEOUT_MS,
  QUEUE_TIMEOUT_MESSAGE,
} from './agent.js';
import { queueTimeoutNotice } from './ws.js';

describe('owner queue timeout', () => {
  test('owner turns (web and owner Discord) wait at least as long as a wake', () => {
    assert.ok(queueTimeoutFor(PRIORITIES.web_interactive) >= AUTONOMOUS_QUEUE_TIMEOUT_MS);
    assert.ok(queueTimeoutFor(PRIORITIES.discord_owner) >= AUTONOMOUS_QUEUE_TIMEOUT_MS);
    assert.equal(queueTimeoutFor(PRIORITIES.autonomous), AUTONOMOUS_QUEUE_TIMEOUT_MS);
  });

  test('an owner message queued behind a 2-minute wake still runs', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    try {
      const q = new QueryQueue();
      let releaseWake!: () => void;
      const wakeDone = new Promise<void>((r) => { releaseWake = r; });
      const wake = q.enqueue(PRIORITIES.autonomous, async () => { await wakeDone; return 'wake'; }, AUTONOMOUS_QUEUE_TIMEOUT_MS);
      const owner = q.enqueue(PRIORITIES.web_interactive, async () => 'answered', queueTimeoutFor(PRIORITIES.web_interactive));
      mock.timers.tick(120_000); // the wake outlives the old 90s window
      releaseWake();
      assert.equal(await wake, 'wake');
      assert.equal(await owner, 'answered');
    } finally {
      mock.timers.reset();
    }
  });
});

describe('her Discord turns are hers by who sent them (2026-10-26)', () => {
  test('her Discord turn gets owner priority and the long wait', () => {
    const p = queuePriorityFor('discord', { kind: 'owner' });
    assert.equal(p, PRIORITIES.discord_owner);
    assert.ok(queueTimeoutFor(p) >= AUTONOMOUS_QUEUE_TIMEOUT_MS);
  });
  test('a guest stays a guest, at any trust level', () => {
    for (const trust of ['full', 'standard', 'limited'] as const) {
      assert.equal(queuePriorityFor('discord', { kind: 'guest', trust }), PRIORITIES.discord_other);
    }
  });
  test('a Discord turn with no audience is never treated as hers', () => {
    assert.equal(queuePriorityFor('discord'), PRIORITIES.discord_other);
  });
  test('web stays first, telegram stays hers', () => {
    assert.equal(queuePriorityFor('web'), PRIORITIES.web_interactive);
    assert.equal(queuePriorityFor('telegram'), PRIORITIES.discord_owner);
  });
});

describe('a timed-out owner turn is never silent', () => {
  test('the queue-timeout string becomes a visible notice', () => {
    const notice = queueTimeoutNotice(QUEUE_TIMEOUT_MESSAGE);
    assert.ok(notice && notice.length > 0);
    assert.equal(queueTimeoutNotice(`  ${QUEUE_TIMEOUT_MESSAGE}\n`) !== null, true);
  });
  test('ordinary replies and empty side-note returns get no notice', () => {
    assert.equal(queueTimeoutNotice('hi love'), null);
    assert.equal(queueTimeoutNotice(''), null);
    assert.equal(queueTimeoutNotice(undefined), null);
  });
});

describe('durable artifacts', () => {
  test('a memory card alone does not keep an empty turn', () => {
    assert.equal(hasDurableTurnArtifacts({ toolCount: 0, thinkingCount: 0, surfacedRecall: { cards: [1] } }), false);
  });
  test('tool and thinking trails still count', () => {
    assert.equal(hasDurableTurnArtifacts({ toolCount: 1, thinkingCount: 0, surfacedRecall: null }), true);
    assert.equal(hasDurableTurnArtifacts({ toolCount: 0, thinkingCount: 2, surfacedRecall: { cards: [1] } }), true);
  });
});
