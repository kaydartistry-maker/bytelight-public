import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'rooms-routes-test-'));
process.env.RESONANT_HOME = tmpRoot;
const { loadConfig } = await import('../config.js');
loadConfig(join(tmpRoot, 'no-config.yaml'));
const { initDb, getDb } = await import('../services/db/init.js');
const { createRoomsRoutes } = await import('./rooms-routes.js');
const router = createRoomsRoutes();
before(() => { initDb(':memory:'); });
after(() => {
  getDb().close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// Exercise Express routing and the real database without requiring a listening socket.
function call(method: string, path: string, body?: unknown): Promise<{
  status: number; json: () => Promise<any>;
}> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { resolve({ status, json: async () => value }); return this; },
    } as Response;
    router({ method, url: path, body, headers: {} } as Request, res, (err?: unknown) => {
      reject(err ?? new Error(`No route matched ${method} ${path}`));
    });
  });
}

describe('companion routes', () => {
  it('rejects deletion of both core residents with 409 and preserves them', async () => {
    for (const id of ['companion-a', 'companion-b']) {
      const before = getDb().prepare('SELECT * FROM companions WHERE id = ?').get(id);
      const res = await call('DELETE', `/companions/${id}`);
      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /Core residents.*cannot be deleted/);
      assert.deepEqual(getDb().prepare('SELECT * FROM companions WHERE id = ?').get(id), before);
    }
  });

  it('deletes non-core companions and returns 404 for missing companions', async () => {
    for (const id of ['companion-c', 'future-resident']) {
      getDb().prepare("INSERT INTO companions (id, display_name, brain) VALUES (?, 'Test', 'test')").run(id);
      const res = await call('DELETE', `/companions/${id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(getDb().prepare('SELECT 1 FROM companions WHERE id = ?').get(id), undefined);
      const missing = await call('DELETE', `/companions/${id}`);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'Companion not found' });
    }
  });

  it('PATCH accepts accent_color, persists it, and gives explicit color precedence', async () => {
    for (const [body, expected] of [
      [{ accent_color: '#123456' }, '#123456'],
      [{ accent_color: '#abcdef', color: '#654321' }, '#654321'],
      [{ accent_color: null }, null],
    ] as const) {
      const res = await call('PATCH', '/companions/companion-a', body);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).companion.color, expected);
      assert.equal((getDb().prepare('SELECT color FROM companions WHERE id = ?').get('companion-a') as { color: string | null }).color, expected);
    }
  });
});

it('creates a companion with the phone payload and rejects duplicates and invalid cards', async () => {
  const body = { slug: 'new_companion', displayName: 'Nova', emoji: '🌟', color: '#123456', avatarUrl: '/avatar.png' };
  const result = await call('POST', '/companions', body);
  assert.equal(result.status, 201);
  const { companion } = await result.json();
  assert.equal(companion.id, body.slug);
  assert.equal(companion.display_name, body.displayName);
  assert.equal(companion.avatar, body.avatarUrl);
  assert.equal(companion.emoji, body.emoji);
  const listed = await (await call('GET', '/companions')).json();
  assert.deepEqual(listed.companions.find((c: any) => c.id === body.slug), companion);
  assert.equal((await call('POST', '/companions', body)).status, 409);
  assert.equal((await call('POST', '/companions', { ...body, slug: '../bad' })).status, 400);
});
