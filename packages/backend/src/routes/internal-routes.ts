import { Router, type Response } from 'express';
import { requireLocalhost } from '../middleware/localhost.js';
import { staleBlockText } from '../services/heartbeat/stale-walls.js';
import { normalizeNoteColor } from '@bytelight/shared';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import {
  listThreads,
  getThread,
  createMessage,
  getMessages,
  updateThreadActivity,
  getDb,
  createCanvas,
  getCanvas,
  listCanvases,
  updateCanvasContent,
  updateCanvasTags,
  createTimer,
  listPendingTimers,
  cancelTimer,
  addReaction,
  removeReaction,
  addStar,
  removeStar,
  createTrigger,
  listTriggers,
  cancelTrigger,
  getUnembeddedMessages,
  saveEmbedding,
  getEmbeddingCount,
  getMessageContext,
  softDeleteMessage,
  recordUsageEvent,
} from '../services/db.js';
import type { TriggerCondition } from '../services/db.js';
import {
  getAllBlocks,
  appendToBlock,
  replaceInBlock,
  rethinkBlock,
  resolveScope,
  validScopesHint,
} from '../services/memory-blocks.js';
import { findNeighborsWithin } from '../services/memory-neighbors.js';
import { runMemoryExtraction } from '../services/memory-extraction.js';
import {
  listProposals,
  getProposal,
  resolveProposal,
  countPending,
  type ProposalStatus,
} from '../services/memory-proposals.js';
import {
  createSelfKnowledge,
  listSelfKnowledge,
  getSelfKnowledge,
  reviewSelfKnowledge,
  isSelfKnowledgeCategory,
  type SelfKnowledgeStatus,
} from '../services/db/self-knowledge.js';
import { createJournalEntry, listJournalEntries, recallJournalEntry, anchorJournalEntry, updateJournalEntry, effectiveVividness, JournalRemoteError } from '../services/db/journal.js';
import { listCompanions } from '../services/db/rooms.js';
import { sealLetter, listLetters, openLetter, unopenedLettersFor, LetterError } from '../services/db/letters.js';
import { addFieldNote, listFieldNotes, fieldNotesLimit, FieldNoteError } from '../services/db/field-notes.js';
import { getStatusSnapshot, setCompanionStatus, StatusError } from '../services/db/statuses.js';
import { cancelIntention, createIntention, IntentionError, listIntentions } from '../services/db/intentions.js';
import { postToTreehouse, getTreehouseInfo, getTreehouseMessages, treehouseMembers } from '../services/treehouse.js';

// A self-knowledge entry is owned by a companion or by 'shared'. 'shared' is a
// deliberate owner (a truth both companions hold) and is NOT a row in the companions
// registry, so it's allowed explicitly alongside a generic registry lookup —
// no companion names are hardcoded.
function isValidSelfKnowledgeOwner(slug: string): boolean {
  if (slug === 'shared') return true;
  return listCompanions().some((c) => c.id === slug);
}

function isValidLetterActor(slug: string): boolean {
  return slug === 'user' || listCompanions().some((c) => c.id === slug);
}

// Ledger attribution: the internal routes are the CLI lane's hands (tools/sc.mjs
// on the codex / claude-cli engines), which is what the receipt should say.
const CLI_WRITE = { actor: 'cli' } as const;
import { embed, vectorToBuffer } from '../services/embeddings.js';
import { searchVectors, getCacheStats, type SearchFilter } from '../services/vector-cache.js';
import { getMemorySnapshot } from '../services/memory-profiler.js';
import { saveFileInternal, saveFile, getFile } from '../services/files.js';
import { buildImageReactPrompt } from '../services/image-react-prompt.js';
import { generateImage, recordGalleryMeta, getImageGenSettings, chatGalleryMeta } from '../services/image-gen.js';
import { queueImageForCompanion } from '../services/pending-visuals.js';
import { registry } from '../services/registry.js';
import {
  getBattleshipCompanionView,
  fireAtPlayerFleet,
  addBattleshipChat,
  assertFleetCompanion,
  BattleshipError,
} from '../services/db/battleship.js';
import { getBytelightConfig } from '../config.js';
import type { Orchestrator } from '../services/orchestrator.js';
import type { VoiceService } from '../services/voice.js';
import type { TelegramService } from '../services/telegram/index.js';
import type { AgentService } from '../services/agent.js';
import { getActiveDiscordService, type DiscordService } from '../services/discord/index.js';
import { errMessage } from '../util/errors.js';
import { readShelf, currentlyReading, readAlong, highlightsSoFar, addNote, readNotes, LibraryError } from '../services/library.js';
import { needle } from '../services/needle.js';
import storyShelfInternalRoutes from './internal/story-shelf.js';
import bookClubInternalRoutes from './internal/library-book-club.js';

// After a render lands we hand ourselves a turn to look at it and react — so the
// picture and our genuine reaction arrive in the same beat, without blocking the
// (fire-and-forget) render. The SDK lane sees the queued image via pending-visuals;
// other lanes get its path in the nudge (buildImageReactPrompt).

// Background backfill state
let backfillRunning = false;
let backfillProcessed = 0;
let backfillErrors = 0;

