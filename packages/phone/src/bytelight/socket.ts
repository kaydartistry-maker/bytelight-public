// Bytelight WebSocket client.
// Owns the single socket, heartbeat, reconnect, and the server-message handler.
// Reactive state lives in store.ts; connection internals are module-local here.

import type { ClientMessage, ServerMessage, Message, ThreadSummary } from './protocol';
import { messagePreviewText } from '@bytelight/shared';
import { getState, setState } from './store';
import { buildStreamingSegments } from './hooks';
import { apiFetch } from './api';
import { applyStarFrame } from './stars';
import { emitCanvasFrame } from './canvas-frames';

// --- Connection internals (non-reactive) ---
let ws: WebSocket | null = null;
let enabled = false; // true between connect() and disconnect() — gates auto-reconnect
let reconnectAttempt = 0;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
let compactionTimeout: ReturnType<typeof setTimeout> | null = null;
let rateLimitTimeout: ReturnType<typeof setTimeout> | null = null;
let visibilityHandler: (() => void) | null = null;
let onlineHandler: (() => void) | null = null;
// The thread a reply is being written in, for threadWriting (ported from Aerie).
let writingThreadId: string | null = null;
// A SOCKET CAN BE DEAD AND STILL REPORT OPEN. On a phone the radio drops, the
// tab is frozen, or a NAT times the connection out, and the browser does not
// find out until it next tries to write — which for a WebSocket may be never.
// readyState says OPEN, ws.send() succeeds, and the message is gone with no
// error and no queue entry. So OPEN is not proof of life; a recent pong is.
let lastPongAt = 0;
const PONG_STALE_MS = 45_000; // heartbeat is 30s, so this is one missed beat plus slack
// A SOCKET CAN ALSO HANG IN CONNECTING AND NEVER RESOLVE. When a phone radio
// flaps mid-handshake the browser may sit in CONNECTING indefinitely: onopen
// never fires, onclose never fires, so no retry is ever scheduled. Everything
// downstream then refuses to act — connect() early-returns on CONNECTING and so
// does the tap on the offline pill — and the ONLY way out is killing the app.
// That is exactly what she has been doing, and it was faster because it worked.
let connectTimeout: ReturnType<typeof setTimeout> | null = null;
let connectingSince = 0;
const CONNECT_TIMEOUT_MS = 8_000; // give a real handshake room, then stop waiting
const CONNECT_TAP_MS = 2_000;     // she is looking at it: replace a slow one on tap

// Rooms that are not the chat (the Story Shelf's table) show their own
// writing dots, so the start and end of a reply are said out loud for them.
// (Ported from Aerie with the Story Shelf.)
function threadWriting(threadId: string | null | undefined, writing: boolean): void {
  if (!threadId || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('bytelight:thread-stream', { detail: { threadId, writing } }));
}

/** True when the socket claims OPEN but has not answered a ping recently. */
function socketIsStale(): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  return lastPongAt > 0 && Date.now() - lastPongAt > PONG_STALE_MS;
}

// Stale tool timeout disabled — was interfering with long-running CLI operations

// Highest message sequence seen, tracked PER THREAD — sequences are
// per-thread counters on the backend, so a single global high-water mark
// poisons reconnect syncs: after viewing a long thread (seq ~5000), a
// short thread (seq ~700) would sync with lastSeenSequence=5000 and the
// server would filter out everything it missed. That was the "messages
// eaten when backgrounding" bug on the Codex thread.
const lastSeenByThread = new Map<string, number>();
function bumpSeen(threadId: string | null | undefined, sequence: number | undefined): void {
  if (!threadId || typeof sequence !== 'number') return;
  const prev = lastSeenByThread.get(threadId) || 0;
  if (sequence > prev) lastSeenByThread.set(threadId, sequence);
}
let pendingMessages: Array<{
  threadId: string;
  content: string;
  contentType: Extract<ClientMessage, { type: 'message' }>['contentType'];
  replyToId?: string;
  metadata?: Record<string, unknown>;
}> = [];

// A thread load is a snapshot taken over HTTP while the socket can still be
// receiving live replies. Keep a monotonically increasing request marker so
// an older fetch cannot replace the room after the user has moved elsewhere.
// The snapshot is also merged with messages newer than its own high-water
// mark: those are the replies which arrived over WebSocket while the fetch was
// in flight. Without that merge, a reconnect/refresh can visibly erase a
// reply that was successfully stored by the backend.
let threadLoadRequest = 0;

function mergeThreadSnapshot(snapshot: Message[], live: Message[], threadId: string): Message[] {
  const snapshotMaxSequence = snapshot.reduce((max, message) => Math.max(max, message.sequence), 0);
  const concurrentMessages = live.filter(
    (message) => message.thread_id === threadId && message.sequence > snapshotMaxSequence,
  );
  const byId = new Map<string, Message>();
  for (const message of snapshot) byId.set(message.id, message);
  for (const message of concurrentMessages) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

function getWebSocketUrl(): string {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Same-origin: in dev the Vite proxy forwards /ws to the backend, so the
  // page and socket share an origin (satisfies the backend Origin allowlist).
  return `${protocol}//${window.location.host}/ws`;
}

function getReconnectDelay(): number {
  const delays = [500, 1000, 2000, 4000, 8000, 15000, 30000];
  const delay = delays[Math.min(reconnectAttempt, delays.length - 1)];
  // Long backoff is for a tab nobody is looking at. While the app is in the
  // FOREGROUND the offline pill is on screen and she is waiting behind it, so
  // a fifteen or thirty second gap is the whole complaint — it is why closing
  // and reopening the app feels faster than waiting, and it is.
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    return Math.min(delay, 2000);
  }
  return delay;
}

