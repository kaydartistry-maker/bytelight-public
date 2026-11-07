// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Preflight validation — layered auth pipeline

import type { Message } from 'discord.js';
import type { PreflightResult, MessageBatch } from './types.js';
import { DISCORD_CONFIG, getOwnerMentionSettings } from './config.js';
import { strongestOwnerMention, type OwnerMentionReason } from './owner-mention.js';
import { PairingService } from './pairing.js';
import {
  isChannelIgnored,
  isChannelReadOnly,
  requiresMention,
  getUserRule,
  getServerRule,
  isUserAllowedInServer,
} from './rules.js';
import { botGateDecision, noteApproved } from './bot-loop.js';

export function isUserAllowed(userId: string): boolean {
  return DISCORD_CONFIG.allowedUsers.has(userId);
}

export function isGuildAllowed(guildId: string | null): boolean {
  if (!guildId) return true;
  return DISCORD_CONFIG.allowedGuilds.has(guildId);
}

export function mentionsBot(message: Message): boolean {
  if (!message.client.user) return false;
  // Direct @bot mention
  if (message.mentions.users.has(message.client.user.id)) return true;
  // Role mention — check if bot has any of the mentioned roles
  if (message.guild && message.mentions.roles.size > 0) {
    const botMember = message.guild.members.cache.get(message.client.user.id);
    if (botMember) {
      for (const [roleId] of message.mentions.roles) {
        if (botMember.roles.cache.has(roleId)) return true;
      }
    }
  }
  return false;
}

// True when this message is a direct reply to one of the bot's own messages.
// Discord surfaces the reply target as `message.mentions.repliedUser` (populated
// even when the reply does not @-ping); `message.reference` confirms it is a
// reply at all. A reply to the bot counts as a summon — it bypasses the
// listen-mode judge exactly the way an @-mention does.
export function repliesToBot(message: Message): boolean {
  if (!message.client.user) return false;
  if (!message.reference) return false;
  return message.mentions.repliedUser?.id === message.client.user.id;
}

/** Addressed to us: an @-mention (or a role we hold), or a reply to one of ours. */
export function summonsBot(message: Message): boolean {
  return mentionsBot(message) || repliesToBot(message);
}

/**
 * Why this batch is about the owner, when the switch is on. Every message in
 * the batch is read, because the debouncer folds one person's rapid messages
 * together and their name can be in any of them. (Aerie.)
 *
 * Never throws: not knowing who the owner is (config not loaded, nothing set)
 * means nothing is about the owner, and a door stays a door.
 */
export function ownerMentionIn(batch: MessageBatch): OwnerMentionReason | null {
  try {
    const settings = getOwnerMentionSettings();
    if (!settings.enabled) return null;
    return strongestOwnerMention(batch.messages, {
      ownerUserId: DISCORD_CONFIG.ownerUserId,
      selfUserId: batch.firstMessage.client.user?.id,
      ownerNames: settings.names,
    });
  } catch (err) {
    console.warn('[Discord] Could not check for a mention of the owner:', (err as Error).message);
    return null;
  }
}

/** A message about the owner that nobody addressed to us: heard, and her phone told. */
function aboutOwnerResult(reason: OwnerMentionReason): PreflightResult {
  return {
    allowed: false,
    deliver: true,
    ownerMention: reason,
    reason: `About the owner (${reason}) — heard, not answering`,
  };
}

/**
 * Every approved message is counted on the way out, in one place, so the
 * consecutive-bot guard cannot be bypassed by a branch that returns early.
 * A human resets the channel; a bot spends one of its turns. (Aerie.)
 *
 * The guard counts bot messages we ANSWER. A bot message the judge sorts to
 * hear or to a beat (judge.ts) is not answered at approval, so it is not
 * counted here (countBotTurn: false) and is counted only if the beat answers
 * it (noteJudgedAnswer). A person still resets the room the moment they are
 * approved, whatever the judge says. (Aerie.)
 */
export async function preflight(
  batch: MessageBatch,
  pairingService: PairingService,
  opts: { countBotTurn?: boolean } = {},
): Promise<PreflightResult> {
  const result = await decide(batch, pairingService);
  if (result.allowed) countApproved(batch.channelId, batch.firstMessage.author.bot, opts.countBotTurn !== false);
  return result;
}

/** Pure: whether an approval is counted. Everything counts except a bot turn the judge is holding. */
export function approvalCounts(fromBot: boolean, countBotTurn: boolean): boolean {
  return !fromBot || countBotTurn;
}

