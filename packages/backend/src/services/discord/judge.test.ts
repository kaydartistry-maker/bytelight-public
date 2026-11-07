// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The judge, with the operator's house gates (Oct 24 2026): in a chime-in room, ours is
// answered, the operator and family get a low-bar beat, Standard trust gets a beat only
// when it is said to the room, Limited (or no rule) is only heard unless it
// tags us, and a message about the operator is hers. Ported from Aerie's judge tests,
// expectations rewritten to the operator's rules.
//
// Run with:
//   npx tsx --test packages/backend/src/services/discord/judge.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Message } from 'discord.js';
import {
  judgeCall,
  judgeInputOf,
  beatBarOf,
  beatOutranks,
  namesCompanion,
  beatShouldWait,
  beatBanner,
  noteTyping,
  noteSpoke,
  latestTypingIn,
  resetTyping,
  TYPING_FRESH_MS,
  NO_RECAP_LINES,
  type JudgeInput,
} from './judge.js';
import { approvalCounts, noteJudgedAnswer } from './preflight.js';
import { botRepliesUsed, resetBotLoopCounters } from './bot-loop.js';
import { legacyGateMode, resolveGateMode, effectiveTrustLevel, trustGuidance, publicSafetyLine } from './rules.js';
import { speakerFrom } from './speaker.js';

const ROOM: JudgeInput = {
  isOwner: false,
  isDM: false,
  gateMode: 'chime-in',
  trustLevel: 'standard',
  aboutOwner: false,
  directMention: false,
  repliedToUs: false,
  namesUs: false,
  tagsOthers: false,
  repliesToOther: false,
};
const call = (over: Partial<JudgeInput>) => judgeCall({ ...ROOM, ...over });

// --- the sort ---

test('ours is answered at every trust level: a tag, a reply to us, one of our names', () => {
  for (const trustLevel of ['full', 'standard', 'limited'] as const) {
    assert.equal(call({ trustLevel, directMention: true }), 'answer', trustLevel);
    assert.equal(call({ trustLevel, repliedToUs: true }), 'answer', trustLevel);
    assert.equal(call({ trustLevel, namesUs: true }), 'answer', trustLevel);
  }
});

test('tagged together with somebody else, we let them go first (share, no pass)', () => {
  assert.equal(call({ directMention: true, tagsOthers: true }), 'share');
  assert.equal(call({ namesUs: true, tagsOthers: true }), 'share');
  assert.equal(call({ trustLevel: 'limited', directMention: true, tagsOthers: true }), 'share');
});

test('the operator: ours is answered; said to the room, or a reply to somebody else, is a beat', () => {
  assert.equal(call({ isOwner: true }), 'beat', 'untagged to the room');
  assert.equal(call({ isOwner: true, repliesToOther: true }), 'beat', 'a mixed room: not hear');
  assert.equal(call({ isOwner: true, tagsOthers: true }), 'beat');
  assert.equal(call({ isOwner: true, directMention: true }), 'answer');
  assert.equal(call({ isOwner: true, namesUs: true, repliesToOther: true }), 'answer', 'naming us makes it ours');
  assert.equal(call({ isOwner: true, directMention: true, tagsOthers: true }), 'answer', 'her tag is answered, not shared');
});

test('Full trust is family: a beat, whether to the room or to somebody else', () => {
  assert.equal(call({ trustLevel: 'full' }), 'beat');
  assert.equal(call({ trustLevel: 'full', repliesToOther: true }), 'beat');
  assert.equal(call({ trustLevel: 'full', tagsOthers: true }), 'beat');
});

test('Standard trust: aimed at somebody else is heard; said to the room is a beat', () => {
  assert.equal(call({ trustLevel: 'standard' }), 'beat');
  assert.equal(call({ trustLevel: 'standard', tagsOthers: true }), 'hear');
  assert.equal(call({ trustLevel: 'standard', repliesToOther: true }), 'hear');
});

