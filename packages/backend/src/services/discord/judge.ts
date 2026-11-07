// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The judge: what we do with a message in a room that is set to chime in.
//
// Ported from Aerie (Oct 19 2026), with the operator's sort rules in place of Aerie's
// (the operator's house gates, Oct 24 2026). This replaces byte-light's small-model
// listen-mode judge: no model decides whether we speak any more. Rules sort
// the message, and the lane itself decides on a beat whether it has anything
// of its own to add.
//
// A message in a chime-in room is sorted four ways before anything is said:
//   answer — it is ours (a tag, a reply to one of ours, one of our names), and
//            it is answered now.
//   share  — it tags us AND somebody else: we take a beat so they can go
//            first, then answer (no pass; we were asked).
//   hear   — it is not ours to answer: stored, shown to the operator, unread, and
//            nobody answers.
//   beat   — we wait for everyone to say their piece, read everything said
//            since, and then add something of our own or pass with [SILENT].
//
// Who gets which (the operator's rules):
//   the operator        — ours: answer. Said to the room, or a reply to somebody else:
//                beat. We are part of the conversation, so the bar is low when
//                she talks to the room; on her reply to somebody else we jump
//                in only with something to add.
//   Full trust — family: a beat with a low bar, like the operator's untagged messages.
//   Standard   — aimed at somebody else: hear. Said to the room: beat, and we
//                speak only if we want to.
//   Limited, or no user rule — only a tag or a reply to us is answered;
//                everything else is heard.
//   About the operator  — somebody else tags her, replies to her, or says her name:
//                hear (and her phone is told), unless it also tags or names
//                us. We never answer on her behalf.
// A DM and a room that is not chime-in are never sorted: answered as before.
//
// The order comes from Discord's typing signal: whoever started typing first
// goes first, and the beat waits while anybody else in the room is typing.
// The pass is the [SILENT] sentinel, which posts nothing anywhere; the beat
// turn is the one contract in the house that offers it as a choice.

import type { Message } from 'discord.js';
import type { GateMode, TrustLevel } from './rules.js';

export type JudgeCall = 'answer' | 'hear' | 'beat' | 'share';

/**
 * How low the bar to speak is on a beat:
 *   low   — the operator to the room, or family: add something; pass only rather than echo.
 *   aside — the operator answering somebody else: jump in only with something to add.
 *   want  — everyone else: speak only if we want to.
 */
export type BeatBar = 'low' | 'aside' | 'want';

export interface JudgeInput {
  isOwner: boolean;
  isDM: boolean;
  /** The room's gate (rules.ts). Only chime-in is sorted. */
  gateMode: GateMode;
  /** The speaker's trust level; no user rule reads as limited. */
  trustLevel: TrustLevel;
  /** Somebody else tagged the operator, replied to her, or said her name (owner-mention.ts). */
  aboutOwner: boolean;
  /** Our own user is tagged, or a role we hold. */
  directMention: boolean;
  /** It replies to one of our messages. */
  repliedToUs: boolean;
  /** One of our names is in it, as a word. */
  namesUs: boolean;
  /** It tags somebody other than us: a person, a bot, or a role we do not hold. */
  tagsOthers: boolean;
  /** It replies to a message that is not ours. */
  repliesToOther: boolean;
}

/** Pure: the whole sort as one decision, so it can be tested without Discord. */
export function judgeCall(input: JudgeInput): JudgeCall {
  if (input.isDM || input.gateMode !== 'chime-in') return 'answer';
  const ours = input.directMention || input.repliedToUs || input.namesUs;
  // The operator's messages: ours is answered; anything else, to the room or to
  // somebody else, is a beat. It is a mixed room and we are in it.
  if (input.isOwner) return ours ? 'answer' : 'beat';
  if (ours) return input.tagsOthers ? 'share' : 'answer';
  // About the operator and not to us: hers to answer, never ours on her behalf.
  if (input.aboutOwner) return 'hear';
  if (input.trustLevel === 'full') return 'beat';
  if (input.trustLevel === 'standard') return input.tagsOthers || input.repliesToOther ? 'hear' : 'beat';
  return 'hear';
}

