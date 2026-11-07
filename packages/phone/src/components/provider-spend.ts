export interface ProviderSpendRow {
  provider: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  spend: { usedFormatted?: string } | null;
}

function isProviderSpendRow(value: unknown): value is ProviderSpendRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.provider === 'string'
    && typeof row.requestCount === 'number'
    && typeof row.inputTokens === 'number'
    && typeof row.outputTokens === 'number'
    && typeof row.costUsd === 'number';
}

export function parseProviderSpend(value: unknown): ProviderSpendRow[] {
  if (!value || typeof value !== 'object') return [];
  const providers = (value as Record<string, unknown>).providers;
  return Array.isArray(providers) ? providers.filter(isProviderSpendRow) : [];
}
