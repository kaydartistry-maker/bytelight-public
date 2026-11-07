// Bytelight client store — a framework-agnostic singleton mirroring the Svelte
// websocket.svelte.ts store, exposed to React via useSyncExternalStore.
//
// Selectors passed to useBytelight() must return a stable reference when the
// slice is unchanged (select one slice per call; compose in hooks).

import { useSyncExternalStore } from 'react';
import type { Message, ThreadSummary, PresenceStatus, CommandRegistryEntry, SystemStatus, ThoughtKind } from './protocol';

export type ConnectionState = 'connected' | 'disconnecting' | 'disconnected' | 'reconnecting';

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

export type ThinkingEvent = { content: string; summary: string; textOffset: number; kind?: ThoughtKind };

export interface ContextUsage {
  percentage: number;
  tokensUsed: number;
  contextWindow: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  model?: string;
}

export interface AuthState {
  checking: boolean;
  authenticated: boolean;
  required: boolean;
  /** The last auth check couldn't reach the server; a re-check is scheduled. */
  unreachable: boolean;
}

export interface BytelightState {
  auth: AuthState;
  connectionState: ConnectionState;
  messages: Message[];
  threads: ThreadSummary[];
  activeThreadId: string | null;
  presence: PresenceStatus;
  unreadCounts: Record<string, number>;
  loadingThread: boolean;
  streamingMessageId: string | null;
  streamingTokens: string;
  toolEvents: Record<string, ToolEvent[]>;
  toolOffsets: Record<string, Array<{ toolId: string; textOffset: number }>>;
  thinkingEvents: Record<string, ThinkingEvent[]>;
  contextUsage: ContextUsage | null;
  compactionNotice: { preTokens: number; message: string; isComplete: boolean } | null;
  rateLimitInfo: { status: string; resetsAt?: number; rateLimitType?: string } | null;
  lastError: { code: string; message: string } | null;
  commandRegistry: CommandRegistryEntry[];
  systemStatus: SystemStatus | null;
  // Voice recording / transcription state — drives the mic button in
  // ChatInput. `prosody` is the Hume tone reading from the backend; held
  // here so the next outbound message can attach it as metadata for the
  // companion's context as bounded expression signals. Cleared once
  // consumed or when a new recording starts.
  transcription: {
    status: 'idle' | 'recording' | 'processing' | 'complete' | 'error';
    text?: string;
    prosody?: Record<string, number>;
    prosodyStatus?: 'complete' | 'unavailable';
    error?: string;
    recordingId?: string;
  };
  // True when viewing a search-jump window (loadThreadAround) rather than
  // the latest messages. The "jump to latest" button should reload the
  // thread to get back to the actual newest messages.
  isViewingAround: boolean;
  // Main's Home thread — where Discord/Telegram/wake land when no thread is
  // named. `routing_thread_changed` keeps it live across devices.
  routingThreadId: string | null;
  // Message ids starred by anyone, kept live by message_starred/unstarred.
  // Seeded lazily by whatever screen reads stars; the frames keep it honest.
  starredBy: Record<string, string[]>;
  // Version signals: a screen showing that data re-fetches when its number
  // moves (the same pattern main's Svelte store uses).
  memoryBlockVersion: number;
  selfKnowledgeVersion: number;
  journalVersion: number;
  // The latest usage-limit warning (main's limit_warning frame).
  limitWarning: { lane: string; label: string; percent: number; resetsAt: string | null; at: number } | null;
  // Main's /api/profiles (name / emoji / photo per identity) — null until read.
  profiles: Record<string, { name: string; emoji: string; image: string | null }> | null;
}

const initialState: BytelightState = {
  auth: { checking: true, authenticated: false, required: true, unreachable: false },
  connectionState: 'disconnected',
  messages: [],
  threads: [],
  activeThreadId: null,
  presence: 'offline',
  unreadCounts: {},
  loadingThread: false,
  streamingMessageId: null,
  streamingTokens: '',
  toolEvents: {},
  toolOffsets: {},
  thinkingEvents: {},
  contextUsage: null,
  compactionNotice: null,
  rateLimitInfo: null,
  lastError: null,
  commandRegistry: [],
  systemStatus: null,
  transcription: { status: 'idle' },
  isViewingAround: false,
  routingThreadId: null,
  starredBy: {},
  memoryBlockVersion: 0,
  selfKnowledgeVersion: 0,
  journalVersion: 0,
  limitWarning: null,
  profiles: null,
};

let state: BytelightState = initialState;
const listeners = new Set<() => void>();

export function getState(): BytelightState {
  return state;
}

export function setState(
  partial: Partial<BytelightState> | ((s: BytelightState) => Partial<BytelightState>),
): void {
  const next = typeof partial === 'function' ? partial(state) : partial;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBytelight<T>(selector: (s: BytelightState) => T): T {
  const snapshot = () => selector(state);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