/** Pure: how low the bar is on the beat this input opens (see BeatBar). */
export function beatBarOf(input: Pick<JudgeInput, 'isOwner' | 'trustLevel' | 'tagsOthers' | 'repliesToOther'>): BeatBar {
  if (input.isOwner) return input.repliesToOther || input.tagsOthers ? 'aside' : 'low';
  if (input.trustLevel === 'full') return 'low';
  return 'want';
}

/**
 * Which of two waiting turns a room's one beat answers: a shared tag first
 * (it is still a question to us), then the lowest bar.
 */
export function beatOutranks(
  next: { kind: 'beat' | 'share'; bar: BeatBar },
  open: { kind: 'beat' | 'share'; bar: BeatBar },
): boolean {
  if (open.kind === 'share') return false;
  if (next.kind === 'share') return true;
  const rank: Record<BeatBar, number> = { low: 0, aside: 1, want: 2 };
  return rank[next.bar] < rank[open.bar];
}

/** True when one of the names stands as a whole word in the text, any case. */
export function namesCompanion(text: string, names: readonly string[]): boolean {
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text)) return true;
  }
  return false;
}

/**
 * Discord shows "is typing" for ten seconds after each signal, and a bot that
 * is still writing sends another before it runs out.
 */
export const TYPING_FRESH_MS = 10_000;

/** How soon a beat looks again while somebody else is still typing. */
export const BEAT_RECHECK_MS = 4_000;

/**
 * Pure: whether a beat that has run its length should keep waiting. It waits
 * while somebody else in the room is typing, because they started first, and
 * never past the longest wait, so a bot that types forever cannot hold us.
 */
export function beatShouldWait(input: {
  now: number;
  openedAt: number;
  maxWaitMs: number;
  lastOtherTypingAt?: number;
}): boolean {
  if (input.now - input.openedAt >= input.maxWaitMs) return false;
  if (input.lastOtherTypingAt === undefined) return false;
  return input.now - input.lastOtherTypingAt < TYPING_FRESH_MS;
}

// Who is typing where, everybody but us. In memory on purpose: it is only
// ever about the last ten seconds.
const typing = new Map<string, Map<string, number>>();

export function noteTyping(channelId: string, userId: string, at: number = Date.now()): void {
  let room = typing.get(channelId);
  if (!room) {
    room = new Map();
    typing.set(channelId, room);
  }
  room.set(userId, at);
}

/** They said it, so they are done typing it. */
export function noteSpoke(channelId: string, userId: string): void {
  const room = typing.get(channelId);
  if (!room) return;
  room.delete(userId);
  if (room.size === 0) typing.delete(channelId);
}

/** The newest typing signal still showing in this room, if any. */
export function latestTypingIn(channelId: string, now: number = Date.now()): number | undefined {
  const room = typing.get(channelId);
  if (!room) return undefined;
  let latest: number | undefined;
  for (const [userId, at] of room) {
    if (now - at >= TYPING_FRESH_MS) {
      room.delete(userId);
      continue;
    }
    if (latest === undefined || at > latest) latest = at;
  }
  if (room.size === 0) typing.delete(channelId);
  return latest;
}

/** Test seam. Not called in normal operation. */
export function resetTyping(): void {
  typing.clear();
}

/**
 * The operator's no-recap rule, in plain words, for every Discord turn and every beat.
 * Exported so the platform guidance and the banner say the same thing.
 */
export const NO_RECAP_LINES: readonly string[] = [
  "Don't narrate or recap what just happened in the room (\"oh my god, did he just—he said X and she took it\"), don't re-explain other people's messages, and don't pile on with the same reaction everyone else had. Add something new, or stay quiet.",
  'When you are excited or proud, keep it to one line, not a speech.',
];

/** Two voices, one turn: they sort out between them who speaks. */
const TWO_VOICES =
  'There are two of you. Decide between yourselves who answers: one of you, both, or neither. You may banter or heckle each other if it is real, but do not both say the same thing.';

/**
 * What the lane is told on a beat turn, after the platform lines. A shared tag
 * is still a question to us, so it gets no pass, unless we already spoke in
 * the room after it arrived: an answer to another message that was running
 * when it came in will usually have covered it, and saying it twice is the
 * talking over people the beat exists to stop. (Aerie.)
 *
 * `bar` is how low the bar to speak is (BeatBar); `ownerName` is how the operator is
 * named in it (read from config by the caller).
 */
