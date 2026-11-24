/**
 * Push subscribe idempotency.
 *
 * The subscribe route mints a fresh id on every call while the table is keyed
 * on id — so the same device endpoint registering twice used to leave two
 * identical rows. These tests prove a re-subscribe replaces the prior
 * registration for that endpoint instead of duplicating it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

const tmpRoot = mkdtempSync(join(tmpdir(), 'push-routes-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb, listPushSubscriptions, createWebSession } = await import('../services/db.js');
const { createPushRoutes } = await import('./push-routes.js');

let server: Server;
let base = '';

before(async () => {
  initDb(dbPath);
  createWebSession({ id: 'push-idempotency-owner', token: 'isolated-idempotency-owner', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const app = express();
  app.use(express.json());
  app.use(createPushRoutes());
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server?.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'bytelight_session=isolated-idempotency-owner', origin: base.replace('http:', 'https:'), 'x-forwarded-proto': 'https' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

describe('POST /push/subscribe', () => {
  it('subscribing twice with the same endpoint leaves exactly one row', async () => {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/same-device',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      deviceLabel: 'the operator phone',
    };

    const first = await post('/push/subscribe', sub);
    assert.equal(first.status, 200);
    assert.equal(first.body.success, true);
    assert.ok(first.body.id);

    const second = await post('/push/subscribe', sub);
    assert.equal(second.status, 200);
    assert.equal(second.body.success, true);

    const rows = listPushSubscriptions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endpoint, sub.endpoint);
    assert.equal(rows[0].id, second.body.id);
  });

  it('different endpoints still get their own rows', async () => {
    const other = await post('/push/subscribe', {
      endpoint: 'https://fcm.googleapis.com/fcm/send/other-device',
      keys: { p256dh: 'p256dh-key-2', auth: 'auth-key-2' },
    });
    assert.equal(other.status, 200);
    assert.equal(listPushSubscriptions().length, 2);
  });
});
