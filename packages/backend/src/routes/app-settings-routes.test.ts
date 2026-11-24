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
const { createAppSettingsRoutes } = await import('./app-settings-routes.js');
const router = createAppSettingsRoutes();
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

describe('phone persistence routes', () => {
  it('round trips setup blobs including extras and empty optional fields', async () => {
    assert.deepEqual(await (await call('GET', '/app-settings')).json(), { settings: null });
    const settings = { theme: null, contacts: {}, appSettings: { userName: 'User' }, extras: { bookmarks: '[]' } };
    assert.equal((await call('PUT', '/app-settings', { settings })).status, 200);
    assert.deepEqual(await (await call('GET', '/app-settings')).json(), { settings });
    assert.ok(getDb().prepare("SELECT value FROM config WHERE key = 'phone.app-settings'").get());
    assert.equal((await call('PUT', '/app-settings', { settings: [] })).status, 400);
    assert.deepEqual(await (await call('GET', '/app-settings')).json(), { settings });
  });
  it('loads an owner card and patches only supplied fields', async () => {
    const initial = await (await call('GET', '/owner-card')).json();
    assert.equal(initial.name, 'User');
    assert.deepEqual(initial.card, { bio: '', status: '' });
    await call('PATCH', '/owner-card', { bio: 'Hello', phone: '123' });
    const result = await (await call('PATCH', '/owner-card', { status: 'Here' })).json();
    assert.deepEqual(result.card, { bio: 'Hello', status: 'Here' });
    assert.equal((await call('PATCH', '/owner-card', { bio: 123 })).status, 400);
    assert.deepEqual(await (await call('GET', '/owner-card')).json(), result);
  });
});
