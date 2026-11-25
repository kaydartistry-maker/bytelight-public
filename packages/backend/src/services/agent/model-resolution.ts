/**
 * resolveModelForTurn — Slice 1 extraction of the model resolution seam
 * from agent.ts (formerly inline at lines 641-648).
 *
 * Returns { tierConfig, model, modelRef, tier } from a single resolution
 * pass so callers consume one source of truth (the original code derived
 * tier twice — once at 641, again at 996 — inviting drift).
 *
 * The optional `resolver` parameter exists for unit-test injection.
 * Production call sites pass one argument; the default uses the real
 * resolveCompanionConfig (which reads SQLite). Tests pass a stub to
 * verify arg propagation and return shape without DB fixtures.
 *
 * Tier type is LOCAL (ResolvedTurnTier) rather than imported as
 * AgentModelTier from agent.ts because the call-site replacement step
 * will make agent.ts import this file — importing back would cycle.
 * 'interactive' | 'autonomous' is a strict subset of AgentModelTier so
 * the call site's assignment widens without coercion.
 *
 * Not in scope: companion_settings DB precedence (lives in
 * resolveCompanionConfig), normalizeModelRef behavior (used as oracle),
 * effort coercion (handled inside resolveCompanionConfig), Claude
 * fallback semantics (handled inside resolveCompanionConfig). The
 * documented `[1m]` 1M-context suffix flows through verbatim — no
 * stripping, normalization, or reinterpretation at this layer.
 */

import { normalizeModelRef, type ModelRef } from '@bytelight/shared';
import {
  resolveCompanionConfig,
  type ResolvedCompanionConfig,
} from '../companion-resolver.js';
import { getLocalBrainId } from '../local-brain.js';

export type ResolvedTurnTier = 'interactive' | 'autonomous';

export interface ResolveModelForTurnInput {
  isAutonomous: boolean;
  threadId: string;
  companionId?: string;
}

export interface ResolvedModelForTurn {
  tierConfig: ResolvedCompanionConfig;
  model: string;
  modelRef: ModelRef;
  tier: ResolvedTurnTier;
}

type CompanionConfigResolver = (
  companionId: string,
  tier: ResolvedTurnTier,
  threadId?: string | null,
) => ResolvedCompanionConfig;

export function resolveModelForTurn(
  input: ResolveModelForTurnInput,
  resolver: CompanionConfigResolver = resolveCompanionConfig,
): ResolvedModelForTurn {
  const companionId = input.companionId ?? getLocalBrainId();
  const tier: ResolvedTurnTier = input.isAutonomous
    ? 'autonomous'
    : 'interactive';
  const scopedThreadId = input.isAutonomous ? null : input.threadId;

  const tierConfig = resolver(companionId, tier, scopedThreadId);
  const model = tierConfig.model;
  const modelRef = normalizeModelRef(
    `${tierConfig.provider}/${tierConfig.model}`,
  );

  return { tierConfig, model, modelRef, tier };
}