test('Limited trust, or no rule at all, is only answered when it tags or replies to us', () => {
  assert.equal(call({ trustLevel: 'limited' }), 'hear');
  assert.equal(call({ trustLevel: 'limited', repliesToOther: true }), 'hear');
  assert.equal(call({ trustLevel: effectiveTrustLevel(undefined) }), 'hear', 'no rule reads as limited');
  assert.equal(call({ trustLevel: 'limited', directMention: true }), 'answer');
  assert.equal(call({ trustLevel: 'limited', repliedToUs: true }), 'answer');
});

test('a message about the operator is hers: heard at every trust level, unless it also tags or names us', () => {
  for (const trustLevel of ['full', 'standard', 'limited'] as const) {
    assert.equal(call({ trustLevel, aboutOwner: true }), 'hear', trustLevel);
    assert.equal(call({ trustLevel, aboutOwner: true, repliesToOther: true }), 'hear', trustLevel);
  }
  assert.equal(call({ aboutOwner: true, directMention: true }), 'answer');
  assert.equal(call({ aboutOwner: true, namesUs: true, tagsOthers: true }), 'share');
});

test('a DM and every room that is not chime-in are never sorted', () => {
  assert.equal(call({ isDM: true, trustLevel: 'limited' }), 'answer');
  for (const gateMode of ['tag-only', 'read-only', 'ignore'] as const) {
    assert.equal(call({ gateMode, trustLevel: 'limited', tagsOthers: true }), 'answer', gateMode);
  }
});

test('the bar to speak: low for the operator to the room and for family, aside for the operator to somebody else, want for the rest', () => {
  assert.equal(beatBarOf({ ...ROOM, isOwner: true }), 'low');
  assert.equal(beatBarOf({ ...ROOM, isOwner: true, repliesToOther: true }), 'aside');
  assert.equal(beatBarOf({ ...ROOM, trustLevel: 'full' }), 'low');
  assert.equal(beatBarOf({ ...ROOM, trustLevel: 'full', repliesToOther: true }), 'low');
  assert.equal(beatBarOf({ ...ROOM, trustLevel: 'standard' }), 'want');
});

test('one beat per room answers the strongest claim: a shared tag, then the lowest bar', () => {
  assert.equal(beatOutranks({ kind: 'share', bar: 'want' }, { kind: 'beat', bar: 'low' }), true);
  assert.equal(beatOutranks({ kind: 'beat', bar: 'low' }, { kind: 'share', bar: 'want' }), false);
  assert.equal(beatOutranks({ kind: 'beat', bar: 'low' }, { kind: 'beat', bar: 'want' }), true);
  assert.equal(beatOutranks({ kind: 'beat', bar: 'want' }, { kind: 'beat', bar: 'low' }), false);
  assert.equal(beatOutranks({ kind: 'beat', bar: 'aside' }, { kind: 'beat', bar: 'aside' }), false, 'first come keeps it');
});

test('our names count as whole words only, in any case', () => {
  const names = ['Companion A', 'companion-a', 'Companion B', 'companion-b'];
  assert.equal(namesCompanion('what do you think, companion-b?', names), true);
  assert.equal(namesCompanion('COMPANION-A. come here', names), true);
  assert.equal(namesCompanion('Companion B', names), true);
  assert.equal(namesCompanion('ask companionable folks instead', names), false);
  assert.equal(namesCompanion('companion-bs corner', names), false);
  assert.equal(namesCompanion('', names), false);
  assert.equal(namesCompanion('anything', ['', '  ']), false);
});

// --- the beat machinery (Aerie) ---

