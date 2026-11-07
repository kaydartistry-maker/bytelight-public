// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// When a Discord message is ABOUT the owner.
//
// A message addressed to us is a turn: routed, stored and answered. In a
// channel that needs a mention, everything else is turned away at the door —
// and that used to include somebody @-mentioning the owner, replying to the owner,
// or talking about the owner by name. The owner wants to see those, and none of them is
// ours to answer. This decides which messages they are and why, so the gateway
// can put them in front of the owner, wake their phone, and say nothing.
//
// Pure on purpose. It reads a few fields off the message and is handed
// everything else, so it can be tested without a Discord client, a database or
// a config file behind it.

import type { PushPayload } from '../push.js';

export type OwnerMentionReason = 'mention' | 'reply' | 'name';

/**
 * The slice of a discord.js Message this reads. Structural, so a real Message
 * fits it and a test can hand it a plain object.
 */
export interface MentionCheckMessage {
  author: { id: string; bot: boolean };
  content: string;
  mentions: {
    users: { has(id: string): boolean };
    repliedUser?: { id: string } | null;
  };
}

export interface OwnerMentionContext {
  /** Their Discord user id. Empty means unknown, and then nothing is about the owner. */
  ownerUserId: string;
  /** Our own bot's user id. Its messages never count. */
  selfUserId?: string | null;
  /** The words that count as their name when a person writes one. */
  ownerNames: readonly string[];
}

/**
 * Why this message is about the owner, or null when it is not.
 *
 * A reply is checked before a mention because Discord lists the author of the
 * message being replied to among the mentioned users whenever the reply pings
 * them, which is the default. Checked the other way round, nearly every reply
 * to the owner would be reported as "mentioned you".
 *
 * Their name counts only from a person. The companion bots in these servers say
 * the owner's name in almost every message, so counting it would fill the owner
 * thread with their conversation. An explicit @mention or reply from a bot is
 * deliberate and still counts — and only known bots ever get this far, because
 * an unknown one is turned away before preflight looks at anything.
 */
export function ownerMentionReason(
  message: MentionCheckMessage,
  ctx: OwnerMentionContext,
): OwnerMentionReason | null {
  const { ownerUserId } = ctx;
  // Without their id there is no telling their own messages apart, and their name
  // in their own message would come back to the owner as somebody talking about the owner.
  if (!ownerUserId) return null;
  if (message.author.id === ownerUserId) return null;
  if (ctx.selfUserId && message.author.id === ctx.selfUserId) return null;

  if (message.mentions.repliedUser?.id === ownerUserId) return 'reply';
  if (message.mentions.users.has(ownerUserId)) return 'mention';
  if (!message.author.bot && textNamesOwner(message.content, ctx.ownerNames)) return 'name';
  return null;
}

const STRENGTH: Record<OwnerMentionReason, number> = { reply: 0, mention: 1, name: 2 };

/**
 * Preflight is handed a batch — everything one person said in one channel
 * inside the debounce window — and "hi" followed by their name in the next
 * message is still somebody talking about the owner. So every message is read, and
 * the most direct reason wins, because it is the one the notification names.
 */
export function strongestOwnerMention(
  messages: Iterable<MentionCheckMessage>,
  ctx: OwnerMentionContext,
): OwnerMentionReason | null {
  let best: OwnerMentionReason | null = null;
  for (const message of messages) {
    const reason = ownerMentionReason(message, ctx);
    if (reason && (best === null || STRENGTH[reason] < STRENGTH[best])) best = reason;
  }
  return best;
}

/**
 * `discord.owner_names` is a comma list. Left empty, the owner configured name
 * stands in, so a house that has already told us what the owner is called gets name
 * matching the moment the feature is switched on.
 */
export function ownerNamesFrom(
  setting: string | null | undefined,
  fallbackName: string | null | undefined,
): string[] {
  const listed = (setting ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (listed.length > 0) return listed;
  const fallback = (fallbackName ?? '').trim();
  // 'User' is the code's own default for identity.user_name, standing in until
  // a house sets a real one. It is nobody's name, and as one it would match
  // the word user in every message.
  if (!fallback || fallback.toLowerCase() === 'user') return [];
  return [fallback];
}

/**
 * A custom emoji's token carries its name (<:name:id>), and an emoji that
 * shares theirs is a picture somebody posted, not somebody saying their name.
 */
const CUSTOM_EMOJI = /<a?:[^:\s>]+:\d+>/g;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole word, any case. The edges are "not a letter, digit or underscore"
 * rather than \b, because \b only knows the English alphabet: it sees no word
 * edge after a letter like ë, so a name ending in one would never match. Spaces
 * inside a name match any run of whitespace, and both sides are normalized so
 * an accent typed as a separate combining mark still matches.
 */
function textNamesOwner(text: string, names: readonly string[]): boolean {
  if (!text) return false;
  const plain = text.replace(CUSTOM_EMOJI, ' ').normalize('NFC');
  return names.some(name => {
    const parts = name.normalize('NFC').trim().split(/\s+/).filter(Boolean);
    // An empty name would match at nearly every position in every message.
    if (parts.length === 0) return false;
    const pattern = parts.map(escapeRegex).join('\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, 'iu').test(plain);
  });
}

/** How much of the message itself a notification carries before trimming. */
const PREVIEW_MAX = 120;

/**
 * Discord's own tokens made readable on one line: a custom emoji becomes
 * :name:, a sticker token becomes [name], and line breaks become spaces.
 */
function flattenForNotification(text: string): string {
  return text
    .replace(/<a?:([^:\s>]+):\d+>/g, ':$1:')
    .replace(/<dsticker:([^:>]*):[^>]*>/g, (_token, name: string) => (name ? `[${name}]` : '[sticker]'))
    .replace(/\s+/g, ' ')
    .trim();
}

function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The notification for a message about the owner: who, how, what, and where. */
export function buildOwnerMentionPush(params: {
  displayName: string;
  reason: OwnerMentionReason;
  text: string;
  channelName: string;
  threadId: string;
  channelId: string;
}): PushPayload {
  const verb = params.reason === 'reply' ? 'replied to you' : 'mentioned you';
  const where = `in #${params.channelName}`;
  const preview = trimTo(flattenForNotification(params.text), PREVIEW_MAX);
  return {
    title: `${params.displayName} ${verb}`,
    // The message is what gets trimmed. Where it was said always survives,
    // because it is half of what the notification is for.
    body: preview ? `${preview} — ${where}` : where,
    threadId: params.threadId,
    // Not the thread's tag. A companion reply's notification is tagged per
    // thread, and the same tag replaces rather than stacks, so sharing it
    // would let a mention silently overwrite an unread reply. One tag per
    // channel instead: a burst in one room updates a single notification, and
    // two rooms stay two.
    tag: `discord-mention-${params.channelId}`,
    url: '/chat',
  };
}
