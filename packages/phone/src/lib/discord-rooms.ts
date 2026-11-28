// Room labels in the chat: when Discord talk in a thread
// moves to another room, a quiet centred line says where it is now
// ("Porch · #front-room"). Pure, so it is tested alone.

export interface DiscordRoom {
  channelId: string;
  guildId: string | null;
  channelName?: string;
  guildName?: string;
}

export interface RoomNames {
  channel(id: string): string | undefined;
  guild(id: string): string | undefined;
}

/** The words on a room's line: names from the message first, then from the live directory. */
export function roomLabel(room: DiscordRoom, names?: RoomNames): string {
  if (!room.guildId) return 'Discord · direct message';
  const channel = room.channelName ?? names?.channel(room.channelId);
  const guild = room.guildName ?? names?.guild(room.guildId);
  if (guild && channel) return `${guild} · #${channel}`;
  if (channel) return `#${channel}`;
  return guild ?? 'Discord';
}

/**
 * For each message, the room line to draw above it, or null. A line appears
 * when Discord talk starts or moves to another room, and again on a new day.
 * The owner's own message from the app ends the room, so talk coming back
 * from Discord is labelled again; a companion's reply keeps the room it
 * answered.
 */
export function roomBreaks(
  messages: ReadonlyArray<{ timestamp: string; direction: 'inbound' | 'outbound'; discordRoom?: DiscordRoom }>,
  names?: RoomNames,
): Array<string | null> {
  let last: string | null = null;
  let lastDay = '';
  return messages.map((m) => {
    const day = new Date(m.timestamp).toDateString();
    if (day !== lastDay) { last = null; lastDay = day; }
    if (m.discordRoom) {
      const key = m.discordRoom.channelId;
      const out = key !== last ? roomLabel(m.discordRoom, names) : null;
      last = key;
      return out;
    }
    if (m.direction === 'inbound') last = null;
    return null;
  });
}
