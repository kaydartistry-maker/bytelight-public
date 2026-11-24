import { Router } from 'express';
import { isPreservedCloudThread } from '../services/native-history.js';
import crypto from 'crypto';
import {
  listThreads,
  getThread,
  createThread,
  getMessages,
  getMessageContext,
  getMessage,
  markMessagesRead,
  archiveThread,
  deleteThread,
  getDb,
  searchMessages,
  pinThread,
  unpinThread,
  getAllEmbeddings,
  getRoutingThreadId,
  setRoutingThreadId,
  getRoutingThreadIdForSource,
  setRoutingThreadIdForSource,
} from '../services/db.js';
import { registry } from '../services/registry.js';
import { deleteFile } from '../services/files.js';
import { embed, cosineSimilarity, bufferToVector } from '../services/embeddings.js';
import { allCompanionsExist } from '../services/db/rooms.js';

export function createChatRoutes(): Router {
  const router = Router();

  // Thread list with summary
  router.get('/threads', (req, res) => {
    try {
      const threads = listThreads({ includeArchived: false, limit: 500 });

      // Enhance with last message preview
      const db = getDb();
      const threadsWithPreview = threads.map(thread => {
        const lastMsg = db.prepare(`
          SELECT content, role, created_at
          FROM messages
          WHERE thread_id = ? AND deleted_at IS NULL
          ORDER BY sequence DESC
          LIMIT 1
        `).get(thread.id) as { content: string; role: string; created_at: string } | undefined;

        return {
          id: thread.id,
          name: thread.name,
          type: thread.type,
          unread_count: thread.unread_count,
          last_activity_at: thread.last_activity_at,
          last_message_preview: lastMsg ? {
            content: lastMsg.content.slice(0, 100) + (lastMsg.content.length > 100 ? '...' : ''),
            role: lastMsg.role,
            created_at: lastMsg.created_at,
          } : null,
          pinned_at: thread.pinned_at ?? null,
        };
      });

      res.json({ threads: threadsWithPreview });
    } catch (error) {
      console.error('Error fetching threads:', error);
      res.status(500).json({ error: 'Failed to fetch threads' });
    }
  });

  // Get archived threads (must be before :id routes)
  router.get('/threads/archived', (req, res) => {
    try {
      const db = getDb();
      const threads = db.prepare(`
        SELECT * FROM threads WHERE archived_at IS NOT NULL
        ORDER BY archived_at DESC LIMIT 50
      `).all();
      res.json({ threads });
    } catch (error) {
      console.error('Error fetching archived threads:', error);
      res.status(500).json({ error: 'Failed to fetch archived threads' });
    }
  });

  // ── Routing ("Home") thread endpoints — ported from reference implementation ──────────
  // Get the active routing thread id (must be declared before /threads/:id
  // routes, otherwise Express treats "routing" as an :id and this never matches)
  router.get('/threads/routing', (_req, res) => {
    try {
      const id = getRoutingThreadId();
      res.json({ threadId: id });
    } catch (error) {
      console.error('Error getting routing thread:', error);
      res.status(500).json({ error: 'Failed to get routing thread' });
    }
  });

  // Per-source routing overrides — fall back to the global key when unset.
  const VALID_ROUTING_SOURCES = new Set(['discord', 'telegram', 'wake']);

  // Get the per-source override (or null if it's falling back to the global)
  router.get('/threads/routing/:source', (req, res) => {
    try {
      const { source } = req.params;
      if (!VALID_ROUTING_SOURCES.has(source)) {
        res.status(400).json({ error: `Unknown routing source: ${source}` });
        return;
      }
      const id = getRoutingThreadIdForSource(source as 'discord' | 'telegram' | 'wake');
      res.json({ threadId: id });
    } catch (error) {
      console.error('Error getting per-source routing thread:', error);
      res.status(500).json({ error: 'Failed to get per-source routing thread' });
    }
  });

  // Set a per-source override. POST body `{ threadId: string | null }` — passing
  // null clears the override so that source falls back to the global routing.
  router.post('/threads/routing/:source', (req, res) => {
    try {
      const { source } = req.params;
      if (!VALID_ROUTING_SOURCES.has(source)) {
        res.status(400).json({ error: `Unknown routing source: ${source}` });
        return;
      }
      const { threadId } = req.body as { threadId: string | null };
      if (threadId !== null && threadId !== undefined) {
        const thread = getThread(threadId);
        if (!thread) {
          res.status(404).json({ error: 'Thread not found' });
          return;
        }
      }
      const typedSource = source as 'discord' | 'telegram' | 'wake';
      setRoutingThreadIdForSource(typedSource, threadId ?? null);
      registry.broadcast({
        type: 'routing_thread_source_changed',
        source: typedSource,
        threadId: threadId ?? null,
      });
      res.json({ success: true, source, threadId: threadId ?? null });
    } catch (error) {
      console.error('Error setting per-source routing thread:', error);
      res.status(500).json({ error: 'Failed to set per-source routing thread' });
    }
  });

  // Set a thread as the active routing thread ("Home")
  router.post('/threads/:id/routing', (req, res) => {
    try {
      const { id } = req.params;
      const thread = getThread(id);
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      setRoutingThreadId(id);
      registry.broadcast({ type: 'routing_thread_changed', threadId: id });
      res.json({ success: true, threadId: id });
    } catch (error) {
      console.error('Error setting routing thread:', error);
      res.status(500).json({ error: 'Failed to set routing thread' });
    }
  });

  // Create named thread. Optional companionIds seats the roster at creation
  // (the Slice 3 picker). Omit it and createThread applies the default resident
  // pair — the single default-seating point lives in db.ts (createThread).
  router.post('/threads', (req, res) => {
    try {
      const { name, companionIds } = req.body;

      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Thread name required' });
        return;
      }

      // Validate an explicit roster if one was sent. Absent/empty → default
      // seating (handled in createThread). A malformed or unknown-id roster is
      // a 400 rather than a silent fallback, so the picker fails loudly.
      let roster: string[] | undefined;
      if (companionIds !== undefined) {
        if (
          !Array.isArray(companionIds) ||
          !companionIds.every((x) => typeof x === 'string' && x.trim().length > 0)
        ) {
          res.status(400).json({ error: 'companionIds must be an array of companion id strings' });
          return;
        }
        const ids = Array.from(new Set((companionIds as string[]).map((s) => s.trim())));
        if (ids.length > 0) {
          if (!allCompanionsExist(ids)) {
            res.status(400).json({ error: 'one or more companionIds do not exist in the companions registry' });
            return;
          }
          roster = ids;
        }
      }

      const thread = createThread({
        id: crypto.randomUUID(),
        name,
        type: 'named',
        createdAt: new Date().toISOString(),
        sessionType: 'v2',
        companionIds: roster,
      });

      res.json({ thread });
    } catch (error) {
      console.error('Error creating thread:', error);
      res.status(500).json({ error: 'Failed to create thread' });
    }
  });

  // Get thread messages (paginated)
  router.get('/threads/:id/messages', (req, res) => {
    try {
      const { id } = req.params;
      const { before, around, limit } = req.query;

      const thread = getThread(id);
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      // `around=<messageId>` loads a window of messages centered on a target —
      // used by search-result jumps so a hit on a message older than the
      // last 50 still has surrounding context to anchor the scroll.
      if (around) {
        const windowSize = limit ? Math.max(1, parseInt(limit as string, 10)) : 50;
        const messages = getMessageContext(around as string, windowSize);
        res.json({ messages });
        return;
      }

      const messages = getMessages({
        threadId: id,
        before: before as string | undefined,
        limit: limit ? parseInt(limit as string, 10) : 50,
      });

      res.json({ messages });
    } catch (error) {
      console.error('Error fetching messages:', error);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // Mark messages as read
  router.post('/messages/read', (req, res) => {
    try {
      const { threadId, beforeId } = req.body;

      if (!threadId || !beforeId) {
        res.status(400).json({ error: 'threadId and beforeId required' });
        return;
      }

      const message = getMessage(beforeId);
      if (!message || message.thread_id !== threadId) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      markMessagesRead(threadId, beforeId, new Date().toISOString());

      res.json({ success: true });
    } catch (error) {
      console.error('Error marking messages as read:', error);
      res.status(500).json({ error: 'Failed to mark messages as read' });
    }
  });

  // Archive a thread
  router.post('/threads/:id/archive', (req, res) => {
    try {
      const { id } = req.params;
      const thread = getThread(id);
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      archiveThread(id, new Date().toISOString());
      res.json({ success: true });
    } catch (error) {
      console.error('Error archiving thread:', error);
      res.status(500).json({ error: 'Failed to archive thread' });
    }
  });

  // Unarchive a thread
  router.post('/threads/:id/unarchive', (req, res) => {
    try {
      const { id } = req.params;
      const thread = getThread(id);
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      archiveThread(id, null);
      res.json({ success: true });
    } catch (error) {
      console.error('Error unarchiving thread:', error);
      res.status(500).json({ error: 'Failed to unarchive thread' });
    }
  });

  // Pin a thread
  router.post('/threads/:id/pin', (req, res) => {
    try {
      const { id } = req.params;
      const thread = getThread(id);
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      pinThread(id);
      const updated = getThread(id)!;

      registry.broadcast({
        type: 'thread_updated',
        thread: {
          id: updated.id,
          name: updated.name,
          type: updated.type,
          unread_count: updated.unread_count,
          last_activity_at: updated.last_activity_at,
          last_message_preview: null,
          pinned_at: updated.pinned_at,
        },
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error pinning thread:', error);
      res.status(500).json({ error: 'Failed to pin thread' });
    }
  });

  // Unpin a thread
  router.post('/threads/:id/unpin', (req, res) => {
    try {
      const { id } = req.params;
      const thread = getThread(id);
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      unpinThread(id);

      registry.broadcast({
        type: 'thread_updated',
        thread: {
          id: thread.id,
          name: thread.name,
          type: thread.type,
          unread_count: thread.unread_count,
          last_activity_at: thread.last_activity_at,
          last_message_preview: null,
          pinned_at: null,
        },
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error unpinning thread:', error);
      res.status(500).json({ error: 'Failed to unpin thread' });
    }
  });

  // Delete a thread and all associated data
  router.delete('/threads/:id', (req, res) => {
    if (isPreservedCloudThread(req.params.id)) {
      res.status(409).json({ error: 'legacy_history_read_only' });
      return;
    }
    try {
      const { id } = req.params;
      const thread = getThread(id);
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      const fileIds = deleteThread(id);

      // Clean up files on disk
      for (const fileId of fileIds) {
        deleteFile(fileId);
      }

      // Broadcast deletion to all connected clients
      registry.broadcast({ type: 'thread_deleted', threadId: id });

      res.json({ success: true, deletedFiles: fileIds.length });
    } catch (error) {
      console.error('Error deleting thread:', error);
      res.status(500).json({ error: 'Failed to delete thread' });
    }
  });

  // Rename a thread
  router.patch('/threads/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { name } = req.body;

      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Thread name required' });
        return;
      }

      const thread = getThread(id);
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      const db = getDb();
      db.prepare('UPDATE threads SET name = ? WHERE id = ?').run(name, id);

      // Broadcast updated thread to all clients
      registry.broadcast({
        type: 'thread_updated',
        thread: {
          id: thread.id,
          name,
          type: thread.type,
          unread_count: thread.unread_count,
          last_activity_at: thread.last_activity_at,
          last_message_preview: null,
          pinned_at: thread.pinned_at ?? null,
        },
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error renaming thread:', error);
      res.status(500).json({ error: 'Failed to rename thread' });
    }
  });

  // Message search
  router.get('/search', (req, res) => {
    try {
      const q = req.query.q as string;
      if (!q || q.trim().length === 0) {
        return res.status(400).json({ error: 'Search query required' });
      }
      const threadId = req.query.threadId as string | undefined;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const { messages: rows, total } = searchMessages({ query: q.trim(), threadId, limit, offset });

      const results = rows.map(row => {
        // Build highlight snippet around match
        const idx = row.content.toLowerCase().indexOf(q.toLowerCase());
        const start = Math.max(0, idx - 40);
        const end = Math.min(row.content.length, idx + q.length + 40);
        const highlight = (start > 0 ? '...' : '') + row.content.slice(start, end) + (end < row.content.length ? '...' : '');

        return {
          messageId: row.id,
          threadId: row.thread_id,
          threadName: row.thread_name,
          role: row.role,
          content: row.content.substring(0, 200),
          highlight,
          createdAt: row.created_at,
        };
      });

      res.json({ results, total });
    } catch (error) {
      console.error('Error searching messages:', error);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // Semantic message search (auth-protected)
  router.get('/search-semantic', async (req, res) => {
    try {
      const q = req.query.q as string;
      if (!q || q.trim().length === 0) {
        return res.status(400).json({ error: 'Search query required' });
      }
      const threadId = req.query.threadId as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 50);

      const queryVector = await embed(q.trim());
      const rows = getAllEmbeddings(threadId);

      const scored = rows.map((row: any) => ({
        messageId: row.message_id,
        threadId: row.thread_id,
        threadName: row.thread_name,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
        similarity: cosineSimilarity(queryVector, bufferToVector(row.vector)) as number,
      }));

      scored.sort((a: { similarity: number }, b: { similarity: number }) => b.similarity - a.similarity);
      const top = scored.slice(0, limit);

      const results = top.map((r: { messageId: string; threadId: string; threadName: string; role: string; content: string; createdAt: string }) => ({
        messageId: r.messageId,
        threadId: r.threadId,
        threadName: r.threadName,
        role: r.role,
        highlight: r.content.length > 160 ? r.content.slice(0, 160) + '…' : r.content,
        createdAt: r.createdAt,
      }));

      res.json({ results, total: results.length });
    } catch (error) {
      console.error('Semantic search error:', error);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  return router;
}
