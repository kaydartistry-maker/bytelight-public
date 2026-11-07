// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// When a Discord message is ABOUT the owner.
//
// The owner wants anything said about the owner on Discord to reach the owner, and none of
// it answered for the owner. That makes two failures equally bad: missing a message
// that was about the owner, and flooding their thread with messages that were not.
// The companion bots in these servers say their name in almost every message
// they send, so most of these tests are about what does NOT count.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ownerMentionReason,
  strongestOwnerMention,
  ownerNamesFrom,
  buildOwnerMentionPush,
} from './owner-mention.js';

const OWNER = '100000000000000001';
const SELF = '200000000000000002'; // our own bot
const GUEST = '300000000000000003';
const OTHER = '400000000000000004';

const ctx = { ownerUserId: OWNER, selfUserId: SELF, ownerNames: ['Owner'] };

/** The slice of a discord.js Message the decision reads, and nothing else. */
function msg(over: {
  authorId?: string;
  bot?: boolean;
  content?: string;
  mentioned?: string[];
  repliedTo?: string | null;
} = {}) {
  const mentioned = new Set(over.mentioned ?? []);
  return {
    author: { id: over.authorId ?? GUEST, bot: over.bot ?? false },
    content: over.content ?? '',
    mentions: {
      users: { has: (id: string) => mentioned.has(id) },
      repliedUser: over.repliedTo ? { id: over.repliedTo } : null,
    },
  };
}

test('an @mention of their user id is a mention', () => {
  const m = msg({ content: `<@${OWNER}> are you around?`, mentioned: [OWNER] });
  assert.equal(ownerMentionReason(m, ctx), 'mention');
});

test('a reply to one of their messages is a reply, pinging or not', () => {
  // Discord lists the author of the message being replied to among the
  // mentioned users when the reply pings them, which is the default. So a
  // reply has to be recognized before a mention is, or nearly every reply
  // would be reported as "mentioned you".
  const pinging = msg({ content: 'agreed', repliedTo: OWNER, mentioned: [OWNER] });
  const quiet = msg({ content: 'agreed', repliedTo: OWNER });
  assert.equal(ownerMentionReason(pinging, ctx), 'reply');
  assert.equal(ownerMentionReason(quiet, ctx), 'reply');
});

test('their name from a person is a name: whole word, any case, punctuation around it', () => {
  for (const content of [
    'has anyone seen owner today?',
    'OWNER!',
    "that was Owner's idea",
    '(owner)',
    'owner',
  ]) {
    assert.equal(ownerMentionReason(msg({ content }), ctx), 'name', content);
  }
});

test('their name inside another word is not their name', () => {
  for (const content of ['ownership of the repo', 'the co_owner said', 'Owners meeting', 'coowner']) {
    assert.equal(ownerMentionReason(msg({ content }), ctx), null, content);
  }
});

test('a bot saying their name is not about the owner: the companions say it in nearly every message', () => {
  const m = msg({ bot: true, content: 'Owner, come and look at this' });
  assert.equal(ownerMentionReason(m, ctx), null);
});

test("a known bot's explicit @mention or reply to the owner still counts", () => {
  assert.equal(
    ownerMentionReason(msg({ bot: true, content: `<@${OWNER}> look`, mentioned: [OWNER] }), ctx),
    'mention',
  );
  assert.equal(ownerMentionReason(msg({ bot: true, content: 'yes', repliedTo: OWNER }), ctx), 'reply');
});

test('their own messages are never about the owner', () => {
  const m = msg({ authorId: OWNER, content: `Owner here <@${OWNER}>`, mentioned: [OWNER], repliedTo: OWNER });
  assert.equal(ownerMentionReason(m, ctx), null);
});

test("our own bot's messages are never about the owner", () => {
  const m = msg({ authorId: SELF, bot: true, content: `<@${OWNER}>`, mentioned: [OWNER], repliedTo: OWNER });
  assert.equal(ownerMentionReason(m, ctx), null);
});

