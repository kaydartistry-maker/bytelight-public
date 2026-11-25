/**
 * Phase 1.4 (backend half) — the API tells clients who really lives here.
 *
 *  - GET /api/companions carries the local brain id and the resident ids, for
 *    0, 1, 2 and 3 residents (a visitor on another brain is listed, never a
 *    resident);
 *  - GET /api/profiles has a profile for every registered companion plus the
 *    owner and the fallback, keeps stored profiles for historical authors who
 *    are no longer registered, and never invents one for someone absent.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import express from 'express';

import { getDb, initDb, setConfig } from '../services/db.js';
import { createRoomsRoutes } from './rooms-routes.js';
import { createProfilesRoutes } from './profiles-routes.js';

const root = mkdtempSync(join(tmpdir(), 'residents-api-'));
let n = 0;

function house(rows: ReadonlyArray<[id: string, name: string, brain?: string]>): void {
  try { getDb().close(); } catch { /* none */ }
  const db = initDb(join(root, `h-${n++}.db`));
  const ins = db.prepare('INSERT INTO companions (id, display_name, brain, slug, sort_order) VALUES (?, ?, ?, ?, ?)');
  rows.forEach(([id, name, brain], i) => ins.run(id, name, brain ?? 'companion-a-b', id, i));
}

async function get(path: string): Promise<Record<string, unknown>> {
  const app = express();
  app.use(express.json());
  app.use('/api', createRoomsRoutes());
  app.use('/api', createProfilesRoutes());
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

for (const [label, rows, residents] of [
  ['0 residents', [], []],
  ['1 resident', [['alpha', 'Alpha']], ['alpha']],
  ['2 residents', [['alpha', 'Alpha'], ['beta', 'Beta']], ['alpha', 'beta']],
  ['3 residents + a visitor', [['alpha', 'Alpha'], ['beta', 'Beta'], ['gamma', 'Gamma'], ['guest', 'Guest', 'elsewhere']], ['alpha', 'beta', 'gamma']],
] as const) {
  test(`GET /api/companions names the local brain and its residents (${label})`, async () => {
    house(rows as ReadonlyArray<[string, string, string?]>);
    const body = await get('/api/companions');
    assert.equal(body.localBrainId, 'companion-a-b');
    assert.deepEqual(body.residents, residents);
    assert.equal((body.companions as unknown[]).length, rows.length);
  });

  test(`GET /api/profiles has exactly the registry plus user and fallback (${label})`, async () => {
    house(rows as ReadonlyArray<[string, string, string?]>);
    const body = await get('/api/profiles');
    const expected = [...rows.map((r) => r[0]), 'user', 'fallback'].sort();
    assert.deepEqual(Object.keys(body).sort(), expected);
    for (const [id, name] of rows) assert.equal((body[id] as { name: string }).name, name);
  });
}

test('stored profiles win, and a historical author keeps his saved profile', async () => {
  house([['alpha', 'Alpha']]);
  setConfig('profiles', JSON.stringify({
    alpha: { name: 'Alpha Prime', emoji: '⭐', image: '/x.png' },
    former: { name: 'Former', emoji: '🕯️', image: null },
  }));
  const body = await get('/api/profiles');
  assert.deepEqual(body.alpha, { name: 'Alpha Prime', emoji: '⭐', image: '/x.png' });
  assert.deepEqual(body.former, { name: 'Former', emoji: '🕯️', image: null });
  assert.equal('companion-a' in body, false, 'nobody absent is invented');
});
