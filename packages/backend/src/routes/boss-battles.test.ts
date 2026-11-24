import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { BOSS_BATTLES_PATH } from '@bytelight/shared';
import { getCookieName } from '../middleware/auth.js';
import { createWebRestOwner } from '../middleware/owner.js';
import { createBossBattleRoutes } from './boss-battles.js';

test('summoning is owner-only and starts one subscription portrait using the Studio default', async () => {
  const db = new Database(':memory:');
  const owner = createWebRestOwner({ session: token => token === 'fixture' ? { expires_at: new Date(Date.now() + 60_000).toISOString() } as never : undefined as never });
  let starts = 0, drafts = 0;
  const app = express();
  app.use(express.json());
  app.use(BOSS_BATTLES_PATH, createBossBattleRoutes({ owner, db: () => db, job: () => undefined,
    defaultStyle: () => 'saved-default-style',
    draft: async (_db, issue) => {
      assert.equal(issue, 'Dishes; private 839'); ++drafts;
      return { name: 'The Tureen Serpent', lore: 'It wants the spoons.', appearance: 'a walking porcelain tureen on long crab legs with three blue flame eyes', kind: 'slime', model: 'fixture/model', companion: 'Companion A', moves: [
        { text: 'Wash four spoons.', smaller: 'Wash one spoon.' }, { text: 'Put three glasses away.', smaller: 'Put one glass away.' }, { text: 'Wipe the stovetop.', smaller: 'Wipe one spot.' },
      ] };
    },
    start: input => {
      assert.equal(input.imageModelId, 'subscription-auto');
      assert.equal(input.styleId, 'saved-default-style');
      assert.doesNotMatch(input.prompt, /private 839/);
      ++starts;
      return 'fixture-art';
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = `http://${host}${BOSS_BATTLES_PATH}`;
  const read = { cookie: `${getCookieName()}=fixture` };
  const write = { ...read, origin: `https://${host}`, 'x-forwarded-proto': 'https', 'content-type': 'application/json' };
  const post = (suffix: string, body: unknown, headers: Record<string, string> = write) => fetch(url + suffix, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const unauthenticated = await fetch(url);
    assert.equal(unauthenticated.status, 403);
    assert.match(unauthenticated.headers.get('cache-control') ?? '', /no-store/);
    assert.equal((await post('', { issue: 'Dishes; private 839' }, { ...write, origin: 'https://elsewhere.invalid' })).status, 403);
    assert.equal(drafts, 0);
    const created = await post('', { issue: 'Dishes; private 839', imageModelId: 'metered', styleId: 'ignored' });
    assert.equal(created.status, 201);
    const { battles: [battle], xp } = await created.json();
    assert.equal(xp, 0);
    assert.equal(battle.moves.length, 3);
    assert.equal(battle.model, 'fixture/model');
    assert.equal(battle.name, 'The Tureen Serpent');
    assert.equal((await post('', { issue: 'Dishes; private 839' })).status, 409);
    assert.equal((await post(`/${battle.id}/portrait`, { styleId: 'saved-style' })).status, 404);
    assert.equal(drafts, 1);
    assert.equal(starts, 1);
    const result = await fetch(url, { headers: read });
    assert.equal(result.status, 200);
    const board = await result.json();
    assert.equal(board.battles[0].issue, 'Dishes; private 839');
    assert.ok(!('portraitJobId' in board.battles[0]));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});