function clearTimers(): void {
  if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
}


function startHeartbeat(): void {
  heartbeatInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
      heartbeatTimeout = setTimeout(() => {
        console.warn('Heartbeat timeout — no pong received');
        ws?.close();
      }, 5000);
    }
  }, 30000);
}

// Track when we last received streaming activity
let lastStreamActivity = 0;

// Clear stale streaming state when tab becomes visible — if we have a
// streamingMessageId but that message already exists in the list (complete),
// the stream_end event was missed while backgrounded. Clear the state.
// Also clear if we haven't received any streaming tokens in 30+ seconds —
// the stream likely finished while we were backgrounded and the end event
// was lost.
function clearStaleStreamingState(): void {
  const st = getState();
  const streamId = st.streamingMessageId;
  if (!streamId) return;

  const exists = st.messages.some((m) => m.id === streamId);
  // The CLI and Codex lanes don't stream tokens — a live turn can go minutes
  // with only tool chips. The server's presence status (refreshed by every
  // reconnect handshake) is authoritative: while it says a turn is running,
  // never wipe on the inactivity timer, only when the final message landed.
  const turnRunning = st.presence === 'active';
  const staleTimeout = 30000; // 30 seconds with no activity = stale
  const isStale = !turnRunning && lastStreamActivity > 0 && (Date.now() - lastStreamActivity) > staleTimeout;

  // `exists` means the streamed message has landed in the list — which is the
  // end of a turn only if the turn is actually over. A lane that comes up for
  // air mid-turn lands a real message and keeps working, so wiping here on
  // `exists` alone is what made a live build look finished.
  if ((exists && !turnRunning) || isStale) {
    setState({ streamingMessageId: null, streamingTokens: '' });
    lastStreamActivity = 0;
  }
}

function showLocalNotification(title: string, body: string): void {
  if (typeof document === 'undefined' || typeof Notification === 'undefined') return;
  if (!document.hidden) return;
  if (Notification.permission !== 'granted') return;
  new Notification(title, { body, tag: 'bytelight-local' });
}

