import { createHash } from 'node:crypto';
import { getDb, recordUsageEvent } from './db.js';

const ACCOUNTING_TAG = 'studio-image-spend-v1';
const WARNING = 'The image was created, but its cost could not be saved. Paid image generation is paused until accounting recovers.';
const pending = new Set<string>();

export interface StudioImageSpendInput {
  filename: string;
  model: string;
  backend: string;
  costUsd: number;
  /** Missing means estimated, never a claim that an unknown price is actual. */
  costSource?: 'actual' | 'estimate';
}

export interface StudioImageSpendResult {
  id: string;
  /** True for either a new receipt or an exact, already-accounted duplicate. */
  recorded: boolean;
  duplicate: boolean;
  warning?: string;
}

export class StudioImageBudgetError extends Error {
  constructor() {
    super('Image cost accounting is unavailable. Paid image generation is paused until accounting recovers.');
    this.name = 'StudioImageBudgetError';
  }
}

/** Record ONLY Studio-origin renders. The chat door already records its own
 * singleton generate_image event; recording both would double-count that image.
 * This function never retries a provider call or throws away a completed image.
 * On failure, retry this same receipt after storage recovers, not generation.
 */
export function recordStudioImageSpend(input: StudioImageSpendInput): StudioImageSpendResult {
  const id = `${ACCOUNTING_TAG}:${createHash('sha256').update(String(input.filename)).digest('hex')}`;
  try {
    const costSource = input.costSource ?? 'estimate';
    if (typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length > 512
      || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 512
      || typeof input.backend !== 'string' || !input.backend.trim() || input.backend.length > 64
      || !Number.isFinite(input.costUsd) || input.costUsd < 0
      || !['actual', 'estimate'].includes(costSource)) throw new StudioImageBudgetError();
    const toolCalls = [{ name: 'generate_image', count: 1, accounting: ACCOUNTING_TAG,
      filename: input.filename, backend: input.backend, cost_source: costSource }];
    const calls = JSON.stringify(toolCalls);
    const db = getDb();
    const duplicate = db.transaction(() => {
      const existing = db.prepare('SELECT model, provider, cost_usd, tool_calls, platform FROM usage_events WHERE id = ?')
        .get(id) as { model: string; provider: string | null; cost_usd: number | null; tool_calls: string | null; platform: string | null } | undefined;
      if (existing) {
        if (existing.model !== input.model || existing.provider !== input.backend || existing.cost_usd !== input.costUsd
          || existing.tool_calls !== calls || existing.platform !== ACCOUNTING_TAG) throw new StudioImageBudgetError();
        return true;
      }
      recordUsageEvent({ id, createdAt: new Date().toISOString(), platform: ACCOUNTING_TAG,
        mode: 'interactive', model: input.model, provider: input.backend,
        inputTokens: 0, outputTokens: 0, toolCalls, costUsd: input.costUsd });
      return false;
    })();
    pending.delete(id);
    return { id, recorded: true, duplicate };
  } catch {
    // Even a readable database must not let future requests ignore a known
    // unrecorded paid result. Each failed receipt must recover independently.
    pending.add(id);
    return { id, recorded: false, duplicate: false, warning: WARNING };
  }
}

/** UTC calendar-month costs, including historical chat image receipts. Normal
 * LLM-turn tool summaries are excluded: the legacy image writer emits exactly
 * one generate_image call and zero text tokens. Unknown matched costs/read
 * failures are never converted to a zero-dollar authorization to spend.
 */
export function monthlyStudioImageSpendUsd(now = new Date()): number {
  if (pending.size) throw new StudioImageBudgetError();
  try {
    if (!Number.isFinite(now.getTime())) throw new StudioImageBudgetError();
    const start = new Date(now);
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const rows = getDb().prepare(`
      WITH candidates AS (
        SELECT cost_usd, platform, input_tokens, output_tokens,
          CASE WHEN json_valid(tool_calls) THEN tool_calls ELSE '[]' END AS calls
        FROM usage_events WHERE created_at >= ? AND created_at < ?
      )
      SELECT cost_usd FROM candidates
      WHERE platform = ? OR (
        input_tokens = 0 AND output_tokens = 0
        AND json_type(calls) = 'array' AND json_array_length(calls) = 1
        AND json_extract(calls, '$[0].name') = 'generate_image'
        AND json_extract(calls, '$[0].count') > 0
      )
    `).all(start.toISOString(), end.toISOString(), ACCOUNTING_TAG) as Array<{ cost_usd: number | null }>;
    let total = 0;
    for (const row of rows) {
      if (typeof row.cost_usd !== 'number' || !Number.isFinite(row.cost_usd) || row.cost_usd < 0) throw new StudioImageBudgetError();
      total += row.cost_usd;
      if (!Number.isFinite(total)) throw new StudioImageBudgetError();
    }
    return total;
  } catch { throw new StudioImageBudgetError(); }
}
