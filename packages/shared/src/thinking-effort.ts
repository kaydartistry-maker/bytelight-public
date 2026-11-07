/**
 * Thinking effort resolution — single source of truth for the
 * `agent.thinking_effort` config knob.
 *
 * The user-facing setting accepts a named effort level OR `'auto'`,
 * which delegates the choice to a small per-model resolver. Auto's
 * goal is "sensible and cheap by default" — not "secretly expensive."
 * Heavier values (`xhigh`, `max`) stay available as explicit opt-ins
 * for users who want the big-brain firepower.
 *
 * Lives in `shared/` because both the backend (config resolution at
 * the SDK call site) and the frontend (Settings dropdown showing
 * "Auto resolves to: Chat X → high · Autonomous Y → high") need to
 * agree on the table. Keeps the displayed values matching what the
 * backend actually sends.
 */

/** Valid values for `agent.thinking_effort`. `'auto'` means "let the
 *  resolver pick per model."
 *
 *  Provider mapping (Rev 2.2 — multi-provider effort vocabulary, see
 *  `shared/per-provider-rendering-spec-2026-05-19.md` D4 and
 *  `shared/codex-runtime-lab-findings-2026-05-19.md` followup #4):
 *
 *  - Claude SDK accepts: `low | medium | high | xhigh | max`
 *  - Codex (pi-ai openai-codex-responses): `none | minimal | low | medium | high | xhigh`
 *
 *  This union is the SUPERSET — what any UI dropdown might surface. The
 *  per-provider option lists (see `getEffortOptionsForProvider`) decide
 *  which values are actually selectable for a given provider. UI gating
 *  is the safeguard against picking provider-invalid values (e.g.
 *  Claude can't accept `'none'`/`'minimal'`); the resolver passes the
 *  configured value through verbatim and trusts the dropdown to have
 *  filtered it. */
export type ThinkingEffort = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Concrete effort level the SDK accepts. Strict subset of `ThinkingEffort`
 *  excluding `'auto'` — what the resolver returns. */
export type ResolvedEffort = Exclude<ThinkingEffort, 'auto'>;

/**
 * Resolve a configured effort value to a concrete level for a given model.
 *
 * - If the user picked an explicit value (anything other than `'auto'`),
 *   return it verbatim — explicit overrides are respected, even if the
 *   model would 400 on them. We don't second-guess the user.
 * - If the user picked `'auto'` (or the value is missing/invalid), pick
 *   a conservative default per model class:
 *     - Haiku family → `'medium'` (lightweight; saves tokens)
 *     - Everything else (Opus / Sonnet) → `'high'` (solid reasoning, not
 *       wasteful, valid on every supported model)
 *
 * Auto deliberately does NOT return `'xhigh'` or `'max'` for any model.
 * Both are "spend freely" modes — `xhigh` is recommended for deep
 * agentic/coding work, `max` for frontier reasoning. Making either the
 * silent default would be like putting the agent in deep-research mode
 * for a "what time is it" query: funny once, expensive forever.
 *
 * Pulse turns don't go through this — they use `thinking: { type: 'disabled' }`
 * so the effort value is moot.
 */
export function resolveEffortForModel(
  model: string,
  configured: ThinkingEffort | string | undefined,
): ResolvedEffort {
  // Explicit non-auto choice: respect it as the user's intentional setting,
  // including provider-specific values (`none`, `minimal`) that only Codex
  // accepts. UI gating prevents Claude users from picking those; if they
  // appear in config anyway (manual YAML edit), the Claude SDK rejects them
  // at the wire — we don't second-guess the user here.
  if (
    configured === 'none' ||
    configured === 'minimal' ||
    configured === 'low' ||
    configured === 'medium' ||
    configured === 'high' ||
    configured === 'xhigh' ||
    configured === 'max'
  ) {
    return configured;
  }

  // Auto path (or missing/invalid value defaulting to auto behavior).
  // Match Haiku family by substring — covers `haiku` alias, pinned IDs
  // like `claude-haiku-4-5`, and any future Haiku variant.
  if (/haiku/i.test(model)) return 'medium';

  // Opus / Sonnet / family aliases / unknown future models: 'high' is
  // the safe baseline. Solid reasoning, not a wallet hit, valid across
  // every current model generation.
  return 'high';
}

// ---------------------------------------------------------------------------
// Provider-shaped effort dropdown options
// ---------------------------------------------------------------------------

/** One option in a reasoning-effort dropdown. */
export interface EffortOption {
  value: ThinkingEffort;
  label: string;
}

