/**
 * Model manifest — type-only subset ported from Maggie's covenant/main,
 * extended with Codex (ChatGPT OAuth) catalog truth in 6B-C Slice 1 after
 * 6B-B sealed the Codex runtime + tool loop.
 *
 * Scope intent (byte-light):
 *   - Provide the *types* and *parsing helpers* (`ProviderId`, `RuntimeId`,
 *     `ModelRef`, `parseModelRef`, `unwrapModelRefForClaudeSdk`,
 *     `providerToRuntime`) so provider-router work has a stable vocabulary
 *     to compile against.
 *   - Functionally expose **Claude** and **Codex (ChatGPT OAuth)** models.
 *     Codex entries mirror the pi-ai `openai-codex` provider registry
 *     verbatim and are drift-tested against the installed package (see
 *     `packages/backend/src/services/runtimes/codex-manifest-drift.test.ts`).
 *   - OpenRouter / Ollama remain valid type values in the `ProviderId` /
 *     `RuntimeId` unions (so a canonical ref like `ollama/llama3` parses
 *     correctly into a `ModelRef`), but no `MODELS` rows ship here for
 *     them — those catalogs are surfaced via live discovery in
 *     `/api/models?provider=...`.
 *   - `unwrapModelRefForClaudeSdk` is the safety belt: any non-Claude ref
 *     that reaches the Claude SDK call site throws a friendly error
 *     instead of getting silently mis-routed. Codex refs go through
 *     CodexRuntime dispatch, not the Claude SDK.
 *
 * Codex catalog source of truth:
 *   The 7 Codex entries below mirror `node_modules/@earendil-works/pi-ai/
 *   dist/models.generated.js` block `"openai-codex"` at pi-ai 0.80.6. If
 *   pi-ai is upgraded and adds/removes/renames Codex models, the drift
 *   test fails loudly — sync the entries here before merging.
 *
 * What is intentionally still NOT here:
 *   - Codex-specific legacy aliases in `LEGACY_BARE_ID_ALIASES` (gpt-5*,
 *     o3, etc.) — only added if/when pi-ai renames Codex ids.
 *   - OpenRouter / Ollama / OpenAI BYOK rows — discovery-based, not
 *     mirrored here.
 *   - `MODEL_MIN_CC` map kept (Claude-only) because byte-light's
 *     runtime-health surfaces still want it; Codex has no `minClaudeCodeVersion`.
 */

// ---------------------------------------------------------------------------
// Provider / runtime / tier vocabulary
// ---------------------------------------------------------------------------

/** Provider namespace in canonical refs. Each provider maps to one runtime. */
export type ProviderId =
  | 'claude'         // Anthropic models via @anthropic-ai/claude-agent-sdk
  | 'openai'         // OpenAI direct BYOK (Step 6A) — chat.completions via openai-compat
  | 'openai-codex'   // OpenAI ChatGPT via Codex OAuth (TYPE ONLY — Step 6B, not wired)
  | 'openrouter'     // OpenRouter aggregator (wired through openai-compat runtime)
  | 'groq'           // Groq OpenAI-compatible API (wired through openai-compat runtime)
  | 'xai'            // xAI / Grok OpenAI-compatible API (wired through openai-compat runtime)
  | 'claude-cli'     // Claude via warm interactive `claude` CLI session (subscription/OAuth — heartbeat runtime)
  | 'codex-cli'      // OpenAI/ChatGPT via warm Codex app-server daemon (subscription/CLI-login — codex-daemon runtime, H2)
  | 'ollama';        // Local / Ollama Cloud (wired through ollama-native runtime)

/** Runtime implementation that handles turns for a provider. */
export type RuntimeId =
  | 'claude-sdk'        // wraps @anthropic-ai/claude-agent-sdk
  | 'claude-cli'        // wraps a warm interactive `claude` CLI session (heartbeat runtime, subscription-billed)
  | 'codex-cli'         // wraps the warm Codex app-server daemon (subscription-billed, ~/.codex/auth.json CLI-login door, H2)
  | 'codex'             // TYPE ONLY — wraps pi-ai openai-codex-responses (Step 6B, not wired)
  | 'openai-compat'     // generic OpenAI-compatible HTTP — wired (OpenAI direct + OpenRouter)
  | 'ollama-native';    // Ollama /api/chat NDJSON — wired (Ollama Cloud deployed 2026-06-04)

