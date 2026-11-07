// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// DiscordService — Gateway listener that routes Discord messages through AgentService

import {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  Partials,
  Routes,
} from 'discord.js';
import type { Message as DiscordMessage, TextChannel, AttachmentBuilder } from 'discord.js';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { FFMPEG } from '../binaries.js';
import { MessageDebouncer } from './debouncer.js';
import { preflight, noteJudgedAnswer, ownerMentionIn } from './preflight.js';
import { getSecret } from '../secrets.js';
import { PairingService } from './pairing.js';
import { getUserRule } from './rules.js';
import { discordTurnAudience } from '../turn-audience.js';
import { buildRulesContext, gateModeFor, trustGuidance, publicSafetyLine } from './rules.js';
import {
  judgeCall,
  judgeInputOf,
  beatBarOf,
  beatOutranks,
  beatShouldWait,
  beatBanner,
  noteTyping,
  noteSpoke,
  latestTypingIn,
  BEAT_RECHECK_MS,
  NO_RECAP_LINES,
  type JudgeCall,
  type BeatBar,
} from './judge.js';
import { botLoopExhausted, botReplyCap } from './bot-loop.js';
import { discordSpeaker } from './speaker.js';
import { buildOwnerMentionPush, type OwnerMentionReason } from './owner-mention.js';
import { getPushService } from '../push.js';
import { DISCORD_CONFIG, getDiscordConfig } from './config.js';
import { splitResponse, formatChannelHistory, resolveEmoteShorthand } from './utils.js';
import { parseAttachmentMarkers } from './attach-markers.js';
import type { MessageBatch } from './types.js';
import type { AgentService } from '../agent.js';
import { isDeliberateSilence } from '../silence.js';
import { createMessage, resolveRoutingThread, updateThreadActivity, listCompanions } from '../db.js';
import { getBytelightConfig } from '../../config.js';
import type { registry as registryInstance } from '../registry.js';
import type { VoiceService } from '../voice.js';
import { errMessage } from '../../util/errors.js';

type ConnectionRegistry = typeof registryInstance;

export type DiscordActionResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

// Zero-width chars survive String.trim(); strip them before blank-checks.
const ZERO_WIDTH = /[​‌‍﻿]/g;
export function isEffectivelyBlank(text: string | null | undefined): boolean {
  return !text || text.replace(ZERO_WIDTH, '').trim() === '';
}

/** Who a message of ours may ping. Users yes, roles and everyone never. (Aerie.) */
export const DISCORD_ALLOWED_MENTIONS = { parse: ['users'] as const, repliedUser: true };

function cleanId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{15,22}$/.test(value)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
  return value;
}

function cleanText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > max) throw new Error(`${name} must be at most ${max} characters`);
  return value;
}

async function discordVoiceMetadata(mp3: Buffer): Promise<{ duration: number; waveform: string }> {
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
    });
    proc.stdin.end(mp3);
  });

  const samples = Math.floor(pcm.length / 2);
  if (!samples) throw new Error('TTS produced no decodable audio');
  const points = Math.min(256, samples);
  const amplitudes = new Uint8Array(points);
  let peak = 1;
  for (let point = 0; point < points; point++) {
    const start = Math.floor(point * samples / points);
    const end = Math.max(start + 1, Math.floor((point + 1) * samples / points));
    let sum = 0;
    for (let i = start; i < end; i++) sum += Math.abs(pcm.readInt16LE(i * 2));
    const average = Math.round(sum / (end - start));
    amplitudes[point] = Math.min(255, average >> 7);
    peak = Math.max(peak, amplitudes[point]);
  }
  for (let i = 0; i < amplitudes.length; i++) {
    amplitudes[i] = Math.round(amplitudes[i] * 255 / peak);
  }
  return { duration: samples / 8000, waveform: Buffer.from(amplitudes).toString('base64') };
}

/** What the server actually calls this person: nickname > global name > username. */
function displayNameOf(message: DiscordMessage): string {
  return message.member?.displayName || message.author.displayName || message.author.username;
}

