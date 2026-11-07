/**
 * Studio's server-side image settings — GET/PUT /api/studio/settings.
 *
 * GET returns { settings, monthlySpendUsd }; PUT takes a partial patch in the
 * route's own snake_case keys and returns { success, settings }. The stored
 * OpenAI key never comes back: the server only says whether one is saved
 * (hasOpenaiKey), and the UI never shows it.
 */
export const STUDIO_ENGINES = ['codex', 'openai', 'cloudflare', 'antigravity', 'openart'] as const;
export type StudioEngine = typeof STUDIO_ENGINES[number];

export interface StudioSettings {
  enabled: boolean;
  backend: StudioEngine;
  size: 'square' | 'portrait' | 'landscape';
  quality: 'auto' | 'low' | 'medium' | 'high';
  openaiModel: string;
  monthlyBudgetUsd: number;
  hasOpenaiKey: boolean;
  antigravityModel?: string;
  openartModel?: string;
}

export const ENGINE_HINTS: Record<StudioEngine, string> = {
  codex: 'Rides your ChatGPT subscription — no per-image cost. Size and quality aren\'t pinned here — just ask for a shape, or leave it to us (like the GPT app).',
  openai: 'Metered OpenAI API — a few cents per image.',
  cloudflare: 'Cloudflare Flux via the ImageGen MCP — set its endpoint to enable.',
  antigravity: 'Antigravity · Gemini via the agy CLI — rides that subscription.',
  openart: 'OpenArt — its own service (not OpenAI), authorized via the OpenArt MCP; metered in OpenArt credits.',
};

/** The sizes PUT /api/studio/settings accepts (it 400s anything else). */
export const SETTINGS_SIZE_OPTS = [
  { value: 'square', label: '1:1 · Square' },
  { value: 'portrait', label: '2:3 · Portrait' },
  { value: 'landscape', label: '3:2 · Landscape' },
] as const;

export const QUALITY_OPTS = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

export function parseStudioSettings(value: unknown): { settings: StudioSettings | null; monthlySpendUsd: number } {
  if (!value || typeof value !== 'object') return { settings: null, monthlySpendUsd: 0 };
  const record = value as Record<string, unknown>;
  const raw = record.settings;
  const spend = typeof record.monthlySpendUsd === 'number' ? record.monthlySpendUsd : 0;
  if (!raw || typeof raw !== 'object') return { settings: null, monthlySpendUsd: spend };
  const s = raw as Record<string, unknown>;
  const backend = STUDIO_ENGINES.includes(s.backend as StudioEngine) ? s.backend as StudioEngine : 'codex';
  return {
    monthlySpendUsd: spend,
    settings: {
      enabled: s.enabled === true,
      backend,
      size: (['square', 'portrait', 'landscape'] as const).find((v) => v === s.size) ?? 'square',
      quality: (['auto', 'low', 'medium', 'high'] as const).find((v) => v === s.quality) ?? 'auto',
      openaiModel: typeof s.openaiModel === 'string' ? s.openaiModel : 'gpt-image-2',
      monthlyBudgetUsd: typeof s.monthlyBudgetUsd === 'number' ? s.monthlyBudgetUsd : 0,
      hasOpenaiKey: s.hasOpenaiKey === true,
      antigravityModel: typeof s.antigravityModel === 'string' ? s.antigravityModel : undefined,
      openartModel: typeof s.openartModel === 'string' ? s.openartModel : undefined,
    },
  };
}

/** Same coercion as the desktop: anything that is not a number saves as 0 (no cap). */
export function budgetPatch(input: string): { monthly_budget_usd: number } {
  return { monthly_budget_usd: Number(input) || 0 };
}

export function spendLine(monthlySpendUsd: number, budgetUsd: number): string {
  return `Spent this month: $${monthlySpendUsd.toFixed(2)}${budgetUsd > 0 ? ` / $${budgetUsd.toFixed(2)}` : ''}`;
}
