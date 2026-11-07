// Engine picking, shared by the chat-header model pill and the house default
// engine in Preferences.
//
// The house default engine is a companion-scope row per tier, written through
// PUT /api/companion-settings/default and read back through
// GET /api/companion-settings/effective (backend
// routes/companion-settings-routes.ts). That row wins over the agent.model /
// agent.model_autonomous config in the resolver
// (services/companion-resolver.ts), so it is the one that actually decides
// which engine answers. This mirrors the classic PreferencesPanel's
// "Your Engine" section: provider first, model follows the provider, effort
// per tier, and an optional separate engine for autonomous wakes.
//
// Everything here is pure so it can be unit-tested without a server.
import {
  MODEL_VARIANTS,
  coerceEffortForProvider,
  getEffortOptionsForProvider,
  type ProviderId,
  type ThinkingEffort,
} from '@bytelight/shared';

/** The shared default brain (migrations/014_companions.sql). The resolver keys
 *  companion defaults on this id; any other id would silently not match. */
export const DEFAULT_BRAIN = 'companion-a-b';

export interface ProviderRow {
  id: ProviderId;
  label: string;
}

// Same providers, order and labels as main's ModelSelector PROVIDER_ROWS
// (HuggingFace, a "coming soon" placeholder there, is left out).
export const PROVIDER_ROWS: ProviderRow[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'claude-cli', label: 'Claude CLI' },
  { id: 'codex-cli', label: 'Codex CLI' },
  { id: 'openai-codex', label: 'Codex' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'groq', label: 'Groq' },
  { id: 'xai', label: 'Grok' },
  { id: 'ollama', label: 'Ollama' },
];

/** Shape of GET /api/models/status (routes/models.ts). */
export interface ProviderStatus {
  routing?: string;
  ollama?: { configured: boolean; enabled: boolean };
  openai?: { configured: boolean; enabled?: boolean };
  openrouter?: { configured: boolean };
  groq?: { configured: boolean };
  xai?: { configured: boolean };
  'openai-codex'?: { available: boolean; reason?: string };
}

export interface ModelOption {
  id: string;
  name: string;
}

// Mirrors ModelSelector.providerEnabled(): the subscription lanes are always
// offered; the BYOK/local lanes need a key or a running server, and the
// api-router lanes are refused while routing is SDK-only.
export function providerEnabled(id: ProviderId, status: ProviderStatus | null): { enabled: boolean; hint?: string } {
  if (id === 'claude' || id === 'claude-cli' || id === 'codex-cli') return { enabled: true };
  if (!status) return { enabled: false, hint: 'checking…' };
  const sdkOnly = status.routing === 'sdk';
  if (id === 'openai-codex') {
    const codex = status['openai-codex'];
    return codex?.available ? { enabled: true } : { enabled: false, hint: 'connect in Providers' };
  }
  if (sdkOnly) return { enabled: false, hint: 'routing is SDK-only' };
  if (id === 'ollama') return status.ollama?.configured && status.ollama.enabled ? { enabled: true } : { enabled: false, hint: 'disabled' };
  if (id === 'openai') return status.openai?.configured && status.openai.enabled ? { enabled: true } : { enabled: false, hint: 'add key' };
  const compat = status[id as 'openrouter' | 'groq' | 'xai'];
  return compat?.configured ? { enabled: true } : { enabled: false, hint: 'add key' };
}

/** Providers whose model list is static (MODEL_VARIANTS) rather than fetched. */
export function isStaticProvider(p: ProviderId): boolean {
  return p === 'claude' || p === 'claude-cli';
}

/** Normalize a GET /api/models?provider=… body into options. */
export function normalizeCatalog(data: unknown): ModelOption[] {
  return Array.isArray(data)
    ? data
      .filter((m): m is { id: string; name?: string } => !!m && typeof (m as { id?: unknown }).id === 'string')
      .map((m) => ({ id: m.id, name: m.name ?? m.id }))
    : [];
}

/** Claude models from the shared shelf — what the chat pill offers. */
export const CLAUDE_VARIANT_OPTIONS: ModelOption[] = MODEL_VARIANTS.map((v) => ({ id: v.modelApiId, name: v.label }));

// Legacy 3.x / 3.5 ids stay selectable on the classic Claude lane (not the
// CLI lane), as in the classic Preferences panel; they are not in the shared
// catalog.
export const LEGACY_CLAUDE_OPTIONS: ModelOption[] = [
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
  { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
];

// Codex CLI shelf used only when discovery for that lane comes back empty or
// fails, so the lane stays pickable through a brief outage.
export const CODEX_CLI_FALLBACK: ModelOption[] = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
];

export type Catalogs = Partial<Record<ProviderId, ModelOption[] | 'error'>>;

/**
 * The models a house-engine tier can pick for a provider. Claude lanes read
 * the shared shelf (+ legacy ids on the classic Claude lane); every other
 * lane reads its fetched catalog. Returns undefined while a catalog is still
 * loading, 'error' when its fetch failed.
 */
