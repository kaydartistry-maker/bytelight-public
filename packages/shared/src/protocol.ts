// WebSocket message protocol — the contract between frontend and backend

import type { Message, Thread, Canvas, PresenceStatus, ThreadSummary, SystemStatus, ThoughtKind } from './types.js';

// --- Command system ---

export interface CommandRegistryEntry {
  name: string;
  description: string;
  category: 'builtin' | 'skill' | 'custom';
  args?: string;        // placeholder hint, e.g. "[name]"
  clientOnly?: boolean;  // true = handled in frontend, no server round-trip
}

// --- Client -> Server ---

export type ClientMessage =
  | { type: 'message'; threadId: string; content: string; contentType: 'text' | 'image' | 'audio' | 'file'; replyToId?: string; metadata?: Record<string, unknown>; clientId?: string }
  | { type: 'edit_message'; messageId: string; newContent: string }
  | { type: 'delete_message'; messageId: string }
  | { type: 'typing' }
  | { type: 'read'; threadId: string; beforeId: string }
  | { type: 'switch_thread'; threadId: string }
  | { type: 'create_thread'; name: string; threadType: 'named' }
  | { type: 'voice_start'; mimeType?: string; mode?: 'dictation' | 'conversation'; recordingId?: string; analyzeTone?: boolean }
  | { type: 'voice_audio'; data: string; recordingId?: string }
  | { type: 'voice_stop'; recordingId?: string }
  | { type: 'voice_cancel'; recordingId?: string }
  | { type: 'voice_interrupt' }
  | { type: 'voice_mode'; enabled: boolean }
  | { type: 'sync'; lastSeenSequence: number; threadId: string }
  | { type: 'ping' }
  | { type: 'request_status' }
  | { type: 'canvas_create'; title: string; contentType: 'markdown' | 'code' | 'text' | 'html'; language?: string; threadId?: string; tags?: string[] }
  | { type: 'canvas_update'; canvasId: string; content: string }
  | { type: 'canvas_update_title'; canvasId: string; title: string }
  | { type: 'canvas_update_tags'; canvasId: string; tags: string[] }
  | { type: 'canvas_delete'; canvasId: string }
  | { type: 'canvas_list' }
  | { type: 'add_reaction'; messageId: string; emoji: string }
  | { type: 'remove_reaction'; messageId: string; emoji: string }
  | { type: 'pin_thread'; threadId: string }
  | { type: 'unpin_thread'; threadId: string }
  | { type: 'visibility'; visible: boolean }
  | { type: 'stop_generation' }
  | { type: 'mcp_reconnect'; serverName: string }
  | { type: 'mcp_toggle'; serverName: string; enabled: boolean }
  | { type: 'rewind_files'; userMessageId: string; dryRun?: boolean }
  | { type: 'command'; name: string; args?: string; threadId?: string };

// --- Server -> Client ---

