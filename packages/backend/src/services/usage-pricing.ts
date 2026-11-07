// Published Anthropic API pricing — $ per million tokens.
// Cache writes are priced at 1.25× input; cache reads at 0.1× input.
// Update this table when pricing changes.

interface ModelPricing {
  input: number;  // USD per million input tokens
  output: number; // USD per million output tokens
}

const PRICING: Record<string, ModelPricing> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

function pricingFor(model: string): ModelPricing {
  // Try exact match first, then strip trailing suffixes (e.g. "[1m]")
  if (PRICING[model]) return PRICING[model];
  const base = model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  if (PRICING[base]) return PRICING[base];
  // Fallback: match prefix
  for (const [k, v] of Object.entries(PRICING)) {
    if (model.startsWith(k)) return v;
  }
  // Default if unknown — use conservative opus-tier estimate
  return { input: 15, output: 75 };
}

export function estimateCost(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): number {
  const p = pricingFor(params.model);
  const MILLION = 1_000_000;
  const inputCost = (params.inputTokens * p.input) / MILLION;
  const outputCost = (params.outputTokens * p.output) / MILLION;
  const cacheReadCost = ((params.cacheReadTokens ?? 0) * p.input * 0.1) / MILLION;
  const cacheCreationCost = ((params.cacheCreationTokens ?? 0) * p.input * 1.25) / MILLION;
  return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}
