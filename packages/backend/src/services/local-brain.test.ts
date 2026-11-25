/**
 * Phase 1.2 — dispatch and model lookup use the house's own brain.
 *
 * Pins:
 *  - the local brain id is configuration, with the historical default;
 *  - companionLookupChain resolves by companions.id, with slug as a fallback,
 *    on a fresh schema and on a live-shaped schema;
 *  - thread > companion > system override order holds for a configured brain;
 *  - 0-, 1-, 2- and 3-seat rosters plan the right lanes;
 *  - the existing house's brain-keyed thread overrides still answer, so the
 *    Codex lane resolves the same model ref (and so resumes the same session).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';

import Database from 'better-sqlite3';

import { createThread, getDb, initDb } from './db.js';
import { upsertCompanionSetting } from './db/companion-settings.js';
import { companionLookupChain, resolveCompanionConfig } from './companion-resolver.js';
import { resolveModelForTurn } from './agent/model-resolution.js';
import { DEFAULT_LOCAL_BRAIN_ID, getLocalBrainId, isLocalBrain } from './local-brain.js';
import { planDispatchOrder } from './ws.js';
import { speakerName } from './heartbeat/other-lane-net.js';

const root = mkdtempSync(join(tmpdir(), 'local-brain-'));
let sequence = 0;

function freshHouse(): Database.Database {
  try { getDb().close(); } catch { /* none open */ }
  return initDb(join(root, `house-${sequence++}.db`));
}

function addCompanion(db: Database.Database, id: string, brain: string, slug: string | null = id): void {
  db.prepare('INSERT INTO companions (id, display_name, brain, slug, sort_order) VALUES (?, ?, ?, ?, 0)')
    .run(id, id.toUpperCase(), brain, slug);
}

beforeEach(() => { delete process.env.BYTELIGHT_LOCAL_BRAIN_ID; });
afterEach(() => { delete process.env.BYTELIGHT_LOCAL_BRAIN_ID; });
after(() => {
  try { getDb().close(); } catch { /* closed */ }
  rmSync(root, { recursive: true, force: true });
});

test('the local brain id defaults to the historical id and follows configuration', () => {
  assert.equal(getLocalBrainId(), DEFAULT_LOCAL_BRAIN_ID);
  assert.equal(DEFAULT_LOCAL_BRAIN_ID, 'companion-a-b');
  process.env.BYTELIGHT_LOCAL_BRAIN_ID = 'solo-brain';
  assert.equal(getLocalBrainId(), 'solo-brain');
  assert.equal(isLocalBrain('solo-brain'), true);
  assert.equal(isLocalBrain(DEFAULT_LOCAL_BRAIN_ID), false);
  assert.equal(isLocalBrain(null), false);
});

test('lookup chain resolves by id even when slug is empty (fresh install rows)', () => {
  const db = freshHouse();
  addCompanion(db, 'alpha', 'pair', null);
  assert.deepEqual(companionLookupChain('alpha'), ['alpha', 'pair']);
  assert.deepEqual(companionLookupChain('pair'), ['pair']);
  assert.deepEqual(companionLookupChain('nobody'), ['nobody']);
});

test('lookup chain falls back to slug when the id differs (live-shaped rows)', () => {
  const db = freshHouse();
  addCompanion(db, 'row-7', 'pair', 'alpha');
  assert.deepEqual(companionLookupChain('row-7'), ['row-7', 'pair']);
  assert.deepEqual(companionLookupChain('alpha'), ['alpha', 'pair']);
});

test('lookup chain tolerates a companions table without a slug column', () => {
  try { getDb().close(); } catch { /* none */ }
  const path = join(root, `noslug-${sequence++}.db`);
  const old = new Database(path);
  old.exec("CREATE TABLE companions (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, brain TEXT NOT NULL); INSERT INTO companions VALUES ('alpha','Alpha','pair');");
  old.close();
  // initDb heals the schema forward; prove the id path works before and after.
  initDb(path);
  assert.deepEqual(companionLookupChain('alpha'), ['alpha', 'pair']);
});

