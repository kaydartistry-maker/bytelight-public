/**
 * Owner-made bells, the must-speak contract at fire time, and the spontaneous
 * engine — exercised against a real (scratch) database and a real
 * Orchestrator with a recording stand-in for the agent.
 */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'orchestrator-bells-'));
process.env.RESONANT_HOME = root;
// The yaml below says UTC; a TZ in the environment would override it.
process.env.TZ = 'UTC';
writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');
const wakeFile = join(root, 'wake.md');
writeFileSync(
  wakeFile,
  '# Wake Prompts\n\n## deep_work\nDeep work from the file.\n\n## leftover_thing\nNobody rings this one.\n',
  'utf-8',
);
const yamlPath = join(root, 'bytelight.yaml');
writeFileSync(
  yamlPath,
  [
    'identity:',
    '  companion_name: Companion',
    '  user_name: Owner',
    '  timezone: UTC',
    'orchestrator:',
    `  wake_prompts_path: ${wakeFile}`,
    '',
  ].join('\n'),
  'utf-8',
);

const { loadConfig } = await import('../config.js');
loadConfig(yamlPath);
const { initDb, getConfig, setConfig } = await import('./db.js');
const { Orchestrator } = await import('./orchestrator.js');

const db = initDb(join(root, 'test.db'));
const nowIso = new Date().toISOString();
db.prepare("INSERT INTO threads (id,name,type,created_at,last_activity_at) VALUES ('home','Home','named',?,?)").run(nowIso, nowIso);
// The spontaneous contract asks whether the Studio can paint; keep it off so
// the fallback line is what these tests see unless they switch it on.
setConfig('image_gen.enabled', 'false');