/** Map a provider to the runtime that handles it. */
export function providerToRuntime(provider: ProviderId): RuntimeId {
  switch (provider) {
    case 'claude':       return 'claude-sdk';
    case 'claude-cli':   return 'claude-cli';
    case 'codex-cli':    return 'codex-cli';
    case 'openai':       return 'openai-compat';
    case 'openai-codex': return 'codex';
    case 'openrouter':   return 'openai-compat';
    case 'groq':         return 'openai-compat';
    case 'xai':          return 'openai-compat';
    case 'ollama':       return 'ollama-native';
  }
}

/** Which model-resolution tier a model is suitable for. UI uses this to
 *  decide which dropdown a model appears in. */
export type TierHint = 'interactive' | 'autonomous' | 'pulse' | 'memory';

// ---------------------------------------------------------------------------
// Capability descriptor
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  /** Can consume MCP server tool definitions natively. Claude-SDK-only today. */
  mcp: boolean;
  /** Provider/runtime supports resuming a prior session by id. */
  sessionResume: boolean;
  /** Runtime can checkpoint and rewind filesystem state. Claude-SDK-only today. */
  fileCheckpointing: boolean;
}

/** Authentication shape required to use a model. */
export interface ModelAuth {
  type: 'claude-sdk' | 'codex-oauth' | 'api-key' | 'none';
  envVars?: string[];
}

// ---------------------------------------------------------------------------
// Model entry
// ---------------------------------------------------------------------------

export interface ModelEntry {
  /** Provider-native model id. */
  id: string;
  /** Human-facing label for the dropdown. */
  label: string;
  /** Provider namespace. */
  provider: ProviderId;
  /** Runtime implementation. */
  runtime: RuntimeId;
  /** Canonical provider-qualified ref (`<provider>/<id>`). */
  ref: string;
  /** Which dropdowns this model should appear in. */
  tierHints: TierHint[];
  /** What the model/runtime can do. */
  capabilities: ModelCapabilities;
  /** Authentication required to use it. */
  auth: ModelAuth;
  /** Minimum bundled Claude Code version this model requires. Only
   *  meaningful when `runtime: 'claude-sdk'`. */
  minClaudeCodeVersion?: string;
}

// ---------------------------------------------------------------------------
// Default capability sets (Claude-only in byte-light today)
// ---------------------------------------------------------------------------

const CLAUDE_SDK_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: true,
  reasoning: true,
  mcp: true,
  sessionResume: true,
  fileCheckpointing: true,
};

const CLAUDE_SDK_AUTH: ModelAuth = { type: 'claude-sdk' };

/** Build a Claude-SDK entry with provider/runtime/ref/capabilities filled in. */
function claudeEntry(
  id: string,
  label: string,
  tierHints: TierHint[],
  minClaudeCodeVersion?: string,
): ModelEntry {
  return {
    id,
    label,
    provider: 'claude',
    runtime: 'claude-sdk',
    ref: `claude/${id}`,
    tierHints,
    capabilities: CLAUDE_SDK_CAPABILITIES,
    auth: CLAUDE_SDK_AUTH,
    ...(minClaudeCodeVersion ? { minClaudeCodeVersion } : {}),
  };
}

// ---------------------------------------------------------------------------
// Codex (ChatGPT OAuth) capability sets
// ---------------------------------------------------------------------------
// All pi-ai openai-codex models advertise reasoning + tool use through the
// Responses API. MCP-native tool catalogs and Claude-SDK file checkpointing
// are claude-sdk-only — flagged false here so callers can gate features
// without a per-provider lookup. SessionResume is true: Codex Responses API
// supports `prompt_cache_key`, `previous_response_id`, and per-session
// WebSocket continuation, which CodexRuntime uses to keep multi-turn state.

const CODEX_OAUTH_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: true,
  reasoning: true,
  mcp: false,
  sessionResume: true,
  fileCheckpointing: false,
};

const CODEX_OAUTH_CAPABILITIES_TEXT_ONLY: ModelCapabilities = {
  ...CODEX_OAUTH_CAPABILITIES,
  vision: false,
};

