import type { Message, Canvas, ThreadSummary, PresenceStatus, MessageSegment, ThoughtKind, CommandRegistryEntry } from '@bytelight/shared';
import { readOutbox, writeOutbox, type PendingMessage } from '../../message-outbox';
import type { ThinkingEvent, ToolEvent } from './protocol';

// Session-scoped outbox persistence; read once to seed pendingMessages.
const outboxStorage = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;

interface WebSocketStore {
  wsInstance: WebSocket | null;
  connectionState: 'connected' | 'disconnecting' | 'disconnected' | 'reconnecting';
  reconnectAttempt: number;
  intentionalClose: boolean;
  closeReason: 'manual' | 'heartbeat_timeout' | 'socket_error' | 'network' | 'unknown';
  reconnectScheduled: boolean;
  lastPongTime: number;
  tabVisible: boolean;
  messages: Message[];
  threads: ThreadSummary[];
  activeThreadId: string | null;
  routingThreadId: string | null;
  presence: PresenceStatus;
  unreadCounts: Record<string, number>;
  streamingMessageId: string | null;
  streamingThreadId: string | null;
  streamingTokens: string;
  lastTokenAt: number | null;
  toolEvents: Record<string, ToolEvent[]>;
  toolOffsets: Record<string, Array<{ toolId: string; textOffset: number }>>;
  thinkingEvents: Record<string, ThinkingEvent[]>;
  voiceModeEnabled: boolean;
  transcriptionStatus: 'idle' | 'processing' | 'complete' | 'error';
  transcriptionText: string | null;
  transcriptionError: string | null;
  transcriptionProsody: Record<string, number> | null;
  transcriptionRecordingId: string | null;
  transcriptionProsodyStatus: 'complete' | 'unavailable' | null;
  ttsPlaying: boolean;
  ttsMessageId: string | null;
  ttsAudioQueue: Array<{ messageId: string; data: string; final: boolean }>;
  contextUsage: { percentage: number; tokensUsed: number; contextWindow: number } | null;
  compactionNotice: { preTokens: number; message: string; isComplete: boolean } | null;
  rateLimitInfo: { status: string; resetsAt?: number; rateLimitType?: string } | null;
  rewindResult: { canRewind: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string } | null;
  commandRegistry: CommandRegistryEntry[];
  lastCommandResult: { name: string; success: boolean; data?: Record<string, unknown>; error?: string; display?: string } | null;
  canvases: Canvas[];
  activeCanvasId: string | null;
  memoryBlockVersion: number;
  selfKnowledgeVersion: number;
  notificationPermission: NotificationPermission;
  lastError: { code: string; message: string } | null;
  pendingMessages: PendingMessage[];
  isViewingAround: boolean;
  pendingJumpMessageId: string | null;
}

export const store: WebSocketStore = $state({
  // Connection state
  wsInstance: null,
  connectionState: 'disconnected',
  reconnectAttempt: 0,
  intentionalClose: false,
  closeReason: 'unknown',
  // Reactive mirror of "a reconnect is genuinely armed" — read by the connection
  // banner so it only claims "Retrying…" when a retry is actually scheduled or in
  // flight, and shows a tap-to-reconnect affordance when truly idle-disconnected.
  reconnectScheduled: false,
  lastPongTime: Date.now(),
  tabVisible: typeof document !== 'undefined' ? !document.hidden : true,
  // Data state
  messages: [],
  threads: [],
  activeThreadId: null,
  // The routing ("Home") thread — where Discord/Telegram/wakes land
  routingThreadId: null,
  presence: 'offline',
  unreadCounts: {},
  // Streaming state
  streamingMessageId: null,
  streamingThreadId: null,
  streamingTokens: '',
  lastTokenAt: null,
  toolEvents: {},
  toolOffsets: {},
  thinkingEvents: {},
  // Voice state
  voiceModeEnabled: false,
  transcriptionStatus: 'idle',
  transcriptionText: null,
  transcriptionError: null,
  transcriptionProsody: null,
  // recordingId + prosodyStatus carry through from the backend's
  // transcription_status frame. The live-call recorder correlates a completed
  // transcription to the exact turn it started (protocol already stamps these;
  // the read path just needs to surface them).
  transcriptionRecordingId: null,
  transcriptionProsodyStatus: null,
  // TTS playback state
  ttsPlaying: false,
  ttsMessageId: null,
  ttsAudioQueue: [],
  // Context usage state
  contextUsage: null,
  compactionNotice: null,
  // Rate limit state
  rateLimitInfo: null,
  // Rewind state
  rewindResult: null,
  // Command state
  commandRegistry: [],
  lastCommandResult: null,
  // Canvas state
  canvases: [],
  activeCanvasId: null,
  // Memory-block live-update signal — bumped on every `memory_block_updated`
  // broadcast (a companion or the operator edited a block). The Memory panel reads this
  // via getMemoryBlockVersion() inside an $effect and re-fetches when it changes.
  memoryBlockVersion: 0,
  // Self-knowledge live-update signal — bumped on every `self_knowledge`
  // broadcast (a companion proposed/reviewed an entry, or the operator reviewed one). The
  // Self-Knowledge panel reads this via getSelfKnowledgeVersion() inside an
  // $effect and re-fetches when it changes.
  selfKnowledgeVersion: 0,
  // Notification state
  notificationPermission: typeof Notification !== 'undefined' ? Notification.permission : 'default',
  // Error state
  lastError: null,
  pendingMessages: readOutbox(outboxStorage),
  // Last seen sequence for sync
  // Search-jump state. When a search result jumps to a message older than the
  // last 50, we load a window CENTERED on that message (loadThreadAround) rather
  // than the tail. `isViewingAround` marks that the current `messages` slice is a
  // window view, so the chat page can avoid auto-scrolling to bottom and can let
  // pagination reconcile on the next normal load. `pendingJumpMessageId` guards
  // the auto-scroll effects so they don't yank the view to the bottom before the
  // jump lands on the target.
  isViewingAround: false,
  pendingJumpMessageId: null,
});

