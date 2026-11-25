/**
 * Which engine the background helpers (the Archivist and the Scribe) run on.
 *
 * By default they follow the house: whatever engine the house itself runs on
 * (the local brain's resolved model, the same one the Agents screen switches).
 * Swap the whole house to OpenRouter because a plan hit its limit, and the
 * helpers go with it, instead of quietly failing on a login the house no
 * longer has. An explicit choice for a helper still wins.
 *
 * The helpers speak three dialects (memory-extraction.ts runHelperPrompt):
 *   'sdk'    Claude through the Agent SDK (a Claude plan login)
 *   'codex'  ChatGPT through the Codex sign-in
 *   'antigravity'  Gemini through the Antigravity CLI's Google sign-in
 *   <id>     any configured API provider through the router (openrouter, groq,
 *            xai, openai, ollama, anthropic)
 */
import { resolveCompanionConfig } from './companion-resolver.js';
import { getLocalBrainId } from './local-brain.js';

export interface HelperEngine {
  provider: string;
  model: string;
  /** 'override' when a helper has its own saved choice, 'house' when it follows. */
  source: 'override' | 'house';
}

/** The cheap Claude model the helpers use when the house runs on Claude. */
export const CLAUDE_HELPER_MODEL = 'haiku';

const ROUTER_PROVIDERS = new Set(['openrouter', 'groq', 'xai', 'openai', 'ollama', 'anthropic']);

/**
 * The helper dialect for a house engine. Claude houses keep the helpers on
 * Haiku (cheap, same login); Codex houses use the house's own model through
 * the Codex sign-in; API houses use the same provider and model.
 */
export function helperEngineForHouse(provider: string, model: string): { provider: string; model: string } {
  if (provider === 'codex-cli' || provider === 'openai-codex') return { provider: 'codex', model };
  if (provider === 'antigravity') return { provider: 'antigravity', model };
  if (ROUTER_PROVIDERS.has(provider) && model) return { provider, model };
  return { provider: 'sdk', model: CLAUDE_HELPER_MODEL };
}

/** The house's own engine, as the local brain resolves it for unattended work. */
export function houseEngine(): { provider: string; model: string } {
  try {
    const resolved = resolveCompanionConfig(getLocalBrainId(), 'autonomous');
    return { provider: resolved.provider, model: resolved.model };
  } catch {
    return { provider: 'claude', model: CLAUDE_HELPER_MODEL };
  }
}

/**
 * A helper's engine: its own saved provider (and model) when it has one,
 * otherwise the house's. `overrideModelDefault` fills an override that named a
 * provider but no model.
 */
export function resolveHelperEngine(
  overrideProvider: string | null | undefined,
  overrideModel: string | null | undefined,
  overrideModelDefault: (provider: string) => string,
  house: () => { provider: string; model: string } = houseEngine,
): HelperEngine {
  const p = overrideProvider?.trim();
  if (p) return { provider: p, model: overrideModel?.trim() || overrideModelDefault(p), source: 'override' };
  const h = house();
  return { ...helperEngineForHouse(h.provider, h.model), source: 'house' };
}
