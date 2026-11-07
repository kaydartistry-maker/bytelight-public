// Bytelight protocol types — mirrors packages/shared/src/{types,protocol}.ts.
// Frames are kept in step with main's backend (packages/shared/src/protocol.ts).
// Copied (not imported) so the phone package stays build-independent of the
// shared workspace. Keep in sync with the backend contract.

export type Platform = 'web' | 'discord' | 'telegram' | 'api';
export type PresenceStatus = 'active' | 'dormant' | 'waking' | 'offline';

export interface Thread {
  id: string;
  name: string;
  type: 'daily' | 'named' | 'treehouse';
  created_at: string;
  archived_at: string | null;
  current_session_id: string | null;
  session_type: 'v1' | 'v2';
  needs_reground: boolean;
  last_activity_at: string | null;
  unread_count: number;
  pinned_at: string | null;
}

export interface ThreadSummary {
  id: string;
  name: string;
  type: 'daily' | 'named' | 'treehouse';
  unread_count: number;
  last_activity_at: string | null;
  last_message_preview: string | null;
  pinned_at: string | null;
}

export interface Reaction {
  emoji: string;
  user: string;
  created_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  sequence: number;
  role: 'companion' | 'user' | 'system';
  content: string;
  content_type: 'text' | 'image' | 'audio' | 'file' | 'sticker';
  platform: Platform;
  metadata: Record<string, unknown> | null;
  companion_id: string | null;
  reply_to_id: string | null;
  reply_to_preview: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  original_content: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

export interface Canvas {
  id: string;
  thread_id: string | null;
  title: string;
  content: string;
  content_type: 'markdown' | 'code' | 'text' | 'html';
  language: string | null;
  tags?: string[];
  created_by: 'companion' | 'user';
  created_at: string;
  updated_at: string;
}

export type ThoughtKind = 'authored' | 'provider' | 'system';

export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'tool'; toolId: string; toolName: string; input?: string; output?: string; isError?: boolean }
  | { type: 'thinking'; content: string; summary: string; kind?: ThoughtKind }
  | { type: 'sticker'; url: string; name: string }
  | { type: 'emoji'; url: string; name: string };

export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error?: string;
  toolCount: number;
  tools?: { name: string; description?: string }[];
  scope?: string;
}

export interface OrchestratorTaskStatus {
  wakeType: string;
  label: string;
  cronExpr: string;
  enabled: boolean;
  status: 'scheduled' | 'stopped' | 'running';
  nextRun: string | null;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe';
  /** Who the bell belongs to: comma-separated companion slugs, or null when shared. */
  companion?: string | null;
}

export interface SystemStatus {
  uptime: number;
  memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
  connections: number;
  userConnected: boolean;
  minutesSinceActivity: number;
  presence: PresenceStatus;
  agentProcessing: boolean;
  orchestratorTasks: OrchestratorTaskStatus[];
  mcpServers: McpServerInfo[];
  discord?: { connected: boolean; guilds: number; messagesProcessed: number; errors: number; deferredPending: number; username: string | null };
  telegram?: { connected: boolean; messagesProcessed: number; errors: number; restarts: number };
  queryQueue?: { processing: boolean; depth: number };
}

export interface CommandRegistryEntry {
  name: string;
  description: string;
  category: 'builtin' | 'skill' | 'custom';
  args?: string;
  clientOnly?: boolean;
}

// --- Client -> Server ---

export type ClientMessage =
  | { type: 'message'; threadId: string; content: string; contentType: 'text' | 'image' | 'audio' | 'file' | 'sticker'; replyToId?: string; metadata?: Record<string, unknown> }
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
  | { type: 'stream_start'; messageId: string; threadId: string }
  | { type: 'stream_token'; messageId: string; token: string }
  | { type: 'stream_end'; messageId: string; final?: Message }
  | { type: 'presence'; status: PresenceStatus }
  | { type: 'unread_update'; threadId: string; count: number }
  | { type: 'thread_created'; thread: Thread }
  | { type: 'thread_list'; threads: ThreadSummary[] }
  | { type: 'tool_use'; toolId: string; toolName: string; input?: string; isComplete: boolean; textOffset?: number }
  | { type: 'tool_result'; toolId: string; output?: string; isError?: boolean }
  | { type: 'voice_audio'; data: string }
  | { type: 'voice_transcript'; text: string }
  | { type: 'voice_mode_ack'; enabled: boolean }
  | { type: 'transcription_status'; status: 'processing' | 'complete' | 'error'; text?: string; error?: string; prosody?: Record<string, number>; prosodyStatus?: 'complete' | 'unavailable'; recordingId?: string }
  | { type: 'tts_start'; messageId: string }
  | { type: 'tts_audio'; messageId: string; data: string; final: boolean }
  | { type: 'tts_end'; messageId: string }
  | { type: 'sync_response'; messages: Message[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'connected'; sessionStatus: PresenceStatus; threads: ThreadSummary[]; activeThreadId: string | null; routingThreadId?: string | null; commands?: CommandRegistryEntry[] }
  | { type: 'pong' }
  | { type: 'system_status'; status: SystemStatus }
  | { type: 'thread_deleted'; threadId: string }
  | { type: 'thread_archived'; threadId: string }
  | { type: 'thread_updated'; thread: ThreadSummary }
  | { type: 'routing_thread_changed'; threadId: string }
  | { type: 'routing_thread_source_changed'; source: 'discord' | 'telegram' | 'wake'; threadId: string | null }
  | { type: 'context_usage'; percentage: number; tokensUsed: number; contextWindow: number; inputTokens?: number; outputTokens?: number; estimatedCost?: number; model?: string }
  | { type: 'compaction_notice'; preTokens: number; message: string; isComplete: boolean; trigger?: 'manual' | 'auto' }
  | { type: 'canvas_created'; canvas: Canvas }
  | { type: 'canvas_updated'; canvasId: string; content: string; updatedAt: string; title?: string; tags?: string[] }
  | { type: 'canvas_deleted'; canvasId: string }
  | { type: 'canvas_list'; canvases: Canvas[] }
  | { type: 'thinking'; content: string; summary: string; kind?: ThoughtKind }
  | { type: 'message_reaction_added'; messageId: string; emoji: string; user: string; createdAt: string }
  | { type: 'message_reaction_removed'; messageId: string; emoji: string; user: string }
  | { type: 'message_starred'; messageId: string; starredBy: string; starredAt: string; note: string | null }
  | { type: 'message_unstarred'; messageId: string; starredBy: string }
  | { type: 'generation_stopped' }
  | { type: 'limit_warning'; lane: string; label: string; percent: number; resetsAt: string | null }
  | { type: 'memory_block_updated'; scope: string; label: string }
  | { type: 'journal_entry'; entry: Record<string, unknown> }
  | { type: 'self_knowledge'; entry: Record<string, unknown> }
  | { type: 'battleship_update'; gameId: string }
  | { type: 'card_table_update'; tableId: string }
  | { type: 'rate_limit'; status: string; resetsAt?: number; rateLimitType?: string; utilization?: number }
  | { type: 'tool_progress'; toolId: string; toolName: string; elapsed: number }
  | { type: 'mcp_status_updated'; servers: McpServerInfo[] }
  | { type: 'rewind_result'; canRewind: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }
  | { type: 'command_result'; name: string; success: boolean; data?: Record<string, unknown>; error?: string; display?: 'toast' | 'panel' | 'silent' };