// Mutable handles (timers, in-flight promises, the swappable pong handler).
// Not reactive, so plain object fields rather than $state.
interface WebSocketRuntime {
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  openTimeout: ReturnType<typeof setTimeout> | null;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  heartbeatTimeout: ReturnType<typeof setTimeout> | null;
  staleStreamTimeout: ReturnType<typeof setTimeout> | null;
  visibilityHandler: (() => void) | null;
  reconnectInFlight: Promise<void> | null;
  streamStartedAt: number;
  compactionTimeout: ReturnType<typeof setTimeout> | null;
  rateLimitTimeout: ReturnType<typeof setTimeout> | null;
  commandResultTimeout: ReturnType<typeof setTimeout> | null;
  handlePong: () => void;
}

export const rt: WebSocketRuntime = {
  reconnectTimeout: null,
  openTimeout: null,
  heartbeatInterval: null,
  heartbeatTimeout: null,
  staleStreamTimeout: null,
  visibilityHandler: null,
  reconnectInFlight: null,
  // When the current stream started (set on stream_start). Used only by the
  // watchdog's hard-cap check.
  streamStartedAt: 0,
  compactionTimeout: null,
  rateLimitTimeout: null,
  commandResultTimeout: null,
  // Separated pong handler for probe interception
  handlePong: () => {
  store.lastPongTime = Date.now();
  if (rt.heartbeatTimeout) { clearTimeout(rt.heartbeatTimeout); rt.heartbeatTimeout = null; }
},
};

export function showLocalNotification(title: string, body: string): void {
  if (typeof document === 'undefined' || typeof Notification === 'undefined') return;
  if (!document.hidden) return; // Only when tab is not focused
  // Check real browser permission, not stale state (permission may have been
  // granted via push subscription flow without updating our state variable)
  const permission = Notification.permission;
  if (permission !== 'granted') return;

  new Notification(title, {
    body,
    icon: '/icons/icon-192.png',
    tag: 'bytelight-local',
  });
}

export function getNotificationPermission(): NotificationPermission {
  // Return live browser value when available, state as fallback (SSR)
  if (typeof Notification !== 'undefined') {
    return Notification.permission;
  }
  return store.notificationPermission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  const result = await Notification.requestPermission();
  store.notificationPermission = result;
  return result;
}

// Highest message sequence seen, tracked PER THREAD — sequences are
// per-thread counters on the backend, so a single global high-water mark
// poisons reconnect syncs: after viewing a long thread (seq ~5000), a
// short thread (seq ~700) would sync with lastSeenSequence=5000 and the
// server would filter out everything it missed. That was the "messages
// eaten when backgrounding" bug on the Codex thread.
// Ported from the sibling app's socket (lastSeenByThread/bumpSeen), whole;
// adapted only in being exported for the split store's other modules.
const lastSeenByThread = new Map<string, number>();
export function bumpSeen(threadId: string | null | undefined, sequence: number | undefined): void {
  if (!threadId || typeof sequence !== 'number') return;
  const prev = lastSeenByThread.get(threadId) || 0;
  if (sequence > prev) lastSeenByThread.set(threadId, sequence);
}
export function seenSequence(threadId: string): number {
  return lastSeenByThread.get(threadId) || 0;
}

export function persistPendingMessages(): void {
  writeOutbox(store.pendingMessages, outboxStorage);
}

export function isViewingAroundWindow(): boolean { return store.isViewingAround; }

// Pending-jump guard: while set, the chat page suppresses its auto-scroll-to-
// bottom effects so they don't override the scroll onto the search target.
export function setPendingJump(id: string | null): void { store.pendingJumpMessageId = id; }
export function getPendingJump(): string | null { return store.pendingJumpMessageId; }

