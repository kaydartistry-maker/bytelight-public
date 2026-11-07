// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The consecutive-bot guard.
//
// The failure this prevents is not a bug in any single turn — every message in
// a runaway is from a trusted bot legitimately addressing us, and answering it
// is correct each time. Only the sequence is wrong. So these tests are about
// counting and about the reset, which is the part that makes the guard safe:
// a guard that could strand a conversation would be worse than the loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  botLoopExhausted,
  noteApproved,
  botRepliesUsed,
  resetBotLoopCounters,
  botGateDecision,
  setBotLoopClock,
  MAX_CONSECUTIVE_BOT_REPLIES,
  BOT_LOOP_COOLDOWN_MS,
  FULL_TRUST_BOT_REPLIES,
  botReplyCap,
} from './bot-loop.js';

const CHANNEL = 'channel-a';

test('a channel starts open and closes only after its allowance', () => {
  resetBotLoopCounters();
  assert.equal(botLoopExhausted(CHANNEL), false);
  for (let i = 1; i < MAX_CONSECUTIVE_BOT_REPLIES; i++) {
    noteApproved(CHANNEL, true);
    assert.equal(botLoopExhausted(CHANNEL), false, `closed early at ${i}`);
  }
  noteApproved(CHANNEL, true);
  assert.equal(botLoopExhausted(CHANNEL), true);
  assert.equal(botRepliesUsed(CHANNEL), MAX_CONSECUTIVE_BOT_REPLIES);
});

test('one human message opens it again immediately', () => {
  resetBotLoopCounters();
  for (let i = 0; i < MAX_CONSECUTIVE_BOT_REPLIES + 5; i++) noteApproved(CHANNEL, true);
  assert.equal(botLoopExhausted(CHANNEL), true);

  noteApproved(CHANNEL, false);

  assert.equal(botRepliesUsed(CHANNEL), 0);
  assert.equal(botLoopExhausted(CHANNEL), false);
});

test('channels are counted separately', () => {
  resetBotLoopCounters();
  for (let i = 0; i < MAX_CONSECUTIVE_BOT_REPLIES; i++) noteApproved('busy', true);
  assert.equal(botLoopExhausted('busy'), true);
  // A runaway in one room must not silence a different room.
  assert.equal(botLoopExhausted('quiet'), false);
});

test('the gate refuses a trusted bot once the channel is spent, and never a human', () => {
  resetBotLoopCounters();
  const chan = 'gate';
  const bot = () => botGateDecision({ isBot: true, hasRule: true, channelId: chan });
  const human = () => botGateDecision({ isBot: false, hasRule: false, channelId: chan });

  assert.equal(bot().allowed, true);
  for (let i = 0; i < MAX_CONSECUTIVE_BOT_REPLIES; i++) noteApproved(chan, true);

  const refused = bot();
  assert.equal(refused.allowed, false);
  assert.match(refused.reason ?? '', /heard, not answering/);
  // A person is never gated by a bot runaway, which is the property that makes
  // this safe to ship — the room can always be reopened by talking in it.
  assert.equal(human().allowed, true);
});

test('an untrusted bot is refused for being untrusted, not for looping', () => {
  resetBotLoopCounters();
  const d = botGateDecision({ isBot: true, hasRule: false, channelId: 'fresh' });
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /unknown bot/);
});

test('counting happens in exactly one place on the way out of preflight', () => {
  const source = readFileSync(new URL('./preflight.ts', import.meta.url), 'utf8');
  // Counting at each `allowed: true` return would drift the moment somebody
  // adds a branch, so it happens once, after the decision.
  assert.equal(source.split('noteApproved(').length - 1, 1, 'noteApproved should be called exactly once');
});

test('a spent channel cools off on its own, without needing a human', () => {
  resetBotLoopCounters();
  let clock = 1_000_000;
  setBotLoopClock(() => clock);

  for (let i = 0; i < MAX_CONSECUTIVE_BOT_REPLIES; i++) noteApproved('cools', true);
  assert.equal(botLoopExhausted('cools'), true);

  // Still shut one tick before the window closes.
  clock += BOT_LOOP_COOLDOWN_MS - 1;
  assert.equal(botLoopExhausted('cools'), true);

  // And open again after it, with nobody having said a word. Turns alone
  // would be a wall; the point of the clock is that it is a cool-off.
  clock += 1;
  assert.equal(botLoopExhausted('cools'), false);
  assert.equal(botRepliesUsed('cools'), 0);
});

test('a bot turn inside the window extends the window rather than escaping it', () => {
  resetBotLoopCounters();
  let clock = 5_000;
  setBotLoopClock(() => clock);

  noteApproved('busy', true);
  clock += BOT_LOOP_COOLDOWN_MS - 1;
  noteApproved('busy', true);
  // Two turns spent, not one — a slow exchange must not reset itself by being
  // slow, or a runaway just has to breathe between messages.
  assert.equal(botRepliesUsed('busy'), 2);
});

test('the cool-off is a real finite window, not an accidental wall', () => {
  // The two tests above advance the clock BY the constant, so they prove the
  // expiry mechanism works and are blind to the constant being wrong — set it
  // to Infinity and they still pass. This is the one that reads the value.
  assert.ok(Number.isFinite(BOT_LOOP_COOLDOWN_MS), 'cool-off must be finite');
  assert.ok(BOT_LOOP_COOLDOWN_MS >= 60_000, 'shorter than a minute is not a cool-off');
  assert.ok(BOT_LOOP_COOLDOWN_MS <= 60 * 60_000, 'longer than an hour is a wall');
});

