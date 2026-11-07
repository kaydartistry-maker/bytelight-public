// Server/channel/user rules — DB-backed with JSON file fallback
// First boot: loads from data/discord-rules.json, then persists to DB

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfig, setConfig } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * How a room is gated (the operator's house gates, Oct 24 2026):
 *   tag-only  — answered only when we are tagged or replied to.
 *   chime-in  — tags answered; everything else sorted by the judge (judge.ts).
 *   read-only — never answered. A message about the operator still reaches her phone.
 *   ignore    — not read at all.
 */
export type GateMode = 'tag-only' | 'chime-in' | 'read-only' | 'ignore';

export const GATE_MODES: readonly GateMode[] = ['tag-only', 'chime-in', 'read-only', 'ignore'];

export interface ServerRule {
  id: string;
  name: string;
  context: string;
  /** Default gate for this server's channels. Wins over the legacy flags below. */
  gateMode?: GateMode;
  /** Legacy: true reads as tag-only, false as chime-in (see legacyGateMode). */
  requireMention?: boolean;
  ignoredChannels?: string[];
  ignoredUsers?: string[];
  allowPublicResponses?: boolean;
}

export interface ChannelRule {
  id: string;
  name: string;
  serverId: string;
  context?: string;
  /** This room's gate. Wins over the legacy flags below. */
  gateMode?: GateMode;
  // Legacy flags, still honoured when gateMode is unset (see legacyGateMode).
  requireMention?: boolean;
  alwaysListen?: boolean;
  ignore?: boolean;
  readOnly?: boolean;
}

export interface UserRule {
  id: string;
  name: string;
  context?: string;
  allowedServers?: string[];
  blockedServers?: string[];
  trustLevel: 'full' | 'standard' | 'limited';
  relationship?: string;
}

export interface RulesData {
  servers: Record<string, ServerRule>;
  channels: Record<string, ChannelRule>;
  users: Record<string, UserRule>;
}

// Load rules from data directory (fallback for first boot)
const RULES_PATH = join(__dirname, '../../../data/discord-rules.json');

function loadRulesFromFile(): RulesData {
  try {
    const content = readFileSync(RULES_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.warn('[Discord Rules] Failed to load discord-rules.json, using empty rules:', (error as Error).message);
    return { servers: {}, channels: {}, users: {} };
  }
}

function loadRulesFromDb(): RulesData | null {
  const raw = getConfig('discord.rules');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn('[Discord Rules] Failed to parse rules from DB, falling back to file');
    return null;
  }
}

function loadRulesWithFallback(): RulesData {
  return loadRulesFromDb() || loadRulesFromFile();
}

// Active rule maps — lazily initialized on first access (DB may not be ready at import time)
export const serverRules: Map<string, ServerRule> = new Map();
export const channelRules: Map<string, ChannelRule> = new Map();
export const userRules: Map<string, UserRule> = new Map();

let rulesInitialized = false;

function ensureRulesLoaded(): void {
  if (rulesInitialized) return;
  rulesInitialized = true;
  const data = loadRulesWithFallback();
  for (const [k, v] of Object.entries(data.servers)) serverRules.set(k, v);
  for (const [k, v] of Object.entries(data.channels)) channelRules.set(k, v);
  for (const [k, v] of Object.entries(data.users)) userRules.set(k, v);
  console.log(`[Discord Rules] Loaded ${serverRules.size} server, ${channelRules.size} channel, ${userRules.size} user rules`);
}

// --- Getters ---

export function getServerRule(guildId: string | null): ServerRule | undefined {
  ensureRulesLoaded();
  if (!guildId) return undefined;
  return serverRules.get(guildId);
}

export function getChannelRule(channelId: string): ChannelRule | undefined {
  ensureRulesLoaded();
  return channelRules.get(channelId);
}

export function getUserRule(userId: string): UserRule | undefined {
  ensureRulesLoaded();
  return userRules.get(userId);
}

// Resolve the effective channel rule for a message. A thread's own rule (keyed
// by its thread id) wins over the parent channel's rule (most-specific-wins,
// consistent with channel-over-server precedence). When there is no thread, or
// the thread has no own rule, the parent channel's rule applies.
export function getEffectiveChannelRule(channelId: string, parentChannelId?: string | null): ChannelRule | undefined {
  const ownRule = getChannelRule(channelId);
  if (ownRule) return ownRule;
  if (parentChannelId) return getChannelRule(parentChannelId);
  return undefined;
}

function isGateMode(value: unknown): value is GateMode {
  return typeof value === 'string' && (GATE_MODES as readonly string[]).includes(value);
}

/**
 * Pure: the gate a single rule asks for, or undefined when it asks for none.
 * An explicit gateMode wins. Otherwise the operator's saved rules are read as they
 * were written, never rewritten: ignore, then readOnly (both outranked a tag
 * before), then requireMention (true = tag-only, false = chime-in, and it
 * outranked alwaysListen before), then alwaysListen (chime-in).
 *
 * `skip` leaves legacy flags for the named modes out, so the older one-flag
 * questions (is this read-only? does it need a tag?) still read each flag
 * on its own, the way they always did. The gate itself never skips anything.
 */
export function legacyGateMode(
  rule: Partial<ChannelRule> | Partial<ServerRule> | undefined,
  skip: readonly GateMode[] = [],
): GateMode | undefined {
  if (!rule) return undefined;
  if (isGateMode(rule.gateMode)) return rule.gateMode;
  const r = rule as Partial<ChannelRule>;
  if (r.ignore === true && !skip.includes('ignore')) return 'ignore';
  if (r.readOnly === true && !skip.includes('read-only')) return 'read-only';
  if (r.requireMention === true) return 'tag-only';
  if (r.requireMention === false) return 'chime-in';
  if (r.alwaysListen === true) return 'chime-in';
  return undefined;
}

/**
 * Pure: a room's gate from its rules. Channel beats server (a thread arrives
 * here with its own rule or, lacking one, its parent's); with neither, the
 * gateway's "Require @mention in guilds" toggle decides (on = tag-only,
 * off = chime-in).
 */
export function resolveGateMode(
  channelRule: Partial<ChannelRule> | undefined,
  serverRule: Partial<ServerRule> | undefined,
  defaultRequireMention: boolean,
  skip: readonly GateMode[] = [],
): GateMode {
  return legacyGateMode(channelRule, skip)
    ?? legacyGateMode(serverRule, skip)
    ?? (defaultRequireMention ? 'tag-only' : 'chime-in');
}

/**
 * The gate for a message's room. A DM has no gate (it is always answered);
 * it reads as chime-in here, and judge.ts answers DMs before looking at it.
 */
export function gateModeFor(
  channelId: string,
  guildId: string | null,
  defaultRequireMention: boolean,
  parentChannelId?: string | null,
  skip: readonly GateMode[] = [],
): GateMode {
  if (!guildId) return 'chime-in';
  return resolveGateMode(
    getEffectiveChannelRule(channelId, parentChannelId),
    getServerRule(guildId),
    defaultRequireMention,
    skip,
  );
}

export function isChannelIgnored(channelId: string, guildId: string | null, parentChannelId?: string | null): boolean {
  if (guildId) {
    const serverRule = getServerRule(guildId);
    // Server-level ignoredChannels also covers a thread whose parent is ignored.
    if (serverRule?.ignoredChannels?.includes(channelId)) return true;
    if (parentChannelId && serverRule?.ignoredChannels?.includes(parentChannelId)) return true;
    return gateModeFor(channelId, guildId, false, parentChannelId) === 'ignore';
  }
  return legacyGateMode(getEffectiveChannelRule(channelId, parentChannelId)) === 'ignore';
}

// True when the room is read-only (own thread rule, inherited parent, or the
// server default). Read-only outranks mentions — the bot never replies here.
// Asked after the ignore check, so an ignore flag beside it is passed over.
export function isChannelReadOnly(channelId: string, parentChannelId?: string | null, guildId?: string | null): boolean {
  if (guildId) return gateModeFor(channelId, guildId, false, parentChannelId, ['ignore']) === 'read-only';
  return legacyGateMode(getEffectiveChannelRule(channelId, parentChannelId), ['ignore']) === 'read-only';
}

// True when the room is tag-only. Asked after ignore and read-only.
export function requiresMention(channelId: string, guildId: string | null, defaultRequirement: boolean, parentChannelId?: string | null): boolean {
  if (!guildId) return false;
  return gateModeFor(channelId, guildId, defaultRequirement, parentChannelId, ['ignore', 'read-only']) === 'tag-only';
}

/** No rule = Limited (the operator's call). */
export type TrustLevel = UserRule['trustLevel'];

export function effectiveTrustLevel(rule: Pick<UserRule, 'trustLevel'> | undefined): TrustLevel {
  const level = rule?.trustLevel;
  return level === 'full' || level === 'standard' || level === 'limited' ? level : 'limited';
}

/**
 * The plain line a turn gets for the person it answers. The operator's own turns get
 * none: it is her house.
 */
export function trustGuidance(level: TrustLevel, ownerName: string): string {
  if (level === 'full') {
    return 'Trust: Full. This person is family. You can talk about our builds, experiments and the house.';
  }
  if (level === 'standard') {
    return "Trust: Standard. Be friendly and general. Don't go into what we're building or testing.";
  }
  return `Trust: Limited. Short, plain answers. Nothing about what we're building, experimenting with or testing, and nothing about ${ownerName}'s life, schedule, work or whereabouts.`;
}

/** The operator's public-space rule. Every server, every trust level, on top of everything else. */
export function publicSafetyLine(ownerName: string): string {
  return `In any server, at any trust level, this always applies: never mention ${ownerName}'s location, workplace, clients, schedule, gigs, call times or any identifying details of her professional life.`;
}

export function buildRulesContext(userId: string, channelId: string, guildId: string | null): string {
  const parts: string[] = [];

  if (guildId) {
    const serverRule = getServerRule(guildId);
    if (serverRule?.context) parts.push(serverRule.context);
  } else {
    parts.push('=== CONTEXT: DIRECT MESSAGE ===');
    parts.push('Private DM conversation. Full presence.');
  }

  const channelRule = getChannelRule(channelId);
  if (channelRule?.context) {
    parts.push('');
    parts.push(`=== CHANNEL: ${channelRule.name} ===`);
    parts.push(channelRule.context);
  }

  const userRule = getUserRule(userId);
  if (userRule) {
    parts.push('');
    parts.push(`=== SPEAKING WITH: ${userRule.name} ===`);
    if (userRule.relationship) parts.push(userRule.relationship);
    if (userRule.context) parts.push(userRule.context);
  }

  return parts.join('\n');
}

export function isUserAllowedInServer(userId: string, guildId: string | null): boolean {
  const userRule = getUserRule(userId);
  if (!userRule) return false;

  if (guildId && userRule.blockedServers?.includes(guildId)) return false;

  if (userRule.allowedServers && userRule.allowedServers.length > 0) {
    if (guildId && !userRule.allowedServers.includes(guildId)) return false;
  }

  return true;
}

// --- DB persistence ---

export function getRulesData(): RulesData {
  ensureRulesLoaded();
  return {
    servers: Object.fromEntries(serverRules),
    channels: Object.fromEntries(channelRules),
    users: Object.fromEntries(userRules),
  };
}

export function saveRules(data: RulesData): void {
  setConfig('discord.rules', JSON.stringify(data));
  reloadRules(data);
}

export function reloadRules(data?: RulesData): void {
  const d = data || loadRulesWithFallback();
  serverRules.clear();
  channelRules.clear();
  userRules.clear();
  for (const [k, v] of Object.entries(d.servers)) serverRules.set(k, v);
  for (const [k, v] of Object.entries(d.channels)) channelRules.set(k, v);
  for (const [k, v] of Object.entries(d.users)) userRules.set(k, v);
  console.log(`[Discord Rules] Reloaded: ${serverRules.size} server, ${channelRules.size} channel, ${userRules.size} user rules`);
}