function handleMessage(event: MessageEvent): void {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(event.data);
  } catch (err) {
    console.error('Failed to parse WebSocket message:', err);
    return;
  }

  const s = getState();

  switch (msg.type) {
    case 'pong':
      lastPongAt = Date.now();
      if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
      break;

    case 'connected': {
      const unread: Record<string, number> = {};
      for (const t of msg.threads) unread[t.id] = t.unread_count;
      setState({
        threads: msg.threads,
        presence: msg.sessionStatus,
        unreadCounts: unread,
        routingThreadId: msg.routingThreadId ?? null,
        ...(msg.commands ? { commandRegistry: msg.commands } : {}),
      });
      // Reconnect ghost-stream cleanup (as main's Svelte store does): a socket
      // that dropped mid-stream missed its stream_end, so the bubble would
      // spin forever. Clear it quietly; the sync that follows lands the reply.
      if (s.streamingMessageId) {
        const ghost = s.streamingMessageId;
        setState((st) => {
          const { [ghost]: _o, ...toolOffsets } = st.toolOffsets;
          const { [ghost]: _t, ...thinkingEvents } = st.thinkingEvents;
          return { streamingMessageId: null, streamingTokens: '', toolOffsets, thinkingEvents };
        });
      }
      // Only adopt a thread on a fresh connect — on reconnect keep whatever
      // the user was viewing.
      if (!s.activeThreadId) {
        const target = msg.activeThreadId || (msg.threads[0]?.id ?? null);
        if (target) void loadThread(target);
      }
      break;
    }

    case 'message': {
      if (msg.message.thread_id === getState().activeThreadId) {
        // Dedup by id — the backend sometimes broadcasts both a `message`
        // and a `stream_end` for the same finalized reply (see agent.ts
        // pulse path at lines 680-685), and any reconnect-sync could
        // replay messages we already have.
        setState((st) => {
          const exists = st.messages.some((m) => m.id === msg.message.id);
          return {
            messages: exists
              ? st.messages.map((m) => (m.id === msg.message.id ? msg.message : m))
              : [...st.messages, msg.message],
          };
        });
      }
      bumpSeen(msg.message.thread_id, msg.message.sequence);
      // Preview and notify with what the bubble will actually render. A turn
      // whose segments carry no text has nothing to show, so it updates the
      // timestamp and stays quiet rather than announcing a message the room
      // then can't display.
      const spokenPreview = messagePreviewText(msg.message.content, msg.message.metadata);
      setState((st) => ({
        threads: st.threads.map((t) =>
          t.id === msg.message.thread_id
            ? {
                ...t,
                last_message_preview: spokenPreview ? spokenPreview.substring(0, 100) : null,
                last_activity_at: msg.message.created_at,
              }
            : t,
        ),
      }));
      if (msg.message.role === 'companion' && spokenPreview) {
        showLocalNotification('Companion', spokenPreview.substring(0, 120).replace(/\n/g, ' '));
      }
      break;
    }

    case 'message_edited':
      setState((st) => ({
        messages: st.messages.map((m) =>
          m.id === msg.messageId ? { ...m, content: msg.newContent, edited_at: msg.editedAt } : m,
        ),
      }));
      break;

    case 'message_deleted':
      setState((st) => ({
        messages: st.messages.map((m) =>
          m.id === msg.messageId ? { ...m, deleted_at: new Date().toISOString() } : m,
        ),
      }));
      break;

    case 'stream_start':
      setState({ streamingMessageId: msg.messageId, streamingTokens: '' });
      lastStreamActivity = Date.now();
      writingThreadId = msg.threadId;
      threadWriting(msg.threadId, true);
      break;

    case 'stream_token':
      if (getState().streamingMessageId === msg.messageId) {
        setState({ streamingTokens: msg.token }); // cumulative — replace, do not append
        lastStreamActivity = Date.now();
      }
      break;

    case 'stream_end': {
      const streamId = getState().streamingMessageId;
      // Router lanes deliver the final reply only via stream_end (no
      // `message` broadcast) — advance the per-thread marker here too.
      if (msg.final) bumpSeen(msg.final.thread_id, msg.final.sequence);
      threadWriting(msg.final?.thread_id ?? writingThreadId, false);
      writingThreadId = null;
      setState((st) => {
        const next: Partial<typeof st> = { streamingMessageId: null, streamingTokens: '' };
        if (msg.final && msg.final.thread_id === st.activeThreadId) {
          let finalMsg = msg.final;
          // If the backend finalized the reply without persisting its
          // interleaved segments, keep the tool/thinking blocks we captured
          // live during the stream so the detail does not vanish when the
          // bubble settles. Model-agnostic — there is no per-model path.
          const meta = finalMsg.metadata as Record<string, unknown> | null;
          const serverSegs = meta && Array.isArray(meta.segments) ? meta.segments : null;
          if ((!serverSegs || serverSegs.length === 0) && streamId) {
            const captured = buildStreamingSegments({
              streamingMessageId: streamId,
              streamingTokens: st.streamingTokens,
              toolOffsets: st.toolOffsets,
              thinkingEvents: st.thinkingEvents,
              toolEvents: st.toolEvents,
            });
            if (captured && captured.some((s) => s.type === 'tool' || s.type === 'thinking')) {
              finalMsg = { ...finalMsg, metadata: { ...(meta || {}), segments: captured } };
            }
          }
          // Same dedup story as the `message` handler — replace in place
          // if we already have this id (e.g. a `message` broadcast already
          // landed it), otherwise append.
          const exists = st.messages.some((m) => m.id === finalMsg.id);
          next.messages = exists
            ? st.messages.map((m) => (m.id === finalMsg.id ? finalMsg : m))
            : [...st.messages, finalMsg];
        }
        if (streamId) {
          if (st.toolOffsets[streamId]) {
            const { [streamId]: _drop, ...rest } = st.toolOffsets;
            next.toolOffsets = rest;
          }
          if (st.thinkingEvents[streamId]) {
            const { [streamId]: _drop2, ...rest2 } = st.thinkingEvents;
            next.thinkingEvents = rest2;
          }
        }
        return next;
      });
      if (msg.final?.role === 'companion') {
        showLocalNotification('Companion', msg.final.content.substring(0, 120).replace(/\n/g, ' '));
      }
      break;
    }

    case 'presence':
      setState({ presence: msg.status });
      break;

    case 'unread_update':
      setState((st) => {
        const next: Partial<typeof st> = {
          unreadCounts: { ...st.unreadCounts, [msg.threadId]: msg.count },
          threads: st.threads.map((t) => (t.id === msg.threadId ? { ...t, unread_count: msg.count } : t)),
        };
        if (msg.threadId === st.activeThreadId && msg.count === 0) {
          const now = new Date().toISOString();
          next.messages = st.messages.map((m) =>
            m.role === 'companion' && !m.read_at ? { ...m, read_at: now } : m,
          );
        }
        return next;
      });
      break;

    case 'thread_created':
      setState((st) => ({
        threads: [
          {
            id: msg.thread.id,
            name: msg.thread.name,
            type: msg.thread.type,
            unread_count: 0,
            last_activity_at: msg.thread.created_at,
            last_message_preview: null,
            pinned_at: null,
          },
          ...st.threads,
        ],
      }));
      break;

    case 'thread_list':
      setState({ threads: msg.threads });
      break;

    case 'thread_deleted':
      setState((st) => {
        const threads = st.threads.filter((t) => t.id !== msg.threadId);
        if (st.activeThreadId === msg.threadId) {
          const nextId = threads.length > 0 ? threads[0].id : null;
          if (nextId) void loadThread(nextId);
          return { threads, activeThreadId: nextId, messages: nextId ? st.messages : [] };
        }
        return { threads };
      });
      break;

    // Archiving takes a thread out of her list just as thoroughly as deleting
    // it does, so it needs the same single owner for moving her off it.
    case 'thread_archived':
      dropArchivedThread(msg.threadId);
      break;

    case 'thread_updated':
      setState((st) => ({
        threads: st.threads.map((t) =>
          t.id === msg.thread.id ? { ...t, name: msg.thread.name, pinned_at: msg.thread.pinned_at } : t,
        ),
      }));
      break;

    case 'message_reaction_added':
      setState((st) => ({
        messages: st.messages.map((m) => {
          if (m.id !== msg.messageId) return m;
          const meta = m.metadata && typeof m.metadata === 'object' ? { ...m.metadata } : {};
          const reactions = Array.isArray((meta as { reactions?: unknown }).reactions)
            ? [...((meta as { reactions: Array<{ emoji: string; user: string; created_at: string }> }).reactions)]
            : [];
          if (reactions.some((r) => r.emoji === msg.emoji && r.user === msg.user)) return m;
          reactions.push({ emoji: msg.emoji, user: msg.user, created_at: msg.createdAt });
          return { ...m, metadata: { ...meta, reactions } };
        }),
      }));
      break;

    case 'message_reaction_removed':
      setState((st) => ({
        messages: st.messages.map((m) => {
          if (m.id !== msg.messageId) return m;
          const meta = m.metadata && typeof m.metadata === 'object' ? { ...m.metadata } : {};
          const reactions = Array.isArray((meta as { reactions?: unknown }).reactions)
            ? ((meta as { reactions: Array<{ emoji: string; user: string; created_at: string }> }).reactions)
            : [];
          return {
            ...m,
            metadata: { ...meta, reactions: reactions.filter((r) => !(r.emoji === msg.emoji && r.user === msg.user)) },
          };
        }),
      }));
      break;

    case 'context_usage':
      setState({
        contextUsage: {
          percentage: msg.percentage,
          tokensUsed: msg.tokensUsed,
          contextWindow: msg.contextWindow,
          inputTokens: msg.inputTokens,
          outputTokens: msg.outputTokens,
          estimatedCost: msg.estimatedCost,
          model: msg.model,
        },
      });
      break;

    case 'compaction_notice':
      setState({ compactionNotice: { preTokens: msg.preTokens, message: msg.message, isComplete: msg.isComplete } });
      if (compactionTimeout) clearTimeout(compactionTimeout);
      if (msg.isComplete) {
        setState({ contextUsage: null });
        compactionTimeout = setTimeout(() => setState({ compactionNotice: null }), 8000);
      } else {
        // Auto-clear in-progress warnings after 15s — user sees it, knows what's happening,
        // and it doesn't stick around forever if the session recycles before completing.
        compactionTimeout = setTimeout(() => setState({ compactionNotice: null }), 15000);
      }
      break;

    case 'sync_response':
      if (msg.messages.length > 0) {
        setState((st) => {
          const existing = new Set(st.messages.map((m) => m.id));
          const fresh = msg.messages.filter((m) => !existing.has(m.id));
          if (fresh.length === 0) return {};
          const last = fresh[fresh.length - 1];
          bumpSeen(last.thread_id, last.sequence);
          return { messages: [...st.messages, ...fresh].sort((a, b) => a.sequence - b.sequence) };
        });
        // After sync completes, clear stale streaming state
        clearStaleStreamingState();
      }
      break;

    case 'tool_use':
      lastStreamActivity = Date.now(); // tool chips are liveness on token-less lanes
      setState((st) => {
        const streamId = st.streamingMessageId;
        if (!streamId) return {};
        const events = st.toolEvents[streamId] || [];
        const next: Partial<typeof st> = {
          toolEvents: {
            ...st.toolEvents,
            [streamId]: [
              ...events,
              { toolId: msg.toolId, toolName: msg.toolName, input: msg.input, isComplete: false, timestamp: new Date().toISOString() },
            ],
          },
        };
        if (msg.textOffset !== undefined) {
          const offsets = st.toolOffsets[streamId] || [];
          next.toolOffsets = { ...st.toolOffsets, [streamId]: [...offsets, { toolId: msg.toolId, textOffset: msg.textOffset }] };
        }
        return next;
      });
      break;

    case 'tool_result':
      lastStreamActivity = Date.now();
      setState((st) => {
        const streamId = st.streamingMessageId;
        if (!streamId) return {};
        const events = st.toolEvents[streamId] || [];
        return {
          toolEvents: {
            ...st.toolEvents,
            [streamId]: events.map((e) =>
              e.toolId === msg.toolId ? { ...e, output: msg.output, isError: msg.isError, isComplete: true } : e,
            ),
          },
        };
      });
      break;

    case 'tool_progress':
      lastStreamActivity = Date.now();
      setState((st) => {
        const streamId = st.streamingMessageId;
        if (!streamId) return {};
        const events = st.toolEvents[streamId] || [];
        return {
          toolEvents: {
            ...st.toolEvents,
            [streamId]: events.map((e) => (e.toolId === msg.toolId ? { ...e, elapsed: msg.elapsed } : e)),
          },
        };
      });
      break;

    case 'thinking':
      lastStreamActivity = Date.now();
      setState((st) => {
        const streamId = st.streamingMessageId;
        if (!streamId) return {};
        const existing = st.thinkingEvents[streamId] || [];
        return {
          thinkingEvents: {
            ...st.thinkingEvents,
            [streamId]: [...existing, {
              content: msg.content,
              summary: msg.summary,
              textOffset: st.streamingTokens.length,
              ...(msg.kind ? { kind: msg.kind } : {}),
            }],
          },
        };
      });
      break;

    case 'generation_stopped':
      setState({ streamingMessageId: null, streamingTokens: '' });
      threadWriting(writingThreadId, false);
      writingThreadId = null;
      break;

    // ── Frames main's backend sends that the fork never had ──────────────

    case 'message_ack':
      // Durable receipt for a send that carried a clientId. This client sends
      // without one, so there is no pending outbox entry to clear.
      break;

    case 'routing_thread_changed':
      setState({ routingThreadId: msg.threadId });
      break;

    case 'routing_thread_source_changed':
      // Per-source overrides are read by the routing screen on open.
      break;

    case 'message_starred':
    case 'message_unstarred':
      applyStarFrame(msg.type, msg.messageId, msg.starredBy);
      break;

    case 'limit_warning':
      setState({
        limitWarning: { lane: msg.lane, label: msg.label, percent: msg.percent, resetsAt: msg.resetsAt, at: Date.now() },
      });
      break;

    case 'memory_block_updated':
      setState((st) => ({ memoryBlockVersion: st.memoryBlockVersion + 1 }));
      break;

    case 'self_knowledge':
      setState((st) => ({ selfKnowledgeVersion: st.selfKnowledgeVersion + 1 }));
      break;

    case 'journal_entry':
      setState((st) => ({ journalVersion: st.journalVersion + 1 }));
      break;

    // The Fleet Room's match moved (ported from Aerie); the open game re-reads it.
    case 'battleship_update':
      window.dispatchEvent(new CustomEvent('bytelight:battleship-update', {
        detail: { gameId: msg.gameId },
      }));
      break;

    // The Card Room's table moved (ported from Aerie). The open room, its rail
    // and the solitaire board listen for this and re-read the table.
    case 'card_table_update':
      window.dispatchEvent(new CustomEvent('bytelight:card-table-update', {
        detail: { tableId: msg.tableId },
      }));
      break;

    // The Story Shelf changed (ported from Aerie): a book shelved, a page written,
    // a page turn started or ended, or a keepsake tied. An open Story Shelf
    // re-reads the shelf, and the open book when it is the one named (or when
    // none is, which a keepsake does because it touches two books).
    case 'story_update':
      window.dispatchEvent(new CustomEvent('bytelight:story-update', {
        detail: { bookId: msg.bookId },
      }));
      break;

    case 'rate_limit': {
      setState({ rateLimitInfo: { status: msg.status, resetsAt: msg.resetsAt, rateLimitType: msg.rateLimitType } });
      if (rateLimitTimeout) clearTimeout(rateLimitTimeout);
      const clearMs = msg.resetsAt ? Math.max(0, msg.resetsAt * 1000 - Date.now()) + 2000 : 30000;
      rateLimitTimeout = setTimeout(() => setState({ rateLimitInfo: null }), clearMs);
      break;
    }

    case 'command_result':
      if (msg.display !== 'silent' && getState().activeThreadId) {
        const text = msg.error
          ? `/${msg.name}: ${msg.error}`
          : ((msg.data as Record<string, unknown>)?.message as string) || `/${msg.name}: done`;
        setState((st) => {
          const sysMsg: Message = {
            id: `cmd-${Date.now()}`,
            thread_id: st.activeThreadId as string,
            sequence: st.messages.length > 0 ? st.messages[st.messages.length - 1].sequence + 1 : 1,
            role: 'system',
            content: text,
            content_type: 'text',
            platform: 'web',
            companion_id: null,
            metadata: null,
            reply_to_id: null,
            reply_to_preview: null,
            original_content: null,
            created_at: new Date().toISOString(),
            delivered_at: null,
            edited_at: null,
            deleted_at: null,
            read_at: null,
          };
          return { messages: [...st.messages, sysMsg] };
        });
      }
      break;

    case 'error':
      console.error(`Server error [${msg.code}]: ${msg.message}`);
      setState({ lastError: { code: msg.code, message: msg.message } });
      setTimeout(() => {
        if (getState().lastError?.code === msg.code) setState({ lastError: null });
      }, 10000);
      break;

    case 'system_status':
      setState({ systemStatus: msg.status });
      break;

    case 'transcription_status':
      // Mic flow: client streams audio frames → backend transcribes via
      // Groq Whisper, optionally analyses tone via Hume → emits this.
      // ChatInput selects from state.transcription to drive the mic
      // button + drop the text into the composer when complete.
      setState({
        transcription: {
          status: msg.status,
          text: msg.text,
          prosody: msg.prosody,
          prosodyStatus: msg.prosodyStatus,
          error: msg.error,
          recordingId: msg.recordingId,
        },
      });
      break;

    // Canvas edits from anywhere (a companion's tool, another device, her own
    // saves echoing back). The Canvas app applies them; see lib/canvas-live.
    case 'canvas_created':
    case 'canvas_updated':
    case 'canvas_deleted':
    case 'canvas_list':
      emitCanvasFrame(msg);
      break;

    // Voice / TTS — handled in later phases.
    default:
      break;
  }
}