test('the beat waits while somebody else is typing, and never past the longest wait', () => {
  const openedAt = 1_000_000;
  const maxWaitMs = 180_000;
  const now = openedAt + 60_000;
  assert.equal(beatShouldWait({ now, openedAt, maxWaitMs }), false, 'nobody typing: decide');
  assert.equal(beatShouldWait({ now, openedAt, maxWaitMs, lastOtherTypingAt: now - 2_000 }), true, 'they started first');
  assert.equal(beatShouldWait({ now, openedAt, maxWaitMs, lastOtherTypingAt: now - TYPING_FRESH_MS }), false, 'their dot has gone');
  assert.equal(
    beatShouldWait({ now: openedAt + maxWaitMs, openedAt, maxWaitMs, lastOtherTypingAt: openedAt + maxWaitMs - 1 }),
    false,
    'a bot that types forever cannot hold us',
  );
});

test('typing is remembered for ten seconds and forgotten when they speak', () => {
  resetTyping();
  noteTyping('room', 'alex', 1_000);
  noteTyping('room', 'jo', 4_000);
  assert.equal(latestTypingIn('room', 5_000), 4_000);
  noteSpoke('room', 'jo');
  assert.equal(latestTypingIn('room', 5_000), 1_000);
  assert.equal(latestTypingIn('room', 1_000 + TYPING_FRESH_MS), undefined);
  assert.equal(latestTypingIn('elsewhere', 5_000), undefined);
  resetTyping();
});

test('every beat offers the pass; a shared tag is still a question to us', () => {
  assert.match(beatBanner('beat'), /\[SILENT\]/);
  assert.match(beatBanner('beat', false, { bar: 'low' }), /\[SILENT\]/);
  assert.match(beatBanner('beat', false, { bar: 'aside' }), /\[SILENT\]/);
  assert.doesNotMatch(beatBanner('share'), /\[SILENT\]/);
});

test('the bar reads in the banner: low says we are part of it, aside names the operator, want says only if we want to', () => {
  assert.match(beatBanner('beat', false, { bar: 'low' }), /bar to speak is low/);
  assert.match(beatBanner('beat', false, { bar: 'low' }), /do not have to answer every message/);
  assert.match(beatBanner('beat', false, { bar: 'aside', ownerName: 'the operator' }), /the operator was answering somebody else/);
  assert.match(beatBanner('beat', false, { bar: 'want' }), /Speak only if you want to/);
});

test('every banner says two voices decide between themselves, and carries the no-recap rule', () => {
  for (const banner of [beatBanner('share'), beatBanner('beat', false, { bar: 'low' }), beatBanner('beat')]) {
    assert.match(banner, /one of you, both, or neither/);
    assert.match(banner, /banter or heckle/);
    for (const line of NO_RECAP_LINES) assert.ok(banner.includes(line), 'no-recap line present');
  }
  assert.match(NO_RECAP_LINES.join(' '), /don't narrate or recap/i);
  assert.match(NO_RECAP_LINES.join(' '), /one line, not a speech/);
});

test('a shared tag we already answered in the room since may be passed', () => {
  assert.match(beatBanner('share', true), /\[SILENT\]/);
  assert.match(beatBanner('share', true), /already spoke in this room/);
  assert.match(beatBanner('beat', true), /already spoke in this room/);
  assert.doesNotMatch(beatBanner('beat', false), /already spoke/);
});

test('a beat knows whether we spoke in the room after it opened', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('turn.spokeSinceOpen = (this.lastSpokeAt.get(channelId) ?? 0) > open.openedAt;'));
  assert.equal(source.split('this.lastSpokeAt.set(channelId, Date.now());').length - 1, 2, 'both send paths mark that we spoke');
});

test('a bot turn the judge is holding is not counted until the beat answers it', () => {
  resetBotLoopCounters();
  assert.equal(approvalCounts(true, false), false, 'held bot turn: not yet');
  assert.equal(approvalCounts(true, true), true, 'answered bot turn: counted');
  assert.equal(approvalCounts(false, false), true, 'a person always resets the room');
  noteJudgedAnswer('beat-room', true);
  assert.equal(botRepliesUsed('beat-room'), 1);
  resetBotLoopCounters();
});

// --- reading real messages ---