const CODEX_OAUTH_AUTH: ModelAuth = { type: 'codex-oauth' };

/** Build a Codex (ChatGPT OAuth) entry. Defaults to vision-capable; pass
 *  `{ vision: false }` for text-only models (e.g. gpt-5.3-codex-spark). */
function codexEntry(
  id: string,
  label: string,
  tierHints: TierHint[],
  options: { vision?: boolean } = {},
): ModelEntry {
  const vision = options.vision ?? true;
  return {
    id,
    label,
    provider: 'openai-codex',
    runtime: 'codex',
    ref: `openai-codex/${id}`,
    tierHints,
    capabilities: vision ? CODEX_OAUTH_CAPABILITIES : CODEX_OAUTH_CAPABILITIES_TEXT_ONLY,
    auth: CODEX_OAUTH_AUTH,
  };
}

// ---------------------------------------------------------------------------
// Codex-CLI (warm daemon) capability set + entry builder — H2
// ---------------------------------------------------------------------------
// The codex-cli lane runs the SAME OpenAI/Codex model ids as the openai-codex
// (June API) door, but dispatches through the warm Codex app-server daemon
// (codex-daemon runtime) on the operator's ChatGPT CLI-login (`~/.codex/auth.json`)
// — NOT pi-ai's Responses API BYOK path. The two doors are deliberately
// distinct (H2 preflight §3). Auth here is `none` at the manifest layer: the
// daemon owns its own login, so there are no byte-light-side env vars to gate.
// sessionResume is true (daemon-resident threads are the resume). mcp true
// (the daemon runs its own MCP servers).

const CODEX_CLI_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: true,
  reasoning: true,
  mcp: true,
  sessionResume: true,
  fileCheckpointing: false,
};

const CODEX_CLI_CAPABILITIES_TEXT_ONLY: ModelCapabilities = {
  ...CODEX_CLI_CAPABILITIES,
  vision: false,
};

/** Build a Codex-CLI (warm daemon) entry. Mirrors `codexEntry` but under the
 *  `codex-cli` provider/runtime. Auth is `none` — the daemon owns its login. */
function codexCliEntry(
  id: string,
  label: string,
  tierHints: TierHint[],
  options: { vision?: boolean } = {},
): ModelEntry {
  const vision = options.vision ?? true;
  return {
    id,
    label,
    provider: 'codex-cli',
    runtime: 'codex-cli',
    ref: `codex-cli/${id}`,
    tierHints,
    capabilities: vision ? CODEX_CLI_CAPABILITIES : CODEX_CLI_CAPABILITIES_TEXT_ONLY,
    auth: { type: 'none' },
  };
}

// ---------------------------------------------------------------------------
// The manifest — Claude (SDK) + Codex (ChatGPT OAuth)
// ---------------------------------------------------------------------------

/** Tier-hint conventions:
 *  - Opus: interactive + autonomous (heavy reasoning; not memory or pulse)
 *  - Sonnet: interactive + autonomous + memory (balanced; structured output OK)
 *  - Haiku: every tier (cheap + reliable; the pulse + memory default)
 *  - Codex: interactive + autonomous baseline. Tier promotion (memory/pulse)
 *    deferred to a later slice — Slice 1 ships catalog truth only.
 */