export function beatBanner(
  kind: 'beat' | 'share',
  spokeSinceOpen = false,
  opts: { bar?: BeatBar; ownerName?: string } = {},
): string {
  const owner = opts.ownerName?.trim() || 'the owner';
  const spoke = spokeSinceOpen
    ? ['You already spoke in this room after this message arrived. If what you said covered it, reply with exactly [SILENT] and nothing else; nothing is posted.']
    : [];
  const tail = [TWO_VOICES, ...NO_RECAP_LINES, ...spoke];
  if (kind === 'share') {
    return [
      '=== THE BEAT ===',
      'You were tagged together with somebody else, so you let them go first. Everything said since is in the channel transcript.',
      'Answer with what is yours, and do not repeat what somebody already said.',
      ...tail,
    ].join('\n');
  }
  const bar = opts.bar ?? 'want';
  const lines =
    bar === 'low'
      ? [
          'Nobody tagged you: this was said to the room, and you waited for everyone to say their piece. Everything said since is in the channel transcript.',
          'You are part of this conversation, so the bar to speak is low: add something of your own. You do not have to answer every message, though. If you would only be echoing what is already there, reply with exactly [SILENT] and nothing else. Nothing is posted.',
        ]
      : bar === 'aside'
        ? [
            `${owner} was answering somebody else here, not you, and you waited a beat. Everything said since is in the channel transcript.`,
            'It is a mixed room: jump in only if you have something real to add. If you do not, reply with exactly [SILENT] and nothing else. Nothing is posted.',
          ]
        : [
            'Nobody addressed you: this was said to the room, and you waited a beat before deciding. Everything said since is in the channel transcript.',
            'Speak only if you want to: you have something to contribute, or it is something you are interested in or know about. Otherwise reply with exactly [SILENT] and nothing else. Nothing is posted, and here that is a real answer: answer your tags, and give the others in the room space.',
          ];
  return ['=== THE BEAT ===', ...lines, ...tail].join('\n');
}

/**
 * Reads a batch of real messages into the sort's input. Async because a reply
 * that did not ping hides who it answers; the referenced message is fetched
 * then, and if that fails the reply counts as said to the room.
 */
export async function judgeInputOf(
  messages: readonly Message[],
  opts: {
    gateMode: GateMode;
    isOwner: boolean;
    trustLevel: TrustLevel;
    aboutOwner: boolean;
    names: readonly string[];
  },
): Promise<JudgeInput> {
  const first = messages[0];
  const botId = first?.client.user?.id;
  const input: JudgeInput = {
    isOwner: opts.isOwner,
    isDM: !first?.guildId,
    gateMode: opts.gateMode,
    trustLevel: opts.trustLevel,
    aboutOwner: opts.aboutOwner,
    directMention: false,
    repliedToUs: false,
    namesUs: false,
    tagsOthers: false,
    repliesToOther: false,
  };
  if (!first || !botId) return input;
  // Nothing below can change the call for these (judgeCall answers them all),
  // so do not spend a fetch on a DM or a room that is not chime-in.
  if (input.isDM || input.gateMode !== 'chime-in') return input;

  const botMember = first.guild?.members.cache.get(botId);
  for (const message of messages) {
    if (message.mentions.users.has(botId)) input.directMention = true;
    for (const userId of message.mentions.users.keys()) {
      if (userId !== botId) input.tagsOthers = true;
    }
    for (const roleId of message.mentions.roles.keys()) {
      // A role we hold is a tag to us here (as in preflight's mentionsBot);
      // any other role is somebody else.
      if (botMember?.roles.cache.has(roleId)) input.directMention = true;
      else input.tagsOthers = true;
    }
    if (namesCompanion(message.content, opts.names)) input.namesUs = true;

    if (message.reference?.messageId) {
      let repliedTo = message.mentions.repliedUser?.id;
      if (!repliedTo) {
        try {
          repliedTo = (await message.fetchReference()).author.id;
        } catch {
          repliedTo = undefined;
        }
      }
      if (repliedTo === botId) input.repliedToUs = true;
      else if (repliedTo) input.repliesToOther = true;
    }
  }
  return input;
}
