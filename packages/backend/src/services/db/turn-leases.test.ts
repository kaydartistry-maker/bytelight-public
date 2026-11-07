// Turn leases: a turn that ends lets go of its lease, one a restart cuts off
// keeps it, and boot retries it at most twice and only within the hour.
import test from 'node:test';
import assert from 'node:assert/strict';

const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { loadConfig } = await import('../../config.js');
loadConfig(join(mkdtempSync(join(tmpdir(), 'turn-leases-test-')), 'no-config.yaml'));

const { initDb, getDb } = await import('./init.js');
const {
  leaseTurn,
  releaseTurn,
  holdTurnLeases,
  resetTurnLeaseHold,
  takeCutOffTurns,
  cutOffPrompt,
} = await import('./turn-leases.js');

const T0 = new Date('2026-10-25T18:00:00Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM turn_leases').get() as { n: number }).n;

function fresh(): void {
  initDb(':memory:');
  resetTurnLeaseHold();
}

test('migration 044 makes the turn_leases table', () => {
  fresh();
  const cols = getDb().prepare('PRAGMA table_info(turn_leases)').all() as Array<{ name: string }>;
  assert.deepEqual(cols.map((c) => c.name), ['id', 'thread_id', 'user_message_id', 'prompt', 'had_images', 'attempts', 'created_at']);
});

test('a turn that ends lets go of its lease', () => {
  fresh();
  const id = leaseTurn({ threadId: 't', userMessageId: 'm', prompt: 'hi' }, T0);
  releaseTurn(id);
  assert.equal(count(), 0);
  assert.deepEqual(takeCutOffTurns(later(1)), []);
});

test('once shutdown begins, a lease stays, and boot picks it up', () => {
  fresh();
  const id = leaseTurn({ threadId: 't', userMessageId: 'm', prompt: 'tell me everything', hadImages: true }, T0);
  holdTurnLeases();
  releaseTurn(id);
  resetTurnLeaseHold(); // the next boot
  const [lease, ...rest] = takeCutOffTurns(later(2));
  assert.equal(rest.length, 0);
  assert.equal(lease.prompt, 'tell me everything');
  assert.equal(lease.hadImages, true);
  assert.equal(lease.attempts, 1);
});

test('a lease gets two retries at most, then it is dropped', () => {
  fresh();
  leaseTurn({ threadId: 't', userMessageId: 'm', prompt: 'p' }, T0);
  assert.equal(takeCutOffTurns(later(1)).length, 1); // crashed again during the retry
  assert.equal(takeCutOffTurns(later(2)).length, 1);
  assert.equal(takeCutOffTurns(later(3)).length, 0);
  assert.equal(count(), 0);
});

test('a lease older than an hour is dropped, not answered', () => {
  fresh();
  leaseTurn({ threadId: 't', userMessageId: 'old', prompt: 'old' }, T0);
  leaseTurn({ threadId: 't', userMessageId: 'new', prompt: 'new' }, later(30));
  const taken = takeCutOffTurns(later(61));
  assert.deepEqual(taken.map((l) => l.prompt), ['new']);
  assert.equal(count(), 1);
});

test('the retry prompt says what happened, then her message as it was', () => {
  fresh();
  leaseTurn({ threadId: 't', userMessageId: 'm', prompt: 'what do you think?', hadImages: true }, T0);
  const [lease] = takeCutOffTurns(later(3));
  const text = cutOffPrompt(lease, 'the operator', later(3));
  assert.match(text, /^\[byte-light restarted while you were answering the operator's message below \(sent 3 minutes ago\)/);
  assert.match(text, /don't repeat it/);
  assert.match(text, /pictures/);
  assert.ok(text.endsWith('\n\nwhat do you think?'));
});