export const MODELS: readonly ModelEntry[] = [
  // Pinned versions
  claudeEntry('claude-fable-5-1', 'Fable 5.1', ['interactive', 'autonomous']),
  claudeEntry('claude-opus-5-5', 'Opus 5.5', ['interactive', 'autonomous']),
  claudeEntry('claude-sonnet-5-5', 'Sonnet 5.5', ['interactive', 'autonomous', 'memory']),
  claudeEntry('claude-haiku-5-5', 'Haiku 5.5', ['interactive', 'autonomous', 'pulse', 'memory']),
  claudeEntry('claude-fable-5', 'Fable 5', ['interactive', 'autonomous']),
  claudeEntry('claude-opus-4-8', 'Opus 4.8', ['interactive', 'autonomous']),
  claudeEntry('claude-sonnet-5', 'Sonnet 5', ['interactive', 'autonomous', 'memory']),
  claudeEntry('claude-opus-5', 'Opus 5', ['interactive', 'autonomous']),
  claudeEntry('claude-opus-4-7', 'Opus 4.7', ['interactive', 'autonomous'], '2.1.111'),
  claudeEntry('claude-opus-4-6', 'Opus 4.6', ['interactive', 'autonomous']),
  claudeEntry('claude-opus-4-5', 'Opus 4.5', ['interactive', 'autonomous']),
  claudeEntry('claude-sonnet-4-6', 'Sonnet 4.6', ['interactive', 'autonomous', 'memory']),
  claudeEntry('claude-sonnet-4-5', 'Sonnet 4.5', ['interactive', 'autonomous', 'memory']),
  claudeEntry('claude-haiku-4-5', 'Haiku 4.5', ['interactive', 'autonomous', 'pulse', 'memory']),
  // Family aliases — auto-track the latest of each family server-side.
  claudeEntry('opus', 'Opus (latest, auto-updates)', ['interactive', 'autonomous'], '2.1.111'),
  claudeEntry('sonnet', 'Sonnet (latest, auto-updates)', ['interactive', 'autonomous', 'memory']),
  claudeEntry('haiku', 'Haiku (latest, auto-updates)', ['interactive', 'autonomous', 'pulse', 'memory']),
  // Codex (ChatGPT OAuth) — mirrors pi-ai 0.80.6 `openai-codex` provider
  // registry. Drift-tested in codex-manifest-drift.test.ts.
  codexEntry('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', ['interactive', 'autonomous'], { vision: false }),
  codexEntry('gpt-5.4', 'GPT-5.4', ['interactive', 'autonomous']),
  codexEntry('gpt-5.4-mini', 'GPT-5.4 Mini', ['interactive', 'autonomous']),
  codexEntry('gpt-5.5', 'GPT-5.5', ['interactive', 'autonomous']),
  codexEntry('gpt-5.6-sol', 'GPT-5.6 Sol', ['interactive', 'autonomous']),
  codexEntry('gpt-5.6-terra', 'GPT-5.6 Terra', ['interactive', 'autonomous']),
  codexEntry('gpt-5.6-luna', 'GPT-5.6 Luna', ['interactive', 'autonomous']),
  // Codex-CLI (warm daemon, H2) — same Codex model ids as the openai-codex
  // door, dispatched through the warm daemon on the operator's ChatGPT login.
  // Kept in lock-step with the codexEntry rows above (H2 preflight: reuse the
  // existing openai-codex id list under the new codex-cli/ prefix). The
  // codex-manifest-drift test only checks provider==='openai-codex', so these
  // rows do not affect it.
  //
  // POLICY: codex-cli mirrors the openai-codex catalog (the codexEntry rows
  // above) by convention. No drift test governs these rows — when the
  // openai-codex list changes to match a pi-ai upgrade, mirror the same
  // add/remove here by hand.
  codexCliEntry('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark (CLI)', ['interactive', 'autonomous'], { vision: false }),
  codexCliEntry('gpt-5.4', 'GPT-5.4 (Codex CLI)', ['interactive', 'autonomous']),
  codexCliEntry('gpt-5.4-mini', 'GPT-5.4 Mini (Codex CLI)', ['interactive', 'autonomous']),
  codexCliEntry('gpt-5.5', 'GPT-5.5 (Codex CLI)', ['interactive', 'autonomous']),
  codexCliEntry('gpt-5.6-sol', 'GPT-5.6 Sol (Codex CLI)', ['interactive', 'autonomous']),
  codexCliEntry('gpt-5.6-terra', 'GPT-5.6 Terra (Codex CLI)', ['interactive', 'autonomous']),
  codexCliEntry('gpt-5.6-luna', 'GPT-5.6 Luna (Codex CLI)', ['interactive', 'autonomous']),
  // Subscription-backed additions. Deliberately CLI-only: ChatGPT account
  // access must never be mistaken for an OpenAI API/BYOK entitlement.
  codexCliEntry('gpt-6.1-sol', 'GPT-6.1 Sol (Codex CLI)', ['interactive', 'autonomous']),
  codexCliEntry('gpt-6-astra', 'GPT-6 Astra (Codex CLI)', ['interactive', 'autonomous']),
  codexCliEntry('gpt-6-sol', 'GPT-6 Sol (Codex CLI)', ['interactive', 'autonomous']),
  codexCliEntry('gpt-6-luna', 'GPT-6 Luna (Codex CLI)', ['interactive', 'autonomous']),
] as const;

