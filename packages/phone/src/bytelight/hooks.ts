// React hooks over the Bytelight store. Each useBytelight() call selects a
// single slice so useSyncExternalStore sees stable references.

import { useMemo } from 'react';
import { useBytelight } from './store';
import type { BytelightState, ToolEvent, ThinkingEvent } from './store';
import type { MessageSegment } from './protocol';

export const useConnectionState = () => useBytelight((s) => s.connectionState);
export const useAuth = () => useBytelight((s) => s.auth);
export const useMessages = () => useBytelight((s) => s.messages);
export const useThreads = () => useBytelight((s) => s.threads);
export const useActiveThreadId = () => useBytelight((s) => s.activeThreadId);
export const usePresence = () => useBytelight((s) => s.presence);
export const useUnreadCounts = () => useBytelight((s) => s.unreadCounts);
export const useLastError = () => useBytelight((s) => s.lastError);
export const useContextUsage = () => useBytelight((s) => s.contextUsage);
export const useCompactionNotice = () => useBytelight((s) => s.compactionNotice);
export const useRateLimitInfo = () => useBytelight((s) => s.rateLimitInfo);
export const useLoadingThread = () => useBytelight((s) => s.loadingThread);
export const useCommandRegistry = () => useBytelight((s) => s.commandRegistry);
export const useSystemStatus = () => useBytelight((s) => s.systemStatus);
export const useIsStreaming = () => useBytelight((s) => s.streamingMessageId !== null);

export function useStreaming(): { messageId: string | null; tokens: string } {
  const messageId = useBytelight((s) => s.streamingMessageId);
  const tokens = useBytelight((s) => s.streamingTokens);
  return { messageId, tokens };
}

// Total unread across all threads.
export function useTotalUnread(): number {
  const counts = useUnreadCounts();
  return useMemo(() => Object.values(counts).reduce((sum, n) => sum + n, 0), [counts]);
}

type StreamingSlices = Pick<
  BytelightState,
  'streamingMessageId' | 'streamingTokens' | 'toolOffsets' | 'thinkingEvents' | 'toolEvents'
>;

// Stale tool timeout disabled — was interfering with long-running CLI operations

// Port of websocket.svelte.ts getStreamingSegments() — merges tool + thinking
// insertions into the streaming text, ordered by text offset.
export function buildStreamingSegments(s: StreamingSlices): MessageSegment[] | null {
  const { streamingMessageId, streamingTokens } = s;
  if (!streamingMessageId) return null;
  const offsets = s.toolOffsets[streamingMessageId] || [];
  const thinking = s.thinkingEvents[streamingMessageId] || [];
  if (offsets.length === 0 && thinking.length === 0) return null;

  const events: ToolEvent[] = s.toolEvents[streamingMessageId] || [];
  const eventMap = new Map(events.map((e) => [e.toolId, e]));

  type Insertion = { textOffset: number } & (
    | { kind: 'tool'; toolId: string }
    | { kind: 'thinking'; content: string; summary: string; thoughtKind?: ThinkingEvent['kind'] }
  );

  const insertions: Insertion[] = [
    ...offsets.map((o) => ({ textOffset: o.textOffset, kind: 'tool' as const, toolId: o.toolId })),
    ...thinking.map((t: ThinkingEvent) => ({
      textOffset: t.textOffset,
      kind: 'thinking' as const,
      content: t.content,
      summary: t.summary,
      thoughtKind: t.kind,
    })),
  ].sort((a, b) => a.textOffset - b.textOffset);

  const text = streamingTokens;
  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const ins of insertions) {
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

export function useStreamingSegments(): MessageSegment[] | null {
  const streamingMessageId = useBytelight((s) => s.streamingMessageId);
  const streamingTokens = useBytelight((s) => s.streamingTokens);
  const toolOffsets = useBytelight((s) => s.toolOffsets);
  const thinkingEvents = useBytelight((s) => s.thinkingEvents);
  const toolEvents = useBytelight((s) => s.toolEvents);
  return useMemo(
    () => buildStreamingSegments({ streamingMessageId, streamingTokens, toolOffsets, thinkingEvents, toolEvents }),
    [streamingMessageId, streamingTokens, toolOffsets, thinkingEvents, toolEvents],
  );
}

// Main-backend live signals. A screen showing this data re-fetches when the
// number moves; components never read the frames directly.
export function useMemoryBlockVersion(): number {
  return useBytelight((s) => s.memoryBlockVersion);
}

export function useSelfKnowledgeVersion(): number {
  return useBytelight((s) => s.selfKnowledgeVersion);
}

export function useJournalVersion(): number {
  return useBytelight((s) => s.journalVersion);
}

export function useRoutingThreadId(): string | null {
  return useBytelight((s) => s.routingThreadId);
}

export function useLimitWarning(): BytelightState['limitWarning'] {
  return useBytelight((s) => s.limitWarning);
}

export function useProfiles(): BytelightState['profiles'] {
  return useBytelight((s) => s.profiles);
}

export function useStarredBy(): Record<string, string[]> {
  return useBytelight((s) => s.starredBy);
}
