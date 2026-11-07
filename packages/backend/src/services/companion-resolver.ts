/**
 * Resolver: (companion, tier, thread?) → (provider, model, effort)
 *
 * Priority order (most-specific wins):
 *   1. Thread-scope override   (if threadId provided + row exists)
 *   2. Companion-scope default (companion-wide override)
 *   3. System fallback         — byte-light's existing config resolution
 *      (cfg.agent.model / cfg.agent.model_autonomous). Untouched by P0;
 *      this resolver only DELEGATES to it, never replaces it.
 *
 * In P0 this resolver exists but is NOT wired into _processQuery (out of
 * scope). The existing Claude dispatch in services/agent.ts continues to
 * read cfg.agent.* directly. The resolver is here so future wiring work
 * can move call sites over without re-designing the contract.
 *
 * Safety belt: the system-fallback exit (and every exit) runs the effort
 * through coerceEffortForProvider so a stale 'none'/'minimal' (Codex-only)
 * can never escape to the Claude SDK. Mirrors Maggie's agent.ts:1163-1165
 * pattern — belt and suspenders at the resolver boundary.
 */

import {
  coerceEffortForProvider,
  normalizeModelRef,
  type ProviderId,
  type ThinkingEffort,
  type TierHint,
} from '@bytelight/shared';
import { getBytelightConfig } from '../config.js';
// SLICE-5a ADAPTATION: DB-config layer for systemFallback — see comment there.
import { getConfig as getDbConfig } from './db.js';
import { getCompanionSetting, type CompanionSettingsRow } from './db/companion-settings.js';
import { getDb } from './db/init.js';

/** What the resolver hands back to a call site. */
export interface ResolvedCompanionConfig {
  provider: ProviderId;
  model: string;
  /** Always a defined ThinkingEffort value — never null. 'auto' is the
   *  sentinel for "let the per-model resolver pick at the SDK boundary." */
  effort: ThinkingEffort;
  /** Which scope this resolution came from. Useful for debug + telemetry. */
  source: 'thread' | 'companion' | 'system';
  /** Whose row answered: the asked-for companion, or the brain it shares
   *  (e.g. 'companion-a' falling through to 'companion-a-b'). Absent on the bare
   *  config fallback, where no row answered. */
  matchedCompanionId?: string;
}

/**
 * Read byte-light's existing per-tier model config. This MUST stay
 * delegation-only — the Claude default path keeps using the same code
 * paths it always has. Adding a new tier here means adding it to
 * BytelightConfig.agent too; in P0 only interactive + autonomous are
 * actually wired in the config schema, so pulse/memory tiers fall back
 * to the interactive model.
 *
 * The 'pulse' and 'memory' tier mappings are intentional defaults — not
 * "wrong." byte-light's config doesn't differentiate them today; if
 * anyone wants them split, they create a companion_settings row at
 * scope='system' or scope='companion' for that tier, which overrides
 * this fallback via the resolver's priority chain.
 */
function systemFallback(tier: TierHint): { provider: ProviderId; model: string } {
  // SLICE-5a ADAPTATION: main's live model selection layers DB config ABOVE
  // YAML — agent.ts getConfiguredModel reads getDbConfig('agent.model' /
  // 'agent.model_autonomous') first (written by commands.ts /model and the
  // pre-5a pill's updateSetting), then cfg.agent.*, then env, then the
  // hard default. The tag's YAML-only fallback (cfg.agent.* alone) would
  // silently ignore a DB-set model the moment the resolver replaced
  // getConfiguredModel at the turn call site. This mirrors the oracle's
  // exact chain; pinned by agent.model-resolution-parity.test.ts. Pulse
  // and memory keep the tag's mapping to the interactive model.
  //
  // The chosen value is split through normalizeModelRef — byte-identical
  // to what the pre-5a call site did (resolveRuntimeDescriptor(model) at
  // agent.ts:856): bare Claude ids (incl. '[1m]' forms) stay on the
  // claude lane with the id untouched, while a canonical
  // '<provider>/<model>' config value (agent.dual-path.test.ts (a):
  // 'openai-codex/gpt-5.5') keeps routing to its real provider instead
  // of being mislabeled 'claude'. Unknown-provider throws surface at the
  // same call depth they did pre-5a.
  const isAutonomous = tier === 'autonomous';
  const cfg = getBytelightConfig();
  const configured =
    getDbConfig(isAutonomous ? 'agent.model_autonomous' : 'agent.model') ||
    (isAutonomous ? cfg.agent.model_autonomous : cfg.agent.model) ||
    process.env.AGENT_MODEL ||
    'claude-sonnet-4-6';
  const ref = normalizeModelRef(configured);
  return { provider: ref.provider, model: ref.model };
}

