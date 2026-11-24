/** Deliberately excludes SDK configuration, credentials and raw device state. */
export interface LabRow {
  key: string; kind: 'user' | 'assistant' | 'reasoning' | 'tool_call';
  uuid?: string; otid?: string; runId?: string; seqId?: number;
  text?: string; toolCallId?: string; toolName?: string;
  status?: string; result?: { content: string; isError: boolean; uuid?: string };
}
export type LabEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'transcript'; rows: LabRow[]; nextBefore?: string | null; hasMore?: boolean }
  | { type: 'status'; status: 'connecting' | 'thinking' | 'tool' | 'stopped' | 'complete' | 'recoverable' }
  | { type: 'approval_required'; approvalId: string; toolCallId: string; toolName: string; summary: string; expiresAt: number }
  | { type: 'approval_resolved'; approvalId: string }
  | { type: 'error'; message: string; ambiguous: boolean };
