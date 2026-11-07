/**
 * Intentions on the orchestrator's tick: a promise that comes due is said by
 * its promiser in his own lane; one waiting on her status fires only after
 * she's been Busy and comes clear; nothing comes due in the quiet hours; and
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
const { initDb, setConfig, createMessage } = await import('./db.js');
const { Orchestrator } = await import('./orchestrator.js');
const { createIntention, getIntention, listOpenIntentions, cancelIntention } = await import('./db/intentions.js');
const { setOwnerStatus } = await import('./db/statuses.js');

const db = initDb(join(root, 'test.db'));
const nowIso = new Date().toISOString();
db.prepare("INSERT INTO threads (id,name,type,created_at,last_activity_at) VALUES ('home','Home','named',?,?)").run(nowIso, nowIso);
setConfig('app.routingThreadId', 'home');

type Call = { threadId: string; prompt: string; owner?: string };
let calls: Call[] = [];
let speaks = true;
const agent = {
  isProcessing: () => false,
  processAutonomous: async (threadId: string, prompt: string, owner?: string) => {
    calls.push({ threadId, prompt, owner });
    if (!speaks) return '';
    createMessage({ id: crypto.randomUUID(), threadId, role: 'companion', content: 'How did it go?', createdAt: new Date().toISOString() });
    return 'How did it go?';
  },
};
const o = new Orchestrator(agent as never) as unknown as { checkTriggers(): Promise<void>; checkIntentions(): Promise<void> };
const tick = async () => { await o.checkTriggers(); await o.checkIntentions(); };

beforeEach(() => {
  calls = [];
  speaks = true;
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
  assert.match(calls[0].prompt, /Companion B, you told the operator .*"check she ate after her shift"/);
  assert.equal(getIntention(intention.id)?.state, 'asked');
  await tick();
  assert.equal(calls.length, 1, 'said once');
});

test('waiting on her status: armed by Busy, said when it clears', async () => {
  const { intention } = createIntention({ companion: 'companion-a', text: 'ask how the meeting went', onStatusClears: true, threadId: 'home' });
  await tick();
  assert.equal(calls.length, 0, 'she was never busy');
  setOwnerStatus({ presence: 'busy', line: 'shoot till 4' });
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
