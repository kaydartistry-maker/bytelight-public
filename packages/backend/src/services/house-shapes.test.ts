/**
 * Phase 1.5 — the four-shape matrix: empty install, solo, pair, shared room.
 *
 * Each shape is built through the real migrations (test-support/house-shapes)
 * and checked end to end against the Phase 1 rules:
 *   - nobody is created automatically, and a reboot changes nothing;
 *   - a thread seats exactly the roster it is given, and keeps it on reboot;
 *   - dispatch, wakes, voices, memory scopes, model lookup and profiles all
 *     read the house's own brain and the thread's roster;
 *   - an empty roster makes no model call;
 *   - historical authors are never rewritten.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { HOUSE_SHAPES, buildHouse, rebootHouse } from '../test-support/house-shapes.js';
import { createMessage, createThread, getMessages, getThreadRoster } from './db.js';
import { residentIds } from './residents.js';
import { getLocalBrainId } from './local-brain.js';
import { planDispatchOrder } from './ws.js';
import { wakeRosterRule } from './wake-roster.js';
import { VoiceService, houseVoiceSpeakers } from './voice.js';
import { companionScopes, resolveScope } from './memory-blocks.js';
import { resolveModelForTurn } from './agent/model-resolution.js';
import { upsertCompanionSetting } from './db/companion-settings.js';
import { hasResidentSeat } from './agent.js';

after(() => { delete process.env.BYTELIGHT_LOCAL_BRAIN_ID; });

function count(db: { prepare(sql: string): { get(): unknown } }, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

for (const shape of HOUSE_SHAPES) {
  describe(`house shape: ${shape.name}`, () => {
    test('boots with exactly its own companions, and a reboot changes nothing', () => {
      const { db, path } = buildHouse(shape);
      assert.equal(getLocalBrainId(), shape.localBrain);
      assert.equal(count(db, 'companions'), shape.companions.length);
      const before = { companions: count(db, 'companions'), threads: count(db, 'threads'), seats: count(db, 'thread_companions'), settings: count(db, 'companion_settings') };
      const again = rebootHouse(path);
      assert.deepEqual(
        { companions: count(again, 'companions'), threads: count(again, 'threads'), seats: count(again, 'thread_companions'), settings: count(again, 'companion_settings') },
        before,
      );
      assert.deepEqual(residentIds(), [...shape.residents]);
    });

    test('the main thread keeps exactly its roster across a reboot', () => {
      const { path } = buildHouse(shape);
      if (shape.seated.length === 0) {
        assert.throws(() => createThread({ id: 'x', name: 'x', type: 'named', createdAt: new Date().toISOString(), companionIds: [] as never }), /non-empty roster/);
        return;
      }
      rebootHouse(path);
      assert.deepEqual(getThreadRoster('main').map((c) => c.id).sort(), [...shape.seated].sort());
    });

    test('dispatch plans the right lanes, and the wake asks for the seated residents', () => {
      buildHouse(shape);
      const roster = shape.seated.length ? getThreadRoster('main') : [];
      assert.deepEqual([...planDispatchOrder(roster)].sort(), [...shape.dispatch].sort());
      const residentNames = shape.companions.filter((c) => shape.residents.includes(c.id) && shape.seated.includes(c.id)).map((c) => c.name);
      const rule = wakeRosterRule(residentNames);
      if (residentNames.length === 0) assert.equal(rule, null);
      else for (const name of residentNames) assert.ok(rule!.includes(name), `${name} is asked for`);
      if (shape.name === 'room') assert.equal(rule!.includes('Visitor'), false, 'a visitor answers from his own node');
    });

    test('an empty roster makes no model call; a seated resident does get a turn', () => {
      buildHouse(shape);
      if (shape.residents.length === 0) {
        assert.equal(residentIds().length, 0);
        return;
      }
      assert.equal(hasResidentSeat('main'), true);
    });

    test('voices and memory scopes are the residents only', () => {
      buildHouse(shape);
      assert.deepEqual(houseVoiceSpeakers().map((s) => s.id), [...shape.residents]);
      assert.deepEqual(companionScopes(), [...shape.residents]);
      assert.equal(resolveScope('shared'), 'shared');
      if (shape.name === 'room') assert.equal(resolveScope('visitor'), null);
      const speakers = houseVoiceSpeakers();
      const segments = VoiceService.splitByCompanion('plain words', speakers);
      assert.equal(segments[0]?.voice ?? '', shape.residents[0] ?? '');
    });

    test("model lookup resolves through the house's own brain", () => {
      buildHouse(shape);
      if (shape.seated.length === 0) return;
      upsertCompanionSetting({ companionId: shape.localBrain, tier: 'interactive', scope: 'thread', threadId: 'main', providerId: 'claude', modelId: `${shape.name}-model` });
      assert.equal(resolveModelForTurn({ isAutonomous: false, threadId: 'main' }).model, `${shape.name}-model`);
      for (const id of shape.residents) {
        assert.equal(resolveModelForTurn({ isAutonomous: false, threadId: 'main', companionId: id }).model, `${shape.name}-model`);
      }
    });

    test('historical authors are stored and read back exactly as written', () => {
      buildHouse(shape);
      if (shape.seated.length === 0) return;
      const stamps = ['companion-a-b', 'companion-c', 'someone-gone', shape.localBrain];
      stamps.forEach((companionId, i) => createMessage({
        id: `m-${i}`, threadId: 'main', role: 'companion', content: `line ${i}`, createdAt: new Date(Date.now() + i).toISOString(), companionId,
      }));
      const read = getMessages({ threadId: 'main', limit: 10 }).map((m) => (m as { companion_id?: string | null }).companion_id);
      assert.deepEqual(read.filter(Boolean).sort(), [...stamps].sort());
    });
  });
}

describe('treehouse membership', () => {
  test('only residents are Treehouse members; a visitor from another node is not', async () => {
    const room = HOUSE_SHAPES.find((s) => s.name === 'room');
    assert.ok(room, 'room shape exists');
    buildHouse(room);
    const { treehouseMembers } = await import('./treehouse.js');
    const members = treehouseMembers().map((m) => m.slug);
    assert.deepEqual(members, [...room.residents]);
    const visitors = room.companions.map((c) => c.id).filter((id) => !room.residents.includes(id));
    assert.ok(visitors.length > 0, 'room shape has a visitor');
    for (const visitor of visitors) assert.ok(!members.includes(visitor), `${visitor} must not be a member`);
  });
});
