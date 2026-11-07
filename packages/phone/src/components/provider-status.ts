// Per-card status line for the Providers screen, ported from the classic
// Providers panel's cardStatus(). Derived from GET /api/models/status plus
// the live Ollama/OpenAI catalog counts, so every card says where it stands
// the moment the screen opens — no Check press needed.

export type ProviderCardId = 'anthropic' | 'openai' | 'openrouter' | 'groq' | 'xai' | 'ollama' | 'huggingface';
export type ProviderDot = 'connected' | 'needs-key' | 'coming-soon' | 'disabled';

export interface ProviderCardStatus {
  dot: ProviderDot;
  text: string;
}

/** The subset of /api/models/status this screen reads. */
export interface ModelsStatus {
  routing?: 'sdk' | 'auto' | 'api';
  claude?: { configured: boolean };
  ollama?: { configured: boolean; enabled: boolean; url?: string };
  openrouter?: { configured: boolean };
  groq?: { configured: boolean };
  xai?: { configured: boolean };
  openai?: { configured: boolean; enabled?: boolean; url?: string };
  huggingface?: { configured: boolean };
}

/** Live catalog reach for a lane: null = not known yet. */
export interface CatalogReach {
  count: number | null;
  reachable: boolean | null;
}

export const UNKNOWN_REACH: CatalogReach = { count: null, reachable: null };

/**
 * What one GET /api/models?provider=<id> answer says about the lane.
 * `models` is the parsed body when the response was ok, otherwise null.
 * Same rule as classic: reachable when it listed models or the lane is on.
 */
export function reachFromCatalog(models: unknown, enabled: boolean): CatalogReach {
  if (models === null) return { count: 0, reachable: false };
  const count = Array.isArray(models) ? models.length : 0;
  return { count, reachable: count > 0 || enabled };
}

/** Folds a Check result into the lane's reach, as classic does after Check. */
export function reachAfterCheck(previous: CatalogReach, result: { ok: true; models: number } | { ok: false }): CatalogReach {
  return result.ok ? { count: result.models, reachable: true } : { ...previous, reachable: false };
}

const COMPAT = new Set<ProviderCardId>(['openrouter', 'groq', 'xai']);

function plural(n: number): string {
  return `${n} model${n === 1 ? '' : 's'}`;
}

export function providerCardStatus(
  id: ProviderCardId,
  status: ModelsStatus | null,
  live: { ollama: CatalogReach; openai: CatalogReach },
  ollamaBaseUrl: string,
): ProviderCardStatus {
  if (id === 'anthropic') {
    return { dot: 'connected', text: 'connected · Claude Agent SDK' };
  }
  if (id === 'openai') {
    // The dispatcher refuses OpenAI direct turns under routing=sdk.
    const configured = !!status?.openai?.configured;
    const enabled = !!status?.openai?.enabled;
    const routingSdk = status?.routing === 'sdk';
    if (!configured && !enabled) return { dot: 'disabled', text: 'disabled · add API key' };
    if (configured && !enabled) return { dot: 'disabled', text: 'disabled · enable to use' };
    if (routingSdk) return { dot: 'needs-key', text: 'routing=sdk · switch to auto for OpenAI direct turns' };
    if (live.openai.reachable === false) return { dot: 'needs-key', text: 'needs-key · check key/base URL' };
    if (live.openai.count === null) return { dot: 'connected', text: 'enabled · checking…' };
    return { dot: 'connected', text: `connected · ${plural(live.openai.count)}` };
  }
  if (COMPAT.has(id)) {
    // Key-only lanes: a saved key + routing other than sdk is live.
    const configured = !!status?.[id as 'openrouter' | 'groq' | 'xai']?.configured;
    const routingSdk = status?.routing === 'sdk';
    if (!configured) return { dot: 'disabled', text: 'disabled · add API key' };
    if (routingSdk) return { dot: 'needs-key', text: 'routing=sdk · switch to auto to use' };
    return { dot: 'connected', text: 'connected · key set' };
  }
  if (id === 'ollama') {
    const enabled = !!status?.ollama?.enabled;
    const configured = !!status?.ollama?.configured;
    const url = status?.ollama?.url ?? ollamaBaseUrl;
    if (!configured) return { dot: 'disabled', text: 'not configured · add a base URL' };
    if (!enabled) return { dot: 'disabled', text: 'disabled · two-stage gate off' };
    if (live.ollama.reachable === false) return { dot: 'needs-key', text: `unreachable at ${url} · check URL` };
    if (live.ollama.count === null) return { dot: 'connected', text: `enabled at ${url}` };
    return { dot: 'connected', text: `running at ${url} · ${plural(live.ollama.count)}` };
  }
  // HuggingFace: a key can be stored, but no lane routes it yet.
  return { dot: 'coming-soon', text: 'coming soon · not wired yet' };
}
