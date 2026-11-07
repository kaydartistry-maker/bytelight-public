// The Archivist catches promises nobody filed: an intention op is filed
// straight into intentions (no approval), marked as caught; one already filed,
// one whose time has gone by, or one from a stranger is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';

const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { loadConfig } = await import('../config.js');
loadConfig(join(mkdtempSync(join(tmpdir(), 'archivist-intentions-')), 'no-config.yaml'));

const { initDb, getDb } = await import('./db/init.js');
const { applyOps, promisesBriefing } = await import('./memory-extraction.js');
const { listOpenIntentions, fileCaughtIntention, createIntention } = await import('./db/intentions.js');

function freshHouse(): void {
  initDb(':memory:');
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO threads (id, name, type, created_at, last_activity_at) VALUES ('home', 'Home', 'named', ?, ?)").run(now, now);
}

const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

test('a caught promise is filed straight away, marked as the Archivist’s, in its thread', () => {
  freshHouse();
  const { applied } = applyOps([
    { op: 'intention', scope: '', label: '', companion: 'companion-a', text: 'ask how the meeting went', at: null, on_status_clears: true },
    { op: 'intention', scope: '', label: '', companion: 'companion-b', text: 'check she ate after her shift', at: inAnHour() },
  ] as never, 'home');
  assert.equal(applied, 2);
  const open = listOpenIntentions();
  assert.deepEqual(open.map((i) => [i.companion, i.source, i.threadId, i.onStatusClears]), [
    ['companion-a', 'archivist', 'home', true],
    ['companion-b', 'archivist', 'home', false],
  ]);
});

test('already filed, already past, or not from a companion here: skipped, never thrown', () => {
  freshHouse();
  createIntention({ companion: 'companion-a', text: 'ask how the meeting went', onStatusClears: true, threadId: 'home' });
  assert.equal(fileCaughtIntention({ companion: 'companion-a', text: 'Ask how the meeting went', on_status_clears: true }, 'home'), 'already filed');
  assert.equal(fileCaughtIntention({ companion: 'companion-a', text: 'old one', at: new Date(Date.now() - 60 * 60_000).toISOString() }, 'home'), 'already past');
  assert.equal(fileCaughtIntention({ companion: 'pat', text: 'x', at: inAnHour() }, 'home'), 'refused');
  assert.equal(fileCaughtIntention({ companion: 'companion-a', text: 'no when at all' }, 'home'), 'refused');
  const { applied, skipped } = applyOps([{ op: 'intention', scope: '', label: '', companion: 'pat', text: 'x', at: inAnHour() }] as never, 'home');
  assert.equal(applied, 0);
  assert.match(skipped[0], /intention pat: refused/);
  assert.equal(listOpenIntentions().length, 1);
});

test('the briefing gives the Archivist now with its offset, and what is already filed', () => {
  freshHouse();
  createIntention({ companion: 'companion-b', text: 'dentist Monday 2:30', at: inAnHour(), threadId: 'home' });
  const text = promisesBriefing('America/New_York', new Date('2026-10-26T15:00:00Z'));
  assert.match(text, /UTC offset -04:00/);
  assert.match(text, /- companion-b: "dentist Monday 2:30"/);
});