/**
 * The ids a companion's settings are looked up under, most specific first:
 * the companion itself, then the brain it shares (companions.brain). Companion A
 * and Companion B share the brain 'companion-a-b', so 'companion-a' → ['companion-a',
 * 'companion-a-b']; a brain id or a companion with its own brain is just
 * itself. Unknown ids (or a missing companions table) are just themselves.
 */
export function companionLookupChain(companionId: string): string[] {
  try {
    const row = getDb()
      .prepare('SELECT brain FROM companions WHERE slug = ?')
      .get(companionId) as { brain?: string | null } | undefined;
    const brain = row?.brain;
    return brain && brain !== companionId ? [companionId, brain] : [companionId];
  } catch {
    return [companionId];
  }
}

type RowLookup = (key: {
  companionId: string;
  tier: TierHint;
  scope: 'thread' | 'companion' | 'system';
  threadId?: string;
}) => CompanionSettingsRow | null | undefined;

/**
 * Pure resolution over a lookup chain. Scope beats id: every id is tried at
 * thread scope before any id at companion scope, so a thread override set
 * for the whole brain (the chat pill's "Both") still wins over one boy's
 * companion default. Within a scope the companion's own row beats its
 * brain's.
 *
 *   thread(companion-a) → thread(companion-a-b) → companion(companion-a) →
 *   companion(companion-a-b) → system(companion-a) → system(companion-a-b) → config
 */
export function resolveFromChain(
  chain: string[],
  tier: TierHint,
  threadId: string | null | undefined,
  lookup: RowLookup,
  fallback: (tier: TierHint) => { provider: ProviderId; model: string },
): ResolvedCompanionConfig {
  const scopes: Array<'thread' | 'companion' | 'system'> = threadId
    ? ['thread', 'companion', 'system']
    : ['companion', 'system'];
  for (const scope of scopes) {
    for (const id of chain) {
      const row = lookup({
        companionId: id,
        tier,
        scope,
        ...(scope === 'thread' ? { threadId: threadId! } : {}),
      });
      if (row) {
        return {
          provider: row.provider_id as ProviderId,
          model: row.model_id,
          effort: coerceEffortForProvider(row.provider_id as ProviderId, row.thinking_effort ?? 'auto'),
          source: scope,
          matchedCompanionId: id,
        };
      }
    }
  }

  // Final fallback: byte-light's existing agent.* config. This is the path
  // today's Claude dispatch ALREADY takes; the resolver just produces a
  // structured value with the safety belt applied.
  const fb = fallback(tier);
  return {
    provider: fb.provider,
    model: fb.model,
    effort: coerceEffortForProvider(fb.provider, 'auto'),
    source: 'system',
  };
}

/**
 * Resolve effective config for (companionId, tier, threadId?).
 *
 * @param companionId  A companion slug ('companion-a', 'companion-b') or a brain id
 *                     ('companion-a-b'). A companion falls through to its
 *                     brain's rows (see resolveFromChain), so nothing set
 *                     per companion means exactly the brain's answer.
 * @param tier         Which model-resolution tier to read.
 * @param threadId     Optional. When provided, thread-scope overrides
 *                     are consulted first.
 */
export function resolveCompanionConfig(
  companionId: string,
  tier: TierHint,
  threadId?: string | null,
): ResolvedCompanionConfig {
  return resolveFromChain(
    companionLookupChain(companionId),
    tier,
    threadId,
    (key) => getCompanionSetting(key),
    systemFallback,
  );
}
