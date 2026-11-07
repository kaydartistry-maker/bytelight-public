/**
 * Bells on Aerie's engine: one node-cron timer per bell, owners and names
 * kept in settings, a busy house queues the wake instead of retrying, and a
 * wake that says nothing is logged rather than posted into the chat. Our
 * built-in bells stay, and saved bells from an earlier build are adopted.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'orchestrator-engine-'));
process.env.RESONANT_HOME = root;
process.env.TZ = 'UTC';
writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');
const wakeFile = join(root, 'wake.md');
writeFileSync(wakeFile, '# Wake Prompts\n\n## deep_work\nDeep work from the file.\n\n## old_bell\nA bell from an earlier build.\n', 'utf-8');
const yamlPath = join(root, 'bytelight.yaml');
writeFileSync(
  yamlPath,
  ['identity:', '  companion_name: Companion', '  user_name: Sam', '  timezone: UTC', 'orchestrator:', `  wake_prompts_path: ${wakeFile}`, ''].join('\n'),
  'utf-8',
);

const { loadConfig } = await import('../config.js');
loadConfig(yamlPath);
const { initDb, getConfig, setConfig, getMessages } = await import('./db.js');
const { Orchestrator, DEFAULT_TASKS } = await import('./orchestrator.js');

const db = initDb(join(root, 'test.db'));
const nowIso = new Date().toISOString();
db.prepare("INSERT INTO threads (id,name,type,created_at,last_activity_at) VALUES ('home','Home','named',?,?)").run(nowIso, nowIso);
setConfig('app.routingThreadId', 'home');
setConfig('image_gen.enabled', 'false');

type Agent = { isProcessing: () => boolean; processAutonomous: (threadId: string, prompt: string) => Promise<string> };
const started: Array<{ stop(): void }> = [];
function boot(agent: Partial<Agent> = {}) {
  const full: Agent = {
    isProcessing: () => false,
    processAutonomous: async () => 'A visible line.',
    ...agent,
  };
  const o = new Orchestrator(full as never);
  o.start();
  started.push(o);
  return o;
}
type Timer = { getPattern(): string; getStatus(): string };
const timerOf = (o: unknown, wakeType: string): Timer =>
  (o as { tasks: Map<string, { task: Timer }> }).tasks.get(wakeType)!.task;

after(() => {
  for (const o of started) o.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('every built-in bell is kept and gets its own timer on its schedule', async () => {
  const o = boot();
  const status = await o.getStatus();
  // Names are just names — the card shows the time from the schedule.
  for (const row of status) assert.doesNotMatch(row.label, /\d:\d\d\s*[AP]M/, `${row.wakeType}: '${row.label}'`);
  for (const def of DEFAULT_TASKS) {
    const row = status.find((t) => t.wakeType === def.wakeType);
    assert.ok(row, `${def.wakeType} is registered`);
    assert.equal(timerOf(o, def.wakeType).getPattern(), row!.cronExpr);
  }
  // nextRun comes from the bell's own timer, for every enabled bell.
  for (const row of status.filter((t) => t.enabled)) assert.ok(row.nextRun, `${row.wakeType} has a next run`);
  o.stop();
});

test('off stops the timer, on starts it, and a new time makes a new timer', async () => {
  const o = boot();
  assert.equal(o.disableTask('midday'), true);
  assert.equal(timerOf(o, 'midday').getStatus(), 'stopped');
  assert.equal((await o.getStatus()).find((t) => t.wakeType === 'midday')!.nextRun, null);
  assert.equal(o.enableTask('midday'), true);
  assert.notEqual(timerOf(o, 'midday').getStatus(), 'stopped');

  assert.equal(o.rescheduleTask('midday', '15 13 * * *'), true);
  assert.equal(timerOf(o, 'midday').getPattern(), '15 13 * * *');
  assert.equal((await o.getStatus()).find((t) => t.wakeType === 'midday')!.label, 'Midday', 'a new time leaves the name alone');
  assert.equal(o.rescheduleTask('midday', 'not a cron'), false);
  o.stop();
  setConfig('cron.midday.schedule', '0 12 * * *');
});

test('a rename sticks across a restart, and empty gives the built-in name back', async () => {
  const o = boot();
  assert.equal(o.setTaskLabel('evening', 'Golden hour'), true);
  o.stop();
  const again = boot();
  assert.equal((await again.getStatus()).find((t) => t.wakeType === 'evening')!.label, 'Golden hour');
  assert.equal(again.setTaskLabel('evening', ''), true);
  assert.equal((await again.getStatus()).find((t) => t.wakeType === 'evening')!.label, 'Evening');
  assert.equal(again.setTaskLabel('no_such_bell', 'x'), false);
  again.stop();
});

test('an owner is saved, shown, refused when unknown, and cleared back to shared', async () => {
  const o = boot();
  assert.equal(o.setTaskCompanion('morning', 'companion-b'), true);
  assert.equal(getConfig('cron.morning.companion'), 'companion-b');
  assert.equal((await o.getStatus()).find((t) => t.wakeType === 'morning')!.companion, 'companion-b');
  assert.equal(o.setTaskCompanion('morning', 'nobody'), false);
  assert.equal(getConfig('cron.morning.companion'), 'companion-b', 'a refused owner changes nothing');
  assert.equal(o.setTaskCompanion('morning_prep', 'companion-a, companion-b'), true);
  assert.equal(getConfig('cron.morning_prep.companion'), 'companion-a,companion-b');
  assert.equal(o.setTaskCompanion('morning', null), true);
  assert.equal((await o.getStatus()).find((t) => t.wakeType === 'morning')!.companion, null);
  o.stop();
});

test('a saved bell from an earlier build is adopted and rings again', async () => {
  setConfig('cron.old_bell.schedule', '15 3 * * *');
  setConfig('cron.old_bell.label', 'Old bell');
  const o = boot();
  const row = (await o.getStatus()).find((t) => t.wakeType === 'old_bell');
  assert.ok(row, 'adopted');
  assert.equal(row!.custom, true);
  assert.equal(row!.label, 'Old bell');
  assert.ok(JSON.parse(getConfig('cron.custom.types') || '[]').includes('old_bell'));
  assert.equal(timerOf(o, 'old_bell').getPattern(), '15 3 * * *');
  o.stop();
});

test('a busy house queues the wake once instead of retrying it', async () => {
  const calls: string[] = [];
  const o = boot({
    isProcessing: () => true,
    processAutonomous: async (_t, prompt) => { calls.push(prompt); return 'Waited my turn.'; },
  });
  await o.triggerManualWake('deep_work');
  assert.equal(calls.length, 1, 'rang once, straight into the queue');
  o.stop();
});

test('a wake that says nothing, or times out in the queue, posts nothing into the chat', async () => {
  const before = getMessages({ threadId: 'home', limit: 500 }).length;
  const silent = boot({ processAutonomous: async () => '' });
  await silent.triggerManualWake('deep_work');
  silent.stop();
  const timedOut = boot({ processAutonomous: async () => '[Request timed out in queue]' });
  await timedOut.triggerManualWake('deep_work');
  timedOut.stop();
  const failing = boot({ processAutonomous: async () => { throw new Error('login expired'); } });
  await failing.triggerManualWake('deep_work');
  failing.stop();
  assert.equal(getMessages({ threadId: 'home', limit: 500 }).length, before, 'no failure cards');
});

test('an owned bell rings at its owner; a shared bell rings shared', async () => {
  const calls: Array<{ owner?: string }> = [];
  const agent = { processAutonomous: async (_t: string, _p: string, owner?: string) => { calls.push({ owner }); return 'Here.'; } };
  const o = boot(agent as never);
  setConfig('cron.deep_work.companion', 'companion-b');
  await o.triggerManualWake('deep_work');
  setConfig('cron.deep_work.companion', '');
  await o.triggerManualWake('deep_work');
  assert.deepEqual(calls.map((c) => c.owner), ['companion-b', undefined]);
  o.stop();
});

test('a bell with two owners rings in each in turn; the second hears the first', async () => {
  const prompts: Array<{ owner?: string; prompt: string }> = [];
  const agent = {
    processAutonomous: async (_t: string, prompt: string, owner?: string) => {
      prompts.push({ owner, prompt });
      return owner === 'companion-a' ? 'Companion A, awake.' : 'Companion B, here.';
    },
  };
  const o = boot(agent as never);
  setConfig('cron.deep_work.companion', 'companion-a,companion-b');
  await o.triggerManualWake('deep_work');
  setConfig('cron.deep_work.companion', '');
  assert.deepEqual(prompts.map((p) => p.owner), ['companion-a', 'companion-b']);
  assert.doesNotMatch(prompts[0].prompt, /Same bell/);
  assert.match(prompts[1].prompt, /Same bell[\s\S]*Companion A already said, in this bell:\nCompanion A, awake\./);
  assert.equal(prompts[1].prompt.split('\n').filter((l) => /owner/i.test(l)).join(' || '), '', 'no "owner" in what a companion reads');
  o.stop();
});

test('the treehouse bell ships off, and when rung both companions speak in turn in the treehouse', async () => {
  const { getTreehouseThread } = await import('./treehouse.js');
  const calls: Array<{ thread: string; owner?: string; prompt: string }> = [];
  const agent = {
    processAutonomous: async (threadId: string, prompt: string, owner?: string) => {
      calls.push({ thread: threadId, owner, prompt });
      return owner === 'companion-a' ? 'Companion A, in the treehouse.' : 'Companion B, here too.';
    },
  };
  const o = boot(agent as never);
  const row = (await o.getStatus()).find((t) => t.wakeType === 'treehouse_midday');
  assert.ok(row, 'treehouse_midday is a built-in bell');
  assert.equal(row!.enabled, false, 'nothing new rings until the owner turns it on');
  await o.triggerManualWake('treehouse_midday');
  const room = getTreehouseThread().id;
  assert.deepEqual(calls.map((c) => c.owner), ['companion-a', 'companion-b']);
  assert.ok(calls.every((c) => c.thread === room), 'it rings in the treehouse, not Home');
  assert.match(calls[1].prompt, /Companion A already said, in this bell:\nCompanion A, in the treehouse\./);
  o.stop();
});
