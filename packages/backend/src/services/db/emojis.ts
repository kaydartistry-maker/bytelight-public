// Custom emoji operations
import { getDb } from './state.js';

export interface EmojiPack {
  id: string;
  name: string;
  description?: string;
  user_only: boolean;
  created_at: string;
}

export interface Emoji {
  id: string;
  name: string;
  filename: string;
  aliases: string[];
  url: string;
  pack_id: string | null;
  created_at: string;
}

interface EmojiPackRow {
  id: string;
  name: string;
  description: string | null;
  user_only: number;
  created_at: string;
}

interface EmojiRow {
  id: string;
  name: string;
  filename: string;
  aliases: string;
  pack_id: string | null;
  created_at: string;
}

function rowToPack(row: EmojiPackRow): EmojiPack {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    user_only: Boolean(row.user_only),
    created_at: row.created_at,
  };
}

function rowToEmoji(row: EmojiRow): Emoji {
  return {
    id: row.id,
    name: row.name,
    filename: row.filename,
    aliases: JSON.parse(row.aliases || '[]'),
    url: `/emojis/${row.filename}`,
    pack_id: row.pack_id,
    created_at: row.created_at,
  };
}

// === Pack operations ===

export function createEmojiPack(params: {
  id: string;
  name: string;
  description?: string;
  userOnly?: boolean;
  createdAt: string;
}): EmojiPack {
  const stmt = getDb().prepare(`
    INSERT INTO emoji_packs (id, name, description, user_only, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.id,
    params.name,
    params.description || null,
    params.userOnly ? 1 : 0,
    params.createdAt,
  );
  return getEmojiPack(params.id)!;
}

export function getEmojiPack(id: string): EmojiPack | null {
  const stmt = getDb().prepare('SELECT * FROM emoji_packs WHERE id = ?');
  const row = stmt.get(id) as EmojiPackRow | undefined;
  return row ? rowToPack(row) : null;
}

export function getEmojiPackByName(name: string): EmojiPack | null {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const stmt = getDb().prepare('SELECT * FROM emoji_packs WHERE name = ?');
  const row = stmt.get(sanitized) as EmojiPackRow | undefined;
  return row ? rowToPack(row) : null;
}

export function listEmojiPacks(): EmojiPack[] {
  const stmt = getDb().prepare('SELECT * FROM emoji_packs ORDER BY name');
  const rows = stmt.all() as EmojiPackRow[];
  return rows.map(rowToPack);
}

export function updateEmojiPack(id: string, updates: {
  name?: string;
  description?: string;
  userOnly?: boolean;
}): boolean {
  const pack = getEmojiPack(id);
  if (!pack) return false;

  const stmt = getDb().prepare(`
    UPDATE emoji_packs SET name = ?, description = ?, user_only = ? WHERE id = ?
  `);
  const result = stmt.run(
    updates.name ?? pack.name,
    updates.description ?? pack.description ?? null,
    updates.userOnly !== undefined ? (updates.userOnly ? 1 : 0) : (pack.user_only ? 1 : 0),
    id,
  );
  return result.changes > 0;
}

export function deleteEmojiPack(id: string): boolean {
  // Cascade delete handled by foreign key, but also delete emojis explicitly
  getDb().prepare('DELETE FROM emojis WHERE pack_id = ?').run(id);
  const stmt = getDb().prepare('DELETE FROM emoji_packs WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export function getPacksWithEmojis(): (EmojiPack & { emojis: Emoji[] })[] {
  const packs = listEmojiPacks();
  return packs.map(pack => ({
    ...pack,
    emojis: listEmojis(pack.id),
  }));
}

// === Emoji operations ===

export function createEmoji(params: {
  id: string;
  name: string;
  filename: string;
  aliases?: string[];
  packId?: string | null;
  createdAt: string;
}): Emoji {
  const stmt = getDb().prepare(`
    INSERT INTO emojis (id, name, filename, aliases, pack_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.id,
    params.name,
    params.filename,
    JSON.stringify(params.aliases || []),
    params.packId || null,
    params.createdAt,
  );
  return getEmoji(params.id)!;
}

export function getEmoji(id: string): Emoji | null {
  const stmt = getDb().prepare('SELECT * FROM emojis WHERE id = ?');
  const row = stmt.get(id) as EmojiRow | undefined;
  return row ? rowToEmoji(row) : null;
}

export function getEmojiByName(name: string): Emoji | null {
  const stmt = getDb().prepare(`
    SELECT * FROM emojis
    WHERE name = ? OR EXISTS (
      SELECT 1 FROM json_each(aliases) WHERE json_each.value = ?
    )
  `);
  const row = stmt.get(name, name) as EmojiRow | undefined;
  return row ? rowToEmoji(row) : null;
}

export function listEmojis(packId?: string): Emoji[] {
  if (packId) {
    const stmt = getDb().prepare('SELECT * FROM emojis WHERE pack_id = ? ORDER BY name');
    const rows = stmt.all(packId) as EmojiRow[];
    return rows.map(rowToEmoji);
  }
  const stmt = getDb().prepare('SELECT * FROM emojis ORDER BY name');
  const rows = stmt.all() as EmojiRow[];
  return rows.map(rowToEmoji);
}

export function updateEmoji(id: string, updates: {
  name?: string;
  aliases?: string[];
}): boolean {
  const emoji = getEmoji(id);
  if (!emoji) return false;

  const stmt = getDb().prepare(`
    UPDATE emojis SET name = ?, aliases = ? WHERE id = ?
  `);
  const result = stmt.run(
    updates.name ?? emoji.name,
    JSON.stringify(updates.aliases ?? emoji.aliases),
    id,
  );
  return result.changes > 0;
}

export function deleteEmoji(id: string): boolean {
  const stmt = getDb().prepare('DELETE FROM emojis WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}
