// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Preflight's half of owner mentions: exactly where a message would be turned
// away for not addressing us (a tag-only room, or a read-only one), a message
// about the owner is delivered instead, heard and not answered. Everything
// above that line must keep winning exactly as it did before, which is what
// most of these tests are for. (In a chime-in room the judge hears it instead;
// see judge.test.ts.)

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../config.js';
import { initDb } from '../db/init.js';
import { setConfig } from '../db/config.js';
import { saveRules } from './rules.js';
import { preflight } from './preflight.js';
import { PairingService } from './pairing.js';
import {
  noteApproved,
  botRepliesUsed,
  resetBotLoopCounters,
  MAX_CONSECUTIVE_BOT_REPLIES,
} from './bot-loop.js';
import type { MessageBatch } from './types.js';

const OWNER = '100000000000000001';
const SELF = '200000000000000002'; // our own bot
const GUEST = '300000000000000003';
const BOT = '400000000000000004'; // a companion bot we know
const STRANGER_BOT = '500000000000000005';
const FENCED = '600000000000000006'; // a person with a rule that fences them elsewhere
const IGNORED = '700000000000000007';
const GUILD = '800000000000000008';
const OTHER_GUILD = '900000000000000009';
const CHANNEL = 'channel-general';
const IGNORED_CHANNEL = 'channel-quiet';
const READ_ONLY_CHANNEL = 'channel-readonly';
const CHIME_CHANNEL = 'channel-chime';

// Its own config and database, and the rules written into that database before
// anything reads them, so the rules loader never goes looking for a file.
const dir = mkdtempSync(join(tmpdir(), 'bytelight-owner-mention-preflight-'));
const yamlPath = join(dir, 'bytelight.yaml');
writeFileSync(yamlPath, `identity:\n  user_name: "Owner"\ndiscord:\n  owner_user_id: "${OWNER}"\n`);
delete process.env.USER_NAME;
loadConfig(yamlPath);
initDb(join(dir, 'test.db'));
// /tmp can be memory on a small box, so the throwaway database goes with the file.
after(() => rmSync(dir, { recursive: true, force: true }));
setConfig('discord.allowedGuilds', GUILD);
saveRules({
  servers: { [GUILD]: { id: GUILD, name: 'Server A', context: '', ignoredUsers: [IGNORED] } },
  channels: {
    [IGNORED_CHANNEL]: { id: IGNORED_CHANNEL, name: 'quiet', serverId: GUILD, ignore: true },
    [READ_ONLY_CHANNEL]: { id: READ_ONLY_CHANNEL, name: 'announcements', serverId: GUILD, gateMode: 'read-only' },
    [CHIME_CHANNEL]: { id: CHIME_CHANNEL, name: 'lounge', serverId: GUILD, alwaysListen: true },
  },
  users: {
    [BOT]: { id: BOT, name: 'Companion A', trustLevel: 'standard' },
    [FENCED]: { id: FENCED, name: 'Guest B', trustLevel: 'standard', allowedServers: [OTHER_GUILD] },
  },
});

const pairing = new PairingService();

function discordMessage(over: {
  authorId?: string;
  bot?: boolean;
  content?: string;
  mentioned?: string[];
  repliedTo?: string | null;
} = {}) {
  const mentioned = new Set(over.mentioned ?? []);
  return {
    id: 'message-1',
    client: { user: { id: SELF } },
    guild: { id: GUILD, name: 'Server A' },
    author: { id: over.authorId ?? GUEST, bot: over.bot ?? false, username: 'someone' },
    content: over.content ?? '',
    mentions: {
      users: { has: (id: string) => mentioned.has(id) },
      roles: { size: 0 },
      repliedUser: over.repliedTo ? { id: over.repliedTo } : null,
    },
  };
}