type Call = { threadId: string; prompt: string };
function fakeAgent(calls: Call[]) {
  return {
    isProcessing: () => false,
    processAutonomous: async (threadId: string, prompt: string) => {
      calls.push({ threadId, prompt });
      return 'A visible line.';
    },
  };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const started: Array<{ stop(): void }> = [];
function boot(calls: Call[]) {
  const o = new Orchestrator(fakeAgent(calls) as never);
  o.start();
  started.push(o);
  return o;
}

after(() => {
  for (const o of started) o.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// A daily cron half a day away from "now" (timezone is UTC): it never fires
// during the run, and next-run lookups stay short.
const QUIET_CRON = `0 ${(new Date().getUTCHours() + 12) % 24} * * *`;
const QUIET_CRON_2 = `30 ${(new Date().getUTCHours() + 13) % 24} * * *`;

test('a bell is refused without a prompt, with a bad name, a bad cron, or a built-in name', () => {
  const o = boot([]);
  const noPrompt = o.createCustomWake({ wakeType: 'tea_time', cronExpr: QUIET_CRON, label: 'Tea', prompt: '   ' });
  assert.deepEqual(noPrompt, { ok: false, error: 'A bell needs something to say — write its prompt.' });
  assert.equal(o.createCustomWake({ wakeType: 'tea time!', cronExpr: QUIET_CRON, label: 'Tea', prompt: 'x' }).ok, false);
  assert.equal(o.createCustomWake({ wakeType: 'tea_time', cronExpr: 'not a cron', label: 'Tea', prompt: 'x' }).ok, false);
  assert.equal(o.createCustomWake({ wakeType: 'deep_work', cronExpr: QUIET_CRON, label: 'Dup', prompt: 'x' }).ok, false);
  assert.equal(getConfig('cron.tea_time.prompt'), null);
  o.stop();
});

test('a bell cannot take a reserved built-in or manual name, whatever its case', () => {
  const o = boot([]);
  for (const name of ['spontaneous', 'failsafe_gentle', 'manual', 'Spontaneous', 'MANUAL', 'Morning']) {
    const r = o.createCustomWake({ wakeType: name, cronExpr: QUIET_CRON, label: 'X', prompt: 'x' });
    assert.equal(r.ok, false, `'${name}' must be refused`);
    if (!r.ok) assert.match(r.error, /reserved|already a bell/);
    assert.equal(getConfig(`cron.${name}.prompt`), null);
  }
  o.stop();
});

test('a saved bell whose name collides with a reserved name is skipped at boot', () => {
  for (const name of ['spontaneous', 'manual', 'Failsafe_Emergency']) {
    setConfig(`cron.${name}.schedule`, QUIET_CRON);
    setConfig(`cron.${name}.prompt`, 'Should never ring.');
  }
  setConfig('cron.custom.types', JSON.stringify(['spontaneous', 'manual', 'Failsafe_Emergency']));
  try {
    const o = boot([]);
    for (const name of ['spontaneous', 'manual', 'Failsafe_Emergency']) {
      assert.equal(o.isCustomWake(name), false, `'${name}' must not register as a made bell`);
    }
    o.stop();
  } finally {
    for (const name of ['spontaneous', 'manual', 'Failsafe_Emergency']) {
      db.prepare('DELETE FROM config WHERE key LIKE ?').run(`cron.${name}.%`);
    }
    db.prepare("DELETE FROM config WHERE key = 'cron.custom.types'").run();
  }
});

test('a made bell is listed as custom, lives in settings, and its own prompt reaches the wake', async () => {
  const calls: Call[] = [];
  const o = boot(calls);
  const before = readFileSync(wakeFile, 'utf-8');

  const made = o.createCustomWake({ wakeType: 'tea_time', cronExpr: QUIET_CRON, label: 'Tea', prompt: 'Put the kettle on, {user_name}.' });
  assert.deepEqual(made, { ok: true });

  // Settings table, not the prompts file.
  assert.equal(getConfig('cron.tea_time.prompt'), 'Put the kettle on, {user_name}.');
  assert.equal(getConfig('cron.tea_time.schedule'), QUIET_CRON);
  assert.deepEqual(JSON.parse(getConfig('cron.custom.types') || '[]'), ['tea_time']);
  assert.equal(readFileSync(wakeFile, 'utf-8'), before, 'the prompts file must not be touched');

  const status = await o.getStatus();
  const bell = status.find((t) => t.wakeType === 'tea_time');
  assert.ok(bell);
  assert.equal(bell.custom, true);
  assert.equal(bell.category, 'wake');
  assert.match(bell.label, /Tea/);
  assert.equal(status.find((t) => t.wakeType === 'deep_work')?.custom, false);

  await o.triggerManualWake('tea_time');
  await waitFor(() => calls.some((c) => c.prompt.includes('Put the kettle on')));
  const call = calls.find((c) => c.prompt.includes('Put the kettle on'))!;
  assert.match(call.prompt, /Put the kettle on, Owner\./, 'stored prompt with the user name filled in');
  assert.match(call.prompt, /must land at least one in-character line/, 'the must-speak contract rides along');
  assert.equal(call.threadId, 'home');
  o.stop();
});

test('a made bell survives a restart and still rings with its own prompt', async () => {
  const calls: Call[] = [];
  const o = boot(calls);
  const status = await o.getStatus();
  const bell = status.find((t) => t.wakeType === 'tea_time');
  assert.ok(bell, 'reloaded from the settings table at boot');
  assert.equal(bell.custom, true);
  assert.equal(bell.cronExpr, QUIET_CRON);

  await o.triggerManualWake('tea_time');
  await waitFor(() => calls.some((c) => c.prompt.includes('Put the kettle on')));
  o.stop();
});

test('a rescheduled bell keeps its new time across a restart', async () => {
  const o = boot([]);
  assert.equal(o.rescheduleTask('tea_time', QUIET_CRON_2), true);
  o.stop();
  const again = boot([]);
  const bell = (await again.getStatus()).find((t) => t.wakeType === 'tea_time');
  assert.equal(bell?.cronExpr, QUIET_CRON_2);
  again.stop();
});

test('built-in wakes get the file prompt plus the must-speak contract', async () => {
  const calls: Call[] = [];
  const o = boot(calls);
  await o.triggerManualWake('deep_work');
  await waitFor(() => calls.some((c) => c.prompt.includes('Deep work from the file.')));
  const call = calls.find((c) => c.prompt.includes('Deep work from the file.'))!;
  assert.match(call.prompt, /do not answer \[SILENT\]/);
  assert.match(call.prompt, /Owner being asleep, away, or slow to answer is not a reason to stand down/);
  o.stop();
});

test('the prompt report marks a made bell as editable-in-settings and lists orphan file sections', () => {
  const o = boot([]);
  const report = o.getWakePromptReport();
  const tea = report.prompts.find((p) => p.wakeType === 'tea_time');
  assert.ok(tea);
  assert.equal(tea.body, 'Put the kettle on, {user_name}.');
  assert.equal(tea.source, 'file');
  assert.equal(tea.hasDefault, false);
  assert.equal(tea.custom, true);

  const deep = report.prompts.find((p) => p.wakeType === 'deep_work');
  assert.equal(deep?.source, 'file');
  assert.equal(deep?.body, 'Deep work from the file.');
  assert.equal(deep?.defaultPrompt, null, 'no built-in text to compare against');

  const spontaneous = report.prompts.find((p) => p.wakeType === 'spontaneous');
  assert.ok(spontaneous, 'spontaneous appears as a known wake');

  assert.deepEqual(report.unusedSections, [{ key: 'leftover_thing', body: 'Nobody rings this one.' }]);
  o.stop();
});

test('an overridden built-in reports its built-in default for comparison', () => {
  writeFileSync(wakeFile, readFileSync(wakeFile, 'utf-8') + '\n## midday\nMy own midday.\n', 'utf-8');
  const o = boot([]);
  const midday = o.getWakePromptReport().prompts.find((p) => p.wakeType === 'midday');
  assert.equal(midday?.source, 'file');
  assert.equal(midday?.body, 'My own midday.');
  assert.match(midday?.defaultPrompt ?? '', /Midday check-in/);
  o.stop();
});

test('editing a made bell prompt writes settings, never the prompts file', () => {
  const o = boot([]);
  const before = readFileSync(wakeFile, 'utf-8');
  assert.equal(o.isCustomWake('tea_time'), true);
  assert.equal(o.setCustomWakePrompt('tea_time', 'Second pot.'), true);
  assert.equal(getConfig('cron.tea_time.prompt'), 'Second pot.');
  assert.equal(readFileSync(wakeFile, 'utf-8'), before);
  assert.equal(o.setCustomWakePrompt('deep_work', 'nope'), false, 'built-ins are not settings-backed');
  o.stop();
});

test('built-ins cannot be deleted; a made bell can, and its settings go with it', async () => {
  const o = boot([]);
  const builtIn = o.deleteCustomWake('deep_work');
  assert.equal(builtIn.ok, false);
  assert.match((builtIn as { error: string }).error, /turn it off/);
  assert.equal(o.deleteCustomWake('no_such_bell').ok, false);

  assert.deepEqual(o.deleteCustomWake('tea_time'), { ok: true });
  assert.equal((await o.getStatus()).some((t) => t.wakeType === 'tea_time'), false);
  for (const key of ['label', 'schedule', 'prompt', 'enabled', 'companion']) assert.equal(getConfig(`cron.tea_time.${key}`), null);
  assert.deepEqual(JSON.parse(getConfig('cron.custom.types') || '[]'), []);
  assert.equal(getConfig('cron.tea_time.schedule'), null);
  o.stop();

  const again = boot([]);
  assert.equal((await again.getStatus()).some((t) => t.wakeType === 'tea_time'), false, 'gone after restart too');
  again.stop();
});

test('spontaneous defaults: off, two a day, 10:00 to 02:00, nothing pending', () => {
  const o = boot([]);
  assert.deepEqual(o.getSpontaneousConfig(), { enabled: false, maxPerDay: 2, windowStart: 10, windowEnd: 26, pendingToday: 0 });
  o.stop();
});

test('spontaneous: a settings change re-rolls, persists the day, restores on boot, never logs times, clears on stop', () => {
  const realRandom = Math.random;
  Math.random = () => 0.99; // roll the maximum count
  try {
    const o = boot([]);
    o.setSpontaneousConfig({ enabled: true, maxPerDay: 3, windowStart: 0, windowEnd: 48 });
    const cfg = o.getSpontaneousConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.pendingToday, 3);
    const rolledFor = getConfig('spontaneous.rolled_for');
    const times = JSON.parse(getConfig('spontaneous.rolled_times') || '[]') as number[];
    assert.equal(times.length, 3);
    assert.ok(rolledFor && /^\d{4}-\d{2}-\d{2}$/.test(rolledFor));
    assert.ok(times.every((t) => t > Date.now()));

    o.stop();
    assert.equal(o.getSpontaneousConfig().pendingToday, 0, 'stop clears every pending timer');

    // A restart restores the same day instead of re-rolling it.
    Math.random = () => 0; // would roll zero if it re-rolled
    const again = boot([]);
    assert.equal(again.getSpontaneousConfig().pendingToday, 3);
    assert.equal(getConfig('spontaneous.rolled_times'), JSON.stringify(times));
    again.stop();

    const logPath = join(import.meta.dirname, '..', '..', '..', '..', 'logs', 'orchestrator.log');
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, 'utf-8');
      for (const t of times) {
        assert.equal(log.includes(String(t)), false, 'fire times are never logged');
        assert.equal(log.includes(new Date(t).toISOString()), false, 'fire times are never logged');
      }
    }

    // Switching off clears the day.
    const third = boot([]);
    third.setSpontaneousConfig({ enabled: false });
    assert.equal(third.getSpontaneousConfig().pendingToday, 0);
    third.stop();
  } finally {
    Math.random = realRandom;
  }
});