/**
 * Map of model id → minimum Claude Code version. Derived from `MODELS`.
 * Keyed by raw `id` (not canonical ref) for back-compat.
 */
export const MODEL_MIN_CC: ReadonlyMap<string, string> = new Map(
  MODELS
    .filter((m): m is ModelEntry & { minClaudeCodeVersion: string } => !!m.minClaudeCodeVersion)
    .map((m) => [m.id, m.minClaudeCodeVersion]),
);

// ---------------------------------------------------------------------------
// OpenAI direct (BYOK) — curated featured metadata (Step 6A)
// ---------------------------------------------------------------------------

/**
 * Curated metadata layer for OpenAI direct chat models. Used by the
 * /api/models endpoint to decorate live-discovered models with friendly
 * labels, dropdown sort order, and an optional UX badge.
 *
 * RULES — read before editing:
 *   - This metadata does NOT create availability. Live discovery via
 *     `/v1/models` is the source of truth: a featured id that doesn't come
 *     back from discovery must NOT appear selectable (no ghost rows).
 *   - `*-codex` discovered ids must NOT receive featured treatment — they're
 *     real models but the Codex / ChatGPT OAuth lane is Step 6B, not here.
 *   - Adding a new id here only changes label/sort/badge — it cannot force
 *     a model into the dropdown.
 */
export const OPENAI_FEATURED_MODELS = {
  'gpt-5.6-sol':   { label: 'GPT-5.6 Sol',   featured: true, sortPriority: 4, badge: 'flagship' },
  'gpt-5.6-terra': { label: 'GPT-5.6 Terra', featured: true, sortPriority: 6 },
  'gpt-5.6-luna':  { label: 'GPT-5.6 Luna',  featured: true, sortPriority: 8 },
  'gpt-5.5':       { label: 'GPT-5.5',       featured: true, sortPriority: 10 },
  'gpt-5.4':       { label: 'GPT-5.4',       featured: true, sortPriority: 20 },
  'gpt-5.4-mini':  { label: 'GPT-5.4 mini',  featured: true, sortPriority: 30 },
  'gpt-5.4-nano':  { label: 'GPT-5.4 nano',  featured: true, sortPriority: 40 },
  'gpt-5':         { label: 'GPT-5',         featured: true, sortPriority: 50 },
  'gpt-5-mini':    { label: 'GPT-5 mini',    featured: true, sortPriority: 60 },
  'gpt-5-nano':    { label: 'GPT-5 nano',    featured: true, sortPriority: 70 },
  'gpt-4o':        { label: 'GPT-4o',        featured: true, sortPriority: 80 },
  'gpt-4o-mini':   { label: 'GPT-4o mini',   featured: true, sortPriority: 90 },
} as const;

// ---------------------------------------------------------------------------
// Model reference parsing + normalization
// ---------------------------------------------------------------------------

/** Resolved model reference — what the resolver hands to a runtime. */
export interface ModelRef {
  /** Canonical form, `<provider>/<model>`. */
  canonical: string;
  /** Provider namespace. */
  provider: ProviderId;
  /** Provider-native model id (the value handed to the SDK / API). */
  model: string;
  /** Runtime implementation that should execute this ref. */
  runtime: RuntimeId;
}

/** Known provider prefixes — kept broad so canonical refs from any provider
 *  parse cleanly. Functional wiring is Claude-only; non-Claude refs hit the
 *  `unwrapModelRefForClaudeSdk` guard if they ever reach the SDK call site. */
const KNOWN_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  'claude',
  'openai',
  'openai-codex',
  'openrouter',
  'groq',
  'xai',
  'claude-cli',
  'codex-cli',
  'ollama',
]);

/**
 * Parse a canonical `<provider>/<model>` ref. Splits on the FIRST `/`.
 * Returns `null` if the input doesn't contain `/` or if the provider
 * prefix is unknown.
 */
