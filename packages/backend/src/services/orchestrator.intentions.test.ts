/**
 * Intentions on the orchestrator's tick: a promise that comes due is said by
 * its promiser in its own lane; one waiting on the operator's status fires only
 * after they've been Busy and come clear; nothing comes due in the quiet hours; and
 * a moment where nothing got said puts the promise back in line.
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'orchestrator-intentions-'));
process.env.RESONANT_HOME = root;
process.env.TZ = 'UTC';
writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');
const yamlPath = join(root, 'bytelight.yaml');
writeFileSync(yamlPath, ['identity:', '  companion_name: Companion', '  user_name: the operator', '  timezone: UTC', ''].join('\n'), 'utf-8');

const { loadConfig } = await import('../config.js');
loadConfig(yamlPath);
const { initDb, setConfig, createMessage, getDb } = await import('./db.js');
const { Orchestrator } = await import('./orchestrator.js');
const { createIntention, getIntention, listOpenIntentions, cancelIntention, resolveIntention } = await import('./db/intentions.js');
const { setOwnerStatus } = await import('./db/statuses.js');

const db = initDb(join(root, 'test.db'));
const nowIso = new Date().toISOString();
db.prepare("INSERT INTO threads (id,name,type,created_at,last_activity_at) VALUES ('home','Home','named',?,?)").run(nowIso, nowIso);
setConfig('app.routingThreadId', 'home');
db.prepare("INSERT OR IGNORE INTO companions (id, display_name, brain) VALUES ('river', 'River', 'test')").run();

type Call = { threadId: string; prompt: string; owner?: string };
let calls: Call[] = [];
let speaks = true;
// When set, the companion reads the room and closes the follow-up instead of speaking.
let closesInstead = false;
let presence: 'active' | 'idle' | 'offline' = 'active';
const agent = {
  isProcessing: () => false,
  processAutonomous: async (threadId: string, prompt: string, owner?: string) => {
    calls.push({ threadId, prompt, owner });
    if (closesInstead) {
      const id = /resolve_intention \(id ([^)]+)\)/.exec(prompt)?.[1];
      if (id) resolveIntention(id, 'she already said it went fine');
      return '';
    }
    if (!speaks) return '';
    createMessage({ id: crypto.randomUUID(), threadId, role: 'companion', content: 'How did it go?', createdAt: new Date().toISOString() });
    return 'How did it go?';
  },
};
const { registry } = await import('./registry.js');
(registry as unknown as { getUserPresenceState: () => string }).getUserPresenceState = () => presence;
const o = new Orchestrator(agent as never) as unknown as { checkTriggers(): Promise<void>; checkIntentions(): Promise<void> };
const tick = async () => { await o.checkTriggers(); await o.checkIntentions(); };

beforeEach(() => {
  calls = [];
  speaks = true;
  closesInstead = false;
  presence = 'active';
  setConfig('intentions.status_fallback_hours', '6');
  setConfig('intentions.status_fallback_gap_hours', '3');
  setConfig('intentions.status_fallback_last_at', '');
  // A quiet window that never covers now, unless a test sets one.
  setConfig('intentions.quiet_start', '00:00');
  setConfig('intentions.quiet_end', '00:00');
  setOwnerStatus({ presence: null });
  for (const i of listOpenIntentions()) cancelIntention(i.id);
});

after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a promise that comes due is said by its promiser, in his lane, and waits on her', async () => {
  const { intention } = createIntention({ companion: 'companion-b', text: 'check she ate after her shift', at: new Date(Date.now() - 1000).toISOString(), threadId: 'home' });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, 'companion-b');
  assert.equal(calls[0].threadId, 'home');
  assert.match(calls[0].prompt, /^\[A follow-up coming due\] Companion B, you chose .* to follow up on this with the operator: "check she ate after her shift"/);
  assert.equal(getIntention(intention.id)?.state, 'asked');
  await tick();
  assert.equal(calls.length, 1, 'said once');
});

test('waiting on the operator status: armed by Busy, said when it clears', async () => {
  const { intention } = createIntention({ companion: 'companion-a', text: 'ask how the meeting went', onStatusClears: true, threadId: 'home' });
  await tick();
  assert.equal(calls.length, 0, 'she was never busy');
  setOwnerStatus({ presence: 'busy', line: 'meeting till 4' });
  await tick();
  await tick();
  assert.equal(calls.length, 0, 'still busy');
  setOwnerStatus({ presence: null });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, 'companion-a');
  assert.equal(getIntention(intention.id)?.state, 'asked');
});

test('nothing comes due inside the quiet hours', async () => {
  const h = new Date().getUTCHours();
  setConfig('intentions.quiet_start', `${String(h).padStart(2, '0')}:00`);
  setConfig('intentions.quiet_end', `${String((h + 1) % 24).padStart(2, '0')}:00`);
  const { intention } = createIntention({ companion: 'companion-a', text: 'quiet one', at: new Date(Date.now() - 1000).toISOString(), threadId: 'home' });
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(getIntention(intention.id)?.state, 'pending');
});

test('a moment where nothing got said puts the promise back in line', async () => {
  speaks = false;
  const { intention } = createIntention({ companion: 'companion-a', text: 'silent one', at: new Date(Date.now() - 1000).toISOString(), threadId: 'home' });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(getIntention(intention.id)?.state, 'pending');
  speaks = true;
  await tick();
  assert.equal(calls.length, 2, 'tried again next tick');
  assert.equal(getIntention(intention.id)?.state, 'asked');
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

test('waiting on the operator status but never Busy: comes due once they are here and it has waited', async () => {
  const { intention } = createIntention({ companion: 'river', text: 'ask how the long day went', onStatusClears: true, threadId: 'home' }, hoursAgo(5));
  await tick();
  assert.equal(calls.length, 0, 'five hours is not long enough');
  getDb().prepare('UPDATE intentions SET created_at = ? WHERE id = ?').run(hoursAgo(7).toISOString(), intention.id);
  presence = 'idle';
  await tick();
  assert.equal(calls.length, 0, 'she is not here');
  presence = 'active';
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(getIntention(intention.id)?.state, 'asked');
});

test('the fallback still respects an `after` time and the quiet hours', async () => {
  const { intention } = createIntention({ companion: 'river', text: 'ask about the evening plans', onStatusClears: true, at: new Date(Date.now() + 3_600_000).toISOString(), threadId: 'home' }, hoursAgo(8));
  await tick();
  assert.equal(calls.length, 0, 'its time has not come');
  cancelIntention(intention.id);

  const h = new Date().getUTCHours();
  setConfig('intentions.quiet_start', `${String(h).padStart(2, '0')}:00`);
  setConfig('intentions.quiet_end', `${String((h + 1) % 24).padStart(2, '0')}:00`);
  const quiet = createIntention({ companion: 'river', text: 'ask about the late night', onStatusClears: true, threadId: 'home' }, hoursAgo(8)).intention;
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(getIntention(quiet.id)?.state, 'pending');
});

test('closed instead of said: it stays closed, nothing goes back in line', async () => {
  closesInstead = true;
  const { intention } = createIntention({ companion: 'river', text: 'ask how the call went', at: new Date(Date.now() - 1000).toISOString(), threadId: 'home' });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(getIntention(intention.id)?.state, 'resolved');
  await tick();
  assert.equal(calls.length, 1, 'never brought up again');
  const t = getDb().prepare('SELECT status FROM triggers WHERE id = ?').get(intention.triggerId) as { status: string };
  assert.notEqual(t.status, 'pending');
});

test('a pending one that never came up goes to rest on the tick', async () => {
  const { intention } = createIntention({ companion: 'river', text: 'ask about something long gone', onStatusClears: true, threadId: 'home' }, hoursAgo(8 * 24));
  presence = 'idle';
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(getIntention(intention.id)?.state, 'resting');
});

test('a nudge the companion closes instead of saying stays closed', async () => {
  const { intention } = createIntention({ companion: 'river', text: 'ask how the visit went', at: new Date(Date.now() - 1000).toISOString(), threadId: 'home' });
  await tick();
  assert.equal(getIntention(intention.id)?.state, 'asked');
  getDb().prepare('UPDATE intentions SET asked_at = ? WHERE id = ?').run(hoursAgo(25).toISOString(), intention.id);
  closesInstead = true;
  await tick();
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /^\[A follow-up, asked again\]/);
  assert.equal(getIntention(intention.id)?.state, 'resolved');
  assert.equal(getIntention(intention.id)?.nudgedAt, null);
});

test('the status fallback lets one through per gap window, oldest first; timed ones are not held back', async () => {
  const older = createIntention({ companion: 'river', text: 'ask how the first errand went', onStatusClears: true, threadId: 'home' }, hoursAgo(9)).intention;
  const newer = createIntention({ companion: 'river', text: 'ask about the second thing', onStatusClears: true, threadId: 'home' }, hoursAgo(8)).intention;
  await tick();
  assert.equal(calls.length, 1, 'only one comes due through the fallback');
  assert.match(calls[0].prompt, /first errand/);
  assert.equal(getIntention(older.id)?.state, 'asked');
  assert.equal(getIntention(newer.id)?.state, 'pending');

  await tick();
  assert.equal(calls.length, 1, 'the gap holds on the next tick');

  // A follow-up with a real time is not throttled by the gap.
  const timed = createIntention({ companion: 'river', text: 'ask how lunch went', at: new Date(Date.now() - 1000).toISOString(), threadId: 'home' }).intention;
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(getIntention(timed.id)?.state, 'asked');
  assert.equal(getIntention(newer.id)?.state, 'pending');

  // The gap is kept in the config table (survives a restart); once it has passed, the next one comes due.
  setConfig('intentions.status_fallback_last_at', hoursAgo(3).toISOString());
  await tick();
  assert.equal(calls.length, 3);
  assert.match(calls[2].prompt, /second thing/);
  assert.equal(getIntention(newer.id)?.state, 'asked');
});

test('a genuinely armed status_clears is not throttled by the fallback gap', async () => {
  setConfig('intentions.status_fallback_last_at', new Date().toISOString());
  const { intention } = createIntention({ companion: 'river', text: 'ask how the meeting went', onStatusClears: true, threadId: 'home' });
  setOwnerStatus({ presence: 'busy' });
  await tick();
  setOwnerStatus({ presence: null });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(getIntention(intention.id)?.state, 'asked');
});
