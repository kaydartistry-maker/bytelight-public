/**
 * buildUsageEventRow — Slice 4b.1 extraction of the usage event row
 * assembly from agent.ts's `usage` event branch.
 *
 * The event consumer loop in agent.ts still owns WHEN a usage row is
 * recorded:
 *   - the `if (event.type === 'usage')` check,
 *   - the surrounding try/catch,
 *   - the `recordUsageEvent(...)` call itself,
 *   - the `console.warn(...)` on failure,
 *   - the `continue` that yields back to the for-await loop.
 *
 * This helper owns HOW the row is assembled:
 *   - tool call aggregation from the per-turn `toolInsertions` array,
 *   - provider-reported cost precedence with `estimateCost(...)` fallback,
 *   - the payload object passed to `recordUsageEvent`.
 *
 * Behavior is held verbatim against the inline source (agent.ts:1185-1248
 * at base 91021fa). Notable invariants:
 *   - `cacheReadTokens: event.cacheRead ?? 0` (default to 0 when absent)
 *   - `cacheCreationTokens: event.cacheWrite ?? 0` (note the cacheWrite ➜
 *     cacheCreationTokens naming — the SDK calls it `cacheWrite` on the
 *     stream, the DB column is `cache_creation_tokens`)
 *   - `toolCalls: list.length > 0 ? list : undefined` (empty turn ➜ omit
 *     the field entirely so the DB row gets NULL for `tool_calls`)
 *   - Tool aggregation preserves first-seen order: the inline code uses
 *     `Array.prototype.find` keyed on `toolName`, so new names are
 *     appended and repeats increment the existing entry's counter.
 *   - `contextWindow: contextWindowSize || null` and
 *     `contextTokens: contextTokensUsed || null` follow the `|| null`
 *     pattern — `0` becomes `null`, matching today's behavior so usage
 *     queries can distinguish "we didn't know" from "we knew it was 0".
 *   - `companionId: null` is fixed; per-companion attribution is a Phase 2
 *     wiring concern (migrations/008 column exists, dispatcher isn't yet
 *     plumbed). Leaving the field present makes backfill possible.
 *   - `provider` / `runtime` / `modelRef` are pulled from the resolved
 *     `ModelRef` so per-provider usage queries can filter without parsing
 *     the raw `model` column.
 *
 * Deps are injected (`randomId`, `nowIso`, `nowMs`, `estimateCost`) so
 * tests pin every output deterministically and the helper stays pure —
 * no `crypto` import, no `Date.now()`, no `new Date().toISOString()`
 * inside.
 *
 * Not in scope (Slice 4b.1):
 *   - the `recordUsageEvent(...)` call (stays at the agent.ts call site),
 *   - any try/catch / console.warn / continue control flow,
 *   - any non-usage branch (compaction, context_usage, etc.),
 *   - DB schema / query / row write,
 *   - websocket / broadcast behavior.
 */

import type { ModelRef } from '@bytelight/shared';
import type { ToolInsertion } from '../hooks.js';
import type { AgentRuntimeEvent } from '../runtimes/types.js';
import type { recordUsageEvent } from '../db.js';
import type { estimateCost } from '../usage-pricing.js';

/** The `usage` variant of the canonical AgentRuntimeEvent stream. */
export type UsageEvent = Extract<AgentRuntimeEvent, { type: 'usage' }>;

/** The row shape accepted by `recordUsageEvent`. Derived from the DB-side
 *  function signature so this helper can't drift from the persistence
 *  contract without a typecheck error landing here first. */
export type UsageEventRow = Parameters<typeof recordUsageEvent>[0];

export interface BuildUsageEventRowInput {
  event: UsageEvent;
  toolInsertions: ToolInsertion[];
  model: string;
  modelRef: ModelRef;
  streamMsgId: string;
  threadId: string;
  platform: string;
  isAutonomous: boolean;
  requestStartMs: number;
  contextTokensUsed: number;
  contextWindowSize: number;
  randomId: () => string;
  nowIso: () => string;
  nowMs: () => number;
  estimateCost: typeof estimateCost;
}

export function buildUsageEventRow(input: BuildUsageEventRowInput): UsageEventRow {
  const inputTokens = input.event.input;
  const outputTokens = input.event.output;
  const cacheReadTokens = input.event.cacheRead ?? 0;
  const cacheCreationTokens = input.event.cacheWrite ?? 0;

  const toolCallList: Array<{ name: string; count: number }> = [];
  for (const ti of input.toolInsertions) {
    const existing = toolCallList.find((t) => t.name === ti.toolName);
    if (existing) existing.count++;
    else toolCallList.push({ name: ti.toolName, count: 1 });
  }

  // Cost precedence: a runtime-reported figure wins; an EXPLICIT null means
  // "this lane has no per-turn dollar measurement — file the absence" (the
  // subscription-billed CLI lane: estimating API-equivalent dollars there
  // would invent a number no bill contains). Only a fully absent field falls
  // through to the estimate, preserving every API lane's existing behavior.
  const costUsd = input.event.cost !== undefined ? input.event.cost : input.estimateCost({
    model: input.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  });

  return {
    id: input.randomId(),
    createdAt: input.nowIso(),
    threadId: input.threadId,
    messageId: input.streamMsgId,
    platform: input.platform,
    mode: input.isAutonomous ? 'autonomous' : 'interactive',
    wakeType: null,
    model: input.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    toolCalls: toolCallList.length > 0 ? toolCallList : undefined,
    costUsd,
    contextWindow: input.contextWindowSize || null,
    contextTokens: input.contextTokensUsed || null,
    durationMs: input.nowMs() - input.requestStartMs,
    companionId: null,
    provider: input.modelRef.provider,
    runtime: input.modelRef.runtime,
    modelRef: input.modelRef.canonical,
  };
}