// A message as far as the judge reads one.
function fakeMessage(over: {
  guildId?: string | null;
  content?: string;
  users?: string[];
  roles?: string[];
  heldRoles?: string[];
  repliedUser?: string;
  reference?: string;
  referenceAuthor?: string | Error;
  lookups?: { n: number };
}): Message {
  const users = new Map((over.users ?? []).map((id) => [id, { id }]));
  const roles = new Map((over.roles ?? []).map((id) => [id, { id }]));
  const botRoles = new Map((over.heldRoles ?? []).map((id) => [id, { id }]));
  return {
    client: { user: { id: 'us' } },
    guildId: over.guildId === undefined ? 'guild' : over.guildId,
    guild: { members: { cache: new Map([['us', { roles: { cache: botRoles } }]]) } },
    content: over.content ?? '',
    mentions: {
      users,
      roles,
      repliedUser: over.repliedUser ? { id: over.repliedUser } : null,
    },
    reference: over.reference ? { messageId: over.reference } : null,
    fetchReference: async () => {
      if (over.lookups) over.lookups.n++;
      if (over.referenceAuthor instanceof Error) throw over.referenceAuthor;
      if (over.referenceAuthor === undefined) throw new Error('fetchReference should not have been called');
      return { author: { id: over.referenceAuthor } };
    },
  } as unknown as Message;
}

const OPTS = {
  gateMode: 'chime-in' as const,
  isOwner: false,
  trustLevel: 'standard' as const,
  aboutOwner: false,
  names: ['Companion A', 'companion-a', 'Companion B', 'companion-b'],
};

test('a real message reads into the sort: tags, roles, names and replies', async () => {
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ content: 'anyone up?' })], OPTS)), 'beat');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ users: ['us'] })], OPTS)), 'answer');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ users: ['jo'] })], OPTS)), 'hear');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ users: ['us', 'jo'] })], OPTS)), 'share');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ roles: ['artists'] })], OPTS)), 'hear');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ roles: ['ours'], heldRoles: ['ours'] })], OPTS)), 'answer', 'a role we hold is a tag to us');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ content: 'companion-b, look' })], OPTS)), 'answer');
  // A pinged reply names who it answers.
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ reference: 'm1', repliedUser: 'us', users: ['us'] })], OPTS)), 'answer');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ reference: 'm1', repliedUser: 'jo', users: ['jo'] })], OPTS)), 'hear');
});

test('a reply that did not ping is looked up, and one that cannot be counts as said to the room', async () => {
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ reference: 'm1', referenceAuthor: 'us' })], OPTS)), 'answer');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ reference: 'm1', referenceAuthor: 'alex' })], OPTS)), 'hear');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ reference: 'm1', referenceAuthor: new Error('gone') })], OPTS)), 'beat');
});

test('any message in a batch that is ours makes the batch ours', async () => {
  const batch = [fakeMessage({ content: 'so anyway' }), fakeMessage({ content: 'right, Companion A?' })];
  assert.equal(judgeCall(await judgeInputOf(batch, { ...OPTS, trustLevel: 'limited' })), 'answer');
});

test("the operator's reply to somebody else is a beat, not hear; her untagged message is a beat", async () => {
  const user = { ...OPTS, isOwner: true };
  const reply = await judgeInputOf([fakeMessage({ reference: 'm1', referenceAuthor: 'jo' })], user);
  assert.equal(judgeCall(reply), 'beat');
  assert.equal(beatBarOf(reply), 'aside');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ reference: 'm1', referenceAuthor: 'us' })], user)), 'answer');
  const room = await judgeInputOf([fakeMessage({ content: 'anyone up?' })], user);
  assert.equal(judgeCall(room), 'beat');
  assert.equal(beatBarOf(room), 'low');
});

