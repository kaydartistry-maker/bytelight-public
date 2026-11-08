// Discord faces in the thread.
//
// The phone already draws a Discord sender's picture when a message carries
// metadata.discordAvatarUrl (adapter.ts -> senderAvatar). The gateway never
// saved one, so every Discord bubble fell back to a letter in a circle.
// New messages now carry the picture; older ones are filled in once.

import type Database from 'better-sqlite3';

/** The smallest shape we need from a discord.js Message. */
export interface AvatarSource {
  member?: { displayAvatarURL(options?: { size?: number }): string } | null;
  author: { displayAvatarURL(options?: { size?: number }): string };
}

/** Their picture in this server if they set one, otherwise their account picture. */
export function discordAvatarFor(message: AvatarSource): string | undefined {
  try {
    return message.member?.displayAvatarURL({ size: 128 }) ?? message.author.displayAvatarURL({ size: 128 });
  } catch {
    return undefined;
  }
}

/** Discord people whose saved messages have no picture yet. */
export function usersMissingAvatars(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT json_extract(metadata, '$.discordUserId') AS userId
    FROM messages
    WHERE platform = 'discord'
      AND json_extract(metadata, '$.discordUserId') IS NOT NULL
      AND json_extract(metadata, '$.discordAvatarUrl') IS NULL
  `).all() as Array<{ userId: string | number }>;
  return rows.map(r => String(r.userId));
}

/** Put a picture on every saved message from this person that has none. Returns rows changed. */
export function fillAvatar(db: Database.Database, userId: string, url: string): number {
  const result = db.prepare(`
    UPDATE messages
    SET metadata = json_set(metadata, '$.discordAvatarUrl', ?)
    WHERE platform = 'discord'
      AND CAST(json_extract(metadata, '$.discordUserId') AS TEXT) = ?
      AND json_extract(metadata, '$.discordAvatarUrl') IS NULL
  `).run(url, userId);
  return result.changes;
}

/**
 * One pass over the old messages. Safe to run on every start: it only touches
 * rows that still have no picture, so once filled it does nothing.
 */
export async function backfillDiscordAvatars(
  db: Database.Database,
  lookup: (userId: string) => Promise<string | undefined>,
): Promise<{ users: number; messages: number; missed: number }> {
  let messages = 0;
  let missed = 0;
  const users = usersMissingAvatars(db);
  for (const userId of users) {
    let url: string | undefined;
    try {
      url = await lookup(userId);
    } catch {
      url = undefined;
    }
    if (!url) { missed++; continue; }
    messages += fillAvatar(db, userId, url);
  }
  return { users: users.length, messages, missed };
}
