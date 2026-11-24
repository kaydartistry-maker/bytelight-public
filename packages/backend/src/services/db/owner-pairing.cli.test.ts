import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './init.js';
import { pairingHash } from './owner-pairing.js';
const exec = promisify(execFile);
test('offline CLI prints exactly one fragment pairing URL; safe override and verifier only', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.pairing-cli-'));
  const file = join(dir, 'test.sqlite');
  const db = initDb(file);
  const script = fileURLToPath(new URL('../../../scripts/pair-device.ts', import.meta.url));
  try {
    for (const origin of [undefined, 'https://owner.example:8443']) {
      const args = ['--import', 'tsx', script, file, ...(origin ? [origin] : [])];
      const { stdout } = await exec(process.execPath, args);
      const urls = stdout.split('\n').filter(line => line.startsWith('https://'));
      assert.equal(urls.length, 1); assert.equal(stdout.trim().split('\n').length, 1);
      const url = new URL(urls[0]); assert.equal(url.origin, origin || 'https://64.225.47.42.nip.io');
      assert.equal(url.pathname, '/pair'); assert.equal(url.search, '');
      const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
      assert.match(token, /^[a-f0-9]{64}$/); assert.equal(stdout.split(token).length, 2);
      const row = db.prepare('SELECT * FROM owner_pairing_tokens WHERE token_hash = ?').get(pairingHash(token));
      assert.ok(row); assert.ok(!JSON.stringify(row).includes(token));
    }
    for (const origin of ['http://owner.example', 'https://user:pass@owner.example', 'https://owner.example/path', 'https://owner.example?token=bad']) {
      await assert.rejects(exec(process.execPath, ['--import', 'tsx', script, file, origin]));
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM owner_pairing_tokens').get() as { n: number }; assert.equal(count.n, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