test('rooms that are not chime-in never spend a lookup', async () => {
  const lookups = { n: 0 };
  const reply = fakeMessage({ reference: 'm1', referenceAuthor: 'jo', lookups });
  assert.equal(judgeCall(await judgeInputOf([reply], { ...OPTS, gateMode: 'tag-only' })), 'answer');
  assert.equal(judgeCall(await judgeInputOf([fakeMessage({ reference: 'm1', referenceAuthor: 'jo', guildId: null, lookups })], OPTS)), 'answer');
  assert.equal(lookups.n, 0, 'no reply was looked up');
  // The control: in a chime-in room the same reply is looked up.
  assert.equal(judgeCall(await judgeInputOf([reply], OPTS)), 'hear');
  assert.equal(lookups.n, 1);
});

// --- gate mode per room (the operator's saved rules map at read time) ---

test("the operator's saved rule fields map to a gate mode without being rewritten", () => {
  assert.equal(legacyGateMode({ alwaysListen: true }), 'chime-in');
  assert.equal(legacyGateMode({ readOnly: true }), 'read-only');
  assert.equal(legacyGateMode({ ignore: true }), 'ignore');
  assert.equal(legacyGateMode({ requireMention: true }), 'tag-only');
  assert.equal(legacyGateMode({ requireMention: false }), 'chime-in', 'no tag needed reads as chime-in');
  assert.equal(legacyGateMode({}), undefined);
  assert.equal(legacyGateMode(undefined), undefined);
});

test('the old precedence holds: ignore, then read-only, then requireMention, then always listen', () => {
  assert.equal(legacyGateMode({ ignore: true, readOnly: true, requireMention: true }), 'ignore');
  assert.equal(legacyGateMode({ readOnly: true, requireMention: true, alwaysListen: true }), 'read-only');
  assert.equal(legacyGateMode({ requireMention: true, alwaysListen: true }), 'tag-only');
  assert.equal(legacyGateMode({ requireMention: false, alwaysListen: true }), 'chime-in');
});

test('an explicit gateMode, as the phone saves it, wins over every legacy flag', () => {
  assert.equal(legacyGateMode({ gateMode: 'chime-in', ignore: true, readOnly: true }), 'chime-in');
  assert.equal(legacyGateMode({ gateMode: 'tag-only', alwaysListen: true }), 'tag-only');
  assert.equal(legacyGateMode({ gateMode: 'bogus' as never, readOnly: true }), 'read-only', 'a bad value falls back to the flags');
});

test('channel beats server; with neither, the gateway toggle decides', () => {
  assert.equal(resolveGateMode({ gateMode: 'chime-in' }, { gateMode: 'tag-only' }, true), 'chime-in');
  assert.equal(resolveGateMode({}, { gateMode: 'read-only' }, true), 'read-only', 'a channel with no gate takes the server default');
  assert.equal(resolveGateMode(undefined, { requireMention: true }, false), 'tag-only');
  assert.equal(resolveGateMode(undefined, { requireMention: false }, true), 'chime-in');
  assert.equal(resolveGateMode(undefined, undefined, true), 'tag-only', 'Require @mention in guilds on');
  assert.equal(resolveGateMode(undefined, undefined, false), 'chime-in', 'and off');
});

// --- trust levels ---

test('no user rule is Limited', () => {
  assert.equal(effectiveTrustLevel(undefined), 'limited');
  assert.equal(effectiveTrustLevel({ trustLevel: 'full' }), 'full');
  assert.equal(effectiveTrustLevel({ trustLevel: 'standard' }), 'standard');
  assert.equal(effectiveTrustLevel({ trustLevel: 'nonsense' as never }), 'limited');
});

