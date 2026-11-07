import { getDb } from './init.js';

// Embedding operations
export function saveEmbedding(messageId: string, vector: Buffer): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO message_embeddings (message_id, vector, created_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(messageId, vector, new Date().toISOString());
}

export function getAllEmbeddings(threadId?: string): Array<{
  message_id: string; vector: Buffer; thread_id: string;
  role: string; content: string; created_at: string; thread_name: string;
}> {
  let query = `
    SELECT e.message_id, e.vector, m.thread_id, m.role, m.content, m.created_at, t.name as thread_name
    FROM message_embeddings e
    JOIN messages m ON m.id = e.message_id
    JOIN threads t ON t.id = m.thread_id
    WHERE m.deleted_at IS NULL
  `;
  const params: unknown[] = [];
  if (threadId) {
    query += ' AND m.thread_id = ?';
    params.push(threadId);
  }
  return getDb().prepare(query).all(...params) as Array<{
    message_id: string; vector: Buffer; thread_id: string;
    role: string; content: string; created_at: string; thread_name: string;
  }>;
}

export function getUnembeddedMessages(limit: number = 50): Array<{
  id: string; content: string; role: string; content_type: string;
}> {
  return getDb().prepare(`
    SELECT m.id, m.content, m.role, m.content_type
    FROM messages m
    LEFT JOIN message_embeddings e ON e.message_id = m.id
    WHERE e.message_id IS NULL
      AND m.deleted_at IS NULL
      AND m.role != 'system'
      AND m.content_type = 'text'
      AND length(m.content) > 10
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string; content: string; role: string; content_type: string;
  }>;
}

export function getEmbeddingCount(): { embedded: number; total: number } {
  const embedded = (getDb().prepare('SELECT COUNT(*) as c FROM message_embeddings').get() as { c: number }).c;
  const total = (getDb().prepare(
    "SELECT COUNT(*) as c FROM messages WHERE deleted_at IS NULL AND role != 'system' AND content_type = 'text' AND length(content) > 10"
  ).get() as { c: number }).c;
  return { embedded, total };
}
