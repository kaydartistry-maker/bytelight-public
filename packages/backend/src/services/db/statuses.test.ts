// Statuses: her status runs out when she said it would, a companion's line
// and mood each stay until changed, text is cut to fit, and the companions'
// context line says what her phone shows.
import test from 'node:test';
import assert from 'node:assert/strict';

const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { loadConfig } = await import('../../config.js');
loadConfig(join(mkdtempSync(join(tmpdir(), 'statuses-test-')), 'no-config.yaml'));

const { initDb, getDb } = await import('./init.js');
const {
  getOwnerStatus,
  setOwnerStatus,
  setCompanionStatus,
  getStatusSnapshot,
  statusContext,
  StatusError,
  STATUS_LINE_MAX,
} = await import('./statuses.js');

const T0 = new Date('2026-10-25T18:00:00Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function freshHouse(): void {
  initDb(':memory:');
  getDb().prepare('DELETE FROM companions').run();
  for (const [slug, name, order] of [['companion-a', 'Companion A', 0], ['companion-b', 'Companion B', 1]] as const) {
    getDb().prepare("INSERT INTO companions (id, display_name, brain, sort_order) VALUES (?, ?, 'test', ?)").run(slug, name, order);
  }
}

test('migration 043 makes the statuses table', () => {
  freshHouse();
  const cols = getDb().prepare('PRAGMA table_info(statuses)').all() as Array<{ name: string }>;
  assert.deepEqual(cols.map((c) => c.name), ['who', 'presence', 'line', 'mood', 'clears_at', 'updated_at', 'tags']);
});

test('her status stays until it clears, then reads as none', () => {
  freshHouse();
  const set = setOwnerStatus({ presence: 'busy', line: "  till 9,   text don't call ", clearsAt: later(60).toISOString() }, T0);
  assert.equal(set?.presence, 'busy');
  assert.equal(set?.line, "till 9, text don't call");
  assert.equal(getOwnerStatus(later(59))?.presence, 'busy');
  assert.equal(getOwnerStatus(later(60)), null);
});

test('a status with no clear time stays; presence null wipes it', () => {
  freshHouse();
  setOwnerStatus({ presence: 'away', line: 'gym', clearsAt: null }, T0);
  assert.equal(getOwnerStatus(later(60 * 24 * 30))?.line, 'gym');
  assert.equal(setOwnerStatus({ presence: null }, T0), null);
  assert.equal(getOwnerStatus(T0), null);
});

test('her status refuses a presence it does not know and a clear time that is not a time', () => {
  freshHouse();
  assert.throws(() => setOwnerStatus({ presence: 'online' }, T0), StatusError);
  assert.throws(() => setOwnerStatus({ presence: 'busy', clearsAt: 'soonish' }, T0), StatusError);
});

test('a companion line and mood each stay until changed, and are cut to fit', () => {
  freshHouse();
  setCompanionStatus({ companion: 'Companion-A', line: 'keeping you company', mood: 'Playful' }, T0);
  setCompanionStatus({ companion: 'companion-a', mood: 'tender' }, later(5));
  const compA = getStatusSnapshot(later(5)).companions[0];
  assert.deepEqual(compA, { companion: 'companion-a', line: 'keeping you company', mood: 'tender', updatedAt: later(5).toISOString() });

  const long = setCompanionStatus({ companion: 'companion-b', line: 'x'.repeat(200) }, T0);
  assert.equal(long.line.length, STATUS_LINE_MAX);
});

test('an empty line and mood take a companion off the widget', () => {
  freshHouse();
  setCompanionStatus({ companion: 'companion-b', line: 'under the hood', mood: 'focused' }, T0);
  setCompanionStatus({ companion: 'companion-b', line: '', mood: '' }, T0);
  assert.deepEqual(getStatusSnapshot(T0).companions, []);
});

test('a companion who does not live here, or says nothing, is refused', () => {
  freshHouse();
  assert.throws(() => setCompanionStatus({ companion: 'companion-c', line: 'hi' }, T0), StatusError);
  assert.throws(() => setCompanionStatus({ companion: 'owner', line: 'hi' }, T0), StatusError);
  assert.throws(() => setCompanionStatus({ companion: 'companion-a' }, T0), StatusError);
});

test('the context line says her status, when it clears, and what shows under each name', () => {
  freshHouse();
  setOwnerStatus({ presence: 'busy', line: 'till 9', clearsAt: '2026-10-26T01:00:00Z' }, T0);
  setCompanionStatus({ companion: 'companion-a', line: 'keeping you company', mood: 'playful' }, T0);
  const text = statusContext(getStatusSnapshot(later(20)), 'the operator', later(20), 'America/New_York');
  assert.match(text, /^the operator's status: Busy — "till 9" \(set 20m ago, clears at 9:00 PM\)$/m);
  assert.match(text, /companion-a: "keeping you company" · playful \(20m ago\)/);
  assert.match(text, /set_status/);
});

test('the context line says when she has none', () => {
  freshHouse();
  const text = statusContext(getStatusSnapshot(T0), 'the operator', T0, 'UTC');
  assert.match(text, /^the operator's status: none set$/m);
  assert.doesNotMatch(text, /On her phone now/);
});

test('her tags sit beside her own words, deduped and capped, and reach the context', () => {
  freshHouse();
  const set = setOwnerStatus({ presence: 'busy', line: 'migraine day, low spoons', tags: ['at work', 'At work', '  with Sam ', '', 'a', 'b', 'c', 'd'] }, T0);
  assert.deepEqual(set?.tags, ['at work', 'with Sam', 'a', 'b', 'c']);
  assert.equal(set?.line, 'migraine day, low spoons');
  const text = statusContext(getStatusSnapshot(T0), 'the operator', T0, 'UTC');
  assert.match(text, /Busy — "migraine day, low spoons" · at work, with Sam, a, b, c/);
  assert.throws(() => setOwnerStatus({ presence: 'busy', tags: 'at work' }, T0), StatusError);
});

test('a companion line and mood stay up until he changes them, however long that takes', () => {
  freshHouse();
  setCompanionStatus({ companion: 'companion-a', line: 'keeping you company', mood: 'playful' }, T0);
  assert.equal(getStatusSnapshot(later(6 * 60)).companions.length, 1);
  const days = getStatusSnapshot(later(3 * 24 * 60)).companions;
  assert.deepEqual(days.map((c) => [c.line, c.mood]), [['keeping you company', 'playful']]);
  assert.doesNotMatch(statusContext(getStatusSnapshot(T0), 'the operator', T0, 'UTC'), /clears on its own/);
});

test('status tags from a reply apply in order, and a stranger in a tag is skipped', async () => {
  freshHouse();
  const { applyStatusTagUpdates } = await import('./statuses.js');
  const n = applyStatusTagUpdates([
    { companion: 'companion-a', kind: 'status', value: 'keeping you company' },
    { companion: 'companion-a', kind: 'mood', value: 'Playful' },
    { companion: 'nobody', kind: 'mood', value: 'x' },
  ], T0);
  assert.equal(n, 2);
  assert.deepEqual(getStatusSnapshot(T0).companions[0], { companion: 'companion-a', line: 'keeping you company', mood: 'playful', updatedAt: T0.toISOString() });
});