export function modelsForProvider(p: ProviderId, catalogs: Catalogs): ModelOption[] | 'error' | undefined {
  if (isStaticProvider(p)) return p === 'claude' ? [...CLAUDE_VARIANT_OPTIONS, ...LEGACY_CLAUDE_OPTIONS] : CLAUDE_VARIANT_OPTIONS;
  const list = catalogs[p];
  if (p === 'codex-cli' && (list === 'error' || (Array.isArray(list) && list.length === 0))) return CODEX_CLI_FALLBACK;
  return list;
}

/** One tier's engine. */
export interface TierEngine {
  provider: ProviderId;
  model: string;
  effort: ThinkingEffort;
}

export type HouseTier = 'interactive' | 'autonomous';

/** Hydrate a tier from a GET /api/companion-settings/effective body. */
export function engineFromEffective(body: unknown): TierEngine | null {
  if (!body || typeof body !== 'object') return null;
  const d = body as { provider?: unknown; model?: unknown; thinkingEffort?: unknown };
  if (typeof d.provider !== 'string' || typeof d.model !== 'string') return null;
  const provider = d.provider as ProviderId;
  return {
    provider,
    model: d.model,
    effort: coerceEffortForProvider(provider, typeof d.thinkingEffort === 'string' ? d.thinkingEffort : 'auto'),
  };
}

export function sameEngine(a: TierEngine, b: TierEngine): boolean {
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

/**
 * Whether the autonomous tier opens as its own engine. Both tiers resolving
 * to the same engine means nobody split them — open unified. Different means
 * a distinct wake engine was set — reveal it so it is not silently lost.
 */
export function initialSplit(chat: TierEngine | null, auto: TierEngine | null): boolean {
  return !!chat && !!auto && !sameEngine(chat, auto);
}

/**
 * Switching provider resets the model to that provider's first option (no
 * stale cross-provider id) and keeps the effort only if the new provider
 * accepts it.
 */
export function switchProvider(engine: TierEngine, provider: ProviderId, models: ModelOption[] | 'error' | undefined): TierEngine {
  return {
    provider,
    model: Array.isArray(models) ? models[0]?.id ?? '' : '',
    effort: coerceEffortForProvider(provider, engine.effort),
  };
}

export interface EffortChoice {
  id: ThinkingEffort;
  label: string;
}

/** Short effort chip labels for a provider's own vocabulary. */
export function effortChoices(provider: ProviderId): EffortChoice[] {
  return getEffortOptionsForProvider(provider).map((o) => ({
    id: o.value,
    label: o.value === 'xhigh' ? 'Extra high' : o.value.charAt(0).toUpperCase() + o.value.slice(1),
  }));
}

/** The engine each tier saves: unified mirrors chat onto autonomous. */
export function savedEngines(chat: TierEngine, auto: TierEngine, split: boolean): Record<HouseTier, TierEngine> {
  return { interactive: chat, autonomous: split ? auto : chat };
}

/** Why a save cannot go yet, or null when it can. */
export function saveBlocker(chat: TierEngine, auto: TierEngine, split: boolean): string | null {
  if (!chat.model || (split && !auto.model)) {
    return split
      ? 'Pick a model for both chat and autonomous before saving.'
      : 'Pick a model for chat before saving.';
  }
  return null;
}

/** Body for PUT /api/companion-settings/default. */
export interface DefaultEngineBody {
  companionId: string;
  tier: HouseTier;
  providerId: ProviderId;
  modelId: string;
  thinkingEffort: ThinkingEffort;
}

export function defaultEngineBodies(chat: TierEngine, auto: TierEngine, split: boolean, companionId = DEFAULT_BRAIN): DefaultEngineBody[] {
  const engines = savedEngines(chat, auto, split);
  return (['interactive', 'autonomous'] as const).map((tier) => ({
    companionId,
    tier,
    providerId: engines[tier].provider,
    modelId: engines[tier].model,
    thinkingEffort: engines[tier].effort,
  }));
}

/**
 * The effort config that rides alongside the rows. A row's 'auto' effort
 * falls through to agent.thinking_effort / agent.thinking_effort_autonomous
 * (services/agent.ts getConfiguredThinkingEffort), so those are kept in step
 * with the rows exactly as the classic panel does. Unified clears the
 * autonomous override so wakes follow chat.
 */
export function effortConfig(chat: TierEngine, auto: TierEngine, split: boolean): {
  preferences: { thinking_effort: ThinkingEffort; thinking_effort_autonomous: ThinkingEffort | null };
  settings: Array<{ key: string; value: string }>;
} {
  return {
    preferences: {
      thinking_effort: chat.effort,
      thinking_effort_autonomous: split ? auto.effort : null,
    },
    settings: [
      { key: 'agent.thinking_effort', value: chat.effort },
      { key: 'agent.thinking_effort_autonomous', value: split ? auto.effort : '' },
    ],
  };
}