function batchOf(
  messages: Array<ReturnType<typeof discordMessage>>,
  where: { guildId?: string; channelId?: string } = {},
): MessageBatch {
  return {
    messages,
    channelId: where.channelId ?? CHANNEL,
    userId: messages[0].author.id,
    guildId: where.guildId ?? GUILD,
    combinedContent: messages.map(m => m.content).join('\n'),
    firstMessage: messages[0],
    lastMessage: messages[messages.length - 1],
  } as unknown as MessageBatch;
}

const run = (b: MessageBatch) => preflight(b, pairing);
const switchedOn = () => setConfig('discord.owner_mentions', 'true');

test('switched off, a message about the owner is turned away exactly as before', async () => {
  // byte-light ships it on, so switch it off on purpose.
  setConfig('discord.owner_mentions', 'false');
  const result = await run(batchOf([discordMessage({ content: `<@${OWNER}> hi`, mentioned: [OWNER] })]));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'Mention required in this channel');
  assert.equal(result.deliver, undefined);
  assert.equal(result.ownerMention, undefined);
});

test('switched on, an @mention of the owner is heard, not answered, and says why', async () => {
  switchedOn();
  const result = await run(batchOf([discordMessage({ content: `<@${OWNER}> hi`, mentioned: [OWNER] })]));
  assert.equal(result.allowed, false, 'nobody answers it');
  assert.equal(result.deliver, true, 'but it reaches the house');
  assert.equal(result.ownerMention, 'mention');
  assert.match(result.reason, /mention/);
});

test('a reply to the owner and their name from a person are heard too, each named for what it was', async () => {
  switchedOn();
  const reply = await run(batchOf([discordMessage({ content: 'agreed', repliedTo: OWNER, mentioned: [OWNER] })]));
  assert.equal(reply.deliver, true);
  assert.equal(reply.ownerMention, 'reply');
  assert.match(reply.reason, /reply/);

  const named = await run(batchOf([discordMessage({ content: 'has anyone seen owner?' })]));
  assert.equal(named.deliver, true);
  assert.equal(named.ownerMention, 'name');
  assert.match(named.reason, /name/);
});

test('a message that addresses the bot is a normal turn, not also a notification', async () => {
  switchedOn();
  const result = await run(batchOf([
    discordMessage({ content: `<@${SELF}> tell <@${OWNER}> hi`, mentioned: [SELF, OWNER] }),
  ]));
  assert.equal(result.allowed, true);
  assert.equal(result.deliver, undefined);
  assert.equal(result.ownerMention, undefined);
});

test('a message about nobody is still turned away', async () => {
  switchedOn();
  const result = await run(batchOf([discordMessage({ content: 'lunch?' })]));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'Mention required in this channel');
  assert.equal(result.deliver, undefined);
});

test('the doors above it still win: allow-list, ignored channel, user rules, ignored users', async () => {
  switchedOn();
  const aboutHer = { content: `owner <@${OWNER}>`, mentioned: [OWNER] };
  const cases: Array<[string, MessageBatch]> = [
    ['Guild not on allowlist', batchOf([discordMessage(aboutHer)], { guildId: OTHER_GUILD })],
    ['Channel is ignored', batchOf([discordMessage(aboutHer)], { channelId: IGNORED_CHANNEL })],
    ['User not allowed in this server by rules', batchOf([discordMessage({ ...aboutHer, authorId: FENCED })])],
    ['User is ignored in this server', batchOf([discordMessage({ ...aboutHer, authorId: IGNORED })])],
  ];
  for (const [reason, b] of cases) {
    const result = await run(b);
    assert.equal(result.reason, reason);
    assert.equal(result.deliver, undefined, `${reason} is a door, not a delivery`);
    assert.equal(result.ownerMention, undefined);
  }
});