// The spontaneous day runs 03:00 to 03:00 local, so a window that ends at
// 26 (2 AM) still belongs to the evening it started in.
function withClock<T>(iso: string, fn: () => T): T {
  mock.timers.enable({ apis: ['Date'], now: new Date(iso).getTime() });
  try { return fn(); } finally { mock.timers.reset(); }
}

test('spontaneous: a restart at 00:40 keeps the prior day\'s pending 01:30 wake', () => {
  const realRandom = Math.random;
  Math.random = () => 0; // would roll zero if it re-rolled
  try {
    const pending = Date.parse('2026-10-19T01:30:00Z');
    setConfig('spontaneous.enabled', 'true');
    setConfig('spontaneous.rolled_for', '2026-10-18');
    setConfig('spontaneous.rolled_times', JSON.stringify([pending]));
    withClock('2026-10-19T00:40:00Z', () => {
      const o = boot([]);
      assert.equal(o.getSpontaneousConfig().pendingToday, 1, 'the 01:30 wake still stands');
      assert.equal(getConfig('spontaneous.rolled_for'), '2026-10-18');
      assert.equal(getConfig('spontaneous.rolled_times'), JSON.stringify([pending]));
      o.stop();
    });
  } finally {
    Math.random = realRandom;
    setConfig('spontaneous.enabled', 'false');
  }
});

test('spontaneous: the day is rolled by its own 03:00 timer, which also covers a missed 03:00', () => {
  const o = boot([]);
  const roll = (o as unknown as { spontaneousRollTask: { getPattern(): string } | null }).spontaneousRollTask;
  assert.ok(roll, 'start() sets the roll timer');
  assert.equal(roll!.getPattern(), '0 3 * * *');
  o.stop();
  assert.equal((o as unknown as { spontaneousRollTask: unknown }).spontaneousRollTask, null, 'stop() clears it');
});