export function parseModelRef(canonical: string): ModelRef | null {
  const slash = canonical.indexOf('/');
  if (slash < 0) return null;
  const provider = canonical.slice(0, slash) as ProviderId;
  const model = canonical.slice(slash + 1);
  if (!KNOWN_PROVIDERS.has(provider)) return null;
  if (!model) return null;
  return {
    canonical,
    provider,
    model,
    runtime: providerToRuntime(provider),
  };
}

/**
 * Aliases for bare ids whose manifest entry has been replaced.
 *
 * Add entries here whenever a manifest id changes — e.g. if pi-ai renames
 * a Codex model, alias the old id to the new one so persisted thread-scope
 * settings keep resolving instead of falling through to the Claude fallback.
 */
const LEGACY_BARE_ID_ALIASES: Record<string, string> = {
  // Reserved for future id renames. Currently empty.
};

/**
 * Normalize either a legacy bare model id (`claude-sonnet-4-6`, `sonnet`)
 * or a canonical ref (`claude/claude-sonnet-4-6`) to a `ModelRef`.
 *
 * Back-compat rules:
 * - Input contains `/` AND has a known provider prefix → treat as canonical.
 * - Otherwise → treat as a legacy Claude id.
 */
export function normalizeModelRef(input: string): ModelRef {
  if (!input || !input.trim()) {
    throw new Error('normalizeModelRef: empty model reference');
  }
  const trimmed = input.trim();

  // Canonical form path
  if (trimmed.includes('/')) {
    const parsed = parseModelRef(trimmed);
    if (parsed) return parsed;
    const prefix = trimmed.slice(0, trimmed.indexOf('/'));
    throw new Error(
      `normalizeModelRef: unknown provider "${prefix}" in "${trimmed}". ` +
      `Known providers: ${[...KNOWN_PROVIDERS].join(', ')}.`,
    );
  }

  // Bare-id path: check the manifest first.
  const entry = MODELS.find((m) => m.id === trimmed);
  if (entry) {
    return {
      canonical: entry.ref,
      provider: entry.provider,
      model: entry.id,
      runtime: entry.runtime,
    };
  }

  // Legacy alias map (Claude-only in byte-light).
  const aliased = LEGACY_BARE_ID_ALIASES[trimmed];
  if (aliased) {
    return normalizeModelRef(aliased);
  }

  // Legacy fallback: assume Claude. Every pre-multi-provider config
  // value was a Claude id; typoed ids surface at the SDK boundary.
  return {
    canonical: `claude/${trimmed}`,
    provider: 'claude',
    model: trimmed,
    runtime: 'claude-sdk',
  };
}

/**
 * Look up a `ModelEntry` for a ref or legacy id. Returns `undefined` if
 * no manifest entry matches.
 */
export function findModelByRef(input: string): ModelEntry | undefined {
  let ref: ModelRef;
  try {
    ref = normalizeModelRef(input);
  } catch {
    return undefined;
  }
  return MODELS.find((m) => m.ref === ref.canonical);
}

/**
 * Filter the manifest down to models whose tierHints include the given
 * tier.
 */
export function getModelsForTier(tier: TierHint): readonly ModelEntry[] {
  return MODELS.filter((m) => m.tierHints.includes(tier));
}

/**
 * Unwrap a `ModelRef` to the raw provider-native string the Claude Agent
 * SDK expects (e.g. `claude-sonnet-4-6`, `sonnet`).
 *
 * Throws a friendly error if `ref.runtime !== 'claude-sdk'` — protects
 * the SDK boundary from being handed a model that requires a runtime
 * that isn't wired up in byte-light. In Maggie's covenant/main this was
 * a defensive belt; in byte-light P0 it is THE enforcement point.
 */
export function unwrapModelRefForClaudeSdk(ref: ModelRef, tierLabel?: string): string {
  if (ref.runtime !== 'claude-sdk') {
    const tierPart = tierLabel ? ` for the ${tierLabel} tier` : '';
    throw new Error(
      `Model "${ref.canonical}" requires the ${ref.runtime} runtime, but ` +
      `only the claude-sdk runtime is wired up in this build. Switch back ` +
      `to a Claude model${tierPart} in Settings.`,
    );
  }
  return ref.model;
}
