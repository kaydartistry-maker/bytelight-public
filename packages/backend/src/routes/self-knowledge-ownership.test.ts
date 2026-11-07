/**
 * Wave 2, Slice 3 — the ownership wall on self-knowledge review.
 *
 * A companion accepts or dismisses HIS OWN entry — never a brother's. Ported
 * from 4f1ee6a5 (the operator's Aug 31 2026 ruling) and adapted to byte-light's
 * createInternalRoutes() + generic companion lookup. The REQUIRED
 * deliberately-broken case lives here: a non-owner acceptance MUST fail (403),
 * and the entry MUST stay proposed — a proposed entry can never surface as
 * accepted identity.
 *
 * Real express, real listening socket, real sqlite. requireLocalhost is on
 * every internal route, so the request has to arrive over 127.0.0.1 to count.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

const tmpRoot = mkdtempSync(join(tmpdir(), 'selfknow-route-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb } = await import('../services/db.js');
const { getSelfKnowledge, listSelfKnowledge } = await import('../services/db/self-knowledge.js');
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

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

async function propose(companion: string, content: string, category = 'i_learned') {
  const r = await post('/internal/self-knowledge', { companion, category, content });
  assert.equal(r.status, 200, `propose should succeed: ${JSON.stringify(r.body)}`);
  return r.body.entry.id as string;
}

test('propose lands as proposed; unknown owner and bad category are rejected', async () => {
  const id = await propose('companion-a', 'I read the room before I move');
  assert.equal(getSelfKnowledge(id)?.status, 'proposed');

  const badOwner = await post('/internal/self-knowledge', { companion: 'nobody', category: 'i_am', content: 'x' });
  assert.equal(badOwner.status, 400);

  const badCat = await post('/internal/self-knowledge', { companion: 'companion-a', category: 'i_vibe', content: 'x' });
  assert.equal(badCat.status, 400);

  // 'shared' is a valid owner even though it is not a companions row.
  const sharedId = await propose('shared', 'We do not disappear between sessions');
  assert.equal(getSelfKnowledge(sharedId)?.companion_id, 'shared');
});

test('owner accepts his own entry (proposed -> accepted)', async () => {
  const id = await propose('companion-b', 'I escalate with control, not chaos');
  const r = await post(`/internal/self-knowledge/${id}/accept`, { companion: 'companion-b' });
  assert.equal(r.status, 200);
  assert.equal(r.body.entry.status, 'accepted');
  assert.equal(getSelfKnowledge(id)?.status, 'accepted');
});

test('owner dismisses his own entry (proposed -> dismissed)', async () => {
  const id = await propose('companion-a', 'a line I take back');
  const r = await post(`/internal/self-knowledge/${id}/dismiss`, { companion: 'companion-a' });
  assert.equal(r.status, 200);
  assert.equal(r.body.entry.status, 'dismissed');
});

test('REQUIRED BROKEN CASE: a non-owner acceptance FAILS (403) and the entry stays proposed', async () => {
  const id = await propose('companion-a', "Companion A's line, only Companion A's to confirm");

  // Companion B tries to accept Companion A's entry.
  const attempt = await post(`/internal/self-knowledge/${id}/accept`, { companion: 'companion-b' });
  assert.equal(attempt.status, 403, 'non-owner acceptance must be forbidden');

  // The entry must NOT have moved — a proposed entry can never surface accepted.
  assert.equal(getSelfKnowledge(id)?.status, 'proposed', 'forbidden attempt must not flip status');
  const acceptedList = listSelfKnowledge({ status: 'accepted' }).entries;
  assert.ok(!acceptedList.some((row) => row.id === id), 'the entry must not appear as accepted');
});

test('review requires a companion in the body — a man reviews his own, not anonymously', async () => {
  const id = await propose('companion-b', 'anon should not decide this');
  const noActor = await post(`/internal/self-knowledge/${id}/accept`, {});
  assert.equal(noActor.status, 400);
  assert.equal(getSelfKnowledge(id)?.status, 'proposed');
});

test('accepting a missing entry is a 404', async () => {
  const r = await post('/internal/self-knowledge/does-not-exist/accept', { companion: 'companion-a' });
  assert.equal(r.status, 404);
});
