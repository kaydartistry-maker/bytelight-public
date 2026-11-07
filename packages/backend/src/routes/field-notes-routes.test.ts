// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The owner field notes over HTTP: the loopback door the companions write
// through. The shapes asserted here are the contract the phone's Field Notes
// page is built against.
//
// byte-light adaptations: the loopback door is createInternalRoutes() (Aerie
// has a separate internal-server), companions are plain registry rows, and
// config boots on defaults + TZ. Aerie's third test (the phone's door behind
// the login) is not carried: it depends on Aerie's session cookie and
// createWebSession shape; the phone door is the same authMiddleware every
// other byte-light router sits behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TZ = 'America/Chicago';
const tmpRoot = mkdtempSync(join(tmpdir(), 'field-notes-routes-test-'));
process.env.RESONANT_HOME = tmpRoot;
const { loadConfig } = await import('../config.js');
loadConfig(join(tmpRoot, 'no-config.yaml'));

const { initDb, getDb } = await import('../services/db/init.js');
const { fieldNotesToday } = await import('../services/db/field-notes.js');
const { createInternalRoutes } = await import('./internal-routes.js');

const NOTE_KEYS = ['id', 'day', 'companion', 'text', 'createdAt'];

function freshHouse(): void {
  initDb(':memory:');
  getDb().prepare('DELETE FROM companions').run();
  for (const [slug, displayName] of [['example', 'Example'], ['other', 'Other']] as const) {
    getDb().prepare("INSERT INTO companions (id, display_name, brain) VALUES (?, ?, 'test')").run(slug, displayName);
  }
}

async function listen(app: express.Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** The loopback door, as api.ts composes it. */
function internalApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createInternalRoutes());
  return app;
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}

test('the loopback door keeps a note and answers 201 with it, on the owner day unless a day is named', async () => {
  freshHouse();
  const { base, close } = await listen(internalApp());
  try {
    const before = fieldNotesToday();
    const written = await call(base, 'POST', '/internal/field-notes', {
      companion: 'example', text: '  The Claude Code CLI has a new version out. Nothing for you to do.  ',
    });
    const after = fieldNotesToday();
    assert.equal(written.status, 201);
    assert.deepEqual(Object.keys(written.json), ['note']);
    assert.deepEqual(Object.keys(written.json.note), NOTE_KEYS);
    assert.equal(written.json.note.companion, 'example');
    assert.equal(written.json.note.text, 'The Claude Code CLI has a new version out. Nothing for you to do.');
    assert.ok([before, after].includes(written.json.note.day), `today on their calendar, not ${written.json.note.day}`);

    const named = await call(base, 'POST', '/internal/field-notes', {
      companion: 'other', text: 'Nothing touched us yesterday.', day: '2020-01-02',
    });
    assert.equal(named.status, 201);
    assert.equal(named.json.note.day, '2020-01-02');

    const read = await call(base, 'GET', '/internal/field-notes');
    assert.equal(read.status, 200);
    assert.deepEqual(Object.keys(read.json), ['notes']);
    assert.deepEqual(read.json.notes.map((n: any) => n.id), [written.json.note.id, named.json.note.id], 'newest day first');
    for (const note of read.json.notes) assert.deepEqual(Object.keys(note), NOTE_KEYS);

    const one = await call(base, 'GET', '/internal/field-notes?limit=1');
    assert.deepEqual(one.json.notes.map((n: any) => n.id), [written.json.note.id]);
  } finally {
    close();
  }
});

test('the loopback door refuses in one plain sentence and keeps nothing it refused', async () => {
  freshHouse();
  const { base, close } = await listen(internalApp());
  try {
    const attempts: Array<[string, unknown, RegExp]> = [
      ['no body at all', undefined, /companion/],
      ['nobody named', { text: 'Words.' }, /companion/],
      ['a companion who does not live here', { companion: 'nobody', text: 'Words.' }, /nobody/],
      ['no words', { companion: 'example' }, /text/],
      ['only spaces', { companion: 'example', text: '   ' }, /text/],
      ['too many words', { companion: 'example', text: 'a'.repeat(601) }, /600/],
      ['a day that is not a date', { companion: 'example', text: 'Words.', day: 'Oct 22' }, /YYYY-MM-DD/],
    ];
    for (const [what, body, says] of attempts) {
      const refused = await call(base, 'POST', '/internal/field-notes', body);
      assert.equal(refused.status, 400, what);
      assert.deepEqual(Object.keys(refused.json), ['error'], what);
      assert.match(refused.json.error, /^[^\n]+\.$/, `${what}: one plain sentence`);
      assert.match(refused.json.error, says, what);
    }
    const read = await call(base, 'GET', '/internal/field-notes');
    assert.deepEqual(read.json.notes, [], 'nothing refused was kept');
  } finally {
    close();
  }
});
