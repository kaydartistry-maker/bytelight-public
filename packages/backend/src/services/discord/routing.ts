// Where Discord talk lands.
//
//   home      — Follow me home: the Discord routing thread, else Home (as always).
//   one       — One Discord thread: every room in a single thread called Discord.
//   per-room  — Each room its own thread; a DM gets its own too.
//
// Rooms on the keep-their-own list get their own thread whatever the mode.
// Threads this makes are remembered by id in config, so renaming one in the
// app keeps it; an archived or deleted one is simply made again.

import crypto from 'crypto';
import type { Thread } from '@bytelight/shared';
import { getConfig, setConfig, getThread, createThread, resolveRoutingThread, requireThreadRoster, listCompanions } from '../db.js';

export type DiscordRouting = 'home' | 'one' | 'per-room';
export const DISCORD_ROUTINGS: readonly DiscordRouting[] = ['home', 'one', 'per-room'];

const MODE_KEY = 'discord.routing';
const OWN_ROOMS_KEY = 'discord.ownThreadChannels';
const ONE_THREAD_KEY = 'discord.oneThreadId';
const roomKey = (channelId: string) => `discord.roomThread.${channelId}`;

export function getDiscordRouting(): DiscordRouting {
  const v = getConfig(MODE_KEY);
  return DISCORD_ROUTINGS.includes(v as DiscordRouting) ? (v as DiscordRouting) : 'home';
}

export function setDiscordRouting(mode: DiscordRouting): void {
  setConfig(MODE_KEY, mode);
}

export function getOwnThreadChannels(): string[] {
  return (getConfig(OWN_ROOMS_KEY) || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function setOwnThreadChannels(ids: string[]): void {
  setConfig(OWN_ROOMS_KEY, ids.map((s) => s.trim()).filter(Boolean).join(','));
}

export interface DiscordPlace {
  channelId: string;
  guildId: string | null;
  channelName?: string;
  guildName?: string;
  /** For a DM: the person on the other side. */
  dmName?: string;
}

/** Pure: which kind of thread a message from this place goes to. */
export function routeKind(mode: DiscordRouting, channelId: string, ownRooms: readonly string[]): 'home' | 'one' | 'room' {
  if (ownRooms.includes(channelId)) return 'room';
  if (mode === 'per-room') return 'room';
  if (mode === 'one') return 'one';
  return 'home';
}

/** Pure: the name a room's own thread is given when it is made. */
export function roomThreadName(place: DiscordPlace): string {
  if (!place.guildId) return `DM · ${place.dmName || 'Discord'}`;
  const room = place.channelName ? `#${place.channelName}` : 'a room';
  return place.guildName ? `${place.guildName} · ${room}` : room;
}

type Broadcaster = { broadcast: (msg: any) => void };

function liveThread(id: string | null): Thread | null {
  if (!id) return null;
  const t = getThread(id);
  return t && !t.archived_at ? t : null;
}

function makeThread(name: string, key: string, registry?: Broadcaster): Thread {
  const created = createThread({
    id: crypto.randomUUID(),
    name,
    type: 'named',
    createdAt: new Date().toISOString(),
    sessionType: 'v2',
    // A room's thread seats everyone who lives here, like the house's other threads.
    companionIds: requireThreadRoster(listCompanions().map((companion) => companion.id)),
  });
  setConfig(key, created.id);
  registry?.broadcast({ type: 'thread_created', thread: created });
  console.log(`[Discord] Made a thread for Discord talk: ${name}`);
  return created;
}

/** The thread a Discord message lands in, made if it doesn't exist yet. */
export function discordThreadFor(place: DiscordPlace, registry?: Broadcaster): Thread {
  const kind = routeKind(getDiscordRouting(), place.channelId, getOwnThreadChannels());
  if (kind === 'room') {
    return liveThread(getConfig(roomKey(place.channelId))) ?? makeThread(roomThreadName(place), roomKey(place.channelId), registry);
  }
  if (kind === 'one') {
    return liveThread(getConfig(ONE_THREAD_KEY)) ?? makeThread('Discord', ONE_THREAD_KEY, registry);
  }
  return resolveRoutingThread('discord', registry);
}