test('override order holds for a configured brain: thread > companion > system', () => {
  process.env.BYTELIGHT_LOCAL_BRAIN_ID = 'solo-brain';
  const db = freshHouse();
  addCompanion(db, 'solo', 'solo-brain');
  createThread({ id: 't-solo', name: 'solo', type: 'named', createdAt: new Date().toISOString(), companionIds: ['solo'] });

  upsertCompanionSetting({ companionId: 'solo-brain', tier: 'interactive', scope: 'system', providerId: 'claude', modelId: 'sys-model' });
  assert.equal(resolveModelForTurn({ isAutonomous: false, threadId: 't-solo' }).model, 'sys-model');

  upsertCompanionSetting({ companionId: 'solo-brain', tier: 'interactive', scope: 'companion', providerId: 'claude', modelId: 'comp-model' });
  assert.equal(resolveModelForTurn({ isAutonomous: false, threadId: 't-solo' }).model, 'comp-model');

  upsertCompanionSetting({ companionId: 'solo-brain', tier: 'interactive', scope: 'thread', threadId: 't-solo', providerId: 'claude', modelId: 'thread-model' });
  assert.equal(resolveModelForTurn({ isAutonomous: false, threadId: 't-solo' }).model, 'thread-model');

  // A seat's own row sits under the brain's thread row but over its companion row.
  upsertCompanionSetting({ companionId: 'solo', tier: 'interactive', scope: 'companion', providerId: 'claude', modelId: 'seat-model' });
  assert.equal(resolveModelForTurn({ isAutonomous: false, threadId: 't-solo', companionId: 'solo' }).model, 'thread-model');
  assert.equal(resolveCompanionConfig('solo', 'interactive', null).model, 'seat-model');
});

test('an existing house with no new config keeps its brain-keyed thread overrides (Codex resumes the same ref)', () => {
  const db = freshHouse();
  addCompanion(db, 'one', 'companion-a-b');
  addCompanion(db, 'two', 'companion-a-b');
  createThread({ id: 't-pair', name: 'pair', type: 'named', createdAt: new Date().toISOString(), companionIds: ['one', 'two'] });
  upsertCompanionSetting({ companionId: 'companion-a-b', tier: 'interactive', scope: 'thread', threadId: 't-pair', providerId: 'codex-cli', modelId: 'gpt-5.6-sol' });

  const shared = resolveModelForTurn({ isAutonomous: false, threadId: 't-pair' });
  assert.equal(shared.tierConfig.matchedCompanionId, 'companion-a-b');
  assert.equal(shared.modelRef.runtime, 'codex-cli');
  // Each seat falls through to the same brain row: one Codex thread, not two.
  const seat = resolveModelForTurn({ isAutonomous: false, threadId: 't-pair', companionId: 'one' });
  assert.deepEqual(seat.modelRef, shared.modelRef);
});

test('dispatch plans 0, 1, 2 and 3 seats against the configured local brain', () => {
  const seat = (brain: string) => ({ brain });
  assert.deepEqual(planDispatchOrder([]), [], 'an empty roster makes no model call');
  assert.deepEqual(planDispatchOrder([seat('companion-a-b')]), ['companion-a-b']);
  assert.deepEqual(planDispatchOrder([seat('companion-a-b'), seat('companion-a-b')]), ['companion-a-b']);
  assert.deepEqual(
    [...planDispatchOrder([seat('companion-a-b'), seat('companion-a-b'), seat('remote')])].sort(),
    ['companion-a-b', 'remote'],
  );

  process.env.BYTELIGHT_LOCAL_BRAIN_ID = 'solo-brain';
  assert.deepEqual(planDispatchOrder([seat('solo-brain')]), ['solo-brain']);
});

test('the house voice label follows the configured brain, other authors keep their id', () => {
  assert.equal(speakerName('companion-a-b', 'House'), 'House');
  assert.equal(speakerName(undefined, 'House'), 'House');
  process.env.BYTELIGHT_LOCAL_BRAIN_ID = 'solo-brain';
  assert.equal(speakerName('solo-brain', 'House'), 'House');
  // Historical rows from a former brain id are never relabelled as the house.
  assert.equal(speakerName('companion-a-b', 'House'), 'Companion-a-b');
});
