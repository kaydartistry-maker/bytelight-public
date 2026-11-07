import type { ServerMessage, Message, ThoughtKind } from '@bytelight/shared';
import { setSystemStatus } from '../settings.svelte';
import { handleStarBroadcast } from '../stars.svelte';
import { showToast } from '../toast.svelte';
import { acknowledgePending } from '../../message-outbox';
import { loadThread } from './api';
import { bumpSeen, persistPendingMessages, rt, showLocalNotification, store } from './store.svelte';

// Stale stream watchdog: clear streaming if no activity for 5 minutes (matches backend timeout)
const STALE_STREAM_TIMEOUT_MS = 5 * 60 * 1000;
// Hard cap for the grace path below — matches the backend's absolute agent
// timeout (agent.ts AGENT_TIMEOUT_MS, 20 min). A turn older than this is
// dead server-side no matter what; stop extending and clean up.
const STALE_STREAM_HARD_CAP_MS = 20 * 60 * 1000;

export function clearStaleStreamWatchdog(): void {
  if (rt.staleStreamTimeout) {
    clearTimeout(rt.staleStreamTimeout);
    rt.staleStreamTimeout = null;
  }
}

function resetStaleStreamWatchdog(): void {
  clearStaleStreamWatchdog();
  if (!store.streamingMessageId) return;
  rt.staleStreamTimeout = setTimeout(() => {
    if (store.streamingMessageId) {
      // Codex-lane quiet stretches: the foreign lane buffers its final text
      // to turn-end, so a working turn can go silent between tool phases
      // (long model reasoning, no open tools → no tool_progress ticks). If
      // this stream has shown real activity (tool or thinking events) and
      // is still inside the backend's absolute 20-min turn window, extend
      // instead of hard-killing — the backend's own 5-min safety timer
      // broadcasts generation_stopped/agent_timeout if the turn truly died,
      // and both of those clear this state through their own handlers. The
      // Claude lane streams tokens constantly, so it never reaches 5 min of
      // silence while healthy — no regression there.
      const hasActivity =
        (store.toolEvents[store.streamingMessageId]?.length ?? 0) > 0 ||
        (store.thinkingEvents[store.streamingMessageId]?.length ?? 0) > 0;
      if (hasActivity && Date.now() - rt.streamStartedAt < STALE_STREAM_HARD_CAP_MS) {
        console.warn('[ws:lifecycle] Stream quiet for 5min but has tool/thinking activity — extending watchdog');
        resetStaleStreamWatchdog();
        return;
      }
      console.warn('[ws:lifecycle] Stale stream detected — clearing stuck streaming state');
      // Clean up tool/thinking state for the stale stream
      if (store.toolOffsets[store.streamingMessageId]) {
        const { [store.streamingMessageId]: _, ...rest } = store.toolOffsets;
        store.toolOffsets = rest;
      }
      if (store.thinkingEvents[store.streamingMessageId]) {
        const { [store.streamingMessageId]: __, ...rest2 } = store.thinkingEvents;
        store.thinkingEvents = rest2;
      }
      store.streamingMessageId = null;
      store.streamingThreadId = null;
      store.streamingTokens = '';
      store.lastError = { code: 'stale_stream', message: 'Stream timed out. Please try again.' };
      setTimeout(() => { store.lastError = null; }, 10000);
    }
  }, STALE_STREAM_TIMEOUT_MS);
}

// Tool events per message
export type ToolEvent = {
  toolId: string;
  toolName: string;
  input?: string;
  output?: string;
  isError?: boolean;
  isComplete: boolean;
  timestamp: string;
  elapsed?: number;
};

// Thinking events per streaming message. `kind` is the Reverie
// thought-semantics classification (Slice 3) — absent on legacy events.
export type ThinkingEvent = { content: string; summary: string; textOffset: number; kind?: ThoughtKind };

