// Canonical list of usable model + context-window combinations.
// Single source of truth read by backend (for SDK config + window math)
// and frontend (for selectors + display).

export interface ModelVariant {
  /** Stable id used in DB / config (slug form) */
  id: string;
  /** Human label shown in UI */
  label: string;
  /** Anthropic model API id */
  modelApiId: string;
  /** Effective context window in tokens for this variant */
  contextWindow: number;
  /** Beta flags to send to the SDK when this variant is selected */
  betas: string[];
  /** Optional pricing tier hint for UI grouping */
  family: 'fable' | 'opus' | 'sonnet' | 'haiku';
}

export const MODEL_VARIANTS: ModelVariant[] = [
  // Current generation (verified against the live models overview 2026-10-11).
  // All four ship 1M context by default — no [1m] variant splits.
  { id: 'fable-5-1',     label: 'Fable 5.1',       modelApiId: 'claude-fable-5-1',            contextWindow: 1_000_000, betas: [], family: 'fable' },
  // Fable 5's 1M context window is the model's default — no [1m] variant split.
  { id: 'fable-5',       label: 'Fable 5',         modelApiId: 'claude-fable-5',              contextWindow: 1_000_000, betas: [], family: 'fable' },
  { id: 'opus-5-5',      label: 'Opus 5.5',        modelApiId: 'claude-opus-5-5',             contextWindow: 1_000_000, betas: [], family: 'opus' },
  // Opus 5 also ships with 1M context by default — there is no smaller/[1m] split.
  { id: 'opus-5',        label: 'Opus 5',          modelApiId: 'claude-opus-5',               contextWindow: 1_000_000, betas: [], family: 'opus' },
  { id: 'opus-4-8-1m',   label: 'Opus 4.8 (1M)',   modelApiId: 'claude-opus-4-8[1m]',         contextWindow: 1_000_000, betas: [], family: 'opus' },
  { id: 'opus-4-8',      label: 'Opus 4.8',        modelApiId: 'claude-opus-4-8',             contextWindow:   200_000, betas: [], family: 'opus' },
  { id: 'opus-4-7-1m',   label: 'Opus 4.7 (1M)',   modelApiId: 'claude-opus-4-7[1m]',         contextWindow: 1_000_000, betas: [], family: 'opus' },
  { id: 'opus-4-7',      label: 'Opus 4.7',        modelApiId: 'claude-opus-4-7',             contextWindow:   200_000, betas: [], family: 'opus' },
  { id: 'opus-4-6-1m',   label: 'Opus 4.6 (1M)',   modelApiId: 'claude-opus-4-6[1m]',         contextWindow: 1_000_000, betas: [], family: 'opus' },
  { id: 'opus-4-6',      label: 'Opus 4.6',        modelApiId: 'claude-opus-4-6',             contextWindow:   200_000, betas: [], family: 'opus' },
  { id: 'opus-4-5',      label: 'Opus 4.5',        modelApiId: 'claude-opus-4-5-20251101',    contextWindow:   200_000, betas: [], family: 'opus' },
  { id: 'sonnet-5-5',    label: 'Sonnet 5.5',      modelApiId: 'claude-sonnet-5-5',           contextWindow: 1_000_000, betas: [], family: 'sonnet' },
  { id: 'sonnet-5-1m',   label: 'Sonnet 5 (1M)',   modelApiId: 'claude-sonnet-5[1m]',         contextWindow: 1_000_000, betas: [], family: 'sonnet' },
  { id: 'sonnet-5',      label: 'Sonnet 5',        modelApiId: 'claude-sonnet-5',             contextWindow:   200_000, betas: [], family: 'sonnet' },
  { id: 'sonnet-4-6-1m', label: 'Sonnet 4.6 (1M)', modelApiId: 'claude-sonnet-4-6[1m]',       contextWindow: 1_000_000, betas: [], family: 'sonnet' },
  { id: 'sonnet-4-6',    label: 'Sonnet 4.6',      modelApiId: 'claude-sonnet-4-6',           contextWindow:   200_000, betas: [], family: 'sonnet' },
  { id: 'sonnet-4-5',    label: 'Sonnet 4.5',      modelApiId: 'claude-sonnet-4-5-20250929',  contextWindow:   200_000, betas: [], family: 'sonnet' },
  { id: 'haiku-5-5',     label: 'Haiku 5.5',       modelApiId: 'claude-haiku-5-5',            contextWindow: 1_000_000, betas: [], family: 'haiku' },
  { id: 'haiku-4-5',     label: 'Haiku 4.5',       modelApiId: 'claude-haiku-4-5-20251001',   contextWindow:   200_000, betas: [], family: 'haiku' },
];

// NOTE: byte-light keeps prod default at claude-sonnet-4-6. Do not change without
// explicit owner approval. 1M variants are selectable but must not be default.
export const DEFAULT_VARIANT_ID = 'sonnet-4-6';

export function getVariant(id: string | null | undefined): ModelVariant {
  if (!id) return MODEL_VARIANTS.find(v => v.id === DEFAULT_VARIANT_ID)!;
  const direct = MODEL_VARIANTS.find(v => v.id === id);
  if (direct) return direct;
  // Backward-compat: caller passed a raw model API id (modelApiId values are unique per variant)
  const byApiId = MODEL_VARIANTS.find(v => v.modelApiId === id);
  if (byApiId) return byApiId;
  return MODEL_VARIANTS.find(v => v.id === DEFAULT_VARIANT_ID)!;
}