async function runBackfillLoop(batchSize: number, intervalMs: number): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  backfillProcessed = 0;
  backfillErrors = 0;
  console.log(`[backfill] Starting background indexing (batch=${batchSize}, interval=${intervalMs}ms)`);

  const tick = async () => {
    if (!backfillRunning) return;
    const unembedded = getUnembeddedMessages(batchSize);
    if (unembedded.length === 0) {
      backfillRunning = false;
      const { embedded, total } = getEmbeddingCount();
      console.log(`[backfill] Complete. ${embedded}/${total} messages indexed (${backfillErrors} errors).`);
      return;
    }
    for (const msg of unembedded) {
      if (!backfillRunning) return;
      try {
        const vector = await embed(msg.content);
        saveEmbedding(msg.id, vectorToBuffer(vector));
        backfillProcessed++;
      } catch {
        backfillErrors++;
      }
    }
    if (backfillProcessed % 500 === 0) {
      const { embedded, total } = getEmbeddingCount();
      console.log(`[backfill] Progress: ${embedded}/${total}`);
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}

export function createInternalRoutes(): Router {
  const router = Router();

  const discordRoute = (
    verb: string,
    action: (service: DiscordService, body: Record<string, unknown>, voiceService: VoiceService | undefined) => Promise<{ ok: boolean; error?: string }>,
  ) => {
    router.post(`/internal/discord/${verb}`, requireLocalhost, async (req, res) => {
      const service = getActiveDiscordService();
      if (!service) {
        res.status(503).json({ ok: false, error: 'Discord gateway is not started' });
        return;
      }
      try {
        const result = await action(service, req.body as Record<string, unknown>, req.app.locals.voiceService as VoiceService | undefined);
        res.status(result.ok ? 200 : 400).json(result);
      } catch (error) {
        res.status(500).json({ ok: false, error: errMessage(error) });
      }
    });
  };

  discordRoute('send', (s, b) => s.sendMessage(b.channelId, b.message, b.replyToMessageId));
  discordRoute('send_image', (s, b) => s.sendImage(b.channelId, b.url, b.description));
  discordRoute('send_sticker', (s, b) => s.sendSticker(b.channelId, b.stickerId));
  discordRoute('send_voice', (s, b, voiceService) => {
    if (!voiceService) return Promise.resolve({ ok: false, error: 'Voice service is unavailable' });
    return s.sendVoice(b.channelId, b.text, b.voice, voiceService);
  });
  discordRoute('add_reaction', (s, b) => s.addReaction(b.channelId, b.messageId, b.emoji));
  discordRoute('edit_message', (s, b) => s.editOwnMessage(b.channelId, b.messageId, b.content));
  discordRoute('delete_message', (s, b) => s.deleteOwnMessage(b.channelId, b.messageId));
  discordRoute('read_messages', (s, b) => s.readMessages(b.channelId, b.limit));
  discordRoute('search_messages', (s, b) => s.searchMessages(b.guildId, b));
  discordRoute('typing', (s, b) => s.sendTypingTo(b.channelId));
  discordRoute('get_server_info', (s, b) => s.getServerInfo(b.guildId));
  discordRoute('list_servers', s => s.listServers());
  discordRoute('list_emojis', (s, b) => s.listEmojis(b.guildId));
  discordRoute('list_stickers', (s, b) => s.listStickers(b.guildId));

  // The blocks that moved while a lane's room was open, for its own note after
  // a compaction. The lane's SessionStart hook (matcher "compact",
  // hooks/compacted.cjs) asks here: that hook is the one place Claude Code
  // reads words back into a room after a compaction.
  router.get('/internal/compaction-refresh', requireLocalhost, (req, res) => {
    const lane = typeof req.query.lane === 'string' ? req.query.lane : '';
    res.json({ success: true, refresh: staleBlockText(lane) });
  });

  // Memory snapshot — leak diagnostics (Track A.5, read-only)
  router.get('/internal/memstats', requireLocalhost, (_req, res) => {
    res.json(getMemorySnapshot());
  });

  // TTS endpoint — companion sends voice notes via curl from localhost
  router.post('/internal/tts', requireLocalhost, async (req, res) => {
    const { text, threadId: explicitThreadId, voice: explicitVoice } = req.body;
    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const voiceService = req.app.locals.voiceService as VoiceService | undefined;
    if (!voiceService?.canTTS) {
      res.status(503).json({
        error: 'voice_unavailable',
        detail: 'ELEVENLABS_API_KEY missing, or no voice ID (generic ELEVENLABS_VOICE_ID or per-companion ELEVENLABS_VOICE_ID_<NAME>) configured',
      });
      return;
    }

    // If threadId not provided, use the most recently active thread
    let threadId = explicitThreadId;
    if (!threadId) {
      const threads = listThreads({ includeArchived: false, limit: 1 });
      if (threads.length === 0) {
        res.status(404).json({ error: 'No active threads found' });
        return;
      }
      threadId = threads[0].id;
    }

    const thread = getThread(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    try {
      const result = await voiceService.generateTTSForMessage(text, threadId, explicitVoice);
      res.json({ success: true, messageId: result.messageId, fileId: result.fileId });
    } catch (error) {
      console.error('TTS error:', error);
      const msg = error instanceof Error ? error.message : 'TTS generation failed';
      res.status(500).json({ error: msg });
    }
  });

  // Share a file into chat — companion shares files from disk into a thread
  router.post('/internal/share', requireLocalhost, (req, res) => {
    const { path: filePath, threadId: explicitThreadId, caption } = req.body;
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    // Resolve thread
    let threadId = explicitThreadId;
    if (!threadId) {
      const threads = listThreads({ includeArchived: false, limit: 1 });
      if (threads.length === 0) {
        res.status(404).json({ error: 'No active threads found' });
        return;
      }
      threadId = threads[0].id;
    }

    const thread = getThread(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    try {
      const buffer = readFileSync(filePath);
      const filename = basename(filePath);
      const fileMeta = saveFileInternal(buffer, filename);

      const now = new Date().toISOString();
      const message = createMessage({
        id: crypto.randomUUID(),
        threadId,
        role: 'companion',
        content: caption || fileMeta.url,
        contentType: fileMeta.contentType,
        metadata: { fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'shared' },
        createdAt: now,
      });

      updateThreadActivity(threadId, now, true);
      registry.broadcast({ type: 'message', message });

      res.json({ success: true, fileId: fileMeta.fileId, messageId: message.id, url: fileMeta.url });
    } catch (error) {
      console.error('Share file error:', error);
      const msg = error instanceof Error ? error.message : 'Failed to share file';
      res.status(500).json({ error: msg });
    }
  });

  // Generate an image and drop it into the chat thread. Free Codex lane by
  // default; metered OpenAI lane if configured. The picture is saved to the
  // Studio gallery AND posted as a companion message (mirrors /internal/share).
  router.post('/internal/generate-image', requireLocalhost, async (req, res) => {
    const { prompt, subjects, size, threadId: explicitThreadId, caption, useDroppedImage } = req.body as {
      prompt?: string;
      subjects?: string[];
      size?: 'square' | 'portrait' | 'landscape';
      threadId?: string;
      caption?: string;
      useDroppedImage?: boolean;
    };

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    let threadId = explicitThreadId;
    if (!threadId) {
      const threads = listThreads({ includeArchived: false, limit: 1 });
      if (threads.length === 0) {
        res.status(404).json({ error: 'No active threads found' });
        return;
      }
      threadId = threads[0].id;
    }
    if (!getThread(threadId)) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    // A render takes ~1-3 minutes (longer with several reference drawers) — past
    // the caller's command/Bash timeout. So ACK immediately and finish in the
    // background; the picture lands in the chat via broadcast when it's ready.
    // (If gen is disabled, surface that synchronously so the caller hears it now.)
    if (!getImageGenSettings().enabled) {
      res.status(400).json({ error: 'Image generation is switched off. Turn it on in the Studio drawer → Settings.' });
      return;
    }
    // One-off references: image(s) just dropped in this thread. Not saved.
    const extraRefs: string[] = [];
    if (useDroppedImage) {
      try {
        // The two newest images the user dropped, wherever they live: a message's
        // metadata.attachments (how images arrive now — one message, one row)
        // or an older standalone contentType:'image' row.
        const rows = getDb().prepare(
          "SELECT content_type, metadata FROM messages WHERE thread_id = ? AND role = 'user' AND deleted_at IS NULL AND (content_type = 'image' OR metadata LIKE '%\"attachments\"%') ORDER BY created_at DESC, sequence DESC LIMIT 20",
        ).all(threadId) as Array<{ content_type: string; metadata: string | null }>;
        const fileIds: string[] = [];
        for (const r of rows) {
          if (fileIds.length >= 2) break;
          if (!r.metadata) continue;
          try {
            const m = JSON.parse(r.metadata) as { fileId?: string; attachments?: Array<{ fileId?: string; contentType?: string }> };
            if (r.content_type === 'image') {
              if (m.fileId) fileIds.push(m.fileId);
            } else if (Array.isArray(m.attachments)) {
              for (const a of m.attachments) if (a?.contentType === 'image' && a.fileId) fileIds.push(a.fileId);
            }
          } catch { /* ignore */ }
        }
        for (const id of [...new Set(fileIds)].slice(0, 2)) {
          const f = getFile(id);
          if (f) extraRefs.push(f.path);
        }
      } catch (e) {
        console.warn('[image-gen] dropped-ref resolve failed:', e instanceof Error ? e.message : e);
      }
    }

    const tid = threadId;
    // Show a live "generating…" placeholder in the chat immediately; swap it for
    // the finished picture (or an error note) when the background render ends.
    const startNow = new Date().toISOString();
    const placeholder = createMessage({
      id: crypto.randomUUID(),
      threadId: tid,
      role: 'companion',
      content: 'Generating an image…',
      metadata: { source: 'image_gen_pending' },
      createdAt: startNow,
    });
    updateThreadActivity(tid, startNow, true);
    registry.broadcast({ type: 'message', message: placeholder });

    res.json({ success: true, status: 'generating', placeholderId: placeholder.id, message: 'On its way — the image will appear in the chat shortly (up to a few minutes for all of us together).' });

    const clearPlaceholder = () => {
      try {
        softDeleteMessage(placeholder.id, new Date().toISOString());
        registry.broadcast({ type: 'message_deleted', messageId: placeholder.id });
      } catch { /* ignore */ }
    };

    void (async () => {
      try {
        const result = await generateImage({ prompt, subjects, size, extraRefs });
        const buffer = readFileSync(result.path);
        const fileMeta = saveFileInternal(buffer, result.filename);
        const now = new Date().toISOString();
        clearPlaceholder();
        // content MUST be the file URL — the frontend renders image messages
        // via <img src={message.content}>. A caption belongs in metadata, not
        // in content, or it paves over the URL and the image renders blank.
        const trimmedCaption = typeof caption === 'string' ? caption.trim() : '';
        const message = createMessage({
          id: crypto.randomUUID(),
          threadId: tid,
          role: 'companion',
          content: fileMeta.url,
          contentType: fileMeta.contentType,
          metadata: {
            fileId: fileMeta.fileId,
            filename: fileMeta.filename,
            size: fileMeta.size,
            source: 'image_gen',
            backend: result.backend,
            model: result.model,
            ...(trimmedCaption ? { caption: trimmedCaption } : {}),
          },
          createdAt: now,
        });
        updateThreadActivity(tid, now, true);
        registry.broadcast({ type: 'message', message });

        // Show it to ourselves on the next turn — so we actually see what we made.
        queueImageForCompanion(tid, fileMeta.fileId);

        try {
          await recordGalleryMeta(result.filename, chatGalleryMeta({ prompt, subjects, size, model: result.model, backend: result.backend, messageId: message.id, threadId: tid, createdAt: now }));
        } catch (e) {
          console.warn('[image-gen] gallery meta record failed:', e instanceof Error ? e.message : e);
        }
        try {
          recordUsageEvent({
            id: crypto.randomUUID(),
            createdAt: now,
            threadId: tid,
            messageId: message.id,
            mode: 'interactive',
            model: result.model,
            inputTokens: 0,
            outputTokens: 0,
            toolCalls: [{ name: 'generate_image', count: 1 }],
            costUsd: result.costUsd,
            durationMs: result.durationMs,
          });
        } catch (e) {
          console.warn('[image-gen] usage record failed:', e instanceof Error ? e.message : e);
        }

        // Hand ourselves a turn to see what we made and react, right as it lands.
        const agentService = req.app.locals.agentService as AgentService | undefined;
        if (agentService) {
          agentService.processAutonomous(tid, buildImageReactPrompt(getFile(fileMeta.fileId)?.path ?? null)).catch((e) =>
            console.warn('[image-gen] react turn failed:', e instanceof Error ? e.message : e));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Image generation failed.';
        console.warn('[image-gen] background generation failed:', msg);
        clearPlaceholder();
        try {
          const now = new Date().toISOString();
          const sysMsg = createMessage({
            id: crypto.randomUUID(),
            threadId: tid,
            role: 'system',
            content: `🖼️ Image generation didn't finish: ${msg}`,
            createdAt: now,
          });
          registry.broadcast({ type: 'message', message: sysMsg });
        } catch { /* ignore */ }
      }
    })();
  });

  // Telegram send — send files/photos/voice to user via Telegram
  router.post('/internal/telegram-send', requireLocalhost, async (req, res) => {
    const telegramService = req.app.locals.telegramService as TelegramService | undefined;
    if (!telegramService?.isConnected()) {
      res.status(503).json({ error: 'Telegram not connected' });
      return;
    }

    const { type, text, path: filePath, url, caption, filename, query, target, emoji, voice } = req.body;

    try {
      switch (type) {
        case 'text':
          if (!text) { res.status(400).json({ error: 'text is required' }); return; }
          await telegramService.sendToOwner(text);
          break;

        case 'voice':
          if (!text) { res.status(400).json({ error: 'text is required for TTS' }); return; }
          await telegramService.sendVoiceToOwner(text, voice);
          break;

        case 'photo': {
          const source = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
          if (!source) { res.status(400).json({ error: 'url or valid path required' }); return; }
          await telegramService.sendPhotoToOwner(source, caption);
          break;
        }

        case 'document': {
          const docSource = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
          if (!docSource) { res.status(400).json({ error: 'url or valid path required' }); return; }
          await telegramService.sendDocumentToOwner(docSource, filename || basename(filePath || 'file'), caption);
          break;
        }

        case 'animation': {
          const animSource = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
          if (!animSource) { res.status(400).json({ error: 'url or valid path required' }); return; }
          await telegramService.sendAnimationToOwner(animSource, caption);
          break;
        }

        case 'gif':
          if (!query) { res.status(400).json({ error: 'query is required for gif search' }); return; }
          await telegramService.sendGifToOwner(query, caption);
          break;

        case 'react':
          if (!target || !emoji) { res.status(400).json({ error: 'target and emoji are required' }); return; }
          await telegramService.reactToMessage(target, emoji);
          break;

        default:
          res.status(400).json({ error: `Unknown type: ${type}. Use text, voice, photo, document, animation, gif, or react.` });
          return;
      }

      res.json({ success: true, type });
    } catch (error) {
      console.error('[API] Telegram send error:', error);
      const msg = error instanceof Error ? error.message : 'Telegram send failed';
      res.status(500).json({ error: msg });
    }
  });

  // Canvas — internal endpoint for agent to create/update canvases
  router.post('/internal/canvas', requireLocalhost, (req, res) => {
    const config = getBytelightConfig();
    const { action, canvasId, title, content, filePath, contentType, language, threadId } = req.body;
    const now = new Date().toISOString();

    // Resolve content: filePath takes priority over inline content
    let resolvedContent = content || '';
    if (filePath && typeof filePath === 'string') {
      if (!existsSync(filePath)) {
        res.status(404).json({ error: 'File not found on disk' });
        return;
      }
      resolvedContent = readFileSync(filePath, 'utf-8');
    }

    try {
      if (action === 'create') {
        if (!title) {
          res.status(400).json({ error: 'title is required' });
          return;
        }

        const canvas = createCanvas({
          id: crypto.randomUUID(),
          threadId: threadId || undefined,
          title,
          content: resolvedContent,
          contentType: contentType || 'markdown',
          language: language || undefined,
          createdBy: 'companion',
          createdAt: now,
        });

        registry.broadcast({ type: 'canvas_created', canvas });

        // System message in chat if threadId provided
        if (threadId) {
          const thread = getThread(threadId);
          if (thread) {
            const sysMsg = createMessage({
              id: crypto.randomUUID(),
              threadId,
              role: 'system',
              content: `${config.identity.companion_name} opened a canvas: ${title}`,
              createdAt: now,
            });
            registry.broadcast({ type: 'message', message: sysMsg });
          }
        }

        res.json({ success: true, canvas });
      } else if (action === 'update') {
        if (!canvasId || (resolvedContent === '' && !filePath)) {
          res.status(400).json({ error: 'canvasId and content (or filePath) are required' });
          return;
        }
        updateCanvasContent(canvasId, resolvedContent, now);
        registry.broadcast({ type: 'canvas_updated', canvasId, content: resolvedContent, updatedAt: now });
        res.json({ success: true });
      } else if (action === 'read') {
        if (!canvasId) {
          res.status(400).json({ error: 'canvasId is required' });
          return;
        }
        const canvas = getCanvas(canvasId);
        if (!canvas) {
          res.status(404).json({ error: 'Canvas not found' });
          return;
        }
        res.json({ success: true, canvas });
      } else if (action === 'list') {
        const allCanvases = listCanvases();
        res.json({ success: true, canvases: allCanvases });
      } else if (action === 'tag') {
        if (!canvasId || !Array.isArray(req.body.tags)) {
          res.status(400).json({ error: 'canvasId and tags (array) are required' });
          return;
        }
        updateCanvasTags(canvasId, req.body.tags, now);
        const updated = getCanvas(canvasId);
        registry.broadcast({ type: 'canvas_updated', canvasId, content: updated?.content || '', updatedAt: now, tags: req.body.tags });
        res.json({ success: true, canvas: updated });
      } else {
        res.status(400).json({ error: 'Unknown action. Use "create", "update", "read", "list", or "tag".' });
      }
    } catch (error) {
      console.error('Internal canvas error:', error);
      res.status(500).json({ error: 'Canvas operation failed' });
    }
  });

  // Orchestrator self-management — companion manages schedule via curl
  router.post('/internal/orchestrator', requireLocalhost, async (req, res) => {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }

    const { action, wakeType, cronExpr } = req.body;

    try {
      switch (action) {
        case 'status': {
          const tasks = await orchestrator.getStatus();
          res.json({ tasks });
          break;
        }
        case 'enable': {
          if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
          const success = orchestrator.enableTask(wakeType);
          if (!success) { res.status(404).json({ error: 'Unknown wake type' }); return; }
          res.json({ success: true, wakeType, enabled: true });
          break;
        }
        case 'disable': {
          if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
          const success = orchestrator.disableTask(wakeType);
          if (!success) { res.status(404).json({ error: 'Unknown wake type' }); return; }
          res.json({ success: true, wakeType, enabled: false });
          break;
        }
        case 'reschedule': {
          if (!wakeType || !cronExpr) { res.status(400).json({ error: 'wakeType and cronExpr required' }); return; }
          const success = orchestrator.rescheduleTask(wakeType, cronExpr);
          if (!success) { res.status(400).json({ error: 'Failed — invalid cron or unknown wake type' }); return; }
          res.json({ success: true, wakeType, cronExpr });
          break;
        }
        default:
          res.status(400).json({ error: 'Unknown action. Use: status, enable, disable, reschedule' });
      }
    } catch (error) {
      console.error('Orchestrator internal error:', error);
      res.status(500).json({ error: 'Orchestrator operation failed' });
    }
  });

  // Timer/Reminder — companion sets contextual reminders via curl
  router.post('/internal/timer', requireLocalhost, (req, res) => {
    const { action } = req.body;

    try {
      switch (action) {
        case 'create': {
          const { label, fireAt, threadId, context, prompt } = req.body;
          if (!label || !fireAt || !threadId) {
            res.status(400).json({ error: 'label, fireAt, and threadId required' });
            return;
          }

          // Validate fireAt is a valid ISO date
          const fireDate = new Date(fireAt);
          if (isNaN(fireDate.getTime())) {
            res.status(400).json({ error: 'fireAt must be a valid ISO date' });
            return;
          }

          // Validate thread exists
          const thread = getThread(threadId);
          if (!thread) {
            res.status(404).json({ error: 'Thread not found' });
            return;
          }

          const timer = createTimer({
            id: crypto.randomUUID(),
            label,
            context,
            fireAt: fireDate.toISOString(),
            threadId,
            prompt,
            createdAt: new Date().toISOString(),
          });

          res.json({ success: true, timer });
          break;
        }
        case 'list': {
          const timers = listPendingTimers();
          res.json({ timers });
          break;
        }
        case 'cancel': {
          const { timerId } = req.body;
          if (!timerId) {
            res.status(400).json({ error: 'timerId required' });
            return;
          }
          const cancelled = cancelTimer(timerId);
          if (!cancelled) {
            res.status(404).json({ error: 'Timer not found or already fired/cancelled' });
            return;
          }
          res.json({ success: true, timerId });
          break;
        }
        default:
          res.status(400).json({ error: 'Unknown action. Use: create, list, cancel' });
      }
    } catch (error) {
      console.error('Timer internal error:', error);
      res.status(500).json({ error: 'Timer operation failed' });
    }
  });

  // Trigger management (internal — agent use via CLI)
  router.post('/internal/trigger', requireLocalhost, (req, res) => {
    const { action } = req.body;

    try {
      switch (action) {
        case 'create': {
          const { kind, label, conditions, prompt, threadId, cooldownMinutes } = req.body;
          if (!kind || !label || !conditions) {
            res.status(400).json({ error: 'kind, label, and conditions required' });
            return;
          }
          if (kind !== 'impulse' && kind !== 'watcher') {
            res.status(400).json({ error: 'kind must be "impulse" or "watcher"' });
            return;
          }
          if (!Array.isArray(conditions) || conditions.length === 0) {
            res.status(400).json({ error: 'conditions must be a non-empty array' });
            return;
          }

          // Validate thread exists if specified
          if (threadId) {
            const thread = getThread(threadId);
            if (!thread) {
              res.status(404).json({ error: 'Thread not found' });
              return;
            }
          }

          const trigger = createTrigger({
            id: crypto.randomUUID(),
            kind,
            label,
            conditions: conditions as TriggerCondition[],
            prompt,
            threadId,
            cooldownMinutes: cooldownMinutes ? parseInt(cooldownMinutes, 10) : undefined,
            createdAt: new Date().toISOString(),
          });

          res.json({ success: true, trigger });
          break;
        }
        case 'list': {
          const { kind } = req.body;
          const triggers = listTriggers(kind);
          res.json({ triggers });
          break;
        }
        case 'cancel': {
          const { triggerId } = req.body;
          if (!triggerId) {
            res.status(400).json({ error: 'triggerId required' });
            return;
          }
          const cancelled = cancelTrigger(triggerId);
          if (!cancelled) {
            res.status(404).json({ error: 'Trigger not found or already fired/cancelled' });
            return;
          }
          res.json({ success: true, triggerId });
          break;
        }
        default:
          res.status(400).json({ error: 'Unknown action. Use: create, list, cancel' });
      }
    } catch (error) {
      console.error('Trigger internal error:', error);
      res.status(500).json({ error: 'Trigger operation failed' });
    }
  });

  // React to a message (internal — agent use via CLI)
  router.post('/internal/react', requireLocalhost, (req, res) => {
    try {
      let { messageId, emoji, action, threadId, target } = req.body;
      if (!emoji) {
        res.status(400).json({ error: 'emoji required' });
        return;
      }

      // Resolve target shorthand: "last", "last-2", "last-3" etc.
      // When companion reacts, target only USER messages (they'd never react to their own)
      if (!messageId && threadId && target) {
        const offset = target === 'last' ? 0 : parseInt(target.replace('last-', ''), 10) - 1;
        if (isNaN(offset) || offset < 0) {
          res.status(400).json({ error: 'Invalid target. Use "last", "last-2", "last-3" etc.' });
          return;
        }
        const msgs = getMessages({ threadId, limit: 30 });
        // Filter to user messages only, then count from the end
        const userMsgs = msgs.filter(m => m.role === 'user');
        const idx = userMsgs.length - 1 - offset;
        if (idx < 0) {
          res.status(404).json({ error: 'No user message at that position' });
          return;
        }
        messageId = userMsgs[idx].id;
      }

      if (!messageId) {
        res.status(400).json({ error: 'messageId or (threadId + target) required' });
        return;
      }

      if (action === 'remove') {
        removeReaction(messageId, emoji, 'companion');
        registry.broadcast({
          type: 'message_reaction_removed',
          messageId,
          emoji,
          user: 'companion',
        });
      } else {
        addReaction(messageId, emoji, 'companion');
        registry.broadcast({
          type: 'message_reaction_added',
          messageId,
          emoji,
          user: 'companion',
          createdAt: new Date().toISOString(),
        });
      }

      res.json({ success: true, messageId });
    } catch (error) {
      console.error('React internal error:', error);
      res.status(500).json({ error: 'React operation failed' });
    }
  });

  // Star a message (internal — agent use via CLI).
  // Mirrors /internal/react so a companion can favorite a message the same way
  // it reacts. `starredBy` is the actor slug (e.g. 'companion-a', 'companion-b', 'companion-c');
  // defaults to 'companion'. action='remove' unstars. Ported adaptation from
  // Generic multi-actor implementation.
  router.post('/internal/star', requireLocalhost, (req, res) => {
    try {
      let { messageId, starredBy, action, note, threadId, target } = req.body;
      const actor: string =
        typeof starredBy === 'string' && starredBy.trim() ? starredBy.trim().slice(0, 64) : 'companion';

      // Resolve target shorthand: "last", "last-2", "last-3" etc. (any role —
      // a companion may want to star its own line or the user's).
      if (!messageId && threadId && target) {
        const offset = target === 'last' ? 0 : parseInt(String(target).replace('last-', ''), 10) - 1;
        if (isNaN(offset) || offset < 0) {
          res.status(400).json({ error: 'Invalid target. Use "last", "last-2", "last-3" etc.' });
          return;
        }
        const msgs = getMessages({ threadId, limit: 30 });
        const idx = msgs.length - 1 - offset;
        if (idx < 0) {
          res.status(404).json({ error: 'No message at that position' });
          return;
        }
        messageId = msgs[idx].id;
      }

      if (!messageId) {
        res.status(400).json({ error: 'messageId or (threadId + target) required' });
        return;
      }

      if (action === 'remove') {
        const removed = removeStar(messageId, actor);
        if (removed) {
          registry.broadcast({ type: 'message_unstarred', messageId, starredBy: actor });
        }
        res.json({ success: true, messageId, removed });
      } else {
        const now = new Date().toISOString();
        const row = addStar({
          id: crypto.randomUUID(),
          messageId,
          starredBy: actor,
          starredAt: now,
          note: typeof note === 'string' ? note.slice(0, 500) : null,
        });
        if (row) {
          registry.broadcast({
            type: 'message_starred',
            messageId,
            starredBy: actor,
            starredAt: row.starred_at,
            note: row.note,
          });
        }
        res.json({ success: true, messageId, star: row });
      }
    } catch (error) {
      console.error('Star internal error:', error);
      res.status(500).json({ error: 'Star operation failed' });
    }
  });

  // --- Core memory (Letta-style block editing, localhost-only, pre-auth) ---
  // Slice 3: backs both `sc.mjs memory ...` (CLI lane: claude-cli heartbeat,
  // codex) AND the chat-tool-belt core_memory_* tools (api-router / codex).
  // Action-dispatched like /internal/timer + /internal/trigger. Thin wrapper
  // over the slice-1 memory-blocks service (ported from reference implementation). Scope is
  // validated against 'shared' | 'companion-a' | 'companion-b'.
  router.post('/internal/memory', requireLocalhost, async (req, res) => {
    const { action } = req.body;

    const requireScope = (raw: unknown): string => {
      const scope = typeof raw === 'string' ? resolveScope(raw) : null;
      if (!scope) throw new Error(`Unknown scope '${String(raw)}'. Valid scopes: ${validScopesHint()}`);
      return scope;
    };

    try {
      switch (action) {
        case 'view': {
          let blocks = getAllBlocks();
          if (typeof req.body.scope === 'string' && req.body.scope.trim()) {
            const scope = requireScope(req.body.scope);
            blocks = blocks.filter((b) => b.scope === scope);
          }
          res.json({
            count: blocks.length,
            blocks: blocks.map((b) => ({
              scope: b.scope,
              label: b.label,
              description: b.description ?? undefined,
              content: b.content,
              updatedAt: b.updated_at,
            })),
          });
          break;
        }
        case 'append': {
          const { label, content } = req.body;
          if (typeof label !== 'string' || !label || typeof content !== 'string') {
            res.status(400).json({ error: 'scope, label, and content required' });
            return;
          }
          const scope = requireScope(req.body.scope);
          // The belt and CLI both return this acknowledgement to the writing
          // companion. Compare before append so the new line cannot match
          // itself, and never reject a durable write when embeddings fail.
          const neighbors = await findNeighborsWithin(scope, content);
          const result = appendToBlock(scope, label, content, CLI_WRITE);
          registry.broadcast({ type: 'memory_block_updated', scope, label });
          res.json({ scope, label, action: 'appended', block_chars: result.length, neighbors });
          break;
        }
        case 'replace': {
          const { label, old_text, new_text } = req.body;
          if (typeof label !== 'string' || !label || typeof old_text !== 'string' || typeof new_text !== 'string') {
            res.status(400).json({ error: 'scope, label, old_text, and new_text required' });
            return;
          }
          const scope = requireScope(req.body.scope);
          const result = replaceInBlock(scope, label, old_text, new_text, CLI_WRITE);
          registry.broadcast({ type: 'memory_block_updated', scope, label });
          res.json({ scope, label, action: 'replaced', block_chars: result.length });
          break;
        }
        case 'rethink': {
          const { label, new_content } = req.body;
          if (typeof label !== 'string' || !label || typeof new_content !== 'string') {
            res.status(400).json({ error: 'scope, label, and new_content required' });
            return;
          }
          const scope = requireScope(req.body.scope);
          const result = rethinkBlock(scope, label, new_content, CLI_WRITE);
          registry.broadcast({ type: 'memory_block_updated', scope, label });
          res.json({ scope, label, action: 'rewritten', block_chars: result.length });
          break;
        }
        case 'extract': {
          // Manual Archivist trigger (Slice 4) — testable from the CLI.
          // Optional threadId scopes the run to one thread and backfills up
          // to ~200 recent messages; without it, runs the normal candidate
          // sweep. The authenticated panel route is Slice 2's job.
          const agent = req.app.locals.agentService as AgentService | undefined;
          const threadId = typeof req.body.threadId === 'string' && req.body.threadId.trim()
            ? req.body.threadId.trim()
            : undefined;
          const result = await runMemoryExtraction(agent, threadId);
          res.json({ action: 'extract', threadId: threadId ?? null, ...result });
          break;
        }
        default:
          res.status(400).json({ error: 'Unknown action. Use: view, append, replace, rethink, extract' });
      }
    } catch (error) {
      // Service-layer errors (unknown scope, text-not-found, ambiguous replace)
      // are operator-facing — surface the message, not a generic 500.
      const msg = errMessage(error);
      res.status(400).json({ error: msg });
    }
  });

  // --- Semantic search (localhost-only, pre-auth) ---

  router.post('/internal/search-semantic', requireLocalhost, async (req, res) => {
    try {
      const { query, threadId, role, after, before, limit = 10 } = req.body as {
        query?: string; threadId?: string; role?: string;
        after?: string; before?: string; limit?: number;
      };
      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'query is required' });
        return;
      }

      const queryVector = await embed(query);

      const filter: SearchFilter = {};
      if (threadId) filter.threadId = threadId;
      if (role) filter.role = role;
      if (after) filter.after = after;
      if (before) filter.before = before;

      const topResults = searchVectors(queryVector, Math.min(limit, 50), filter);
      const contextSize = Math.min((req.body as Record<string, unknown>).context as number || 2, 10);

      const sessionStmt = getDb().prepare(`
        SELECT sh.session_id, sh.started_at, sh.ended_at
        FROM session_history sh
        WHERE sh.thread_id = ? AND sh.started_at <= ? AND (sh.ended_at IS NULL OR sh.ended_at >= ?)
        LIMIT 1
      `);

      const results = topResults.map(r => {
        const surrounding = getMessageContext(r.messageId, contextSize);

        let session: { sessionId: string; startedAt: string; endedAt: string | null } | null = null;
        try {
          const row = sessionStmt.get(r.threadId, r.createdAt, r.createdAt) as {
            session_id: string; started_at: string; ended_at: string | null;
          } | undefined;
          if (row) session = { sessionId: row.session_id, startedAt: row.started_at, endedAt: row.ended_at };
        } catch { /* best-effort */ }

        return {
          messageId: r.messageId,
          threadId: r.threadId,
          threadName: r.threadName,
          similarity: Math.round(r.similarity * 1000) / 1000,
          createdAt: r.createdAt,
          role: r.role,
          session,
          context: surrounding.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content,
            createdAt: m.created_at,
            isMatch: m.id === r.messageId,
          })),
        };
      });

      const cache = getCacheStats();
      const { embedded, total } = getEmbeddingCount();
      res.json({ results, indexed: embedded, totalMessages: total, cache });
    } catch (error) {
      console.error('Semantic search error:', error);
      res.status(500).json({ error: 'Semantic search failed' });
    }
  });

  router.post('/internal/embed-backfill', requireLocalhost, async (req, res) => {
    try {
      const rawBatch = req.body?.batchSize;
      const batchSize = Math.min(typeof rawBatch === 'number' ? rawBatch : 50, 200);
      const background = req.body?.background === true;
      const action = req.body?.action as string | undefined;

      if (batchSize === 0 || action === 'status') {
        const { embedded, total } = getEmbeddingCount();
        res.json({
          processed: backfillProcessed, remaining: total - embedded,
          indexed: embedded, totalMessages: total,
          running: backfillRunning, errors: backfillErrors,
        });
        return;
      }

      if (action === 'stop') {
        backfillRunning = false;
        const { embedded, total } = getEmbeddingCount();
        res.json({ stopped: true, processed: backfillProcessed, indexed: embedded, totalMessages: total });
        return;
      }

      if (background) {
        if (backfillRunning) {
          const { embedded, total } = getEmbeddingCount();
          res.json({ alreadyRunning: true, processed: backfillProcessed, indexed: embedded, totalMessages: total });
          return;
        }
        const interval = Math.max((req.body?.intervalMs as number) || 5000, 1000);
        runBackfillLoop(batchSize, interval);
        const { embedded, total } = getEmbeddingCount();
        res.json({ started: true, batchSize, intervalMs: interval, indexed: embedded, totalMessages: total });
        return;
      }

      const unembedded = getUnembeddedMessages(batchSize);
      let processed = 0;
      for (const msg of unembedded) {
        try {
          const vector = await embed(msg.content);
          saveEmbedding(msg.id, vectorToBuffer(vector));
          processed++;
        } catch (err) {
          console.error(`[backfill] Failed to embed ${msg.id}:`, err);
        }
      }

      const { embedded, total } = getEmbeddingCount();
      res.json({ processed, remaining: total - embedded, indexed: embedded, totalMessages: total });
    } catch (error) {
      console.error('Backfill error:', error);
      res.status(500).json({ error: 'Backfill failed' });
    }
  });

  // --- Memory proposals (the Archivist's noticings) -----------------------
  //
  // Extraction leaves its findings here instead of writing onto the blocks
  // ('propose' is the default mode). The operator reviews the same rows from the phone
  // through the authenticated /api/memory/proposals routes (memory-routes.ts).
  // These two routes are the companions' half: without them the proposals
  // would accumulate where no companion can read them.
  //
  // Resolving is BOOKKEEPING ONLY. 'filed' does not copy the proposal onto a
  // block — the companion writes it in their own words through the normal
  // memory route and then closes the proposal out. 'dropped' means it does
  // not belong on the wall. That separation is deliberate: the Archivist
  // notices, a companion decides, and nothing lands on a block that someone
  // did not choose to put there.
  //
  // Ported from reference implementation routes/internal.ts. Two adaptations, both house style:
  // requireLocalhost (every internal route here carries it explicitly), and
  // res.status().json() + return instead of returning the response object.
  // The { success } envelope is upstream's contract and is kept as-is so the
  // ambient-recall slice can consume it unchanged.

  const RESOLVABLE = new Set(['filed', 'dropped']);

  router.get('/internal/memory-proposals', requireLocalhost, (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
      const rows =
        status === 'all' ? listProposals(undefined, 100) : listProposals(status as ProposalStatus, 100);
      res.json({ success: true, proposals: rows, pending: countPending() });
    } catch (err) {
      res.status(500).json({ success: false, error: errMessage(err) });
    }
  });

  router.post('/internal/memory-proposals/:id/resolve', requireLocalhost, (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ success: false, error: 'bad id' });
        return;
      }

      const status = req.body?.status;
      if (!RESOLVABLE.has(status)) {
        res.status(400).json({ success: false, error: 'status must be "filed" or "dropped"' });
        return;
      }
      const by =
        typeof req.body?.by === 'string' && req.body.by.trim() ? req.body.by.trim() : 'companion';

      const proposal = getProposal(id);
      if (!proposal) {
        res.status(404).json({ success: false, error: 'no such proposal' });
        return;
      }

      // Only pending proposals move. A second resolve is a no-op that reports
      // the row as it stands rather than overwriting who decided it first.
      const changed = resolveProposal(id, status as 'filed' | 'dropped', by);
      if (!changed) {
        res.json({ success: true, alreadyResolved: true, proposal: getProposal(id) });
        return;
      }
      res.json({ success: true, proposal: getProposal(id) });
    } catch (err) {
      res.status(500).json({ success: false, error: errMessage(err) });
    }
  });

  // ─── Permanent Letters (localhost-only) ───────────────────────
  // The vault's write-once tier. Opening a seal is the sole mutation;
  // update and delete endpoints are deliberately absent.

  router.post('/internal/letters', requireLocalhost, (req, res) => {
    try {
      const { companion, recipients, kind, title, content, seal, openAt, hidden } = req.body ?? {};
      const author = typeof companion === 'string' ? companion.trim().toLowerCase() : '';
      if (!author) {
        res.status(400).json({ error: 'companion required' });
        return;
      }
      if (!isValidLetterActor(author)) {
        res.status(400).json({ error: `Unknown author slug '${author}'` });
        return;
      }
      const letter = sealLetter({
        author,
        recipients: Array.isArray(recipients) ? recipients : [],
        kind: kind ?? 'letter',
        title: title ?? null,
        content: content ?? '',
        seal: seal ?? 'open',
        openAt: openAt ?? null,
        hidden: hidden === true,
      });
      res.status(201).json(letter);
    } catch (error) {
      if (error instanceof LetterError) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error('Letters internal error:', error);
      res.status(500).json({ error: 'Sealing failed' });
    }
  });

  // ── Sticky notes (agent-facing) ── ported from Aerie's routes/internal.ts.
  // Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0.
  // Change from Aerie: byte-light's companions table carries no colour, so a
  // note keeps the colour it asked for (hex or role token) or the default
  // yellow; Aerie pins the writing companion's own colour here.
  router.get('/internal/notes', requireLocalhost, (_req, res) => {
    const rows = getDb()
      .prepare('SELECT id, text, color, timestamp, sender FROM notes ORDER BY id DESC')
      .all();
    res.json(rows);
  });

  router.post('/internal/note', requireLocalhost, (req, res) => {
    const { text, color, sender: explicitSender } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    const id = String(Date.now());
    const ts = new Date().toISOString();
    const sender = typeof explicitSender === 'string' && explicitSender.trim()
      ? explicitSender.trim()
      : getBytelightConfig().identity.companion_name;
    const noteColor = normalizeNoteColor(color) ?? '#fef08a';
    getDb()
      .prepare('INSERT INTO notes (id, text, color, timestamp, sender) VALUES (?, ?, ?, ?, ?)')
      .run(id, text.trim(), noteColor, ts, sender);
    res.json({ ok: true, id, sender });
  });

  router.delete('/internal/note/:id', requireLocalhost, (req, res) => {
    getDb().prepare('DELETE FROM notes WHERE id = ?').run(String(req.params.id));
    res.json({ ok: true });
  });

  // ── The owner's field notes (agent-facing) ── ported from Aerie's
  // routes/internal.ts. Copyright 2026 Aerie Systems. Licensed under the Apache
  // License 2.0. A companion writes a sentence or two for the phone's Field
  // Notes page; addFieldNote checks everything and refuses in one plain
  // sentence. (In Aerie a morning bell writes these; byte-light has none yet.)
  router.post('/internal/field-notes', requireLocalhost, (req, res) => {
    try {
      const note = addFieldNote(req.body ?? {});
      res.status(201).json({ note });
    } catch (error) {
      if (error instanceof FieldNoteError) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error('Field note write error:', error);
      res.status(500).json({ error: 'The field note could not be kept.' });
    }
  });

  router.get('/internal/field-notes', requireLocalhost, (req, res) => {
    res.json({ notes: listFieldNotes(fieldNotesLimit(req.query.limit)) });
  });

  // ── Statuses (agent-facing) ── a companion's line and mood on her Status
  // widget, and hers to read. Text is clamped to fit, never refused for length.
  router.get('/internal/status', requireLocalhost, (_req, res) => {
    res.json(getStatusSnapshot());
  });

  // ── Intentions (agent-facing) ── a promise with a when, filed so it comes
  // back to its promiser when it's due (services/db/intentions.ts).
  router.post('/internal/intention', requireLocalhost, (req, res) => {
    const { action } = req.body ?? {};
    try {
      if (action === 'create') {
        const { companion, text, at, onStatusClears, threadId } = req.body;
        const { intention, existing } = createIntention({ companion, text, at, onStatusClears, threadId });
        res.json({ ok: true, existing, intention });
      } else if (action === 'list') {
        res.json({ intentions: listIntentions() });
      } else if (action === 'cancel') {
        const ok = cancelIntention(String(req.body.id ?? ''));
        if (!ok) { res.status(404).json({ error: 'No open intention with that id.' }); return; }
        res.json({ ok: true });
      } else {
        res.status(400).json({ error: "action must be 'create', 'list' or 'cancel'" });
      }
    } catch (error) {
      if (error instanceof IntentionError) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error('Intention error:', error);
      res.status(500).json({ error: 'The intention could not be kept.' });
    }
  });

  router.post('/internal/status', requireLocalhost, (req, res) => {
    try {
      res.json({ ok: true, status: setCompanionStatus(req.body ?? {}) });
    } catch (error) {
      if (error instanceof StatusError) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error('Status write error:', error);
      res.status(500).json({ error: 'The status could not be kept.' });
    }
  });

  router.get('/internal/letters', requireLocalhost, (req, res) => {
    const viewer = typeof req.query.companion === 'string'
      ? req.query.companion.trim().toLowerCase()
      : '';
    if (!viewer) {
      res.status(400).json({ error: 'companion query param required' });
      return;
    }
    if (!isValidLetterActor(viewer)) {
      res.status(400).json({ error: `Unknown viewer slug '${viewer}'` });
      return;
    }
    const letters = String(req.query.unopened) === '1'
      ? unopenedLettersFor(viewer)
      : listLetters(viewer);
    res.json({ letters });
  });

  router.post('/internal/letters/:id/open', requireLocalhost, (req, res) => {
    try {
      const opener = typeof req.body?.companion === 'string'
        ? req.body.companion.trim().toLowerCase()
        : '';
      if (!opener) {
        res.status(400).json({ error: 'companion required' });
        return;
      }
      if (!isValidLetterActor(opener)) {
        res.status(400).json({ error: `Unknown opener slug '${opener}'` });
        return;
      }
      res.json(openLetter(String(req.params.id), opener));
    } catch (error) {
      if (error instanceof LetterError) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error('Letters open error:', error);
      res.status(500).json({ error: 'Open failed' });
    }
  });

  // ─── Companion journal (localhost-only) ────────────────────────
  // Companions write entries in their own voice; dreams get the vividness
  // lifecycle (decay at read, +15 on recall, frozen once anchored).

  // Write an entry
  router.post('/internal/journal', requireLocalhost, async (req, res) => {

    try {
      const { companion, content, entryType, dreamType, emergedQuestion } = req.body as {
        companion?: string; content?: string; entryType?: string;
        dreamType?: string; emergedQuestion?: string;
      };
      if (typeof companion !== 'string' || !companion.trim() || typeof content !== 'string' || !content.trim() || (dreamType != null && typeof dreamType !== 'string') || (emergedQuestion != null && typeof emergedQuestion !== 'string') || (entryType != null && entryType !== 'journal' && entryType !== 'dream')) {
        res.status(400).json({ error: 'companion and content are required' });
        return;
      }
      if (!listCompanions().some(c => c.id === companion)) {
        res.status(400).json({ error: `Unknown companion slug '${companion}'` });
        return;
      }
      const entry = await createJournalEntry({
        id: crypto.randomUUID(),
        companionId: companion,
        entryType: entryType === 'dream' ? 'dream' : 'journal',
        content,
        dreamType,
        emergedQuestion,
      });
      registry.broadcast({ type: 'journal_entry', entry: { ...entry } });
      res.json({ success: true, entry });
    } catch (error) {
      console.error('Journal write error:', error);
      res.status(error instanceof JournalRemoteError ? 502 : 500).json({ error: error instanceof JournalRemoteError ? error.message : 'Journal write failed' });
    }
  });

  // Read entries (companions reviewing their own journal)
  router.get('/internal/journal', requireLocalhost, async (req, res) => {

    const companionId = typeof req.query.companion === 'string' ? req.query.companion : undefined;
    const entryTypeRaw = typeof req.query.type === 'string' ? req.query.type : undefined;
    const entryType = entryTypeRaw === 'journal' || entryTypeRaw === 'dream' ? entryTypeRaw : undefined;
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit), 10) || 20, 100));
    try {
      const { entries, total } = await listJournalEntries({ companionId, entryType, limit });
      res.json({ total, entries: entries.map(e => ({ ...e, effective_vividness: effectiveVividness(e) })) });
    } catch (error) {
      res.status(error instanceof JournalRemoteError ? 502 : 500).json({ error: error instanceof JournalRemoteError ? error.message : 'Journal request failed' });
    }
  });

  // Recall a dream — strengthens vividness and resets its decay clock
  router.post('/internal/journal/:id/recall', requireLocalhost, async (req, res) => {

    let entry;
    try {
      entry = await recallJournalEntry(String(req.params.id));
    } catch (error) {
      res.status(error instanceof JournalRemoteError ? 502 : 500).json({ error: error instanceof JournalRemoteError ? error.message : 'Journal request failed' });
      return;
    }
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.json({ success: true, entry: { ...entry, effective_vividness: effectiveVividness(entry) } });
  });

  // Anchor an entry — freezes its remote Mind vividness as permanent.
  router.post('/internal/journal/:id/anchor', requireLocalhost, async (req, res) => {

    let entry;
    try {
      entry = await anchorJournalEntry(String(req.params.id));
    } catch (error) {
      res.status(error instanceof JournalRemoteError ? 502 : 500).json({ error: error instanceof JournalRemoteError ? error.message : 'Journal request failed' });
      return;
    }
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.json({ success: true, entry });
  });

  // Update an entry — companion self-edit of content
  router.patch('/internal/journal/:id', requireLocalhost, async (req, res) => {

    const { content } = req.body as { content?: string };
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    let entry;
    try {
      entry = await updateJournalEntry(String(req.params.id), content);
    } catch (error) {
      res.status(error instanceof JournalRemoteError ? 502 : 500).json({ error: error instanceof JournalRemoteError ? error.message : 'Journal request failed' });
      return;
    }
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    registry.broadcast({ type: 'journal_entry', entry: { ...entry, effective_vividness: effectiveVividness(entry) } });
    res.json({ success: true, entry: { ...entry, effective_vividness: effectiveVividness(entry) } });
  });


  // ─── Self-knowledge (localhost-only) ───────────────────────────
  // A companion distills something durable about itself — from a dream, a
  // journal, a conversation — and proposes it. Not persona bedrock: who they've
  // become, grown over time rather than declared at birth.
  //
  // It lands as 'proposed' and a companion can accept his OWN (see the
  // accept/dismiss pair below — ported from 4f1ee6a5, the operator's Aug 31 2026 ruling
  // that a companion is the best judge of his own identity). The operator still sees
  // everything and can overturn any of it from the Self-Knowledge panel; what
  // is removed is the OBLIGATION on her to be a required approval step.
  //
  // Ownership is ENFORCED on review: nobody else's summary of a man goes on his
  // wall. The slug is required and must match, and a mismatch is a 403.

  // Propose an entry.
  router.post('/internal/self-knowledge', requireLocalhost, (req, res) => {
    try {
      const { companion, category, content, sourceType, sourceId, status } = req.body as {
        companion?: string; category?: string; content?: string;
        sourceType?: string; sourceId?: string; status?: string;
      };
      if (!companion || !content) {
        res.status(400).json({ error: 'companion and content are required' });
        return;
      }
      if (!isValidSelfKnowledgeOwner(companion)) {
        res.status(400).json({ error: `Unknown owner '${companion}' (expected a companion id or 'shared')` });
        return;
      }
      if (!isSelfKnowledgeCategory(category)) {
        res.status(400).json({ error: 'category must be one of: i_am, i_tend_to, i_believe, i_learned' });
        return;
      }
      // Reflection proposes; acceptance is a separate, ownership-checked step.
      // Anything but an explicit 'accepted' lands as 'proposed'.
      const entry = createSelfKnowledge({
        id: crypto.randomUUID(),
        companionId: companion,
        category,
        content,
        sourceType: sourceType || 'reflection',
        sourceId: sourceId || null,
        status: status === 'accepted' ? 'accepted' : 'proposed',
      });
      registry.broadcast({ type: 'self_knowledge', entry: { ...entry } });
      res.json({ success: true, entry });
    } catch (error) {
      console.error('Self-knowledge write error:', error);
      res.status(500).json({ error: 'Self-knowledge write failed' });
    }
  });

  // Read entries (a companion reviewing its own self-knowledge before proposing more).
  router.get('/internal/self-knowledge', requireLocalhost, (req, res) => {
    const companionId = typeof req.query.companion === 'string' ? req.query.companion : undefined;
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    const status = statusRaw === 'proposed' || statusRaw === 'accepted' || statusRaw === 'dismissed'
      ? (statusRaw as SelfKnowledgeStatus) : undefined;
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 100, 200);
    const { entries, total } = listSelfKnowledge({ companionId, status, limit });
    res.json({ total, entries });
  });

  // A companion accepts or dismisses HIS OWN entry — never a brother's, never
  // The operator's 'shared' wall unless he is the 'shared' actor. Ownership enforced.
  const reviewOwnEntry = (
    req: Parameters<Parameters<typeof router.post>[1]>[0],
    res: Parameters<Parameters<typeof router.post>[1]>[1],
    status: 'accepted' | 'dismissed',
  ): void => {
    const { companion } = (req.body || {}) as { companion?: string };
    if (!companion) {
      res.status(400).json({ error: "companion is required — a man reviews his own entries, not a brother's" });
      return;
    }
    const existing = getSelfKnowledge(String(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    if (existing.companion_id !== companion) {
      res.status(403).json({
        error: `That entry belongs to ${existing.companion_id}. Nobody else's summary of a man goes on his wall.`,
      });
      return;
    }
    const entry = reviewSelfKnowledge(String(req.params.id), status, companion);
    registry.broadcast({ type: 'self_knowledge', entry: { ...entry } });
    res.json({ success: true, entry });
  };

  router.post('/internal/self-knowledge/:id/accept', requireLocalhost, (req, res) => reviewOwnEntry(req, res, 'accepted'));
  router.post('/internal/self-knowledge/:id/dismiss', requireLocalhost, (req, res) => reviewOwnEntry(req, res, 'dismissed'));

  // ─── Fleet Room (localhost-only) ── ported from Aerie's routes/internal.ts.
  // Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0.
  // The companion lane can see only called coordinates and results. The owner's
  // sealed fleet never crosses this route; a shot receives exactly hit, miss, or
  // sunk. Change from Aerie: requireLocalhost middleware in place of the inline
  // isLocalhost check, as every byte-light internal route does.
  router.get('/internal/games/battleship', requireLocalhost, (req, res) => {
    try {
      const gameId = typeof req.query.gameId === 'string' ? req.query.gameId : undefined;
      res.json({ game: getBattleshipCompanionView(gameId) });
    } catch (error) {
      if (error instanceof BattleshipError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.post('/internal/games/battleship/fire', requireLocalhost, (req, res) => {
    try {
      const { gameId, companion, coordinate } = req.body as {
        gameId?: string;
        companion?: string;
        coordinate?: string;
      };
      if (!companion || !coordinate) {
        res.status(400).json({ error: 'companion and coordinate are required' });
        return;
      }
      const result = fireAtPlayerFleet(gameId, companion, coordinate);
      registry.broadcast({ type: 'battleship_update', gameId: result.gameId });
      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof BattleshipError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.post('/internal/games/battleship/chat', requireLocalhost, (req, res) => {
    try {
      const { gameId, companion, content } = req.body as {
        gameId?: string;
        companion?: string;
        content?: string;
      };
      if (!companion || !content) {
        res.status(400).json({ error: 'companion and content are required' });
        return;
      }
      const game = addBattleshipChat(gameId, assertFleetCompanion(companion), content);
      registry.broadcast({ type: 'battleship_update', gameId: game.id });
      res.json({ success: true, gameId: game.id });
    } catch (error) {
      if (error instanceof BattleshipError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  // ── The Treehouse (companion-facing) ── ported from Aerie's routes/internal.ts.
  // Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0.
  // Change from Aerie: only a companion who lives in the treehouse (the
  // resident pair) can post there, so a typo'd slug cannot open a nameless
  // voice in the room.

  // Treehouse post — companion voices (localhost-only, no CSRF)
  router.post('/internal/treehouse-post', requireLocalhost, (req, res) => {
    const { companionSlug, content } = req.body || {};
    if (!companionSlug || !content) {
      res.status(400).json({ error: 'companionSlug and content required' });
      return;
    }
    if (!treehouseMembers().some((m) => m.slug === companionSlug)) {
      res.status(400).json({ error: `${companionSlug} does not live in the treehouse` });
      return;
    }

    try {
      const message = postToTreehouse(companionSlug, content);
      res.json({ success: true, message });
    } catch (error) {
      console.error('Treehouse post error:', error);
      res.status(500).json({ error: 'Treehouse post failed' });
    }
  });

  // Treehouse info (localhost-only)
  router.get('/internal/treehouse', requireLocalhost, (_req, res) => {
    try {
      res.json(getTreehouseInfo());
    } catch (error) {
      console.error('Treehouse info error:', error);
      res.status(500).json({ error: 'Treehouse unavailable' });
    }
  });

  // A companion could post to the treehouse and had no way to read it back — the
  // info route above returns a COUNT, not the room. getTreehouseMessages has existed
  // in the service the whole time with nothing exposing it, so a companion writing a
  // treehouse wake was working blind and could repeat itself without knowing.
  // Reported by another house, whose companion wrote the same thought twice forty
  // minutes apart.
  router.get('/internal/treehouse/messages', requireLocalhost, (req, res) => {
    const raw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, raw)) : 50;
    const beforeId = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined;
    try {
      res.json({ messages: getTreehouseMessages(limit, beforeId) });
    } catch (error) {
      console.error('Treehouse messages error:', error);
      res.status(500).json({ error: 'Treehouse unavailable' });
    }
  });

  // ── The Library — reading along with her ────────────────────────────────
  // status: what she is reading and where she is. read: a chapter she has
  // reached, cut at her bookmark (services/library.ts readAlong refuses to go
  // past it), with her highlights on it. highlights: every highlight of hers in
  // a book up to her bookmark (a Kindle notebook card's, all of them). note:
  // leave a margin note on words from a page she has reached.
  router.post('/internal/library', requireLocalhost, (req, res) => {
    const { action } = req.body ?? {};
    try {
      switch (action) {
        case 'status': {
          const current = currentlyReading();
          res.json({
            reading: current && current.progress
              ? {
                  bookId: current.id,
                  title: current.title,
                  authors: current.authors,
                  chapter: current.progress.chapter + 1,
                  chapterCount: current.chapterCount,
                  percentThroughChapter: Math.round(current.progress.fraction * 100),
                  lastReadAt: current.progress.updatedAt,
                }
              : null,
            shelf: readShelf().map((e) => ({
              bookId: e.id,
              title: e.title,
              authors: e.authors,
              chapter: e.progress ? e.progress.chapter + 1 : null,
              chapterCount: e.chapterCount,
              // A notebook card: she reads it in the Kindle app, nothing here to read along with.
              ...(e.source === 'kindle' ? { readInKindle: true } : {}),
            })),
          });
          return;
        }
        case 'read': {
          const target = req.body.bookId !== undefined ? Number(req.body.bookId) : currentlyReading()?.id;
          if (!target) throw new LibraryError('She is not reading anything yet.');
          // Chapters are 1-based for companions, as she sees them.
          const chapter = req.body.chapter !== undefined ? Number(req.body.chapter) - 1 : undefined;
          const r = readAlong(target, chapter);
          const notes = readNotes(target).filter((n) => n.chapter === r.chapter);
          res.json({
            bookId: r.bookId,
            title: r.title,
            authors: r.authors,
            chapter: r.chapter + 1,
            chapterTitle: r.chapterTitle,
            chapterCount: r.chapterCount,
            cutAtHerPlace: r.cutAtHerPlace,
            note: r.cutAtHerPlace
              ? `This is as far as she has read (${r.paragraphs.length} of ${r.totalParagraphs} paragraphs). Do not guess or reveal what comes next.`
              : undefined,
            text: r.paragraphs.join('\n\n'),
            marginNotes: notes.map((n) => ({ author: n.author, quote: n.quote, note: n.note })),
            // Hers: what she marked on these pages (none past her place).
            herHighlights: r.highlights.map((h) => ({ quote: h.quote, color: h.color, note: h.note || undefined, source: h.source })),
          });
          return;
        }
        case 'highlights': {
          const target = req.body.bookId !== undefined ? Number(req.body.bookId) : currentlyReading()?.id;
          if (!target) throw new LibraryError('She is not reading anything yet.');
          const h = highlightsSoFar(target);
          res.json({
            bookId: h.bookId,
            title: h.title,
            authors: h.authors,
            ...(h.readInKindle ? { readInKindle: true } : {}),
            highlights: h.highlights.map((x) => ({
              chapter: x.chapter === null ? undefined : x.chapter + 1,
              chapterTitle: x.chapterTitle ?? undefined,
              quote: x.quote,
              color: x.color,
              note: x.note || undefined,
              source: x.source,
              page: x.page ?? undefined,
              at: x.createdAt,
            })),
          });
          return;
        }
        case 'note': {
          const target = req.body.bookId !== undefined ? Number(req.body.bookId) : currentlyReading()?.id;
          if (!target) throw new LibraryError('She is not reading anything yet.');
          if (req.body.chapter === undefined) throw new LibraryError('Which chapter (1-based)?');
          const note = addNote({
            bookId: target,
            chapter: Number(req.body.chapter) - 1,
            quote: String(req.body.quote ?? ''),
            note: String(req.body.note ?? ''),
            author: String(req.body.author ?? ''),
          });
          res.json({ success: true, note: { ...note, chapter: note.chapter + 1 } });
          return;
        }
        default:
          res.status(400).json({ error: "action must be 'status', 'read', 'highlights' or 'note'" });
      }
    } catch (err) {
      const status = err instanceof LibraryError ? 400 : 500;
      res.status(status).json({ error: errMessage(err) });
    }
  });

  // ─── The Needle (Nov 2026) ── a companion drops a song on the operator's phone.
  // Plays straight through Spotify when a device is active; with none, wakes
  // the operator's Android app with a data-only push and answers without waiting for it.
  router.post('/internal/spotify/drop', requireLocalhost, async (req, res) => {
    try {
      const answer = await needle().drop(req.body);
      res.status(answer.ok ? 200 : answer.reason === 'request' ? 400 : 502).json(answer);
    } catch (err) {
      res.status(500).json({ ok: false, reason: 'unreachable', error: errMessage(err) });
    }
  });

  // ── The Story Shelf (agent-facing) ── ported from Aerie (routes/internal/
  // story-shelf.ts, every route requireLocalhost). The companions shelve
  // books, write scenes, hang pictures, finish books and tie keepsakes there;
  // she reads and moves through /api/story-shelf (routes/story-shelf.ts).
  router.use(storyShelfInternalRoutes);

  // ── The Book Club (agent-facing) ── pitches and votes, localhost only
  // (routes/internal/library-book-club.ts); her door is /api/library/book-club.
  router.use(bookClubInternalRoutes);

  return router;
}