test('the bot gate still wins: an unknown bot is refused, and a spent channel stays the cool-off', async () => {
  switchedOn();
  resetBotLoopCounters();
  const stranger = await run(batchOf([
    discordMessage({ authorId: STRANGER_BOT, bot: true, content: `<@${OWNER}>`, mentioned: [OWNER] }),
  ]));
  assert.equal(stranger.reason, 'Author is an unknown bot');
  assert.equal(stranger.deliver, undefined);
  assert.equal(stranger.ownerMention, undefined);

  const spent = 'channel-spent';
  for (let i = 0; i < MAX_CONSECUTIVE_BOT_REPLIES; i++) noteApproved(spent, true);
  const held = await run(batchOf(
    [discordMessage({ authorId: BOT, bot: true, content: `<@${OWNER}>`, mentioned: [OWNER] })],
    { channelId: spent },
  ));
  assert.equal(held.deliver, true, 'the cool-off still hears it');
  assert.match(held.reason, /consecutive turns/, 'as the cool-off, not as a mention');
  assert.equal(held.ownerMention, undefined);
  resetBotLoopCounters();
});

test("a delivery spends none of a bot's turns", async () => {
  switchedOn();
  resetBotLoopCounters();
  const result = await run(batchOf([
    discordMessage({ authorId: BOT, bot: true, content: `<@${OWNER}> look`, mentioned: [OWNER] }),
  ]));
  assert.equal(result.ownerMention, 'mention', "a known bot's explicit mention of the owner counts");
  assert.equal(botRepliesUsed(CHANNEL), 0, 'nothing was answered, so nothing was counted');
});

test('a known bot saying their name is still just turned away', async () => {
  switchedOn();
  const result = await run(batchOf([discordMessage({ authorId: BOT, bot: true, content: 'Owner, look at this' })]));
  assert.equal(result.reason, 'Mention required in this channel');
  assert.equal(result.deliver, undefined);
});

test('their own message is never delivered back to the owner as one about the owner', async () => {
  switchedOn();
  const result = await run(batchOf([
    discordMessage({ authorId: OWNER, content: `Owner here <@${OWNER}>`, mentioned: [OWNER] }),
  ]));
  assert.equal(result.reason, 'Mention required in this channel');
  assert.equal(result.deliver, undefined);
});

test('a later message in the same batch can be the one about the owner', async () => {
  switchedOn();
  const result = await run(batchOf([
    discordMessage({ content: 'hey' }),
    discordMessage({ content: `<@${OWNER}> are you around?`, mentioned: [OWNER] }),
  ]));
  assert.equal(result.deliver, true);
  assert.equal(result.ownerMention, 'mention');
});

test('in a read-only room a message about the owner still reaches her; nothing else gets through', async () => {
  switchedOn();
  const about = await run(batchOf([discordMessage({ content: `<@${OWNER}> look`, mentioned: [OWNER] })], { channelId: READ_ONLY_CHANNEL }));
  assert.equal(about.allowed, false, 'never answered');
  assert.equal(about.deliver, true);
  assert.equal(about.ownerMention, 'mention');

  const tagged = await run(batchOf([discordMessage({ content: `<@${SELF}> hi`, mentioned: [SELF] })], { channelId: READ_ONLY_CHANNEL }));
  assert.equal(tagged.reason, 'Channel is read-only', 'a tag to us still is not answered here');
  assert.equal(tagged.deliver, undefined);

  setConfig('discord.owner_mentions', 'false');
  const off = await run(batchOf([discordMessage({ content: `<@${OWNER}> look`, mentioned: [OWNER] })], { channelId: READ_ONLY_CHANNEL }));
  assert.equal(off.reason, 'Channel is read-only');
  assert.equal(off.deliver, undefined);
});

test('a reply to one of ours gets through a tag-only room like a tag does', async () => {
  switchedOn();
  const msg = { ...discordMessage({ content: 'yes!', repliedTo: SELF }), reference: { messageId: 'ours' } };
  const result = await run(batchOf([msg as ReturnType<typeof discordMessage>]));
  assert.equal(result.allowed, true);
});

test('in a chime-in room preflight approves it; the judge decides it is hers (judge.test.ts)', async () => {
  switchedOn();
  const result = await run(batchOf([discordMessage({ content: 'has anyone seen owner?' })], { channelId: CHIME_CHANNEL }));
  assert.equal(result.allowed, true);
  assert.equal(result.ownerMention, undefined);
});