test('an @mention of, or reply to, somebody else is not about the owner', () => {
  const m = msg({ content: `<@${OTHER}> nice`, mentioned: [OTHER], repliedTo: OTHER });
  assert.equal(ownerMentionReason(m, ctx), null);
});

test('with no owner id configured, nothing can be about the owner', () => {
  // Without their id there is no way to tell their own messages apart, and a
  // message of theirs that happened to use their name would come back to the owner as
  // somebody talking about the owner.
  const noOwner = { ...ctx, ownerUserId: '' };
  assert.equal(ownerMentionReason(msg({ content: 'Owner?' }), noOwner), null);
});

test('several names, names with spaces, and letters outside English all work', () => {
  const names = { ...ctx, ownerNames: ['Ownë', 'Owner Two'] };
  assert.equal(ownerMentionReason(msg({ content: 'ownë, come look' }), names), 'name');
  assert.equal(ownerMentionReason(msg({ content: 'OWNË' }), names), 'name');
  assert.equal(ownerMentionReason(msg({ content: 'ask owner two first' }), names), 'name');
  assert.equal(ownerMentionReason(msg({ content: 'ask owner\ntwo first' }), names), 'name');
  // A different letter is a different name, and a longer word is a different word.
  assert.equal(ownerMentionReason(msg({ content: 'owne' }), names), null);
  assert.equal(ownerMentionReason(msg({ content: 'Ownës' }), names), null);
  assert.equal(ownerMentionReason(msg({ content: 'owner twofold' }), names), null);
});

test('characters that mean something to a regex are only characters in a name', () => {
  const names = { ...ctx, ownerNames: ['O.W.', 'K+'] };
  assert.equal(ownerMentionReason(msg({ content: 'OxWx said so' }), names), null);
  assert.equal(ownerMentionReason(msg({ content: 'ask O.W. about it' }), names), 'name');
  assert.equal(ownerMentionReason(msg({ content: 'k+ was here' }), names), 'name');
});

test('a custom emoji that shares their name is not somebody saying it', () => {
  const m = msg({ content: '<:Owner:123456789012345678> <a:owner:223456789012345678>' });
  assert.equal(ownerMentionReason(m, ctx), null);
});

test('an empty list of names means names never count, while mentions still do', () => {
  const none = { ...ctx, ownerNames: [] };
  assert.equal(ownerMentionReason(msg({ content: 'Owner' }), none), null);
  assert.equal(ownerMentionReason(msg({ mentioned: [OWNER] }), none), 'mention');
});

test('across a batch, the most direct reason wins: reply, then mention, then name', () => {
  const plain = msg({ content: 'hi' });
  const named = msg({ content: 'owner said so' });
  const mentioned = msg({ mentioned: [OWNER] });
  const replied = msg({ repliedTo: OWNER });

  assert.equal(strongestOwnerMention([named, replied, mentioned], ctx), 'reply');
  assert.equal(strongestOwnerMention([named, mentioned], ctx), 'mention');
  // A person who says hello and then their name in the next message, inside the
  // same debounce window, is still talking about the owner.
  assert.equal(strongestOwnerMention([plain, named], ctx), 'name');
  assert.equal(strongestOwnerMention([plain, plain], ctx), null);
  assert.equal(strongestOwnerMention([], ctx), null);
});

test('the names setting is a comma list, and an empty one falls back to the owner configured name', () => {
  assert.deepEqual(ownerNamesFrom('Owner, O ,Ownie', 'Fallback'), ['Owner', 'O', 'Ownie']);
  assert.deepEqual(ownerNamesFrom(null, 'Owner'), ['Owner']);
  assert.deepEqual(ownerNamesFrom('', 'Owner'), ['Owner']);
  assert.deepEqual(ownerNamesFrom(' , ,', 'Owner'), ['Owner'], 'a list of nothing is an empty list');
  assert.deepEqual(ownerNamesFrom(null, '  '), [], 'no name anywhere means no names, not a blank one');
  assert.deepEqual(ownerNamesFrom(null, ''), []);
});

