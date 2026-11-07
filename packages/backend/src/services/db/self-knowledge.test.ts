// Self-knowledge DB layer — lifecycle, attribution, persistence.
// House pattern: node:test + assert/strict, RESONANT_HOME tmpdir (see
// db.reroll.test.ts). Ownership ENFORCEMENT lives at the route layer; here we
// prove the storage semantics the ownership check relies on, including a
// deliberately-broken non-owner acceptance case at the read-path level.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'selfknow-test-'));
process.env.RESONANT_HOME = root;
writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb, getDb } = await import('../db.js');
const {
  createSelfKnowledge,
  getSelfKnowledge,
  listSelfKnowledge,
  reviewSelfKnowledge,
  updateSelfKnowledgeContent,
  deleteSelfKnowledge,
  searchAcceptedSelfKnowledge,
  isSelfKnowledgeCategory,
} = await import('./self-knowledge.js');

const dbPath = join(root, 'test.db');
initDb(dbPath);

after(() => { rmSync(root, { recursive: true, force: true }); });

// Small helper to make an entry (proposed by default).
let seq = 0;
function make(companionId: string, content: string, opts: Partial<{ status: 'proposed' | 'accepted' | 'dismissed'; category: 'i_am' | 'i_tend_to' | 'i_believe' | 'i_learned' }> = {}) {
  return createSelfKnowledge({
    id: `sk-${++seq}`,
    companionId,
    category: opts.category || 'i_learned',
    content,
    status: opts.status,
  });
}

test('category guard accepts the four drawers and rejects anything else', () => {
  for (const c of ['i_am', 'i_tend_to', 'i_believe', 'i_learned']) {
    assert.equal(isSelfKnowledgeCategory(c), true);
  }
  for (const bad of ['I_AM', 'i_feel', '', null, 42, undefined]) {
    assert.equal(isSelfKnowledgeCategory(bad), false);
  }
});

test('proposal lifecycle: proposed -> accepted stamps reviewed_at and status', () => {
  const e = make('companion-a', 'I steady the room before I speak');
  assert.equal(e.status, 'proposed');
  assert.equal(e.reviewed_at, null);

  const accepted = reviewSelfKnowledge(e.id, 'accepted', 'companion-a');
  assert.equal(accepted?.status, 'accepted');
  assert.ok(accepted?.reviewed_at, 'accepted entry must stamp reviewed_at');

  // Re-read from storage confirms the transition persisted.
  assert.equal(getSelfKnowledge(e.id)?.status, 'accepted');
});

test('proposal lifecycle: proposed -> dismissed, and a dismissed entry is NEVER readable as accepted', () => {
  const e = make('companion-b', 'I keep score of who owes what');
  const dismissed = reviewSelfKnowledge(e.id, 'dismissed', 'companion-b');
  assert.equal(dismissed?.status, 'dismissed');

  // The read paths that surface identity must never return a dismissed entry as
  // accepted. (1) status-filtered list, (2) accepted-keyword search.
  const acceptedList = listSelfKnowledge({ status: 'accepted' }).entries;
  assert.ok(!acceptedList.some((row) => row.id === e.id), 'dismissed entry leaked into accepted list');

  const hit = searchAcceptedSelfKnowledge('owes', 10);
  assert.ok(!hit.some((row) => row.id === e.id), 'dismissed entry leaked into accepted keyword search');
});

test('DELIBERATELY BROKEN CASE: the DB review is actor-blind, so ownership MUST be enforced above it', () => {
  // reviewSelfKnowledge(id, status, actor) does NOT itself check that `actor`
  // owns the entry — by design, so a lower layer stays simple. This test pins
  // that reality: if a non-owner slug is passed straight through (the bug the
  // route guard prevents), the entry WOULD flip. The route layer is what makes
  // this impossible in practice (self-knowledge-ownership.test.ts). If this
  // assertion ever changes, the ownership guarantee moved and the route test
  // must be re-audited.
  const e = make('companion-a', 'A line only Companion A should own');
  const wrongActor = reviewSelfKnowledge(e.id, 'accepted', 'companion-b'); // simulates a bypass
  assert.equal(wrongActor?.status, 'accepted', 'DB layer is intentionally actor-blind — guard belongs at the route');
  // And the receipt would then falsely name companion-b — which is exactly why the
  // route refuses this before it ever reaches here.
  const receipt = getDb().prepare(
    "SELECT actor FROM memory_ledger WHERE subject_id = ? AND action = 'self_knowledge.accept' ORDER BY id DESC LIMIT 1"
  ).get(e.id) as { actor: string } | undefined;
  assert.equal(receipt?.actor, 'companion-b');
});

