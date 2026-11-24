import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { initDb } from './init.js';
import { issuePairingToken } from './owner-pairing.js';
test('independent SQLite connections race: exactly one committed session', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.pairing-race-'));
  const file = join(dir, 'test.sqlite');
  const db = initDb(file);
  const token = issuePairingToken();
  const script = `
    import { initDb } from ${JSON.stringify(new URL('./init.ts', import.meta.url).href)};
    import { consumePairingToken } from ${JSON.stringify(new URL('./owner-pairing.ts', import.meta.url).href)};
    const db = initDb(process.argv[1]);
    process.on('message', token => {
      try { process.send({ consumed: !!consumePairingToken(token) }); }
      finally { db.close(); process.disconnect(); }
    });
    process.send({ ready: true });
  `;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  try {
    await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
      child.once('message', message => (message as { ready: boolean }).ready ? resolve() : reject(new Error('Not ready')));
      child.once('error', reject); child.once('exit', code => { if (code) reject(new Error('Worker failed')); });
    })));
    const results = children.map(child => new Promise<boolean>((resolve, reject) => { child.once('message', m => resolve((m as { consumed: boolean }).consumed)); child.once('error', reject); }));
    children.forEach(child => child.send(token));
    assert.equal((await Promise.all(results)).filter(Boolean).length, 1);
    await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()))));
    const row = db.prepare('SELECT COUNT(*) AS count FROM web_sessions').get() as { count: number };
    assert.equal(row.count, 1);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