function countApproved(channelId: string, fromBot: boolean, countBotTurn: boolean): void {
  if (approvalCounts(fromBot, countBotTurn)) noteApproved(channelId, fromBot);
}

/** A beat turn that answered: the bot turn it opened on is spent now. */
export function noteJudgedAnswer(channelId: string, fromBot: boolean): void {
  countApproved(channelId, fromBot, true);
}

async function decide(batch: MessageBatch, pairingService: PairingService): Promise<PreflightResult> {
  const { firstMessage, userId, guildId, channelId, parentChannelId } = batch;

  // Bots: unknown ones never got in, and trusted ones are still capped. Every
  // turn in a runaway is individually legitimate — a trusted bot genuinely
  // addressing us — which is why the count is the only thing that can stop it.
  // One human message in the channel opens this again.
  //
  // A capped channel comes back with deliver:true rather than a plain refusal:
  // an unknown bot is turned away at the door, and a trusted one we have simply
  // run out of turns for is still HEARD. (Aerie.)
  const authorRule = getUserRule(firstMessage.author.id);
  const botGate = botGateDecision({
    isBot: firstMessage.author.bot,
    hasRule: !!authorRule,
    channelId,
    // A bot the operator set to Full trust gets the looser allowance (bot-loop.ts).
    trustLevel: authorRule?.trustLevel,
  });
  if (!botGate.allowed) {
    return { allowed: false, reason: botGate.reason!, deliver: botGate.deliver };
  }

  // Check if channel is ignored (threads inherit the parent channel's rule)
  if (isChannelIgnored(channelId, guildId, parentChannelId)) {
    return { allowed: false, reason: 'Channel is ignored' };
  }

  // Read-only channels never get a reply — outranks @-mentions (threads
  // inherit parent). A message about the owner is the one thing that still
  // comes through, heard and never answered, once the doors below say yes.
  const readOnly = isChannelReadOnly(channelId, parentChannelId, guildId);
  const readOnlyMention = readOnly && guildId ? ownerMentionIn(batch) : null;
  if (readOnly && !readOnlyMention) {
    return { allowed: false, reason: 'Channel is read-only' };
  }

  const userAllowed = isUserAllowed(userId);
  const userRule = getUserRule(userId);
  const serverRule = guildId ? getServerRule(guildId) : undefined;

  // Guild message flow
  if (guildId) {
    if (!userAllowed && !isGuildAllowed(guildId)) {
      return { allowed: false, reason: 'Guild not on allowlist' };
    }

    if (userRule && !isUserAllowedInServer(userId, guildId)) {
      return { allowed: false, reason: 'User not allowed in this server by rules' };
    }

    if (serverRule?.ignoredUsers?.includes(userId)) {
      return { allowed: false, reason: 'User is ignored in this server' };
    }

    if (readOnlyMention) return aboutOwnerResult(readOnlyMention);

    // Tag-only: a tag or a reply to one of ours gets through. Anything else is
    // turned away, unless it is about the owner: then it still reaches her,
    // heard and not answered. It sits here and nowhere earlier on purpose:
    // every door above has already said yes to this server, channel and
    // person, and a message that does address us never gets this far, so it
    // is a turn and not also a notification. (Aerie.)
    const needsMention = requiresMention(channelId, guildId, DISCORD_CONFIG.requireMentionInGuilds, parentChannelId);
    if (needsMention && !summonsBot(firstMessage)) {
      const aboutOwner = ownerMentionIn(batch);
      if (aboutOwner) return aboutOwnerResult(aboutOwner);
      return { allowed: false, reason: 'Mention required in this channel' };
    }

    if (userAllowed || isGuildAllowed(guildId)) {
      return { allowed: true, reason: 'Guild message approved' };
    }

    if (serverRule?.allowPublicResponses && summonsBot(firstMessage)) {
      return { allowed: true, reason: 'Public response allowed in this server' };
    }

    return { allowed: false, reason: 'User not allowed in this guild' };
  }

  // DM flow
  if (userAllowed) {
    return { allowed: true, reason: 'User is on allowlist' };
  }

  // Check SQLite-backed pairing
  if (pairingService.isApproved(userId)) {
    return { allowed: true, reason: 'User has approved pairing' };
  }

  // Need pairing
  const config = await import('../../config.js').then(m => m.getBytelightConfig());
  const code = pairingService.createOrGet(userId, firstMessage.author.username, channelId);
  return {
    allowed: false,
    reason: 'Pairing required for DM',
    requiresPairing: true,
    pairingCode: code,
  };
}