/**
 * Forget everything the app is showing that belonged to the PREVIOUS model.
 *
 * Both the rate-limit banner and the context readout describe a provider, and
 * nothing was ever telling the phone when she changed which provider answers
 * her. On Sep 5 2026 she switched to Claude with plenty of window left and the
 * banner stayed up, because it clears on a timer set for the moment the OLD
 * account's limit resets — hers was eight hours out. It looked stale; it was
 * doing exactly what it had been told by a fact that had stopped applying.
 *
 * A hard refresh cleared it because this state only lives in memory. This is
 * the same clear, without the refresh.
 */
export function clearProviderScopedState(): void {
  if (rateLimitTimeout) {
    clearTimeout(rateLimitTimeout);
    rateLimitTimeout = null;
  }
  setState({ rateLimitInfo: null, contextUsage: null });
}

export function connect(): void {
  enabled = true;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  clearTimers();
  try {
    ws = new WebSocket(getWebSocketUrl());
    connectingSince = Date.now();
    setState({ connectionState: reconnectAttempt > 0 ? 'reconnecting' : 'disconnected' });

    // A handshake that never resolves is silent. Close it ourselves so onclose
    // fires and the normal backoff schedules the next attempt.
    const opening = ws;
    connectTimeout = setTimeout(() => {
      if (opening.readyState === WebSocket.CONNECTING) {
        console.warn('WebSocket stuck in CONNECTING — abandoning this attempt');
        opening.close();
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      console.log('Bytelight WebSocket connected');
      if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
      setState({ connectionState: 'connected', lastError: null });
      reconnectAttempt = 0;
      lastPongAt = Date.now();
      startHeartbeat();

      send({ type: 'visibility', visible: !document.hidden });
      if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = () => {
        send({ type: 'visibility', visible: !document.hidden });
        // When tab becomes visible, clear stale streaming state if the message is already complete
        if (!document.hidden) {
          clearStaleStreamingState();
          // Coming back to the app is the moment a frozen or dead socket has to
          // prove itself, because it is also the moment she is about to type.
          // Waiting for the 30s heartbeat here is what eats a message.
          proveAliveOrReconnect();
        }
      };
      document.addEventListener('visibilitychange', visibilityHandler);

      if (onlineHandler) window.removeEventListener('online', onlineHandler);
      onlineHandler = () => { reconnectAttempt = 0; proveAliveOrReconnect(); };
      window.addEventListener('online', onlineHandler);

      const activeThreadId = getState().activeThreadId;
      const seenSeq = activeThreadId ? lastSeenByThread.get(activeThreadId) || 0 : 0;
      if (seenSeq > 0 && activeThreadId) {
        send({ type: 'sync', lastSeenSequence: seenSeq, threadId: activeThreadId });
      }

      if (pendingMessages.length > 0) {
        const queued = pendingMessages;
        pendingMessages = [];
        for (const m of queued) {
          send({
            type: 'message',
            threadId: m.threadId,
            content: m.content,
            contentType: m.contentType,
            replyToId: m.replyToId,
            metadata: m.metadata,
          });
        }
      }
    };

    ws.onmessage = handleMessage;

    ws.onclose = () => {
      setState({ connectionState: 'disconnected' });
      clearTimers();
      if (!enabled) return; // intentional disconnect — do not reconnect
      reconnectAttempt++;
      const delay = getReconnectDelay();
      console.log(`Bytelight WebSocket reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
      reconnectTimeout = setTimeout(() => {
        setState({ connectionState: 'reconnecting' });
        connect();
      }, delay);
    };

    ws.onerror = (err) => console.error('Bytelight WebSocket error:', err);
  } catch (err) {
    console.error('Failed to create WebSocket:', err);
    setState({ connectionState: 'disconnected' });
  }
}

export function disconnect(): void {
  enabled = false;
  clearTimers();
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler);
    onlineHandler = null;
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  if (ws) {
    setState({ connectionState: 'disconnecting' });
    // Detach handlers so the close does not trigger a reconnect (StrictMode-safe).
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onopen = null;
    try { ws.close(); } catch { /* noop */ }
    ws = null;
  }
  reconnectAttempt = 0;
  setState({ connectionState: 'disconnected' });
}

/** Ask the socket to prove it is alive, and replace it quickly if it cannot.
 *  Called when the app comes back to the foreground or the network returns —
 *  the two moments a phone's socket is most likely to be dead-but-OPEN. The
 *  deadline is short on purpose: this runs when she is looking at the screen. */
export function proveAliveOrReconnect(): void {
  if (!enabled) return;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
    reconnectAttempt = 0;
    connect();
    return;
  }
  if (ws.readyState === WebSocket.CONNECTING) {
    // On its way is only true for a couple of seconds. Past that, the tap is
    // her asking for a live socket now, and the answer cannot be to do nothing.
    if (Date.now() - connectingSince > CONNECT_TAP_MS) ws.close();
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;

  if (socketIsStale()) { ws.close(); return; } // onclose schedules the reconnect

  try {
    ws.send(JSON.stringify({ type: 'ping' }));
  } catch {
    ws.close();
    return;
  }
  const sentAt = Date.now();
  setTimeout(() => {
    if (lastPongAt < sentAt && ws?.readyState === WebSocket.OPEN) {
      console.warn('No pong on wake — replacing the socket');
      setState({ connectionState: 'reconnecting' });
      ws.close();
    }
  }, 3000);
}

export function send(msg: ClientMessage): void {
  // A stale socket still reports OPEN, so sending into it loses the message
  // silently. Queue it instead and go and get a live socket.
  if (msg.type === 'message' && socketIsStale()) {
    pendingMessages.push({
      threadId: msg.threadId,
      content: msg.content,
      contentType: msg.contentType,
      replyToId: msg.replyToId,
      metadata: msg.metadata,
    });
    console.warn('Message queued — socket has not answered a ping recently');
    setState({ connectionState: 'reconnecting' });
    ws?.close();
    return;
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if (msg.type === 'message') {
    pendingMessages.push({
      threadId: msg.threadId,
      content: msg.content,
      contentType: msg.contentType,
      replyToId: msg.replyToId,
      metadata: msg.metadata,
    });
    console.warn('Message queued — will send on reconnect');
  } else {
    console.warn('Cannot send: WebSocket not connected', msg.type);
  }
}

// --- REST helpers ---

export async function loadThread(threadId: string): Promise<void> {
  const requestId = ++threadLoadRequest;
  setState({ activeThreadId: threadId, loadingThread: true });
  try {
    const res = await apiFetch(`/api/threads/${threadId}/messages`);
    if (!res.ok) throw new Error('Failed to load messages');
    const data = await res.json();
    const messages: Message[] = data.messages || [];
    // A thread switch or a newer reload won while this request was in flight.
    // Never let this older response repaint a different room.
    if (requestId !== threadLoadRequest || getState().activeThreadId !== threadId) return;

    const mergedMessages = mergeThreadSnapshot(messages, getState().messages, threadId);
    setState({ messages: mergedMessages, loadingThread: false, isViewingAround: false });
    // After messages load, clear stale streaming state — catches the case
    // where visibility fired before reconnect completed
    clearStaleStreamingState();
    if (mergedMessages.length > 0) {
      const last = mergedMessages[mergedMessages.length - 1];
      bumpSeen(threadId, last.sequence);
      send({ type: 'read', threadId, beforeId: last.id });
    }
  } catch (err) {
    console.error('Failed to load thread:', err);
    if (requestId === threadLoadRequest && getState().activeThreadId === threadId) {
      setState({ messages: [], loadingThread: false });
    }
  }
}

// Load a window of messages centered on a specific message id. Used by
// search-result jumps so a hit on a message older than the loaded 50
// can be scrolled to without paging through every batch in between.
// Sets the same `messages` slice loadThread does so callers can scroll
// to the target right after this resolves.
export async function loadThreadAround(threadId: string, messageId: string, windowSize = 50): Promise<void> {
  const requestId = ++threadLoadRequest;
  setState({ activeThreadId: threadId, loadingThread: true });
  try {
    const res = await apiFetch(`/api/threads/${threadId}/messages?around=${encodeURIComponent(messageId)}&limit=${windowSize}`);
    if (!res.ok) throw new Error('Failed to load thread around message');
    const data = await res.json();
    const messages: Message[] = data.messages || [];
    if (requestId !== threadLoadRequest || getState().activeThreadId !== threadId) return;
    setState({ messages, loadingThread: false, isViewingAround: true });
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      bumpSeen(threadId, last.sequence);
    }
  } catch (err) {
    console.error('Failed to load thread around message:', err);
    if (requestId === threadLoadRequest && getState().activeThreadId === threadId) {
      setState({ messages: [], loadingThread: false });
    }
  }
}

// Loads an older page and prepends it. Returns true if more may remain.
export async function loadOlderMessages(threadId: string): Promise<boolean> {
  const current = getState().messages;
  if (current.length === 0) return false;
  const oldest = current[0];
  try {
    const res = await apiFetch(`/api/threads/${threadId}/messages?before=${oldest.id}&limit=50`);
    if (!res.ok) throw new Error('Failed to load older messages');
    const data = await res.json();
    const older: Message[] = data.messages || [];
    if (older.length === 0) return false;
    // The user may have changed rooms while this older-page request was
    // travelling. In that case it belongs to the old room, not the visible
    // one.
    if (getState().activeThreadId !== threadId) return false;
    setState((st) => {
      const existing = new Set(st.messages.map((message) => message.id));
      const freshOlder = older.filter((message) => !existing.has(message.id));
      return { messages: [...freshOlder, ...st.messages] };
    });
    return older.length >= 50;
  } catch (err) {
    console.error('Failed to load older messages:', err);
    return false;
  }
}

export async function loadThreads(): Promise<void> {
  try {
    const res = await apiFetch('/api/threads');
    if (!res.ok) throw new Error('Failed to load threads');
    const data = await res.json();
    // Main's REST list carries the preview as {content, role, created_at};
    // the socket's thread frames carry a string. The list renders a string.
    const threads: ThreadSummary[] = ((data.threads || []) as Array<Omit<ThreadSummary, 'last_message_preview'> & { last_message_preview: unknown }>).map((t) => {
      const p = t.last_message_preview;
      let preview: string | null = null;
      if (typeof p === 'string') preview = p;
      else if (p && typeof p === 'object' && typeof (p as { content?: unknown }).content === 'string') {
        preview = (p as { content: string }).content;
      }
      return { ...t, last_message_preview: preview };
    });
    setState({ threads });
  } catch (err) {
    console.error('Failed to load threads:', err);
  }
}

// --- Actions ---

export function switchThread(threadId: string): void {
  if (getState().activeThreadId === threadId) return;
  send({ type: 'switch_thread', threadId });
  void loadThread(threadId);
}

// Optimistic local Home after a successful POST /threads/:id/routing; the
// routing_thread_changed broadcast confirms it on every device.
export function setRoutingThreadId(threadId: string): void {
  setState({ routingThreadId: threadId });
}

// Remove an archived thread from the list, moving off it if it was open.
// Main archives over REST without broadcasting, so the archiving client calls
// this itself; the thread_archived frame (if a backend sends one) lands here too.
export function dropArchivedThread(threadId: string): void {
  setState((st) => {
    const threads = st.threads.filter((t) => t.id !== threadId);
    if (st.activeThreadId === threadId) {
      const nextId = threads.length > 0 ? threads[0].id : null;
      if (nextId) void loadThread(nextId);
      return { threads, activeThreadId: nextId, messages: nextId ? st.messages : [] };
    }
    return { threads };
  });
}

// Main's create_thread frame always seats the default roster; only the REST
// route honours a chosen roster. REST doesn't broadcast thread_created, so the
// list is refreshed here.
export function createThread(name: string, companionIds?: string[]): void {
  if (!companionIds || companionIds.length === 0) {
    send({ type: 'create_thread', name, threadType: 'named' });
    return;
  }
  void (async () => {
    try {
      const res = await apiFetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, companionIds }),
      });
      if (!res.ok) throw new Error(`Create thread failed: ${res.status} ${await res.text().catch(() => '')}`);
      await loadThreads();
    } catch (err) {
      console.error('Failed to create thread:', err);
      setState({ lastError: { code: 'create_thread', message: 'Could not create the thread.' } });
    }
  })();
}

export function pinThread(threadId: string): void {
  send({ type: 'pin_thread', threadId });
}

export function unpinThread(threadId: string): void {
  send({ type: 'unpin_thread', threadId });
}

export function sendUserMessage(
  content: string,
  contentType: 'text' | 'image' | 'audio' | 'file' | 'sticker' = 'text',
  metadata?: Record<string, unknown>,
  replyToId?: string,
): void {
  const threadId = getState().activeThreadId;
  if (!threadId) {
    console.warn('Cannot send message: no active thread');
    return;
  }
  send({ type: 'message', threadId, content, contentType, metadata, replyToId });
}

/**
 * Send to a thread captured by a foreground workflow such as voice mode.
 * Unlike sendUserMessage(), this cannot drift into a newly selected thread
 * between beginning an utterance and receiving its transcript.
 */
export function sendUserMessageToThread(
  threadId: string,
  content: string,
  contentType: 'text' | 'image' | 'audio' | 'file' | 'sticker' = 'text',
  metadata?: Record<string, unknown>,
  replyToId?: string,
): void {
  send({ type: 'message', threadId, content, contentType, metadata, replyToId });
}

// Delete a user message. Goes through REST so the backend can soft-delete
// in the DB and broadcast `message_deleted` to every connected client.
// (No WS frame for this — the old delete_message frame had no server
// handler and silently dropped the request.)
export async function deleteMessage(messageId: string): Promise<void> {
  const res = await apiFetch(`/api/messages/${messageId}`, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Delete failed: ${res.status} ${text}`);
  }
}

// Edit a user message. The WS edit_message frame has no `rerun` field, so we
// hit the REST endpoint. The backend broadcasts `message_edited` (and on
// rerun, a fresh `stream_start`) so no local apply is needed.
export async function editMessage(
  messageId: string,
  newContent: string,
  rerun = false,
): Promise<void> {
  const res = await apiFetch(`/api/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: newContent.trim(), rerun }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Edit failed: ${res.status} ${text}`);
  }
}

// The conversation moved between the "Reroll? Removes N" tap and the server
// check, so the confirmed count is no longer what would be deleted.
export class RerollChangedError extends Error {}

// Reroll a companion message — REST only, no WS frame exists. Main guards the
// soft-delete with a revision: preview first (count + revision of the exact
// tail), and the reroll only applies if that tail is still the same. The count
// The operator confirmed on the bubble must match what the server would remove.
export async function regenerateMessage(messageId: string, confirmedCount: number): Promise<void> {
  const previewRes = await apiFetch(`/api/messages/${messageId}/regenerate-preview`);
  if (!previewRes.ok) {
    const text = await previewRes.text().catch(() => '');
    throw new Error(`Regenerate preview failed: ${previewRes.status} ${text}`);
  }
  const preview = (await previewRes.json()) as { count: number; revision: string };
  if (preview.count !== confirmedCount) {
    throw new RerollChangedError(
      `Conversation changed — a reroll now removes ${preview.count}. Tap reroll again to confirm.`,
    );
  }
  const res = await apiFetch(`/api/messages/${messageId}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: preview.revision }),
  });
  if (res.status === 409) {
    throw new RerollChangedError('Conversation changed — check the new count and tap reroll again.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Regenerate failed: ${res.status} ${text}`);
  }
}

export function addReaction(messageId: string, emoji: string): void {
  send({ type: 'add_reaction', messageId, emoji });
}

export function removeReaction(messageId: string, emoji: string): void {
  send({ type: 'remove_reaction', messageId, emoji });
}

export function stopGeneration(): void {
  setState({ streamingMessageId: null, streamingTokens: '' });
  send({ type: 'stop_generation' });
}

// Dispatch a slash-command to the backend. Server replies with a
// `command_result` frame that the handler above renders as a system
// message (unless display='silent').
export function sendCommand(name: string, args?: string): void {
  const threadId = getState().activeThreadId ?? undefined;
  send({ type: 'command', name, args, threadId });
}

// MCP control — backend broadcasts mcp_status_updated on success, so no
// optimistic UI is needed.
export function mcpToggle(serverName: string, enabled: boolean): void {
  send({ type: 'mcp_toggle', serverName, enabled });
}

export function mcpReconnect(serverName: string): void {
  send({ type: 'mcp_reconnect', serverName });
}

export function markRead(threadId: string, beforeId: string): void {
  send({ type: 'read', threadId, beforeId });
}

export function requestStatus(): void {
  send({ type: 'request_status' });
}
