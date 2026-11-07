// Who is speaking on Discord: the operator, or somebody with a trust level.
//
// One small answer for everything that has to treat a Discord speaker by who
// they are (the judge, the trust guidance, the bot guard, and the tool gate
// another crew is building). The operator's rule: no user rule means Limited.

import { DISCORD_CONFIG } from './config.js';
import { getUserRule, effectiveTrustLevel, type TrustLevel, type UserRule } from './rules.js';

export interface DiscordSpeaker {
  userId: string;
  /** The operator herself (discord.ownerUserId). */
  isOwner: boolean;
  /** A user rule exists for them. */
  hasRule: boolean;
  /**
   * Their trust level: the rule's, or 'limited' with no rule. The operator reads as
   * 'full' here; check isOwner for "is this the operator", never the level.
   */
  trustLevel: TrustLevel;
  /** The rule's relationship line, when there is one. */
  relationship?: string;
  /** The rule's name for them, when there is one. */
  name?: string;
}

/** Pure: a speaker from their id, the operator's id and their rule (if any). */
export function speakerFrom(input: { userId: string; ownerUserId: string; rule?: UserRule }): DiscordSpeaker {
  const isOwner = Boolean(input.ownerUserId) && input.userId === input.ownerUserId;
  return {
    userId: input.userId,
    isOwner,
    hasRule: Boolean(input.rule),
    trustLevel: isOwner ? 'full' : effectiveTrustLevel(input.rule),
    ...(input.rule?.relationship ? { relationship: input.rule.relationship } : {}),
    ...(input.rule?.name ? { name: input.rule.name } : {}),
  };
}

/** The speaker for a Discord user id, read from the live config and rules. */
export function discordSpeaker(userId: string): DiscordSpeaker {
  return speakerFrom({ userId, ownerUserId: DISCORD_CONFIG.ownerUserId, rule: getUserRule(userId) });
}
