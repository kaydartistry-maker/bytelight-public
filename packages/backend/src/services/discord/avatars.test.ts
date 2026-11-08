import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { discordAvatarFor, usersMissingAvatars, fillAvatar, backfillDiscordAvatars } from './avatars.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, platform TEXT, metadata TEXT)`);
  const add = db.prepare('INSERT INTO messages (id, platform, metadata) VALUES (?, ?, ?)');
  add.run('a1', 'discord', JSON.stringify({ discordUserId: '111', discordUsername: 'amber' }));
  add.run('a2', 'discord', JSON.stringify({ discordUserId: '111', discordUsername: 'amber' }));
  add.run('b1', 'discord', JSON.stringify({ discordUserId: '222', discordAvatarUrl: 'https://cdn/old.png' }));
  add.run('c1', 'discord', JSON.stringify({ discordUserId: '333' }));
  add.run('k1', 'web', JSON.stringify({ discordUserId: '999' }));
  return db;
}

const meta = (db: Database.Database, id: string) =>
  JSON.parse((db.prepare('SELECT metadata FROM messages WHERE id = ?').get(id) as { metadata: string }).metadata);

test('server picture wins over the account picture', () => {
  const url = discordAvatarFor({
    member: { displayAvatarURL: () => 'server.png' },
    author: { displayAvatarURL: () => 'account.png' },
  });
  assert.equal(url, 'server.png');
});

test('falls back to the account picture when there is no member', () => {
  assert.equal(discordAvatarFor({ member: null, author: { displayAvatarURL: () => 'account.png' } }), 'account.png');
});

test('only Discord people without a picture are listed', () => {
  assert.deepEqual(usersMissingAvatars(makeDb()).sort(), ['111', '333']);
});

test('filling keeps the rest of the metadata and never overwrites an existing picture', () => {
  const db = makeDb();
  assert.equal(fillAvatar(db, '111', 'https://cdn/amber.png'), 2);
  assert.equal(meta(db, 'a1').discordAvatarUrl, 'https://cdn/amber.png');
  assert.equal(meta(db, 'a1').discordUsername, 'amber');
  assert.equal(fillAvatar(db, '222', 'https://cdn/new.png'), 0);
  assert.equal(meta(db, 'b1').discordAvatarUrl, 'https://cdn/old.png');
  assert.equal(meta(db, 'k1').discordAvatarUrl, undefined);
});

test('backfill fills who it can, counts who it cannot, and is a no-op the second time', async () => {
  const db = makeDb();
  const lookup = async (id: string) => (id === '111' ? 'https://cdn/amber.png' : undefined);
  assert.deepEqual(await backfillDiscordAvatars(db, lookup), { users: 2, messages: 2, missed: 1 });
  assert.deepEqual(await backfillDiscordAvatars(db, lookup), { users: 1, messages: 0, missed: 1 });
});

test('a lookup that throws counts as missed, not a crash', async () => {
  const db = makeDb();
  const result = await backfillDiscordAvatars(db, async () => { throw new Error('404'); });
  assert.equal(result.missed, 2);
});