// Getters for reactive state
export function getConnectionState() { return store.connectionState; }
export function getReconnectScheduled() { return store.reconnectScheduled; }
export function getMessages() { return store.messages; }
export function getThreads() { return store.threads; }
export function getActiveThreadId() { return store.activeThreadId; }
export function getRoutingThreadId() { return store.routingThreadId; }
export function getPresence() { return store.presence; }
export function getUnreadCounts() { return store.unreadCounts; }
export function getStreamingState() {
  return { messageId: store.streamingMessageId, threadId: store.streamingThreadId, tokens: store.streamingTokens };
}
export function getLastError() { return store.lastError; }
export function getPendingCount() { return store.pendingMessages.length; }
export function clearError() { store.lastError = null; }
export function getToolEvents() { return store.toolEvents; }
export function getLastTokenAt() { return store.lastTokenAt; }

// Compute interleaved segments for the currently streaming message
export function getStreamingSegments(): MessageSegment[] | null {
  if (!store.streamingMessageId) return null;
  const offsets = store.toolOffsets[store.streamingMessageId] || [];
  const thinking = store.thinkingEvents[store.streamingMessageId] || [];
  if (offsets.length === 0 && thinking.length === 0) return null;

  const events = store.toolEvents[store.streamingMessageId] || [];
  const eventMap = new Map(events.map(e => [e.toolId, e]));

  // Merge all insertions into one sorted list
  type Insertion = { textOffset: number } & (
    | { kind: 'tool'; toolId: string }
    | { kind: 'thinking'; content: string; summary: string; thoughtKind?: ThoughtKind }
  );

  const allInsertions: Insertion[] = [
    ...offsets.map(o => ({ textOffset: o.textOffset, kind: 'tool' as const, toolId: o.toolId })),
    ...thinking.map(t => ({ textOffset: t.textOffset, kind: 'thinking' as const, content: t.content, summary: t.summary, thoughtKind: t.kind })),
  ].sort((a, b) => a.textOffset - b.textOffset);

  const text = store.streamingTokens;
  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const ins of allInsertions) {
    const offset = Math.min(ins.textOffset, text.length);
    if (offset > cursor) {
      segments.push({ type: 'text', content: text.slice(cursor, offset) });
    }
    if (ins.kind === 'tool') {
      const ev = eventMap.get(ins.toolId);
      segments.push({
        type: 'tool',
        toolId: ins.toolId,
        toolName: ev?.toolName || 'unknown',
        input: ev?.input,
        output: ev?.output,
        isError: ev?.isError,
      });
    } else {
      // Kindless events build the exact legacy segment shape (no `kind`
      // key) so streaming render matches pre-Slice-3 persisted output.
      segments.push({
        type: 'thinking',
        content: ins.content,
        summary: ins.summary,
        ...(ins.thoughtKind ? { kind: ins.thoughtKind } : {}),
      });
    }
    cursor = offset;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', content: text.slice(cursor) });
  }

  return segments;
}

// Voice getters
export function getVoiceModeEnabled() { return store.voiceModeEnabled; }
export function getTranscriptionStatus() { return store.transcriptionStatus; }
export function getTranscriptionText() { return store.transcriptionText; }
export function getTranscriptionError() { return store.transcriptionError; }
export function getTranscriptionProsody() { return store.transcriptionProsody; }
export function getTranscriptionRecordingId() { return store.transcriptionRecordingId; }
export function getTranscriptionProsodyStatus() { return store.transcriptionProsodyStatus; }
export function clearTranscription() {
  store.transcriptionStatus = 'idle';
  store.transcriptionText = null;
  store.transcriptionError = null;
  store.transcriptionProsody = null;
  store.transcriptionRecordingId = null;
  store.transcriptionProsodyStatus = null;
}

// TTS getters
export function getTtsPlaying() { return store.ttsPlaying; }
export function getTtsAudioQueue() { return store.ttsAudioQueue; }
export function dequeueTtsAudio() {
  if (store.ttsAudioQueue.length === 0) return null;
  const [item, ...rest] = store.ttsAudioQueue;
  store.ttsAudioQueue = rest;
  return item;
}
export function setTtsPlaying(playing: boolean) { store.ttsPlaying = playing; }

// Context usage getters
export function getContextUsage() { return store.contextUsage; }
export function getCompactionNotice() { return store.compactionNotice; }

// Canvas getters & actions
export function getCanvases() { return store.canvases; }
export function getActiveCanvasId() { return store.activeCanvasId; }

// Memory-block live-update signal (see memoryBlockVersion above).
export function getMemoryBlockVersion() { return store.memoryBlockVersion; }
export function getSelfKnowledgeVersion() { return store.selfKnowledgeVersion; }
export function setActiveCanvasId(id: string | null) { store.activeCanvasId = id; }
export function isStreaming() { return store.streamingMessageId !== null; }

// Rate limit
export function getRateLimitInfo() { return store.rateLimitInfo; }
export function getRewindResult() { return store.rewindResult; }

// Command system
export function getCommandRegistry() { return store.commandRegistry; }
export function getLastCommandResult() { return store.lastCommandResult; }
export function clearCommandResult() { store.lastCommandResult = null; }