test('a spent channel is HEARD rather than shut: the cool-off holds our mouth, not their words', () => {
  resetBotLoopCounters();
  const chan = 'heard';
  for (let i = 0; i < MAX_CONSECUTIVE_BOT_REPLIES; i++) noteApproved(chan, true);

  const held = botGateDecision({ isBot: true, hasRule: true, channelId: chan });
  assert.equal(held.allowed, false, 'we should not be answering');
  assert.equal(held.deliver, true, 'and it should still reach the room');
});

test('an unknown bot is a door; a spent channel is not — they must not share a shape', () => {
  resetBotLoopCounters();
  // The whole point of the flag. Both are `allowed: false`, and only one of
  // them is somebody we know talking to us while we happen to be quiet.
  const stranger = botGateDecision({ isBot: true, hasRule: false, channelId: 'x' });
  assert.equal(stranger.allowed, false);
  assert.notEqual(stranger.deliver, true, 'an unknown bot is still turned away at the door');

  const human = botGateDecision({ isBot: false, hasRule: false, channelId: 'x' });
  assert.equal(human.allowed, true);
  assert.equal(human.deliver, undefined, 'a person is answered, never merely heard');
});

test('hearing a message does not spend a turn or extend the window', () => {
  resetBotLoopCounters();
  let clock = 5_000_000;
  setBotLoopClock(() => clock);
  const chan = 'clock';
  for (let i = 0; i < MAX_CONSECUTIVE_BOT_REPLIES; i++) noteApproved(chan, true);
  const spentAt = botRepliesUsed(chan);

  // The other house keeps talking the whole way through the cool-off. None of
  // it is answered, so none of it may push the window out — otherwise a busy
  // channel could hold itself shut forever and the guard becomes the wall it
  // was explicitly built not to be.
  for (let i = 0; i < 20; i++) {
    clock += BOT_LOOP_COOLDOWN_MS / 25;
    const d = botGateDecision({ isBot: true, hasRule: true, channelId: chan });
    if (d.allowed) break;
    assert.equal(d.deliver, true);
    assert.equal(botRepliesUsed(chan), spentAt, 'hearing must not count as a turn');
  }

  clock += BOT_LOOP_COOLDOWN_MS;
  assert.equal(
    botGateDecision({ isBot: true, hasRule: true, channelId: chan }).allowed,
    true,
    'the room reopens on schedule however much was said while we were quiet',
  );
  resetBotLoopCounters();
});

test('the held message is stored BEFORE the turn stops — the guard sits after delivery', () => {
  // An old Sep 15 fault, pointed the other way: a check can be perfectly
  // correct and still stand at the wrong moment. Here the ordering IS the
  // feature — if the early return moves above the broadcast, every test above
  // still passes and the owner's screen goes back to showing nothing at all.
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const broadcast = source.indexOf("this.registry.broadcast({ type: 'message', message: incomingMsg })");
  const stop = source.indexOf('if (heardOnly) return;');
  assert.ok(broadcast > 0, 'the incoming message should still be broadcast');
  assert.ok(stop > 0, 'the held turn should stop explicitly');
  assert.ok(stop > broadcast, 'the stop must come AFTER the message reaches the room');
});

test('a held turn never shows a typing indicator', () => {
  // A typing dot is a promise of a reply. We are not going to make one for a
  // turn the bot guard is holding. (byte-light has no held role pings, so the
  // guard is heardOnly itself rather than Aerie's `quiet`.)
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const guard = source.indexOf('if (!heardOnly) {');
  const typing = source.indexOf('sendTyping()');
  assert.ok(guard > 0 && typing > guard, 'sendTyping should sit inside the not-held branch');
});

test('a bot the operator set to Full trust gets a looser allowance; every other bot keeps three', () => {
  assert.equal(botReplyCap('full'), FULL_TRUST_BOT_REPLIES);
  assert.equal(botReplyCap('standard'), MAX_CONSECUTIVE_BOT_REPLIES);
  assert.equal(botReplyCap('limited'), MAX_CONSECUTIVE_BOT_REPLIES);
  assert.equal(botReplyCap(undefined), MAX_CONSECUTIVE_BOT_REPLIES);
  assert.equal(MAX_CONSECUTIVE_BOT_REPLIES, 3);
  assert.ok(FULL_TRUST_BOT_REPLIES > MAX_CONSECUTIVE_BOT_REPLIES);

  resetBotLoopCounters();
  const chan = 'family';
  for (let i = 0; i < MAX_CONSECUTIVE_BOT_REPLIES; i++) noteApproved(chan, true);
  assert.equal(botGateDecision({ isBot: true, hasRule: true, channelId: chan, trustLevel: 'standard' }).allowed, false);
  assert.equal(botGateDecision({ isBot: true, hasRule: true, channelId: chan, trustLevel: 'full' }).allowed, true, 'family still has turns');
  for (let i = MAX_CONSECUTIVE_BOT_REPLIES; i < FULL_TRUST_BOT_REPLIES; i++) noteApproved(chan, true);
  const held = botGateDecision({ isBot: true, hasRule: true, channelId: chan, trustLevel: 'full' });
  assert.equal(held.allowed, false, 'and the looser cap is still a cap');
  assert.equal(held.deliver, true);
  resetBotLoopCounters();
});