export type ServerMessage =
  | { type: 'message'; message: Message }
  | { type: 'message_ack'; clientId: string; messageId: string; threadId: string; status: 'accepted' | 'duplicate' }
  | { type: 'message_edited'; messageId: string; newContent: string; editedAt: string }
  | { type: 'message_deleted'; messageId: string }
  // companionId/turnId (Slice 4A): identify which companion's turn a stream
  // belongs to and which dispatch turn produced it, so multiple companions
  // streaming into one thread (Living Room) stay distinguishable. Optional —
  // absent on legacy events; local turns stamp the envelope (start/end).
  | { type: 'stream_start'; messageId: string; threadId: string; companionId?: string; turnId?: string }
  | { type: 'stream_token'; messageId: string; token: string; companionId?: string; turnId?: string }
  | { type: 'stream_end'; messageId: string; final?: Message; companionId?: string; turnId?: string }
  | { type: 'presence'; status: PresenceStatus }
  | { type: 'unread_update'; threadId: string; count: number }
  | { type: 'thread_created'; thread: Thread }
  | { type: 'thread_list'; threads: ThreadSummary[] }
  | { type: 'tool_use'; toolId: string; toolName: string; input?: string; isComplete: boolean; textOffset?: number; companionId?: string; turnId?: string }
  | { type: 'tool_result'; toolId: string; output?: string; isError?: boolean; companionId?: string; turnId?: string }
  | { type: 'voice_audio'; data: string }
  | { type: 'voice_transcript'; text: string }
  | { type: 'voice_mode_ack'; enabled: boolean }
  | { type: 'transcription_status'; status: 'processing' | 'complete' | 'error'; text?: string; error?: string; prosody?: Record<string, number>; prosodyStatus?: 'complete' | 'unavailable'; recordingId?: string }
  | { type: 'tts_start'; messageId: string }
  | { type: 'tts_audio'; messageId: string; data: string; final: boolean }
  | { type: 'tts_end'; messageId: string }
  | { type: 'sync_response'; messages: Message[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'connected'; sessionStatus: PresenceStatus; threads: ThreadSummary[]; activeThreadId: string | null; routingThreadId: string | null; commands?: CommandRegistryEntry[] }
  | { type: 'pong' }
  | { type: 'system_status'; status: SystemStatus }
  | { type: 'thread_deleted'; threadId: string }
  | { type: 'thread_updated'; thread: ThreadSummary }
  | { type: 'routing_thread_changed'; threadId: string }
  | { type: 'routing_thread_source_changed'; source: 'discord' | 'telegram' | 'wake'; threadId: string | null }
  | { type: 'context_usage'; percentage: number; tokensUsed: number; contextWindow: number }
  | { type: 'compaction_notice'; preTokens: number; message: string; isComplete: boolean }
  | { type: 'canvas_created'; canvas: Canvas }
  | { type: 'canvas_updated'; canvasId: string; content: string; updatedAt: string; title?: string; tags?: string[] }
  | { type: 'canvas_deleted'; canvasId: string }
  | { type: 'canvas_list'; canvases: Canvas[] }
  | { type: 'thinking'; content: string; summary: string; kind?: ThoughtKind; companionId?: string; turnId?: string }
  | { type: 'message_reaction_added'; messageId: string; emoji: string; user: string; createdAt: string }
  | { type: 'message_reaction_removed'; messageId: string; emoji: string; user: string }
  | { type: 'message_starred'; messageId: string; starredBy: string; starredAt: string; note: string | null }
  | { type: 'message_unstarred'; messageId: string; starredBy: string }
  | { type: 'generation_stopped' }
  | { type: 'rate_limit'; status: string; resetsAt?: number; rateLimitType?: string; utilization?: number }
  | { type: 'limit_warning'; lane: string; label: string; percent: number; resetsAt: string | null }
  | { type: 'tool_progress'; toolId: string; toolName: string; elapsed: number; companionId?: string; turnId?: string }
  | { type: 'mcp_status_updated'; servers: import('./types.js').McpServerInfo[] }
  | { type: 'rewind_result'; canRewind: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }
  | { type: 'command_result'; name: string; success: boolean; data?: Record<string, unknown>; error?: string; display?: 'toast' | 'panel' | 'silent' }
  | { type: 'memory_block_updated'; scope: string; label: string }
  | { type: 'journal_entry'; entry: Record<string, unknown> }
  | { type: 'self_knowledge'; entry: Record<string, unknown> }
  /** The word beside the dot under the faces, while a bell that has one is running (services/bell-status.ts, Aerie); null is Home. `companions` names whose cards show it, or is empty for every companion's. */
  | { type: 'status_word'; word: string | null; companions: string[] }
  // The Fleet Room's match or the Card Room's table changed (ported from
  // Aerie): the phone re-reads it.
  | { type: 'battleship_update'; gameId: string }
  | { type: 'card_table_update'; tableId: string };

// --- Message type guards ---

export function isClientMessage(data: unknown): data is ClientMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== 'string') return false;

  const validTypes = [
    'message', 'edit_message', 'delete_message', 'typing', 'read',
    'switch_thread', 'create_thread', 'voice_start', 'voice_audio',
    'voice_stop', 'voice_cancel', 'voice_interrupt', 'voice_mode', 'sync', 'ping', 'request_status',
    'canvas_create', 'canvas_update', 'canvas_update_title', 'canvas_update_tags', 'canvas_delete', 'canvas_list',
    'add_reaction', 'remove_reaction', 'pin_thread', 'unpin_thread', 'visibility',
    'stop_generation', 'mcp_reconnect', 'mcp_toggle', 'rewind_files', 'command',
  ];

  return validTypes.includes(msg.type);
}
