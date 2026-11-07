import crypto from 'crypto';
import type { Message } from '@bytelight/shared';
import { embed, vectorToBuffer } from '../embeddings.js';
import { AUTO_EMBED_CONFIG_KEY, shouldAutomaticallyEmbed } from '../embedding-policy.js';
import { cacheEmbedding } from '../vector-cache.js';
import { getConfig } from './config.js';
import { saveEmbedding } from './embeddings.js';
import { getDb } from './init.js';
import { getThread } from './threads.js';

// Async embedding helper — fire-and-forget from createMessage
async function embedMessageAsync(messageId: string, content: string, meta: {
  threadId: string; threadName: string; role: string; createdAt: string;
}): Promise<void> {
  try {
    const vector = await embed(content);
    saveEmbedding(messageId, vectorToBuffer(vector));
    cacheEmbedding(messageId, vector, meta);
  } catch (err) {
    console.error(`[embeddings] Failed to embed message ${messageId}:`, err);
  }
}

// Message operations
export function getNextSequence(threadId: string): number {
  const stmt = getDb().prepare('SELECT MAX(sequence) as max_seq FROM messages WHERE thread_id = ?');
  const row = stmt.get(threadId) as { max_seq: number | null };
  return (row.max_seq || 0) + 1;
}

export function createMessage(params: {
  id: string;
  threadId: string;
  role: 'companion' | 'user' | 'system';
  content: string;
  contentType?: 'text' | 'image' | 'audio' | 'file';
  platform?: 'web' | 'discord' | 'telegram' | 'api';
  metadata?: Record<string, unknown>;
  replyToId?: string;
  createdAt: string;
  /** Authoring companion registry id (e.g. 'companion-a-b', 'companion-c'). Omit for
   *  user/system rows — the column stays NULL. */
  companionId?: string;
  /** Stable id supplied by a client. Only user sends should set this. */
  clientId?: string;
}): Message {
  const sequence = getNextSequence(params.threadId);

  const stmt = getDb().prepare(`
    INSERT INTO messages (
      id, thread_id, sequence, role, content, content_type, platform, metadata, reply_to_id, created_at, companion_id, client_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.id,
    params.threadId,
    sequence,
    params.role,
    params.content,
    params.contentType || 'text',
    params.platform || 'web',
    params.metadata ? JSON.stringify(params.metadata) : null,
    params.replyToId || null,
    params.createdAt,
    params.companionId || null,
    params.clientId || null
  );

  // Automatic local embeddings are opt-in. Explicit semantic search/backfill
  // can still load the model, but routine messages and wakes never should.
  const shouldAutoEmbed = shouldAutomaticallyEmbed({
    setting: getConfig(AUTO_EMBED_CONFIG_KEY),
    role: params.role,
    contentType: params.contentType,
    contentLength: params.content.length,
  });
  if (shouldAutoEmbed) {
    const thread = getThread(params.threadId);
    embedMessageAsync(params.id, params.content, {
      threadId: params.threadId,
      threadName: thread?.name || '',
      role: params.role,
      createdAt: params.createdAt,
    }).catch(() => {});
  }

  return getMessage(params.id)!;
}

export function getMessageByClientId(clientId: string): Message | null {
  const row = getDb().prepare('SELECT * FROM messages WHERE client_id = ?').get(clientId);
  if (!row) return null;
  const message = row as unknown as Message;
  if (message.metadata && typeof message.metadata === 'string') {
    message.metadata = JSON.parse(message.metadata);
  }
  return message;
}

export function getMessage(id: string): Message | null {
  const stmt = getDb().prepare('SELECT * FROM messages WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;

  const message = row as unknown as Message;
  if (message.metadata && typeof message.metadata === 'string') {
    message.metadata = JSON.parse(message.metadata);
  }
  return message;
}

export function getMessages(params: {
  threadId: string;
  before?: string;
  limit?: number;
  /** Only messages created strictly after this ISO timestamp (recency bridge). */
  since?: string;
}): Message[] {
  const { threadId, before, limit = 50, since } = params;

  let sql = 'SELECT * FROM messages WHERE thread_id = ? AND deleted_at IS NULL';
  const sqlParams: unknown[] = [threadId];

  if (before) {
    sql += ' AND sequence < (SELECT sequence FROM messages WHERE id = ?)';
    sqlParams.push(before);
  }

  if (since) {
    sql += ' AND created_at > ?';
    sqlParams.push(since);
  }

  sql += ' ORDER BY sequence DESC LIMIT ?';
  sqlParams.push(limit);

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(...sqlParams);

  const messages = (rows as unknown as Message[]).map(msg => {
    if (msg.metadata && typeof msg.metadata === 'string') {
      msg.metadata = JSON.parse(msg.metadata);
    }
    return msg;
  });

  return messages.reverse(); // Return in chronological order
}

/** Get messages surrounding a specific message (N before + the message + N after). */
export function getMessageContext(messageId: string, windowSize: number = 2): Message[] {
  const target = getDb().prepare('SELECT thread_id, sequence FROM messages WHERE id = ?').get(messageId) as { thread_id: string; sequence: number } | undefined;
  if (!target) return [];

  const rows = getDb().prepare(`
    SELECT * FROM messages
    WHERE thread_id = ? AND deleted_at IS NULL
      AND sequence BETWEEN ? AND ?
    ORDER BY sequence ASC
  `).all(target.thread_id, target.sequence - windowSize, target.sequence + windowSize);

  return (rows as unknown as Message[]).map(msg => {
    if (msg.metadata && typeof msg.metadata === 'string') {
      msg.metadata = JSON.parse(msg.metadata);
    }
    return msg;
  });
}

export function editMessage(id: string, newContent: string, editedAt: string): void {
  const stmt = getDb().prepare(`
    UPDATE messages
    SET content = ?, edited_at = ?, original_content = COALESCE(original_content, content)
    WHERE id = ?
  `);
  stmt.run(newContent, editedAt, id);
}

export function softDeleteMessage(id: string, deletedAt: string): void {
  const stmt = getDb().prepare('UPDATE messages SET deleted_at = ? WHERE id = ?');
  stmt.run(deletedAt, id);
}

// Soft-delete every message in `threadId` whose sequence is strictly greater
// than `afterSequence`. Used by Edit & Rerun and Regenerate to drop the tail
// of the conversation before re-prompting. Returns the IDs of rows that
// flipped from non-deleted to deleted (so we can broadcast them).
/** Database-wide reroll preview; never limited by the UI's loaded page. */
export function getRerollPreview(id: string) {
  const target = getMessage(id);
  if (!target || target.deleted_at || target.role !== 'companion') return null;
  const prior = getDb().prepare(
    "SELECT id FROM messages WHERE thread_id = ? AND sequence < ? AND role = 'user' AND deleted_at IS NULL ORDER BY sequence DESC LIMIT 1"
  ).get(target.thread_id, target.sequence) as { id: string } | undefined;
  if (!prior) return null;
  const tail = getDb().prepare(
    'SELECT id, content, edited_at FROM messages WHERE thread_id = ? AND sequence >= ? AND deleted_at IS NULL ORDER BY sequence'
  ).all(target.thread_id, target.sequence);
  const priorUser = getMessage(prior.id)!;
  return { target, priorUser, count: tail.length,
    revision: crypto.createHash('sha256').update(JSON.stringify({ prior: [priorUser.id, priorUser.content, priorUser.edited_at], tail })).digest('hex') };
}

/** Check the confirmed tail and delete it in one synchronous transaction. */
export function applyReroll(id: string, revision: string) {
  return getDb().transaction(() => {
    const preview = getRerollPreview(id);
    if (!preview || preview.revision !== revision) return null;
    const deletedIds = softDeleteAfterSequence(preview.target.thread_id,
      preview.target.sequence - 1, new Date().toISOString());
    return { ...preview, deletedIds };
  })();
}

export function softDeleteAfterSequence(
  threadId: string,
  afterSequence: number,
  deletedAt: string,
): string[] {
  const idsStmt = getDb().prepare(
    'SELECT id FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL'
  );
  const ids = (idsStmt.all(threadId, afterSequence) as { id: string }[]).map(r => r.id);
  if (ids.length === 0) return [];
  const updateStmt = getDb().prepare(
    'UPDATE messages SET deleted_at = ? WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL'
  );
  updateStmt.run(deletedAt, threadId, afterSequence);
  return ids;
}

export function markMessagesRead(threadId: string, beforeId: string, readAt: string): void {
  const stmt = getDb().prepare(`
    UPDATE messages
    SET read_at = ?
    WHERE thread_id = ?
    AND sequence <= (SELECT sequence FROM messages WHERE id = ?)
    AND read_at IS NULL
  `);
  stmt.run(readAt, threadId, beforeId);

  // Reset unread count
  const resetStmt = getDb().prepare('UPDATE threads SET unread_count = 0 WHERE id = ?');
  resetStmt.run(threadId);
}

// Search operations
export function searchMessages(params: {
  query: string;
  threadId?: string;
  limit?: number;
  offset?: number;
}): { messages: Array<{ id: string; thread_id: string; role: string; content: string; content_type: string; created_at: string; thread_name: string }>; total: number } {
  const { query, threadId, limit = 50, offset = 0 } = params;
  const escapedQuery = query.replace(/[%_]/g, '\\$&');
  const searchPattern = `%${escapedQuery}%`;

  let whereClause = "WHERE m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'";
  const countParams: unknown[] = [searchPattern];
  const selectParams: unknown[] = [searchPattern];

  if (threadId) {
    whereClause += ' AND m.thread_id = ?';
    countParams.push(threadId);
    selectParams.push(threadId);
  }

  const countStmt = getDb().prepare(`SELECT COUNT(*) as total FROM messages m ${whereClause}`);
  const { total } = countStmt.get(...countParams) as { total: number };

  const selectStmt = getDb().prepare(`
    SELECT m.id, m.thread_id, m.role, m.content, m.content_type, m.created_at, t.name as thread_name
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    ${whereClause}
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `);
  selectParams.push(limit, offset);

  const rows = selectStmt.all(...selectParams) as Array<{
    id: string; thread_id: string; role: string; content: string;
    content_type: string; created_at: string; thread_name: string;
  }>;

  return { messages: rows, total };
}
