/**
 * Notes (ported from Aerie) — the companions' side of the sticky-note door.
 *
 * Proves migration 029 makes the table on a fresh DB, and that a companion can
 * leave, list and remove a note. Real express, real socket on 127.0.0.1, real
 * sqlite — requireLocalhost is on every route.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

const tmpRoot = mkdtempSync(join(tmpdir(), 'notes-route-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { loadConfig } = await import('../config.js');
// The note route falls back to the companion name when no sender is given.
loadConfig(join(tmpRoot, 'config.yaml'));
const { initDb, getDb } = await import('../services/db.js');
const { createInternalRoutes } = await import('./internal-routes.js');

let server: Server;
let base = '';

before(async () => {
  initDb(dbPath);
  const app = express();
  app.use(express.json());
  app.use(createInternalRoutes());
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

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
};

describe('notes — internal door', () => {
  it('migration 029 creates the notes table', () => {
    const cols = getDb().prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
    assert.deepEqual(cols.map((c) => c.name), ['id', 'text', 'color', 'timestamp', 'sender']);
  });

  it('a companion leaves a note, lists it, and removes it', async () => {
    const made = await call('POST', '/internal/note', { text: '  water, love  ', sender: 'companion-b', color: 'role:quiet' });
    assert.equal(made.status, 200);
    assert.equal(made.body.sender, 'companion-b');

    const listed = await call('GET', '/internal/notes');
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].text, 'water, love');
    assert.equal(listed.body[0].color, 'role:quiet');

    const gone = await call('DELETE', `/internal/note/${made.body.id}`);
    assert.equal(gone.status, 200);
    assert.equal((await call('GET', '/internal/notes')).body.length, 0);
  });

  it('an unknown colour falls back to the default yellow', async () => {
    const made = await call('POST', '/internal/note', { text: 'hi', color: 'javascript:alert(1)' });
    const row = getDb().prepare('SELECT color FROM notes WHERE id = ?').get(made.body.id) as { color: string };
    assert.equal(row.color, '#fef08a');
  });

  it('refuses an empty note', async () => {
    const res = await call('POST', '/internal/note', { text: '   ' });
    assert.equal(res.status, 400);
  });
});
