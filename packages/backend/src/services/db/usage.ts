import { join } from 'path';
import type { UsageEvent, UsageBucket, UsageToolRow } from '@bytelight/shared';
import { getDb } from './init.js';

// Usage tracking operations
export function recordUsageEvent(params: {
  id: string;
  createdAt: string;
  threadId?: string | null;
  messageId?: string | null;
  platform?: string | null;
  mode: 'interactive' | 'autonomous';
  wakeType?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  toolCalls?: Array<{ name: string; count: number }>;
  costUsd?: number | null;
  contextWindow?: number | null;
  contextTokens?: number | null;
  durationMs?: number | null;
  /** Companion identifier for per-companion cost attribution. NULL when
   *  the calling context can't determine which companion ran the turn.
   *  See migrations/010_usage_events_companion_id.sql. */
  companionId?: string | null;
  /** ProviderId namespace this turn was billed against. NULL on pre-Step-3
   *  rows; populated from `modelRef.provider` going forward. */
  provider?: string | null;
  /** RuntimeId that produced the events for this turn. NULL on pre-Step-3
   *  rows; populated from `modelRef.runtime`. */
  runtime?: string | null;
  /** Canonical provider-qualified ModelRef string (`<provider>/<model>`).
   *  Distinct from `model` which keeps the raw provider-native id for
   *  back-compat with cost-attribution scripts. */
  modelRef?: string | null;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO usage_events (
      id, created_at, thread_id, message_id, platform, mode, wake_type,
      model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      tool_calls, cost_usd, duration_ms, context_window, context_tokens, companion_id,
      provider, runtime, model_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.id,
    params.createdAt,
    params.threadId ?? null,
    params.messageId ?? null,
    params.platform ?? null,
    params.mode,
    params.wakeType ?? null,
    params.model,
    params.inputTokens,
    params.outputTokens,
    params.cacheReadTokens ?? 0,
    params.cacheCreationTokens ?? 0,
    params.toolCalls ? JSON.stringify(params.toolCalls) : null,
    params.costUsd ?? null,
    params.durationMs ?? null,
    params.contextWindow ?? null,
    params.contextTokens ?? null,
    params.companionId ?? null,
    params.provider ?? null,
    params.runtime ?? null,
    params.modelRef ?? null
  );
}

export function listUsageEvents(params: {
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
  threadId?: string;
  platform?: string;
  mode?: 'interactive' | 'autonomous';
  model?: string;
}): UsageEvent[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (params.since) { clauses.push('u.created_at >= ?'); args.push(params.since); }
  if (params.until) { clauses.push('u.created_at <= ?'); args.push(params.until); }
  if (params.threadId) { clauses.push('u.thread_id = ?'); args.push(params.threadId); }
  if (params.platform) { clauses.push('u.platform = ?'); args.push(params.platform); }
  if (params.mode) { clauses.push('u.mode = ?'); args.push(params.mode); }
  if (params.model) { clauses.push('u.model = ?'); args.push(params.model); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;
  const stmt = getDb().prepare(`
    SELECT u.*, t.name AS thread_name
    FROM usage_events u
    LEFT JOIN threads t ON t.id = u.thread_id
    ${where}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(...args, limit, offset) as unknown as UsageEvent[];
}

export function getUsageEventByMessageId(messageId: string): UsageEvent | null {
  const stmt = getDb().prepare('SELECT * FROM usage_events WHERE message_id = ? LIMIT 1');
  const row = stmt.get(messageId);
  return row ? (row as unknown as UsageEvent) : null;
}

export function getUsageAggregate(params: {
  since?: string;
  until?: string;
  groupBy?: 'model' | 'platform' | 'mode' | 'wake_type' | 'thread_id' | 'day';
}): UsageBucket[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (params.since) { clauses.push('created_at >= ?'); args.push(params.since); }
  if (params.until) { clauses.push('created_at <= ?'); args.push(params.until); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  let groupExpr = "'all'";
  if (params.groupBy === 'model') groupExpr = 'model';
  else if (params.groupBy === 'platform') groupExpr = 'platform';
  else if (params.groupBy === 'mode') groupExpr = 'mode';
  else if (params.groupBy === 'wake_type') groupExpr = 'wake_type';
  else if (params.groupBy === 'thread_id') groupExpr = 'thread_id';
  else if (params.groupBy === 'day') groupExpr = "substr(created_at, 1, 10)";

  const stmt = getDb().prepare(`
    SELECT ${groupExpr} as bucket,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COUNT(*) as request_count
    FROM usage_events
    ${where}
    GROUP BY bucket
    ORDER BY bucket
  `);
  return stmt.all(...args) as UsageBucket[];
}

export function getToolCallAggregate(params: {
  since?: string;
  until?: string;
}): UsageToolRow[] {
  const clauses: string[] = ['tool_calls IS NOT NULL'];
  const args: unknown[] = [];
  if (params.since) { clauses.push('created_at >= ?'); args.push(params.since); }
  if (params.until) { clauses.push('created_at <= ?'); args.push(params.until); }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const stmt = getDb().prepare(`SELECT tool_calls FROM usage_events ${where}`);
  const rows = stmt.all(...args) as Array<{ tool_calls: string }>;

  const counts = new Map<string, { count: number; requests: number }>();
  for (const row of rows) {
    try {
      const tools = JSON.parse(row.tool_calls) as Array<{ name: string; count: number }>;
      for (const t of tools) {
        const existing = counts.get(t.name) || { count: 0, requests: 0 };
        existing.count += t.count;
        existing.requests += 1;
        counts.set(t.name, existing);
      }
    } catch {}
  }
  return Array.from(counts.entries())
    .map(([name, v]) => ({ name, count: v.count, request_count: v.requests }))
    .sort((a, b) => b.count - a.count);
}