export function handleMessage(event: MessageEvent) {
  try {
    const msg: ServerMessage = JSON.parse(event.data);

    switch (msg.type) {
      case 'pong':
        rt.handlePong();
        break;

      case 'connected':
        // Initial connection — receive thread list and presence
        store.threads = msg.threads;
        store.presence = msg.sessionStatus;
        // Only set activeThreadId on fresh connect — on reconnect, preserve whatever
        // thread the user was viewing (prevents mobile app-switch from silently
        // switching to today's daily thread while showing old messages)
        if (msg.activeThreadId && !store.activeThreadId) store.activeThreadId = msg.activeThreadId;
        store.routingThreadId = msg.routingThreadId ?? null;
        // Build unread counts from thread list
        for (const t of msg.threads) {
          store.unreadCounts[t.id] = t.unread_count;
        }
        // Command registry
        if (msg.commands) store.commandRegistry = msg.commands;
        // Reconnect ghost-stream cleanup: if the socket dropped mid-stream, the
        // stream_end broadcast was missed — clear stale streaming state silently
        // (no lastError toast; unlike the stale-stream watchdog path)
        if (store.streamingMessageId) {
          console.warn('[ws:lifecycle] Reconnected with stale streaming state — clearing ghost stream');
          if (store.toolOffsets[store.streamingMessageId]) {
            const { [store.streamingMessageId]: _, ...rest } = store.toolOffsets;
            store.toolOffsets = rest;
          }
          if (store.thinkingEvents[store.streamingMessageId]) {
            const { [store.streamingMessageId]: __, ...rest2 } = store.thinkingEvents;
            store.thinkingEvents = rest2;
          }
          store.streamingMessageId = null;
          store.streamingThreadId = null;
          store.streamingTokens = '';
          store.lastTokenAt = null;
          clearStaleStreamWatchdog();
        }
        break;

      case 'message':
        if (msg.message.thread_id === store.activeThreadId) {
          store.messages = [...store.messages, msg.message];
        }
        // Update last seen sequence
        bumpSeen(msg.message.thread_id, msg.message.sequence);
        // Update thread preview, then re-sort by last_activity_at DESC so the
        // touched thread climbs to the top of the non-pinned order immediately
        // (ThreadList re-extracts pinned by pinned_at and regroups the rest, so
        // this store order only feeds recency/grouping — safe to sort here).
        // Immutable sort (new array) so Svelte reactivity fires.
        store.threads = store.threads
          .map(t =>
            t.id === msg.message.thread_id
              ? { ...t, last_message_preview: msg.message.content.substring(0, 100), last_activity_at: msg.message.created_at }
              : t
          )
          .sort((a, b) => {
            const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0;
            const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0;
            return tb - ta;
          });
        // Local notification for companion messages (timers, system-injected)
        if (msg.message.role === 'companion') {
          const preview = msg.message.content.substring(0, 120).replace(/\n/g, ' ');
          showLocalNotification('Bytelight', preview);
        }
        break;

      case 'message_ack':
        store.pendingMessages = acknowledgePending(store.pendingMessages, msg.clientId);
        persistPendingMessages();
        break;

      case 'message_edited':
        store.messages = store.messages.map(m =>
          m.id === msg.messageId
            ? { ...m, content: msg.newContent, edited_at: msg.editedAt }
            : m
        );
        break;

      case 'message_deleted':
        store.messages = store.messages.map(m =>
          m.id === msg.messageId
            ? { ...m, deleted_at: new Date().toISOString() }
            : m
        );
        break;

      case 'stream_start':
        store.streamingMessageId = msg.messageId;
        store.streamingThreadId = msg.threadId;
        store.streamingTokens = '';
        store.lastTokenAt = Date.now();
        rt.streamStartedAt = Date.now();
        // Idempotency for reconnect replay (ws.ts replays stream_start +
        // tool/thinking events + cumulative token to newly connected
        // sockets): drop any state already held for this message so the
        // replayed events can't double-paint chips on a client that kept
        // state across a fast reconnect. First-time stream_start is a
        // no-op here — these keys don't exist yet.
        if (store.toolEvents[msg.messageId]) {
          const { [msg.messageId]: _te, ...teRest } = store.toolEvents;
          store.toolEvents = teRest;
        }
        if (store.toolOffsets[msg.messageId]) {
          const { [msg.messageId]: _to, ...toRest } = store.toolOffsets;
          store.toolOffsets = toRest;
        }
        if (store.thinkingEvents[msg.messageId]) {
          const { [msg.messageId]: _th, ...thRest } = store.thinkingEvents;
          store.thinkingEvents = thRest;
        }
        resetStaleStreamWatchdog();
        break;

      case 'stream_token':
        if (store.streamingMessageId === msg.messageId) {
          store.streamingTokens = msg.token; // Replace with cumulative text from backend
          store.lastTokenAt = Date.now();
          resetStaleStreamWatchdog(); // Activity received — reset watchdog
        }
        break;

      case 'stream_end':
        clearStaleStreamWatchdog();
        if (msg.final) {
          const final = msg.final;
          // Always update target thread's metadata (last_message_preview / last_activity_at).
          // This is THREAD METADATA, not user activity — it must update whether or not the
          // user is currently viewing this thread, so the sidebar reflects new content.
          store.threads = store.threads.map(t =>
            t.id === final.thread_id
              ? { ...t, last_message_preview: final.content.substring(0, 100), last_activity_at: final.created_at }
              : t
          );
          if (final.thread_id === store.activeThreadId) {
            // Active thread: append to visible message list and advance sync cursor.
            store.messages = [...store.messages, final];
            bumpSeen(final.thread_id, final.sequence);
          } else if (final.role === 'companion') {
            // Non-active thread + companion message: bump unread so the operator sees something
            // landed in another thread. Switching INTO that thread refetches from DB
            // (loadThread) and sends a `read` event that clears the badge via unread_update.
            const prev = store.unreadCounts[final.thread_id] ?? 0;
            store.unreadCounts = { ...store.unreadCounts, [final.thread_id]: prev + 1 };
            store.threads = store.threads.map(t =>
              t.id === final.thread_id ? { ...t, unread_count: (t.unread_count ?? 0) + 1 } : t
            );
          }
        }
        // Local notification for streamed companion messages (unchanged — fires regardless of thread)
        if (msg.final?.role === 'companion') {
          const preview = msg.final.content.substring(0, 120).replace(/\n/g, ' ');
          showLocalNotification('Bytelight', preview);
        }
        // Clean up streaming offsets and thinking events (unchanged)
        if (store.streamingMessageId) {
          if (store.toolOffsets[store.streamingMessageId]) {
            const { [store.streamingMessageId]: _, ...rest } = store.toolOffsets;
            store.toolOffsets = rest;
          }
          if (store.thinkingEvents[store.streamingMessageId]) {
            const { [store.streamingMessageId]: __, ...rest2 } = store.thinkingEvents;
            store.thinkingEvents = rest2;
          }
        }
        store.streamingMessageId = null;
        store.streamingThreadId = null;
        store.streamingTokens = '';
        store.lastTokenAt = null;
        break;

      case 'presence':
        store.presence = msg.status;
        break;

      case 'unread_update':
        store.unreadCounts = { ...store.unreadCounts, [msg.threadId]: msg.count };
        store.threads = store.threads.map(t =>
          t.id === msg.threadId ? { ...t, unread_count: msg.count } : t
        );
        // Update read_at on messages in the current thread
        if (msg.threadId === store.activeThreadId && msg.count === 0) {
          const now = new Date().toISOString();
          store.messages = store.messages.map(m =>
            m.role === 'companion' && !m.read_at ? { ...m, read_at: now } : m
          );
        }
        break;

      case 'thread_created':
        store.threads = [{
          id: msg.thread.id,
          name: msg.thread.name,
          type: msg.thread.type,
          unread_count: 0,
          last_activity_at: msg.thread.created_at,
          last_message_preview: null,
          pinned_at: null,
        }, ...store.threads];
        break;

      case 'thread_list':
        store.threads = msg.threads;
        break;

      case 'thread_deleted':
        store.threads = store.threads.filter(t => t.id !== msg.threadId);
        if (store.activeThreadId === msg.threadId) {
          store.activeThreadId = store.threads.length > 0 ? store.threads[0].id : null;
          if (store.activeThreadId) loadThread(store.activeThreadId);
          else store.messages = [];
        }
        break;

      case 'thread_updated':
        store.threads = store.threads.map(t =>
          t.id === msg.thread.id ? { ...t, name: msg.thread.name, pinned_at: msg.thread.pinned_at } : t
        );
        break;

      case 'routing_thread_changed':
        store.routingThreadId = msg.threadId;
        break;

      case 'message_reaction_added': {
        const idx = store.messages.findIndex(m => m.id === msg.messageId);
        if (idx !== -1) {
          const m = store.messages[idx];
          const meta = (m.metadata && typeof m.metadata === 'object') ? { ...m.metadata } : {};
          const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(meta.reactions) ? [...meta.reactions] : [];
          if (!reactions.some(r => r.emoji === msg.emoji && r.user === msg.user)) {
            reactions.push({ emoji: msg.emoji, user: msg.user, created_at: msg.createdAt });
            const updated = { ...m, metadata: { ...meta, reactions } };
            store.messages = [...store.messages.slice(0, idx), updated, ...store.messages.slice(idx + 1)];
          }
        }
        break;
      }

      case 'message_reaction_removed': {
        const idx = store.messages.findIndex(m => m.id === msg.messageId);
        if (idx !== -1) {
          const m = store.messages[idx];
          const meta = (m.metadata && typeof m.metadata === 'object') ? { ...m.metadata } : {};
          const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(meta.reactions) ? [...meta.reactions] : [];
          const filtered = reactions.filter(r => !(r.emoji === msg.emoji && r.user === msg.user));
          const updated = { ...m, metadata: { ...meta, reactions: filtered } };
          store.messages = [...store.messages.slice(0, idx), updated, ...store.messages.slice(idx + 1)];
        }
        break;
      }

      case 'message_starred':
      case 'message_unstarred':
        handleStarBroadcast({ type: msg.type, messageId: msg.messageId, starredBy: msg.starredBy });
        break;

      case 'context_usage':
        store.contextUsage = { percentage: msg.percentage, tokensUsed: msg.tokensUsed, contextWindow: msg.contextWindow };
        break;

      case 'compaction_notice':
        store.compactionNotice = { preTokens: msg.preTokens, message: msg.message, isComplete: msg.isComplete };
        if (rt.compactionTimeout) clearTimeout(rt.compactionTimeout);
        if (msg.isComplete) {
          // Compaction finished — reset context usage and auto-hide after 8s
          store.contextUsage = null;
          rt.compactionTimeout = setTimeout(() => { store.compactionNotice = null; }, 8000);
        }
        // When !isComplete (in-progress), no timeout — banner stays until completion
        break;

      case 'sync_response':
        if (msg.messages.length > 0) {
          // Merge missed messages, avoiding duplicates
          const existingIds = new Set(store.messages.map(m => m.id));
          const newMsgs = msg.messages.filter(m => !existingIds.has(m.id));
          if (newMsgs.length > 0) {
            store.messages = [...store.messages, ...newMsgs].sort((a, b) => a.sequence - b.sequence);
            const last = newMsgs[newMsgs.length - 1];
            bumpSeen(last.thread_id, last.sequence);
          }
        }
        break;

      case 'tool_use':
        resetStaleStreamWatchdog();
        if (store.streamingMessageId) {
          const events = store.toolEvents[store.streamingMessageId] || [];
          store.toolEvents = {
            ...store.toolEvents,
            [store.streamingMessageId]: [...events, {
              toolId: msg.toolId,
              toolName: msg.toolName,
              input: msg.input,
              isComplete: false,
              timestamp: new Date().toISOString(),
            }],
          };
          // Track text offset for interleaved rendering
          if (msg.textOffset !== undefined) {
            const offsets = store.toolOffsets[store.streamingMessageId] || [];
            store.toolOffsets = {
              ...store.toolOffsets,
              [store.streamingMessageId]: [...offsets, { toolId: msg.toolId, textOffset: msg.textOffset }],
            };
          }
        }
        break;

      case 'tool_result':
        resetStaleStreamWatchdog();
        if (store.streamingMessageId) {
          const currentEvents = store.toolEvents[store.streamingMessageId] || [];
          store.toolEvents = {
            ...store.toolEvents,
            [store.streamingMessageId]: currentEvents.map(e =>
              e.toolId === msg.toolId
                ? { ...e, output: msg.output, isError: msg.isError, isComplete: true }
                : e
            ),
          };
        }
        break;

      case 'thinking':
        resetStaleStreamWatchdog();
        if (store.streamingMessageId) {
          const existing = store.thinkingEvents[store.streamingMessageId] || [];
          store.thinkingEvents = {
            ...store.thinkingEvents,
            [store.streamingMessageId]: [...existing, {
              content: msg.content,
              summary: msg.summary,
              textOffset: store.streamingTokens.length,
              ...(msg.kind ? { kind: msg.kind } : {}),
            }],
          };
        }
        break;

      case 'voice_mode_ack':
        store.voiceModeEnabled = msg.enabled;
        break;

      case 'transcription_status':
        store.transcriptionStatus = msg.status;
        store.transcriptionRecordingId = msg.recordingId ?? null;
        if (msg.status === 'complete') {
          store.transcriptionText = msg.text ?? null;
          store.transcriptionProsody = msg.prosody ?? null;
          store.transcriptionProsodyStatus = msg.prosodyStatus ?? null;
          store.transcriptionError = null;
        } else if (msg.status === 'error') {
          store.transcriptionError = msg.error ?? 'Transcription failed';
          store.transcriptionText = null;
          store.transcriptionProsody = null;
          store.transcriptionProsodyStatus = null;
        } else {
          store.transcriptionText = null;
          store.transcriptionError = null;
          store.transcriptionProsody = null;
          store.transcriptionProsodyStatus = null;
        }
        break;

      case 'tts_start':
        store.ttsPlaying = true;
        store.ttsMessageId = msg.messageId;
        break;

      case 'tts_audio':
        store.ttsAudioQueue = [...store.ttsAudioQueue, { messageId: msg.messageId, data: msg.data, final: msg.final }];
        break;

      case 'tts_end':
        store.ttsMessageId = null;
        // ttsPlaying stays true until AudioAutoPlayer finishes playback
        break;

      case 'system_status':
        setSystemStatus(msg.status);
        break;

      case 'canvas_created':
        store.canvases = [msg.canvas, ...store.canvases];
        break;

      case 'canvas_updated': {
        store.canvases = store.canvases.map(c =>
          c.id === msg.canvasId
            ? {
                ...c,
                content: msg.content,
                updated_at: msg.updatedAt,
                ...(msg.title !== undefined && { title: msg.title }),
                ...(msg.tags !== undefined && { tags: msg.tags }),
              }
            : c
        );
        break;
      }

      case 'canvas_deleted':
        store.canvases = store.canvases.filter(c => c.id !== msg.canvasId);
        if (store.activeCanvasId === msg.canvasId) store.activeCanvasId = null;
        break;

      case 'canvas_list':
        store.canvases = msg.canvases;
        break;

      case 'memory_block_updated':
        // A memory block changed (companion tool edit, CLI, or the operator's panel).
        // Bump the version signal; the Memory panel re-fetches on the change.
        store.memoryBlockVersion++;
        break;

      case 'journal_entry':
        // Backend-first Journal port. Its dedicated screen is deferred;
        // entry reads remain available through the authenticated Journal API.
        break;

      case 'self_knowledge':
        // A self-knowledge entry was proposed or reviewed (companion via the
        // internal CLI lane, or the operator in her panel). Bump the version signal; the
        // Self-Knowledge panel re-fetches on the change.
        store.selfKnowledgeVersion++;
        break;

      case 'generation_stopped':
        clearStaleStreamWatchdog();
        store.streamingMessageId = null;
        store.streamingThreadId = null;
        store.streamingTokens = '';
        store.lastTokenAt = null;
        break;

      case 'rate_limit':
        store.rateLimitInfo = { status: msg.status, resetsAt: msg.resetsAt, rateLimitType: msg.rateLimitType };
        if (rt.rateLimitTimeout) clearTimeout(rt.rateLimitTimeout);
        // Warn, then get out of the way: a weekly-window reset can be DAYS
        // out, and holding the banner until then blocks the screen for the
        // whole wait. Two minutes is the ceiling; the Limits tab carries the
        // durable state.
        const clearMs = Math.min(
          msg.resetsAt ? Math.max(0, msg.resetsAt * 1000 - Date.now()) + 2000 : 30000,
          120_000,
        );
        rt.rateLimitTimeout = setTimeout(() => { store.rateLimitInfo = null; }, clearMs);
        break;

      case 'limit_warning': {
        const reset = msg.resetsAt ? new Date(msg.resetsAt) : null;
        const resetNote = reset && !Number.isNaN(reset.getTime())
          ? ` · resets ${reset.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
          : '';
        showToast(`${msg.label} at ${msg.percent}%${resetNote}`, 'info', 120_000);
        break;
      }

      case 'tool_progress':
        resetStaleStreamWatchdog();
        if (store.streamingMessageId) {
          const currentEvents = store.toolEvents[store.streamingMessageId] || [];
          store.toolEvents = {
            ...store.toolEvents,
            [store.streamingMessageId]: currentEvents.map(e =>
              e.toolId === msg.toolId ? { ...e, elapsed: msg.elapsed } : e
            ),
          };
        }
        break;

      case 'mcp_status_updated':
        // Update system status MCP servers if we have a cached status
        setSystemStatus(null, msg.servers);
        break;

      case 'rewind_result':
        store.rewindResult = { canRewind: msg.canRewind, filesChanged: msg.filesChanged, insertions: msg.insertions, deletions: msg.deletions, error: msg.error };
        break;

      case 'command_result':
        store.lastCommandResult = { name: msg.name, success: msg.success, data: msg.data, error: msg.error, display: msg.display };
        // Inject as a system message in chat
        if (msg.display !== 'silent' && store.activeThreadId) {
          const text = msg.error
            ? `/${msg.name}: ${msg.error}`
            : (msg.data as Record<string, unknown>)?.message as string || `/${msg.name}: done`;
          const sysMsg: Message = {
            id: `cmd-${Date.now()}`,
            thread_id: store.activeThreadId,
            sequence: store.messages.length > 0 ? store.messages[store.messages.length - 1].sequence + 1 : 1,
            role: 'system',
            content: text,
            content_type: 'text',
            platform: 'web',
            // Carry the full command_result envelope so structured cards
            // (e.g. /subagents) can render in MessageBubble; plain toasts
            // ignore it and fall back to the system-text render.
            metadata: {
              kind: 'command_result',
              commandName: msg.name,
              success: msg.success,
              data: msg.data ?? null,
            },
            companion_id: null,
            reply_to_id: null,
            reply_to_preview: null,
            original_content: null,
            created_at: new Date().toISOString(),
            edited_at: null,
            deleted_at: null,
            delivered_at: null,
            read_at: null,
            client_id: null,
          };
          store.messages = [...store.messages, sysMsg];
        }
        break;

      case 'error':
        console.error(`Server error [${msg.code}]: ${msg.message}`);
        store.lastError = { code: msg.code, message: msg.message };
        // Agent timeout means the stream is dead — clear stuck streaming state
        if (msg.code === 'agent_timeout' && store.streamingMessageId) {
          console.warn('[ws:lifecycle] Agent timeout — clearing streaming state');
          clearStaleStreamWatchdog();
          // Clean up tool/thinking state
          if (store.toolOffsets[store.streamingMessageId]) {
            const { [store.streamingMessageId]: _, ...rest } = store.toolOffsets;
            store.toolOffsets = rest;
          }
          if (store.thinkingEvents[store.streamingMessageId]) {
            const { [store.streamingMessageId]: __, ...rest2 } = store.thinkingEvents;
            store.thinkingEvents = rest2;
          }
          store.streamingMessageId = null;
          store.streamingThreadId = null;
          store.streamingTokens = '';
        }
        // Auto-clear error after 10 seconds
        setTimeout(() => { store.lastError = null; }, 10000);
        break;
    }
  } catch (err) {
    console.error('Failed to parse WebSocket message:', err);
  }
}