/** A Discord object's display name, when it has a real one. (Aerie.) */
function nameOf(thing: unknown): string | undefined {
  const name = (thing as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && name ? name : undefined;
}

/** Our names as words a message can carry (the judge's "one of our names"), from the companions list. */
function companionNames(): string[] {
  try {
    return listCompanions().flatMap((c) => [c.display_name, c.id]).filter(Boolean);
  } catch {
    return [];
  }
}

/** How the operator is named in a turn's lines: her configured name, never the code's 'User' placeholder. */
function ownerDisplayName(): string {
  try {
    const name = getBytelightConfig().identity.user_name?.trim();
    if (name && name.toLowerCase() !== 'user') return name;
  } catch { /* config not loaded */ }
  return 'the owner';
}

/** Everything a reply needs once the message it answers is stored. (Aerie.) */
interface ReplyTurn {
  /** 'answer' now, or a beat that has run ('beat' may pass, 'share' answers). */
  kind: 'answer' | 'beat' | 'share';
  /** How low the bar to speak is on a beat (judge.ts). */
  bar: BeatBar;
  batch: MessageBatch;
  threadId: string;
  threadName: string;
  /** Set when a beat is up: we posted in this room after its message arrived. */
  spokeSinceOpen?: boolean;
  isOwner: boolean;
  userId: string;
  channelId: string;
}

/** A message waiting for the beat (see judge.ts). (Aerie.) */
interface PendingBeat {
  openedAt: number;
  turn: ReplyTurn;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The query queue's timeout text (agent.ts QUEUE_TIMEOUT_MESSAGE), repeated
 * here rather than imported: agent.ts reaches this file through hooks.ts, and
 * a value import back would be a cycle. judge.test.ts holds the two equal.
 */
export const QUEUE_TIMEOUT_TEXT = '[Request timed out in queue]';

/** The query queue's own refusals, which are never words of ours. (Aerie.) */
export function isQueueRefusal(response: string): boolean {
  const text = response.trim();
  return text === QUEUE_TIMEOUT_TEXT || /^\[.* is busy — please try again in a moment\]$/.test(text);
}

/** What the log says when the judge keeps a message quiet. (Aerie.) */
function judgeReason(call: JudgeCall, aboutOwner: boolean): string {
  if (call === 'hear') return aboutOwner ? 'about the owner, not ours to answer (the judge)' : 'not ours to answer (the judge)';
  if (call === 'share') return 'tagged with somebody else, waiting a beat (the judge)';
  return 'waiting a beat (the judge)';
}

// The speaker helper for anything that needs to know who a Discord turn is
// for (the operator? which trust level?) — see speaker.ts.
export { discordSpeaker, speakerFrom, type DiscordSpeaker } from './speaker.js';

// Module-level activity tracker — records last message per Discord user
interface ActivityEntry {
  name: string;
  lastSeen: number;
  channelId: string;
}

const ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000; // entries older than a day are no longer "recent"
const recentActivity = new Map<string, ActivityEntry>();

export function getDiscordActivity(): Map<string, ActivityEntry> {
  return recentActivity;
}

/** A single connected-guild custom emoji, flattened for orientation/resolver use. */
export interface CustomEmoji {
  name: string;
  id: string;
  animated: boolean;
  guild: string;
}

// Module-level pointer to the live gateway (set on start, cleared on stop) so
// non-Discord modules (hooks orientation, outbound resolver) can read the
// connected guilds' custom emojis without an import cycle — mirrors the
// recentActivity/getDiscordActivity module accessor above.
let activeDiscordService: DiscordService | null = null;

/**
 * Flat list of every custom emoji across the connected guilds. Empty when the
 * gateway isn't started or no guilds are cached — never throws. Read live from
 * the discord.js cache (always current), same as getStats() reads guild count.
 */
export function getCustomEmojiCatalog(): CustomEmoji[] {
  return activeDiscordService?.listCustomEmojis() ?? [];
}

/** Live Discord gateway service, or null before start/after stop. */
export function getActiveDiscordService(): DiscordService | null {
  return activeDiscordService;
}

export class DiscordService {
  private client: Client;
  private debouncer: MessageDebouncer;
  private pairingService: PairingService;
  private agentService: AgentService;
  private registry: ConnectionRegistry;
  private processing = new Set<string>();
  private started = false;
  /** One open beat per room at most (see judge.ts). (Aerie.) */
  private beats = new Map<string, PendingBeat>();
  /** When we last posted in each room, so a beat knows whether we already spoke after it opened. (Aerie.) */
  private lastSpokeAt = new Map<string, number>();

  // Deferred queue — holds non-owner Discord batches when owner is active on web UI
  private deferredBatches: Array<{ batch: MessageBatch; queuedAt: number }> = [];
  private deferTimer: ReturnType<typeof setInterval> | null = null;

  // Stats
  private stats = {
    messagesReceived: 0,
    messagesProcessed: 0,
    deferred: 0,
    errors: 0,
    startedAt: Date.now(),
  };

  constructor(agentService: AgentService, registry: ConnectionRegistry) {
    this.agentService = agentService;
    this.registry = registry;
    this.pairingService = new PairingService();

    this.client = new Client({
      // Nothing we send can ping a whole server or a role: @everyone, @here
      // and <@&role> stay plain text. Tagging one person, and the person we
      // reply to, still works. Client-wide, so every send, reply and edit
      // below carries it. (Aerie.)
      allowedMentions: DISCORD_ALLOWED_MENTIONS,
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildExpressions, // keeps guild.emojis.cache fresh on add/update/delete
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        // Who is typing where: the judge's order (whoever started first goes
        // first). Not a privileged intent; nothing to switch on in the portal.
        // (Aerie.)
        GatewayIntentBits.GuildMessageTyping,
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
      ],
    });

    this.debouncer = new MessageDebouncer();
    this.debouncer.onBatch(this.handleBatch.bind(this));

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on(Events.TypingStart, (typing) => {
      if (typing.user.id === this.client.user?.id) return;
      noteTyping(typing.channel.id, typing.user.id, typing.startedTimestamp);
    });

    this.client.on(Events.MessageCreate, (message: DiscordMessage) => {
      // Ignore own messages
      if (message.author.id === this.client.user?.id) return;

      // Whoever was typing has said it now, heard by us or not. (Aerie.)
      noteSpoke(message.channelId, message.author.id);

      // Ignore unknown bots — allow bots with UserRules
      if (message.author.bot) {
        const botRule = getUserRule(message.author.id);
        if (!botRule) return;
        const hasPayload =
          message.attachments.size > 0 ||
          message.embeds.length > 0 ||
          (message.stickers?.size ?? 0) > 0;
        if (isEffectivelyBlank(message.content) && !hasPayload) {
          return; // zero-width blank from a peer bot — do not arm the debouncer
        }
        console.log(`[Discord] Known bot message: ${botRule.name}`);
      }

      this.stats.messagesReceived++;
      this.debouncer.add(message);
    });

    this.client.on(Events.ClientReady, (c) => {
      console.log(`[Discord] Logged in as ${c.user.tag}`);
      console.log(`[Discord] Guilds: ${c.guilds.cache.size}`);
    });

    this.client.on('error', (error) => {
      console.error('[Discord] Client error:', error);
    });

    this.client.on('warn', (msg) => {
      console.warn('[Discord] Warning:', msg);
    });

    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      console.error(`[Discord] Shard ${shardId} disconnected (code ${event.code})`);
    });

    this.client.on(Events.ShardReconnecting, (shardId) => {
      console.log(`[Discord] Shard ${shardId} reconnecting...`);
    });

    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      console.log(`[Discord] Shard ${shardId} resumed (${replayedEvents} events replayed)`);
    });
  }

  private async handleBatch(batch: MessageBatch): Promise<void> {
    const { firstMessage, userId } = batch;
    const isOwner = userId === DISCORD_CONFIG.ownerUserId;

    // Defer non-owner Discord messages when owner is actively chatting on web UI
    // This prevents Discord conversations from interrupting the owner's flow
    // Uses web-specific activity — Telegram activity should NOT trigger deferral.
    // Queued quietly: no hourglass, no reaction of any kind (operator request).
    // The room sees nothing until the answer comes.
    if (!isOwner) {
      const ownerActiveMinutes = this.registry.minutesSinceLastUserWebActivity();
      if (ownerActiveMinutes < getDiscordConfig().ownerActiveThresholdMin) {
        this.deferredBatches.push({ batch, queuedAt: Date.now() });
        this.stats.deferred++;
        console.log(`[Discord] Deferred message from ${firstMessage.author.username} (owner active ${ownerActiveMinutes.toFixed(1)}m ago, ${this.deferredBatches.length} in queue)`);
        return;
      }
    }

    await this._processBatch(batch);
  }

  private async _processBatch(batch: MessageBatch): Promise<void> {
    const { firstMessage, lastMessage, channelId, userId } = batch;
    const isOwner = userId === DISCORD_CONFIG.ownerUserId;
    const key = `${channelId}:${userId}`;

    if (this.processing.has(key)) {
      console.log(`[Discord] Already processing ${key}, skipping`);
      return;
    }

    this.processing.add(key);

    // Track activity for relational field context. Sweep stale entries
    // occasionally — this map is keyed by every unique author ever seen and
    // previously had no eviction at all.
    if (recentActivity.size > 256) {
      const staleBefore = Date.now() - ACTIVITY_TTL_MS;
      for (const [id, entry] of recentActivity) {
        if (entry.lastSeen < staleBefore) recentActivity.delete(id);
      }
    }
    recentActivity.set(userId, {
      name: displayNameOf(firstMessage),
      lastSeen: Date.now(),
      channelId,
    });

    let typingInterval: ReturnType<typeof setInterval> | null = null;

    try {
      // The judge (judge.ts, Aerie, with the operator's rules): in a chime-in room, a
      // message that is not ours waits for a beat or is only heard. A DM and
      // every other gate come back 'answer' (preflight already decided them).
      const gateMode = gateModeFor(channelId, batch.guildId, DISCORD_CONFIG.requireMentionInGuilds, batch.parentChannelId);
      const speaker = discordSpeaker(userId);
      // Somebody talking about the operator in a chime-in room: hers, not ours (unless
      // it also tags or names us). Tag-only and read-only rooms are handled
      // in preflight, at the door.
      const aboutOwner: OwnerMentionReason | null =
        batch.guildId && gateMode === 'chime-in' && !isOwner ? ownerMentionIn(batch) : null;
      const judgeInput = await judgeInputOf(batch.messages, {
        gateMode,
        isOwner,
        trustLevel: speaker.trustLevel,
        aboutOwner: aboutOwner !== null,
        names: companionNames(),
      });
      const judged: JudgeCall = judgeCall(judgeInput);
      const bar = beatBarOf(judgeInput);

      // Run preflight checks. A bot turn the judge is holding is not counted
      // yet (see preflight); the beat counts it if it answers.
      const result = await preflight(batch, this.pairingService, { countBotTurn: judged === 'answer' });

      // Two shapes of no. A plain denial is a door and nothing comes through
      // it. `deliver` is the consecutive-bot cool-off, or a message about the
      // owner at a tag-only or read-only door: we are not going to answer,
      // and the message still lands in the room, unread, exactly where the
      // owner reads it. It falls through routing and storage below on purpose
      // and stops at the line before generation. (Aerie.)
      const cooledOff = !result.allowed && result.deliver === true;
      // The judge's quiet is the same shape: approved, stored, shown, and not
      // ours to answer now. Only ever on an approved message, so a denied one
      // can never come through it. (Aerie.)
      const waiting = result.allowed && judged !== 'answer';
      const heardOnly = cooledOff || waiting;
      // A message about the owner, from either door: her phone is told.
      const ownerMention: OwnerMentionReason | undefined = cooledOff
        ? result.ownerMention
        : waiting && judged === 'hear' && aboutOwner
          ? aboutOwner
          : undefined;

      if (!result.allowed && !heardOnly) {
        console.log(`[Discord] Preflight denied: ${result.reason}`);

        if (result.requiresPairing && result.pairingCode) {
          const config = getBytelightConfig();
          await lastMessage.reply(
            `I don't recognize you yet. To chat with me, ask ${config.identity.user_name} to approve this code: \`${result.pairingCode}\`\n\nThis code expires in 1 hour.`
          );
        }
        return;
      }

      if (heardOnly) console.log(`[Discord] Heard, not answering: ${cooledOff ? result.reason : judgeReason(judged, aboutOwner !== null)}`);

      // Something is being answered here now, so an open beat in this room
      // folds into it: this turn reads the same transcript the beat would
      // have. (Aerie.)
      if (!heardOnly) this.cancelBeat(channelId, `folded into the answer to ${firstMessage.author.username}`);

      // Touch owner's activity if they're the sender
      if (isOwner) {
        this.registry.touchUserActivity();
      }

      // History and the typing dot are both for a reply now. A held turn and
      // a waiting one have neither: a typing dot is a promise of a reply that
      // is not coming, and a beat fetches its own fresh transcript when it is up.
      if (!heardOnly) {
        try {
          const channel = lastMessage.channel;
          if ('messages' in channel) {
            const history = await (channel as TextChannel).messages.fetch({ limit: 10 });
            batch.channelHistory = formatChannelHistory([...history.values()].reverse());
          }
        } catch (err) {
          console.warn('[Discord] Could not fetch channel history:', err);
        }

        // Show typing indicator (refresh every 8s — Discord typing expires after 10s)
        if ('sendTyping' in lastMessage.channel) {
          await lastMessage.channel.sendTyping();
        }
        typingInterval = setInterval(() => {
          if ('sendTyping' in lastMessage.channel) {
            (lastMessage.channel as TextChannel).sendTyping().catch(() => {});
          }
        }, 8000);
      }

      console.log(`[Discord] Processing from ${firstMessage.author.username} in ${channelId}`);

      // All Discord messages route to the routing thread ("Home") — owner,
      // community, DMs. This ensures social interactions and community
      // conversations are visible in the handoff context alongside everything
      // else. (Thornvale port: per-channel threads stop being created.)
      const routedThread = resolveRoutingThread('discord', this.registry);
      const threadId = routedThread.id;
      const threadName = routedThread.name;
      console.log(`[Discord] ${isOwner ? 'Owner' : 'Community'} routed to routing thread: ${threadName} (${threadId})`);

      // Where a message about the owner was said, in the names she would use
      // for it: read off the message itself first, then the client's caches,
      // and the raw id only when neither knows. (Aerie.)
      const place = ownerMention
        ? {
            channelName: nameOf(lastMessage.channel) ?? nameOf(this.client.channels.cache.get(channelId)) ?? channelId,
            guildName: batch.guildId
              ? nameOf(lastMessage.guild) ?? nameOf(this.client.guilds.cache.get(batch.guildId)) ?? batch.guildId
              : null,
          }
        : null;

      // Store incoming message in SQLite
      const now = new Date().toISOString();
      const senderRole = isOwner ? 'user' : 'system';
      // Collect sticker metadata across the batch — content carries readable
      // [sticker: Name] tokens; metadata keeps the structured ids/urls.
      const stickers = batch.messages.flatMap(m =>
        [...m.stickers.values()].map(s => ({ id: s.id, name: s.name, url: s.url, format: s.format }))
      );
      const incomingMsg = createMessage({
        id: crypto.randomUUID(),
        threadId,
        role: senderRole as 'user' | 'system',
        content: batch.combinedContent,
        contentType: 'text',
        platform: 'discord',
        metadata: {
          discordUserId: userId,
          discordUsername: firstMessage.author.username,
          discordDisplayName: displayNameOf(firstMessage),
          discordChannelId: channelId,
          discordGuildId: batch.guildId,
          discordMessageId: lastMessage.id,
          ...(stickers.length > 0 ? { discordStickers: stickers } : {}),
          // A message about the owner rather than to us says so, and where it
          // was said, so the phone can label it without looking anything up. (Aerie.)
          ...(ownerMention && place
            ? { ownerMention, discordChannelName: place.channelName, discordGuildName: place.guildName }
            : {}),
        },
        createdAt: now,
      });

      updateThreadActivity(threadId, now, true);
      this.registry.broadcast({ type: 'message', message: incomingMsg });

      // A waiting message opens the beat (or joins one already open) only now
      // that it is stored and shown: their screen first. (Aerie.)
      if (waiting && (judged === 'beat' || judged === 'share')) {
        this.openBeat({
          kind: judged,
          bar,
          batch,
          threadId,
          threadName,
          isOwner,
          userId,
          channelId,
        });
      }

      // A message about the owner wakes her phone: the one kind of heard
      // message that does. Through sendIfOffline, so it stays quiet while she
      // is already looking at the app. Not awaited: a push is a network round
      // trip, and while this batch is still running the next one from the
      // same person in the same channel is skipped as already processing. (Aerie.)
      if (ownerMention && place) {
        const push = getPushService();
        if (push) {
          push.sendIfOffline(buildOwnerMentionPush({
            displayName: displayNameOf(firstMessage),
            reason: ownerMention,
            text: batch.combinedContent,
            channelName: place.channelName,
            threadId,
            channelId,
          })).catch(err => console.error('[Discord] Owner mention push error:', err));
        }
      }

      // Heard, stored, shown — and not ours to answer (bot-loop.ts, the judge,
      // or a message about the owner). This stop sits AFTER the broadcast on
      // purpose.
      if (heardOnly) return;

      await this.generateAndReply({
        kind: 'answer',
        bar,
        batch,
        threadId,
        threadName,
        isOwner,
        userId,
        channelId,
      });

    } catch (error) {
      console.error('[Discord] Handler error:', error);
      this.stats.errors++;
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      this.processing.delete(key);
    }
  }

  /**
   * Everything after the message is stored: the prompt, the turn, the reply in
   * the channel. An answer now comes here straight from _processBatch; a beat
   * comes here when it is up, with a fresh transcript and the beat's lines. (Aerie.)
   */
  private async generateAndReply(turn: ReplyTurn): Promise<void> {
    const { batch, threadId, threadName, isOwner, userId, channelId } = turn;
    const { firstMessage, lastMessage } = batch;
    const ownerName = ownerDisplayName();

    // Who this turn answers, and how far to trust them (rules.ts). The operator's own
    // turns get no trust line: it is her house.
    const speaker = discordSpeaker(userId);
    const speakerLines = isOwner
      ? []
      : [
          trustGuidance(speaker.trustLevel, ownerName),
          ...(turn.kind === 'answer'
            ? []
            : ['Other people in the transcript keep their own trust. When you cannot tell who someone is, treat them as Limited.']),
        ];

    // Build platform context (platform info + rules + channel history)
    const platformHeader = batch.guildId
      ? `=== PLATFORM: DISCORD ===\nResponding in #${(this.client.channels.cache.get(channelId) as TextChannel)?.name || channelId} on ${this.client.guilds.cache.get(batch.guildId)?.name || batch.guildId}.`
      : `=== PLATFORM: DISCORD ===\nResponding in DM with ${firstMessage.author.username}.`;
    const platformGuidance = [
      platformHeader,
      `Discord IDs for native actions: channelId=${channelId}, guildId=${batch.guildId ?? 'DM'}, lastMessageId=${lastMessage.id}.`,
      'Discord formatting: **bold**, *italic*, `code`, ```codeblocks```, > quotes, ||spoilers||.',
      'Max message length: 2000 chars (responses auto-split at 1900).',
      'To post a stored file (a picture in data/files) as a real attachment, put [discord-attach:<fileId>] in your reply; the marker is removed and the file is attached.',
      turn.kind === 'answer'
        ? 'Replying to the last message in this batch.'
        : 'Answering the room after a beat: the message below opened it, and the transcript holds everything said since.',
      'Keep responses appropriate to the platform — not as terse as Telegram, but don\'t write essays.',
      'IMPORTANT: Do NOT use --- (horizontal rules) between Companion A and Companion B sections — they render as literal dashes in Discord. Use a blank line instead.',
      ...NO_RECAP_LINES,
      ...speakerLines,
      ...(batch.guildId ? [publicSafetyLine(ownerName)] : []),
    ].join('\n');

    const rulesContext = buildRulesContext(userId, channelId, batch.guildId);
    const historyContext = batch.channelHistory
      ? `\n\n=== RECENT CHANNEL HISTORY (last ${turn.kind === 'answer' ? 10 : 15} messages) ===\n${batch.channelHistory}`
      : '';
    const beatContext = turn.kind === 'answer'
      ? ''
      : `${beatBanner(turn.kind, turn.spokeSinceOpen, { bar: turn.bar, ownerName })}\n\n`;
    const platformContext = `${platformGuidance}\n\n${beatContext}${rulesContext}${historyContext}`;

    this.stats.messagesProcessed++;

    // Process through AgentService
    const response = await this.agentService.processMessage(
      threadId,
      batch.combinedContent,
      { name: threadName, type: 'named' },
      {
        platform: 'discord',
        platformContext,
        discordChannelId: batch.channelId,
        discordGuildId: batch.guildId ?? undefined,
        discordMessageId: batch.lastMessage.id,
        // Who is asking, so every engine's tool gate can tell a guest's turn
        // from the owner's. A batch is one speaker (keyed by channel and
        // author), so one audience covers the whole turn (turn-audience.ts).
        audience: discordTurnAudience(isOwner, getUserRule(userId)?.trustLevel),
      },
    );

    // The query queue answers a turn it gave up on with its own sentinel text
    // (and a full queue with a 'busy' line). Those are house plumbing, never a
    // reply. (Aerie.)
    if (response && isQueueRefusal(response)) {
      console.warn(`[Discord] Not posting a queue refusal to ${channelId}: ${response.trim()}`);
      return;
    }

    // [SILENT] is a pass, chosen: nothing is posted. The agent already drops
    // the sentinel; this is the last line before the room.
    if (isDeliberateSilence(response)) {
      console.log(`[Discord] Beat passed in ${channelId}: nothing of ours to add`);
      return;
    }

    if (isEffectivelyBlank(response) || response === '[No response]') {
      // On a beat that is the pass, chosen; anywhere else it is a turn that
      // came back with nothing.
      console.log(turn.kind === 'beat' || turn.spokeSinceOpen ? `[Discord] Beat passed in ${channelId}: nothing of ours to add` : '[Discord] Empty response from agent');
      return;
    }

    // Resolve :name: shorthand into real custom-emoji tokens before splitting,
    // so shorthand the companion wrote renders as the server's actual emoji.
    // Empty index / gateway down → identity (no-op). Done pre-split so a token
    // is never severed across a chunk boundary.
    const resolved = resolveEmoteShorthand(response, this.listCustomEmojis());

    // [discord-attach:<fileId>] markers become real files on the message
    // and are stripped from the words (attach-markers.ts, Aerie): a picture
    // goes into the channel as itself, not as a link.
    const { text: cleanedResponse, files: attachments } = parseAttachmentMarkers(resolved);

    // Attachment-only reply (no words left once the markers are stripped)
    if (isEffectivelyBlank(cleanedResponse)) {
      if (attachments.length > 0) {
        await this.replyOrSend(lastMessage, { files: attachments });
        console.log(`[Discord] Sent ${attachments.length} attachment(s) (no text) to ${channelId}`);
        this.lastSpokeAt.set(channelId, Date.now());
        if (turn.kind !== 'answer') noteJudgedAnswer(channelId, firstMessage.author.bot);
      } else {
        console.log('[Discord] Empty response after parsing');
      }
      return;
    }

    // Split and send response with rate limit delay
    const chunks = splitResponse(cleanedResponse, 1900);

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        // First chunk carries any attachments
        if (attachments.length > 0) {
          await this.replyOrSend(lastMessage, { content: chunks[i], files: attachments });
        } else {
          await this.replyOrSend(lastMessage, chunks[i]);
        }
      } else {
        // 200ms delay between chunks to avoid rate limits
        await new Promise(r => setTimeout(r, 200));
        if ('send' in lastMessage.channel) {
          await (lastMessage.channel as TextChannel).send(chunks[i]);
        }
      }
    }

    console.log(`[Discord] Sent ${chunks.length} chunk(s)${attachments.length > 0 ? ` with ${attachments.length} attachment(s)` : ''} to ${channelId}`);
    this.lastSpokeAt.set(channelId, Date.now());
    // A beat that answered has spent the bot turn it opened on (see preflight).
    if (turn.kind !== 'answer') noteJudgedAnswer(channelId, firstMessage.author.bot);
  }

  /**
   * Reply to the message, or say it to the room when that message is gone (a
   * beat answers a minute late, and people delete things). (Aerie.)
   */
  private async replyOrSend(
    message: DiscordMessage,
    payload: string | { content?: string; files: AttachmentBuilder[] },
  ): Promise<void> {
    try {
      await message.reply(payload);
    } catch (err) {
      if (!('send' in message.channel)) throw err;
      console.warn(`[Discord] Could not reply to ${message.id}, saying it to the room instead:`, (err as Error).message);
      await (message.channel as TextChannel).send(payload);
    }
  }

  /**
   * A message waiting for the room's beat (judge.ts). One beat per room: a
   * later message joins the open one and is read in the transcript when it is
   * up. A shared tag outranks a general message as the one we answer, and a
   * lower bar (the operator, family) outranks a higher one. (Aerie, with the operator's bars.)
   */
  private openBeat(turn: ReplyTurn): void {
    const open = this.beats.get(turn.channelId);
    if (open) {
      if (turn.kind !== 'answer' && open.turn.kind !== 'answer'
          && beatOutranks({ kind: turn.kind, bar: turn.bar }, { kind: open.turn.kind, bar: open.turn.bar })) {
        open.turn = turn;
      }
      console.log(`[Discord] ${turn.batch.firstMessage.author.username} joins the beat open in ${turn.channelId}`);
      return;
    }
    const beatMs = getDiscordConfig().judgeBeatMs;
    this.beats.set(turn.channelId, {
      openedAt: Date.now(),
      turn,
      timer: setTimeout(() => void this.fireBeat(turn.channelId), beatMs),
    });
    console.log(`[Discord] Beat opened in ${turn.channelId} (${turn.kind}/${turn.bar}, ${Math.round(beatMs / 1000)}s) for ${turn.batch.firstMessage.author.username}`);
  }

  private cancelBeat(channelId: string, why: string): void {
    const open = this.beats.get(channelId);
    if (!open) return;
    clearTimeout(open.timer);
    this.beats.delete(channelId);
    console.log(`[Discord] Beat in ${channelId} closed: ${why}`);
  }

  /**
   * The beat is up. It waits on while anybody else in the room is typing,
   * because they started first, then reads everything said since and hands
   * the room to the lane, which answers or passes. Never a typing dot: we may
   * well say nothing. (Aerie.)
   */
  private async fireBeat(channelId: string): Promise<void> {
    const open = this.beats.get(channelId);
    if (!open) return;
    const now = Date.now();
    if (beatShouldWait({
      now,
      openedAt: open.openedAt,
      maxWaitMs: getDiscordConfig().judgeMaxWaitMs,
      lastOtherTypingAt: latestTypingIn(channelId, now),
    })) {
      open.timer = setTimeout(() => void this.fireBeat(channelId), BEAT_RECHECK_MS);
      return;
    }
    this.beats.delete(channelId);

    const { turn } = open;
    turn.spokeSinceOpen = (this.lastSpokeAt.get(channelId) ?? 0) > open.openedAt;
    const author = turn.batch.firstMessage.author;
    if (author.bot && botLoopExhausted(channelId, botReplyCap(getUserRule(author.id)?.trustLevel))) {
      console.log(`[Discord] Beat in ${channelId} ended quiet: the bot guard has this room`);
      return;
    }

    const key = `${channelId}:beat`;
    if (this.processing.has(key)) {
      console.log(`[Discord] A beat is already answering in ${channelId}, skipping`);
      return;
    }
    this.processing.add(key);
    try {
      try {
        const channel = turn.batch.lastMessage.channel;
        if ('messages' in channel) {
          // Fresh, and a little longer than usual: a minute of a busy room.
          const history = await (channel as TextChannel).messages.fetch({ limit: 15 });
          turn.batch.channelHistory = formatChannelHistory([...history.values()].reverse());
        }
      } catch (err) {
        console.warn('[Discord] Could not fetch channel history for the beat:', err);
      }
      console.log(`[Discord] Beat in ${channelId} is up after ${Math.round((Date.now() - open.openedAt) / 1000)}s; deciding`);
      await this.generateAndReply(turn);
    } catch (error) {
      console.error('[Discord] Beat error:', error);
      this.stats.errors++;
    } finally {
      this.processing.delete(key);
    }
  }

  private async drainDeferredQueue(): Promise<void> {
    if (this.deferredBatches.length === 0) return;

    const config = getDiscordConfig();

    // Prune expired batches BEFORE the owner-active hold below. When the
    // prune sat behind that early return, a continuously-active owner meant
    // expired batches (each pinning full discord.js Message objects) were
    // never dropped and the queue grew for as long as the owner kept chatting.
    const now = Date.now();
    this.deferredBatches = this.deferredBatches.filter(entry => {
      if (now - entry.queuedAt > config.deferMaxAgeMs) {
        console.log(`[Discord] Dropping expired deferred batch from ${entry.batch.firstMessage.author.username}`);
        return false;
      }
      return true;
    });

    const ownerActiveMinutes = this.registry.minutesSinceLastUserWebActivity();
    if (ownerActiveMinutes < config.ownerActiveThresholdMin) return; // Owner still active on web — keep holding

    if (this.deferredBatches.length === 0) return;

    console.log(`[Discord] Owner idle ${ownerActiveMinutes.toFixed(1)}m — draining ${this.deferredBatches.length} deferred messages`);

    // Process one at a time to avoid flooding
    while (this.deferredBatches.length > 0) {
      // Re-check owner's web activity before each batch — stop draining if they come back to web
      if (this.registry.minutesSinceLastUserWebActivity() < config.ownerActiveThresholdMin) {
        console.log(`[Discord] Owner returned — pausing drain (${this.deferredBatches.length} remaining)`);
        break;
      }
      const entry = this.deferredBatches.shift()!;
      await this._processBatch(entry.batch);
    }
  }

  async start(): Promise<void> {
    const token = getSecret('discord_bot_token'); // DB → env; takes effect on restart
    if (!token) {
      console.error('[Discord] DISCORD_BOT_TOKEN not set — gateway disabled');
      return;
    }

    try {
      await this.client.login(token);
      this.started = true;
      activeDiscordService = this; // expose emoji catalog to orientation/resolver

      // Start deferred queue drain timer
      this.deferTimer = setInterval(() => {
        this.drainDeferredQueue().catch(err =>
          console.error('[Discord] Drain error:', err)
        );
      }, getDiscordConfig().deferPollIntervalMs);

      console.log('[Discord] Gateway started');
    } catch (error) {
      console.error('[Discord] Failed to login:', error);
    }
  }

  async stop(): Promise<void> {
    for (const open of this.beats.values()) clearTimeout(open.timer);
    this.beats.clear();
    this.lastSpokeAt.clear();
    if (!this.started) return;
    console.log('[Discord] Shutting down gateway...');
    if (this.deferTimer) {
      clearInterval(this.deferTimer);
      this.deferTimer = null;
    }
    this.deferredBatches = [];
    this.debouncer.destroy();
    this.client.destroy();
    this.started = false;
    if (activeDiscordService === this) activeDiscordService = null;
  }

  isConnected(): boolean {
    return this.started && this.client.isReady();
  }

  getStats() {
    return {
      ...this.stats,
      deferredPending: this.deferredBatches.length,
      connected: this.isConnected(),
      username: this.client.user?.username || null,
      guilds: this.client.guilds.cache.size,
    };
  }

  getPairingService(): PairingService {
    return this.pairingService;
  }

  private async action(fn: () => Promise<Record<string, unknown>>): Promise<DiscordActionResult> {
    if (!this.client.isReady()) return { ok: false, error: 'Discord gateway is not started' };
    try {
      return { ok: true, ...(await fn()) };
    } catch (error) {
      return { ok: false, error: errMessage(error) };
    }
  }

  private async textChannel(channelId: unknown) {
    const id = cleanId(channelId, 'channelId');
    const channel = await this.client.channels.fetch(id);
    if (!channel || !channel.isTextBased() || !('send' in channel) || !('messages' in channel)) {
      throw new Error('Channel is not a message-capable text channel');
    }
    return channel;
  }

  async sendMessage(channelId: unknown, message: unknown, replyToMessageId?: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const content = cleanText(message, 'message', 2000);
      const sent = replyToMessageId
        ? await (await channel.messages.fetch(cleanId(replyToMessageId, 'replyToMessageId'))).reply(content)
        : await channel.send(content);
      return { messageId: sent.id, channelId: sent.channelId };
    });
  }

  async sendImage(channelId: unknown, url: unknown, description?: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const imageUrl = cleanText(url, 'url', 2048);
      let parsed: URL;
      try { parsed = new URL(imageUrl); } catch { throw new Error('url must be a valid URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('url must use http or https');
      const desc = description === undefined ? undefined : cleanText(description, 'description', 4096);
      const sent = await channel.send({ embeds: [{ ...(desc ? { description: desc } : {}), image: { url: imageUrl } }] });
      return { messageId: sent.id, channelId: sent.channelId };
    });
  }

  async sendSticker(channelId: unknown, stickerId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const sent = await channel.send({ stickers: [cleanId(stickerId, 'stickerId')] });
      return { messageId: sent.id, channelId: sent.channelId };
    });
  }

  async sendVoice(channelId: unknown, text: unknown, voice: unknown, voiceService: VoiceService): Promise<DiscordActionResult> {
    return this.action(async () => {
      const id = cleanId(channelId, 'channelId');
      await this.textChannel(id);
      const spoken = cleanText(text, 'text', 20000);
      if (voice !== undefined && voice !== 'companion-a' && voice !== 'companion-b') throw new Error('voice must be companion-a or companion-b');
      if (!voiceService.canTTS) throw new Error('Voice service is not configured');
      const audio = await voiceService.generateTTS(spoken, voice as string | undefined);
      const metadata = await discordVoiceMetadata(audio);
      const sent = await this.client.rest.post(Routes.channelMessages(id), {
        files: [{ data: audio, name: 'voice-message.mp3', contentType: 'audio/mpeg' }],
        body: {
          flags: MessageFlags.IsVoiceMessage,
          attachments: [{ id: 0, filename: 'voice-message.mp3', duration_secs: metadata.duration, waveform: metadata.waveform }],
        },
      }) as { id: string; channel_id: string };
      return { messageId: sent.id, channelId: sent.channel_id, duration: metadata.duration };
    });
  }

  async addReaction(channelId: unknown, messageId: unknown, emoji: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const message = await channel.messages.fetch(cleanId(messageId, 'messageId'));
      await message.react(cleanText(emoji, 'emoji', 100));
      return { messageId: message.id, emoji };
    });
  }

  async editOwnMessage(channelId: unknown, messageId: unknown, content: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const message = await channel.messages.fetch(cleanId(messageId, 'messageId'));
      if (message.author.id !== this.client.user!.id) throw new Error('Refusing to edit a message not authored by this bot');
      const edited = await message.edit(cleanText(content, 'content', 2000));
      return { messageId: edited.id, channelId: edited.channelId };
    });
  }

  async deleteOwnMessage(channelId: unknown, messageId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const message = await channel.messages.fetch(cleanId(messageId, 'messageId'));
      if (message.author.id !== this.client.user!.id) throw new Error('Refusing to delete a message not authored by this bot');
      await message.delete();
      return { messageId: message.id, deleted: true };
    });
  }

  async readMessages(channelId: unknown, limit: unknown = 50): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const count = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 100)) : 50;
      const messages = await channel.messages.fetch({ limit: count });
      return { messages: [...messages.values()].map(m => ({ messageId: m.id, authorId: m.author.id, author: m.author.username, content: m.content, timestamp: m.createdAt.toISOString() })) };
    });
  }

  async sendTypingTo(channelId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      await channel.sendTyping();
      return { channelId: channel.id, typing: true };
    });
  }

  async getServerInfo(guildId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const guild = await this.client.guilds.fetch(cleanId(guildId, 'guildId'));
      return { guild: { guildId: guild.id, name: guild.name, description: guild.description, ownerId: guild.ownerId, memberCount: guild.memberCount, createdAt: guild.createdAt.toISOString(), iconUrl: guild.iconURL() } };
    });
  }

  async listServers(): Promise<DiscordActionResult> {
    return this.action(async () => ({
      guilds: [...this.client.guilds.cache.values()].map(g => ({ guildId: g.id, name: g.name, memberCount: g.memberCount, iconUrl: g.iconURL() })),
    }));
  }

  async listEmojis(guildId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const guild = await this.client.guilds.fetch(cleanId(guildId, 'guildId'));
      await guild.emojis.fetch();
      return { emojis: [...guild.emojis.cache.values()].map(e => ({ emojiId: e.id, name: e.name, animated: e.animated ?? false, available: e.available })) };
    });
  }

  async listStickers(guildId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const guild = await this.client.guilds.fetch(cleanId(guildId, 'guildId'));
      const stickers = await guild.stickers.fetch();
      return { stickers: [...stickers.values()].map(s => ({ stickerId: s.id, name: s.name, description: s.description, format: s.format, tags: s.tags, url: s.url })) };
    });
  }

  async searchMessages(guildId: unknown, options: { content?: unknown; authorId?: unknown; channelId?: unknown; has?: unknown; limit?: unknown }): Promise<DiscordActionResult> {
    return this.action(async () => {
      const id = cleanId(guildId, 'guildId');
      const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) ? Math.max(1, Math.min(Math.floor(options.limit), 25)) : 25;
      const query = new URLSearchParams({ limit: String(limit) });
      if (options.content !== undefined) query.set('content', cleanText(options.content, 'content', 1024));
      if (options.authorId !== undefined) query.append('author_id', cleanId(options.authorId, 'authorId'));
      if (options.channelId !== undefined) query.append('channel_id', cleanId(options.channelId, 'channelId'));
      if (options.has !== undefined) {
        const values = Array.isArray(options.has) ? options.has : [options.has];
        const allowed = new Set(['link', 'embed', 'file', 'video', 'image', 'sound', 'sticker', 'snapshot', 'poll']);
        for (const value of values) {
          const filter = cleanText(value, 'has', 50);
          if (!allowed.has(filter)) throw new Error(`Unsupported has filter: ${filter}`);
          query.append('has', filter);
        }
      }
      const result = await this.client.rest.get(Routes.guildMessagesSearch(id), { query }) as {
        total_results?: number;
        messages?: Array<Array<{ id: string; channel_id: string; content: string; timestamp: string; author: { id: string; username: string; global_name?: string | null } }>>;
        message?: string;
        retry_after?: number;
      };
      if (!result.messages) throw new Error(result.message ?? `Discord search index is pending; retry after ${result.retry_after ?? 'a moment'}`);
      return {
        totalResults: result.total_results ?? 0,
        messages: result.messages.flatMap(group => group.slice(-1)).map(m => ({
          messageId: m.id,
          channelId: m.channel_id,
          authorId: m.author.id,
          author: m.author.global_name || m.author.username,
          content: m.content,
          timestamp: m.timestamp,
        })),
      };
    });
  }

  /**
   * Flatten every custom emoji across the connected guilds. Reads the discord.js
   * cache live (kept current by the Guilds intent), so no snapshot to go stale.
   * Returns [] if the gateway isn't ready — never throws.
   */
  listCustomEmojis(): CustomEmoji[] {
    if (!this.client.isReady()) return [];
    const out: CustomEmoji[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      for (const emoji of guild.emojis.cache.values()) {
        if (!emoji.name) continue; // deleted/partial emojis can have null name
        out.push({
          name: emoji.name,
          id: emoji.id,
          animated: emoji.animated ?? false,
          guild: guild.name,
        });
      }
    }
    return out;
  }
}