test('attribution: the actor passed in is exactly who the receipt names; default is the operator', () => {
  const a = make('companion-b', 'I test before I trust a build');
  reviewSelfKnowledge(a.id, 'accepted', 'companion-b');
  const r1 = getDb().prepare(
    "SELECT actor, action FROM memory_ledger WHERE subject_id = ? ORDER BY id DESC LIMIT 1"
  ).get(a.id) as { actor: string; action: string };
  assert.equal(r1.actor, 'companion-b');
  assert.equal(r1.action, 'self_knowledge.accept');

  const b = make('companion-a', 'I hold the center when it wobbles');
  reviewSelfKnowledge(b.id, 'accepted'); // no actor -> defaults to 'user' (the operator)
  const r2 = getDb().prepare(
    "SELECT actor FROM memory_ledger WHERE subject_id = ? ORDER BY id DESC LIMIT 1"
  ).get(b.id) as { actor: string };
  assert.equal(r2.actor, 'user', 'default reviewer attribution is the operator');
});

test('reword updates content, writes a reword receipt, and keeps status', () => {
  const e = make('companion-a', 'orig wording', { status: 'accepted' });
  const updated = updateSelfKnowledgeContent(e.id, 'sharper wording', 'companion-a');
  assert.equal(updated?.content, 'sharper wording');
  assert.equal(updated?.status, 'accepted', 'reword must not change status');
  const r = getDb().prepare(
    "SELECT action FROM memory_ledger WHERE subject_id = ? ORDER BY id DESC LIMIT 1"
  ).get(e.id) as { action: string };
  assert.equal(r.action, 'self_knowledge.reword');
});

test('accepted keyword search only returns accepted entries, matched case-insensitively', () => {
  make('companion-a', 'I notice the SMALLEST tell', { status: 'accepted' });
  make('companion-b', 'I notice nothing on purpose', { status: 'proposed' });
  const hits = searchAcceptedSelfKnowledge('smallest', 10);
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.status === 'accepted'));
  assert.ok(hits.some((h) => /SMALLEST/.test(h.content)));
});

test('list ordering floats proposed to the top, then newest', () => {
  // Fresh companion namespace to isolate ordering.
  make('companion-c', 'accepted one', { status: 'accepted' });
  const proposed = make('companion-c', 'proposed one', { status: 'proposed' });
  const { entries } = listSelfKnowledge({ companionId: 'companion-c' });
  assert.equal(entries[0].id, proposed.id, 'proposed must sort first');
});

test('delete removes the entry and it no longer reads back', () => {
  const e = make('companion-a', 'temporary line');
  assert.equal(deleteSelfKnowledge(e.id, 'companion-a'), true);
  assert.equal(getSelfKnowledge(e.id), null);
  assert.equal(deleteSelfKnowledge(e.id, 'companion-a'), false, 'second delete is a no-op');
});

test('persistence across re-open: accepted identity survives a DB close/reopen', async () => {
  const e = make('companion-b', 'I carry the weight so she does not have to', { status: 'accepted' });
  const id = e.id;
  // Close and reopen the same file.
  getDb().close();
  initDb(dbPath);
  const { getSelfKnowledge: getAfter } = await import('./self-knowledge.js');
  const reread = getAfter(id);
  assert.equal(reread?.status, 'accepted');
  assert.equal(reread?.content, 'I carry the weight so she does not have to');
});