/**
 * Effort options as Claude's Agent SDK accepts them. Claude does NOT
 * recognize `'none'` or `'minimal'` — they are deliberately absent.
 */
const CLAUDE_EFFORT_OPTIONS: readonly EffortOption[] = [
  { value: 'auto',   label: 'Auto — picks safely per model (recommended)' },
  { value: 'max',    label: 'Max — frontier reasoning, spend freely (Opus 4.6+ only)' },
  { value: 'xhigh',  label: 'XHigh — deep agentic/coding work' },
  { value: 'high',   label: 'High — solid reasoning' },
  { value: 'medium', label: 'Medium — thinks when needed' },
  { value: 'low',    label: 'Low — minimal thinking, fastest responses' },
] as const;

/**
 * Effort options as pi-ai's `openai-codex-responses` provider accepts
 * them. Codex does NOT recognize `'max'` — `mapEffortForCodex` silently
 * coerces it to `'xhigh'`, but it's omitted here so the user doesn't
 * pick a "phantom" tier. `'none'` and `'minimal'` are Codex-only.
 *
 * `'auto'` translates to `undefined` at the runtime boundary, which
 * lets pi-ai pick the provider default (verified in lab findings as
 * "open a structural reasoning span but emit no content" for gpt-5.5).
 */
const CODEX_EFFORT_OPTIONS: readonly EffortOption[] = [
  { value: 'auto',    label: 'Auto — pi-ai picks the default' },
  { value: 'xhigh',   label: 'XHigh — maximum reasoning' },
  { value: 'high',    label: 'High — solid reasoning' },
  { value: 'medium',  label: 'Medium — thinks when needed' },
  { value: 'low',     label: 'Low — light reasoning' },
  { value: 'minimal', label: 'Minimal — quick reasoning pass' },
  { value: 'none',    label: 'None — skip reasoning entirely' },
] as const;

/**
 * Conservative fallback for providers we haven't carved out yet
 * (OpenRouter, Ollama). Three universally-recognized tiers + auto.
 * When those providers actually ship, replace with provider-specific
 * lists.
 */
const GENERIC_EFFORT_OPTIONS: readonly EffortOption[] = [
  { value: 'auto',   label: 'Auto — provider default' },
  { value: 'high',   label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low',    label: 'Low' },
] as const;

/**
 * Return the ordered reasoning-effort options the UI should surface for
 * a given provider. The dropdown reads from this — never from the
 * `ThinkingEffort` union directly — so each provider's selectable
 * tiers stay accurate (Codex has `none`/`minimal` and no `max`;
 * Claude has `max` but no `none`/`minimal`). See lab findings #4 for
 * why this exists.
 */
export function getEffortOptionsForProvider(
  provider: import('./model-manifest.js').ProviderId,
): readonly EffortOption[] {
  switch (provider) {
    case 'claude':       return CLAUDE_EFFORT_OPTIONS;
    case 'claude-cli':   return CLAUDE_EFFORT_OPTIONS; // CLI lane runs Claude models — same effort vocabulary
    case 'openai-codex': return CODEX_EFFORT_OPTIONS;
    case 'codex-cli':    return CODEX_EFFORT_OPTIONS; // warm-daemon CLI lane runs Codex models — same effort vocabulary
    case 'openai':
    case 'openrouter':
    case 'groq':
    case 'xai':
    case 'ollama':
      return GENERIC_EFFORT_OPTIONS;
  }
}

/**
 * Coerce a configured effort value to one valid for the given provider.
 * If the value is missing, `'auto'`, or accepted by the provider's
 * dropdown options, it passes through unchanged. Otherwise returns
 * `'auto'` — the safe universal fallback.
 *
 * Use this AT EVERY POINT where the (model, effort) pair could become
 * mismatched: UI model-change handlers (so a Claude → Codex switch
 * doesn't leave `max` lingering), autonomous "Match Chat" inheritance
 * (so chat's `none` doesn't bleed into a Claude autonomous turn), and
 * the backend resolve site (belt and suspenders).
 *
 * Returns `'auto'` for an explicit `''` (empty string) input — UI
 * "match other tier" semantics should NOT route through this helper;
 * coerce only the resolved value, not the sentinel.
 */
export function coerceEffortForProvider(
  provider: import('./model-manifest.js').ProviderId,
  effort: ThinkingEffort | string | undefined | null,
): ThinkingEffort {
  if (!effort || effort === 'auto') return 'auto';
  const valid = getEffortOptionsForProvider(provider).some((o) => o.value === effort);
  return valid ? (effort as ThinkingEffort) : 'auto';
}
