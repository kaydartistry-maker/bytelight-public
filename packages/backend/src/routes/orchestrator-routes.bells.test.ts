/**
 * HTTP surface for owner-made bells and spontaneous wakes.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const root = mkdtempSync(join(tmpdir(), 'orchestrator-routes-bells-'));
process.env.RESONANT_HOME = root;
writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');
const wakeFile = join(root, 'wake.md');
writeFileSync(wakeFile, '# Wake Prompts\n\n## deep_work\nDeep work from the file.\n', 'utf-8');
const yamlPath = join(root, 'bytelight.yaml');
writeFileSync(
  yamlPath,
  ['identity:', '  user_name: Owner', '  timezone: UTC', 'orchestrator:', `  wake_prompts_path: ${wakeFile}`, ''].join('\n'),
  'utf-8',
);

const { loadConfig } = await import('../config.js');
loadConfig(yamlPath);
const { initDb, getConfig } = await import('../services/db.js');
const { Orchestrator } = await import('../services/orchestrator.js');
const { createOrchestratorRoutes } = await import('./orchestrator-routes.js');

const db = initDb(join(root, 'test.db'));
const orchestrator = new Orchestrator({ isProcessing: () => false, processAutonomous: async () => 'ok' } as never);
orchestrator.start();

const app = express();
app.use(express.json());
app.locals.orchestrator = orchestrator;
app.use('/api', createOrchestratorRoutes());
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/orchestrator`;

after(async () => {
  orchestrator.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('POST /orchestrator/tasks refuses a reserved name with a clear 400', async () => {
  for (const wakeType of ['spontaneous', 'manual']) {
    const res = await send('POST', '/tasks', { wakeType, cronExpr: '0 9 * * *', prompt: 'x' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /reserved/);
  }
});

test('POST /orchestrator/tasks validates name, cron and prompt', async () => {
  let res = await send('POST', '/tasks', { wakeType: 'tea time', cronExpr: '0 9 * * *', prompt: 'x' });
  assert.equal(res.status, 400);
  res = await send('POST', '/tasks', { wakeType: 'tea_time', prompt: 'x' });
  assert.equal(res.status, 400);
  res = await send('POST', '/tasks', { wakeType: 'tea_time', cronExpr: 'nope', prompt: 'x' });
  assert.equal(res.status, 400);
  res = await send('POST', '/tasks', { wakeType: 'tea_time', cronExpr: '0 9 * * *', prompt: '  ' });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, 'A bell needs something to say — write its prompt.');
});

test('POST makes a bell listed as custom; the prompt lives in settings', async () => {
  const before = readFileSync(wakeFile, 'utf-8');
  const res = await send('POST', '/tasks', { wakeType: 'tea_time', cronExpr: '0 9 * * *', label: 'Tea', prompt: 'Kettle on.' });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { success: boolean; tasks: Array<{ wakeType: string; custom: boolean; label: string }> };
  assert.equal(data.success, true);
  const bell = data.tasks.find((t) => t.wakeType === 'tea_time');
  assert.equal(bell?.custom, true);
  assert.equal(bell?.label, 'Tea');
  assert.equal(getConfig('cron.tea_time.prompt'), 'Kettle on.');
  assert.equal(readFileSync(wakeFile, 'utf-8'), before);

  const status = (await (await send('GET', '/status')).json()) as { tasks: Array<{ wakeType: string; custom: boolean }> };
  assert.equal(status.tasks.find((t) => t.wakeType === 'deep_work')?.custom, false);
});

test('PUT wake-prompts on a made bell rewrites its settings prompt, not the file', async () => {
  const before = readFileSync(wakeFile, 'utf-8');
  const res = await send('PUT', '/wake-prompts/tea_time', { content: 'Second pot.' });
  assert.equal(res.status, 200);
  assert.equal(getConfig('cron.tea_time.prompt'), 'Second pot.');
  assert.equal(readFileSync(wakeFile, 'utf-8'), before);
  const report = (await res.json()) as { prompts: Array<{ wakeType: string; body: string }> };
  assert.equal(report.prompts.find((p) => p.wakeType === 'tea_time')?.body, 'Second pot.');

  const reset = await send('DELETE', '/wake-prompts/tea_time');
  assert.equal(reset.status, 400, 'a made bell has no default to reset to');
  assert.equal(getConfig('cron.tea_time.prompt'), 'Second pot.');
});

test('DELETE refuses built-ins and removes made bells', async () => {
  let res = await send('DELETE', '/tasks/deep_work');
  assert.equal(res.status, 400);
  res = await send('DELETE', '/tasks/bad-name!');
  assert.equal(res.status, 400);
  res = await send('DELETE', '/tasks/tea_time');
  assert.equal(res.status, 200);
  const data = (await res.json()) as { tasks: Array<{ wakeType: string }> };
  assert.equal(data.tasks.some((t) => t.wakeType === 'tea_time'), false);
  assert.equal(getConfig('cron.tea_time.prompt'), null);
});

test('GET/PATCH /orchestrator/spontaneous round-trips the dice settings', async () => {
  const initial = await (await send('GET', '/spontaneous')).json();
  assert.deepEqual(initial, { enabled: false, maxPerDay: 2, windowStart: 10, windowEnd: 26, pendingToday: 0 });

  const res = await send('PATCH', '/spontaneous', { enabled: true, maxPerDay: 0 });
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.equal(data.success, true);
  assert.equal(data.enabled, true);
  assert.equal(data.maxPerDay, 0);
  assert.equal(data.pendingToday, 0, 'max 0 rolls nothing');
  assert.equal(getConfig('spontaneous.enabled'), 'true');

  const bad = await send('PATCH', '/spontaneous', { maxPerDay: -1 });
  assert.equal(bad.status, 400);
});