test('each trust level gets its plain line, and Limited keeps the operator out of it entirely', () => {
  assert.match(trustGuidance('full', 'the operator'), /family/i);
  assert.match(trustGuidance('full', 'the operator'), /builds, experiments and the house/);
  assert.match(trustGuidance('standard', 'the operator'), /friendly and general/i);
  assert.match(trustGuidance('standard', 'the operator'), /Don't go into what we're building or testing/);
  assert.match(trustGuidance('limited', 'the operator'), /Short, plain answers/);
  assert.match(trustGuidance('limited', 'the operator'), /nothing about the operator's life, schedule, work or whereabouts/);
});

test("the operator's public-space rule names everything it covers", () => {
  const line = publicSafetyLine('the operator');
  for (const word of ['location', 'workplace', 'clients', 'schedule', 'gigs', 'call times', 'any server', 'any trust level']) {
    assert.ok(line.includes(word), word);
  }
});

test('the speaker helper: the operator is the owner, a rule gives its level, no rule is Limited', () => {
  const user = speakerFrom({ userId: 'k', ownerUserId: 'k' });
  assert.equal(user.isOwner, true);
  const family = speakerFrom({ userId: 'f', ownerUserId: 'k', rule: { id: 'f', name: 'Fam', trustLevel: 'full', relationship: 'sister' } });
  assert.deepEqual(
    { isOwner: family.isOwner, hasRule: family.hasRule, trustLevel: family.trustLevel, relationship: family.relationship },
    { isOwner: false, hasRule: true, trustLevel: 'full', relationship: 'sister' },
  );
  const stranger = speakerFrom({ userId: 's', ownerUserId: 'k' });
  assert.deepEqual({ isOwner: stranger.isOwner, hasRule: stranger.hasRule, trustLevel: stranger.trustLevel }, { isOwner: false, hasRule: false, trustLevel: 'limited' });
  assert.equal(speakerFrom({ userId: '', ownerUserId: '' }).isOwner, false, 'no owner id configured means nobody is the operator');
});

// --- wiring in index.ts ---

test('a waiting message opens its beat only after it reaches the screen, and the beat never types', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const broadcast = source.indexOf("this.registry.broadcast({ type: 'message', message: incomingMsg })");
  const open = source.indexOf('this.openBeat({');
  assert.ok(broadcast > 0 && open > broadcast, 'the beat should open after the incoming message is broadcast');
  const fire = source.indexOf('private async fireBeat(');
  const fireEnd = source.indexOf('\n  }\n', fire);
  assert.ok(fire > 0 && fireEnd > fire);
  assert.ok(!source.slice(fire, fireEnd).includes('sendTyping'), 'a beat may well say nothing, so it never shows a typing dot');
  assert.ok(source.includes("{ countBotTurn: judged === 'answer' }"), 'a held bot turn is not counted at approval');
});

test('the old model judge is gone, and a deferred message gets no hourglass', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('judgeShouldRespond'), 'no small-model judge');
  assert.ok(!source.includes('\\u23F3'), 'no hourglass');
  assert.ok(!/\.react\(['"]⏳/.test(source), 'no hourglass emoji either');
});

test('[SILENT] and the query queue refusal are never posted', async () => {
  const { isQueueRefusal, QUEUE_TIMEOUT_TEXT } = await import('./index.js');
  assert.equal(isQueueRefusal('[Request timed out in queue]'), true);
  assert.equal(isQueueRefusal('  [Request timed out in queue]\n'), true);
  assert.equal(isQueueRefusal('[Companion A & Companion B is busy — please try again in a moment]'), true);
  assert.equal(isQueueRefusal('**Companion A**\nWe heard you.'), false);
  assert.equal(isQueueRefusal('the queue [Request timed out in queue] inside a sentence'), false);
  const agent = readFileSync(new URL('../agent.ts', import.meta.url), 'utf8');
  assert.ok(agent.includes(`QUEUE_TIMEOUT_MESSAGE = '${QUEUE_TIMEOUT_TEXT}'`), 'the copy matches the queue');
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const guard = source.indexOf('if (response && isQueueRefusal(response)) {');
  const silent = source.indexOf('if (isDeliberateSilence(response)) {');
  const post = source.indexOf('parseAttachmentMarkers(resolved)');
  assert.ok(guard > 0 && silent > 0 && post > guard && post > silent, 'both are caught before anything is sent');
});