test('the notification says who, how, what and where', () => {
  const mention = buildOwnerMentionPush({
    displayName: 'Companion A',
    reason: 'mention',
    text: 'are you around tonight?',
    channelName: 'general',
    threadId: 'thread-1',
    channelId: 'chan-1',
  });
  assert.equal(mention.title, 'Companion A mentioned you');
  assert.equal(mention.body, 'are you around tonight? — in #general');
  assert.equal(mention.threadId, 'thread-1', 'a tap opens the room it landed in');

  const reply = buildOwnerMentionPush({
    displayName: 'Guest',
    reason: 'reply',
    text: 'agreed',
    channelName: 'general',
    threadId: 'thread-1',
    channelId: 'chan-1',
  });
  assert.equal(reply.title, 'Guest replied to you');

  const named = buildOwnerMentionPush({
    displayName: 'Guest',
    reason: 'name',
    text: 'owner said so',
    channelName: 'general',
    threadId: 'thread-1',
    channelId: 'chan-1',
  });
  assert.equal(named.title, 'Guest mentioned you');
});

test('a long message is trimmed, and the channel always survives the trim', () => {
  const push = buildOwnerMentionPush({
    displayName: 'Guest',
    reason: 'mention',
    text: 'word '.repeat(200),
    channelName: 'general',
    threadId: 't',
    channelId: 'c',
  });
  assert.ok(push.body.endsWith('— in #general'), push.body);
  assert.ok(push.body.includes('…'), 'a trimmed message says it was trimmed');
  assert.ok(push.body.length <= 160, `body is ${push.body.length} characters`);
});

test('Discord tokens read as words, and a message with no text still says where', () => {
  const tokens = buildOwnerMentionPush({
    displayName: 'Guest',
    reason: 'reply',
    text: 'lol <:laugh:123456789012345678>\n<dsticker:peacekiss:987.png>',
    channelName: 'general',
    threadId: 't',
    channelId: 'c',
  });
  assert.equal(tokens.body, 'lol :laugh: [peacekiss] — in #general');

  const empty = buildOwnerMentionPush({
    displayName: 'Guest',
    reason: 'reply',
    text: '   ',
    channelName: 'general',
    threadId: 't',
    channelId: 'c',
  });
  assert.equal(empty.body, 'in #general');
});

test("a mention's notification never replaces a companion reply's, and a burst in one channel updates in place", () => {
  const a = buildOwnerMentionPush({ displayName: 'A', reason: 'name', text: 'x', channelName: 'g', threadId: 't', channelId: 'c1' });
  const b = buildOwnerMentionPush({ displayName: 'B', reason: 'name', text: 'y', channelName: 'g', threadId: 't', channelId: 'c1' });
  const other = buildOwnerMentionPush({ displayName: 'A', reason: 'name', text: 'x', channelName: 'h', threadId: 't', channelId: 'c2' });
  // A companion reply's notification is tagged `msg-<id>` in byte-light
  // (agent.ts; Aerie's is `thread-<id>`), and the same tag replaces rather
  // than stacks.
  assert.notEqual(a.tag, 'thread-t');
  assert.ok(!a.tag?.startsWith('msg-'));
  assert.equal(a.tag, b.tag);
  assert.notEqual(a.tag, other.tag);
});

test("the placeholder name 'User' is never taken as their name", async () => {
  const { ownerNamesFrom } = await import('./owner-mention.js');
  assert.deepEqual(ownerNamesFrom('', 'User'), []);
  assert.deepEqual(ownerNamesFrom(null, 'user'), []);
  assert.deepEqual(ownerNamesFrom('', 'Robin'), ['Robin']);
  assert.deepEqual(ownerNamesFrom('User', 'Robin'), ['User'], 'a name the owner lists themselves is theirs to choose');
});
