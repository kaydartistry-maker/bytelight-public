/**
 * GET /api/models — live model catalog across configured providers.
 *
 * Sourced from reference implementation @ 1ceb24a `routes/models.ts` with three byte-light Step 3 changes:
 *
 *   1. `runtime` field added to ModelInfo, populated from
 *      `providerToRuntime(provider)` so the UI can gate capability controls
 *      (effort dropdown, MCP picker) without re-parsing the provider id.
 *
 *   2. Provider catalogs that aren't activated in Step 3 (OpenRouter, Groq,
 *      xAI, OpenAI direct, HuggingFace) gate their live HTTP probes behind
 *      a config-presence check — if the `api_key` isn't set, the section
 *      is skipped entirely rather than 401-spamming on every request.
 *      reference implementation version also gated by config, so this is a 1:1 port.
 *
 *   3. Codex tier removed for Step 3 (no Codex auth flow yet — Step 5+).
 *      The CODEX_MODELS array stays as a code path but is unreachable
 *      until `isCodexLoggedIn()` exists, which it doesn't in byte-light yet.
 *
 *   4. Ollama discovery additionally gates on the two-stage rollback flag
 *      (`providers.ollama.enabled`). If the URL is configured but the
 *      flag is off, Ollama is hidden from the catalog so the UI can't
 *      offer it — matches the dispatcher's refusal to resolve it.
 */

import { Router, type Request, type Response } from 'express';
import { getBytelightConfig } from '../config.js';
import {
  providerToRuntime,
  OPENAI_FEATURED_MODELS,
  MODELS as SHARED_MODELS,
  type ProviderId,
  type RuntimeId,
} from '@bytelight/shared';
// pi-ai 0.80.6 moved the static catalog read `getModel` off the top-level
// barrel into the `/compat` entrypoint.
import { getModel as getPiModel } from '@earendil-works/pi-ai/compat';
import {
  getCodexAuthSnapshot,
  type CodexAuthSnapshot,
} from '../services/auth/codex-oauth.js';
import { errMessage } from '../util/errors.js';

const router: Router = Router();

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  /** Runtime that handles this model — used by the UI to gate capability controls. */
  runtime: RuntimeId;
  tier: 'free' | 'paid' | 'included' | 'local';
  description?: string;
  context_length?: number;
  supports_tools?: boolean;
  /** Canonical ModelRef string (`<provider>/<id>`) — UI uses this for setting model. */
  ref: string;
  // ── Step 6A: curated featured metadata (OpenAI direct today; extensible) ──
  /** True when the manifest curates this id (label/sort/badge). */
  featured?: boolean;
  /** Dropdown sort order. Lower numbers sort first. Default 500 for un-curated. */
  sortPriority?: number;
  /** Optional UX badge — 'flagship', 'advanced', etc. */
  badge?: string;
}

/**
 * Compose the `/v1/models` endpoint for an OpenAI-compatible base URL.
 * Handles both shapes the product accepts:
 *   - Trailing-slash-agnostic ("https://api.openai.com/v1" or ".../v1/")
 *   - With or without the `/v1` suffix already present on the base
 *
 * Avoids `.../v1/v1/models` when the user keeps the OpenAI default base.
 */
export function modelsEndpointForBaseUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  return clean.endsWith('/v1') ? `${clean}/models` : `${clean}/v1/models`;
}

/**
 * Build the Codex catalog rows — pure, no I/O, no config dependency. Sourced
 * from @bytelight/shared MODELS (Slice 1 catalog truth), decorated with
 * context_window from the pi-ai registry. Skips any shared entry pi-ai
 * doesn't recognise (the Slice 1 drift test catches the mismatch case;
 * skipping here keeps a phantom row from shipping if a runtime regression
 * slips past).
 *
 * Lifted out of the route handler so tests can exercise it without spinning
 * up an express router, matching the `computeCodexAvailability` pattern.
 */
export function buildCodexCatalogEntries(): ModelInfo[] {
  const out: ModelInfo[] = [];
  const sharedCodexEntries = SHARED_MODELS.filter((m) => m.provider === 'openai-codex');
  for (const entry of sharedCodexEntries) {
    const piModel = getPiModel('openai-codex', entry.id as never);
    if (!piModel) continue;
    out.push({
      id: entry.id,
      name: entry.label,
      provider: 'openai-codex',
      runtime: 'codex',
      tier: 'included',
      context_length: piModel.contextWindow,
      supports_tools: entry.capabilities.tools,
      ref: entry.ref,
    });
  }
  return out;
}

/**
 * Build the Codex-CLI (warm daemon, H2) catalog rows. Same catalog-truth
 * source as `buildCodexCatalogEntries` (shared MODELS), filtered to the
 * `codex-cli` provider. Context window is decorated from the pi-ai registry
 * under `openai-codex` (the daemon runs the SAME underlying model ids), but a
 * missing pi-ai row does NOT drop the entry here — the codex-cli lane's
 * availability is the daemon's own, not pi-ai's, so we surface the catalog
 * regardless (unlike the openai-codex door, which skips pi-ai-unknown ids).
 */
export function buildCodexCliCatalogEntries(): ModelInfo[] {
  const out: ModelInfo[] = [];
  const sharedEntries = SHARED_MODELS.filter((m) => m.provider === 'codex-cli');
  for (const entry of sharedEntries) {
    const piModel = getPiModel('openai-codex', entry.id as never);
    out.push({
      id: entry.id,
      name: entry.label,
      provider: 'codex-cli',
      runtime: 'codex-cli',
      tier: 'included',
      ...(piModel ? { context_length: piModel.contextWindow } : {}),
      supports_tools: entry.capabilities.tools,
      ref: entry.ref,
    });
  }
  return out;
}

// Claude models — always available via SDK (matches model-manifest entries).
const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-fable-5-1' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-opus-5-5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-sonnet-5-5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-haiku-5-5' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-fable-5' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-opus-4-8' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-sonnet-5' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-opus-5' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-opus-4-7' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-opus-4-6' },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 200000, supports_tools: true, ref: 'claude/claude-opus-4-5' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 1000000, supports_tools: true, ref: 'claude/claude-sonnet-4-6' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 200000, supports_tools: true, ref: 'claude/claude-sonnet-4-5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'claude', runtime: 'claude-sdk', tier: 'included', context_length: 200000, supports_tools: true, ref: 'claude/claude-haiku-4-5' },
];

/**
 * Build the Ollama live-discovery catalog. Returns [] if Ollama is not
 * configured / not enabled / unreachable. Tries OpenAI-compat `/v1/models`
 * first then falls back to the native `/api/tags` endpoint per reference implementation
 * router.ts approach.
 */
async function discoverOllamaModels(): Promise<ModelInfo[]> {
  const cfg = getBytelightConfig();
  const ollama = cfg.providers.ollama;
  if (!ollama?.base_url) return [];
  // Two-stage gate: even if base_url is set, refuse discovery when the
  // enabled flag is off. This keeps the catalog and the dispatcher in
  // perfect lockstep — the UI never offers a model the dispatcher would
  // refuse to resolve.
  if (!ollama.enabled) return [];

  const baseUrl = ollama.base_url.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (ollama.api_key) headers['Authorization'] = `Bearer ${ollama.api_key}`;

  let ollamaModels: string[] = [];

  // Try OpenAI-compat endpoint first.
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json() as any;
      ollamaModels = (data.data || []).map((m: any) => m.id);
    }
  } catch {
    // Fall through to native API.
  }

  // Fallback: native Ollama API.
  if (ollamaModels.length === 0) {
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json() as any;
        ollamaModels = (data.models || []).map((m: any) => m.name);
      }
    } catch { /* Ollama unreachable */ }
  }

  return ollamaModels.map(id => ({
    id,
    name: id,
    provider: 'ollama' as const,
    runtime: providerToRuntime('ollama'),
    tier: 'local' as const,
    ref: `ollama/${id}`,
  }));
}

/**
 * GET /api/models — full model catalog. Optional `?provider=ollama`
 * filter narrows to a single provider.
 */
router.get('/models', async (req: Request, res: Response) => {
  const cfg = getBytelightConfig();
  const providers = cfg.providers;
  const providerFilter = typeof req.query.provider === 'string' ? req.query.provider : undefined;
  const models: ModelInfo[] = [];

  // Claude — always available via SDK regardless of routing mode.
  if (!providerFilter || providerFilter === 'claude' || providerFilter === 'anthropic') {
    models.push(...CLAUDE_MODELS);
  }

  // Ollama — live discovery, gated by enabled flag.
  if (!providerFilter || providerFilter === 'ollama') {
    models.push(...(await discoverOllamaModels()));
  }

  // OpenRouter — gate on api_key presence AND non-'sdk' routing. The
  // catalog and dispatcher must agree; if routing=sdk would refuse the
  // model, we don't offer it.
  if ((!providerFilter || providerFilter === 'openrouter') && providers.openrouter?.api_key && cfg.agent.routing !== 'sdk') {
    try {
      const orRes = await fetch('https://openrouter.ai/api/v1/models', {
        signal: AbortSignal.timeout(8000),
      });
      if (orRes.ok) {
        const data = await orRes.json() as any;
        for (const m of (data.data || [])) {
          const isFree = m.id?.endsWith(':free') ||
            (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
          const supportsTools = Array.isArray(m.supported_parameters)
            ? m.supported_parameters.includes('tools')
            : undefined;
          models.push({
            id: m.id,
            name: m.name || m.id,
            provider: 'openrouter',
            runtime: 'openai-compat',
            tier: isFree ? 'free' : 'paid',
            description: m.description || undefined,
            context_length: m.context_length || undefined,
            supports_tools: supportsTools,
            ref: `openrouter/${m.id}`,
          });
        }
      }
    } catch { /* OpenRouter unreachable */ }
  }

  // Groq / xAI / OpenAI / HuggingFace catalogs are gated on api_key AND
  // routing != 'sdk'. They're declared but not in byte-light's
  // ProviderId union yet — so we surface them with a `provider` string
  // for the UI but flag `runtime: 'openai-compat'` so capability
  // queries route correctly.
  if ((!providerFilter || providerFilter === 'groq') && providers.groq?.api_key && cfg.agent.routing !== 'sdk') {
    try {
      const baseUrl = (providers.groq.base_url || 'https://api.groq.com/openai').replace(/\/+$/, '');
      const groqRes = await fetch(`${baseUrl}/v1/models`, {
        headers: { 'Authorization': `Bearer ${providers.groq.api_key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (groqRes.ok) {
        const data = await groqRes.json() as any;
        for (const m of (data.data || [])) {
          models.push({
            id: m.id,
            name: m.id,
            provider: 'groq',
            runtime: 'openai-compat',
            tier: 'included',
            supports_tools: true,
            ref: `groq/${m.id}`,
          });
        }
      }
    } catch { /* Groq unreachable */ }
  }

  if ((!providerFilter || providerFilter === 'xai') && providers.xai?.api_key && cfg.agent.routing !== 'sdk') {
    try {
      const baseUrl = (providers.xai.base_url || 'https://api.x.ai').replace(/\/+$/, '');
      const xaiRes = await fetch(`${baseUrl}/v1/models`, {
        headers: { 'Authorization': `Bearer ${providers.xai.api_key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (xaiRes.ok) {
        const data = await xaiRes.json() as any;
        for (const m of (data.data || [])) {
          models.push({
            id: m.id,
            name: m.id,
            provider: 'xai',
            runtime: 'openai-compat',
            tier: 'included',
            ref: `xai/${m.id}`,
          });
        }
      }
    } catch { /* xAI unreachable */ }
  }

  // OpenAI direct (BYOK) — Step 6A. Mirrors the Ollama discipline: configured
  // + enabled + routing != 'sdk'. Discovered ids decorated with featured
  // metadata (label/sort/badge) where present; *-codex ids deliberately
  // flagged as Step 6B (not featured, no flagship badge).
  if (
    (!providerFilter || providerFilter === 'openai') &&
    providers.openai?.enabled &&
    providers.openai?.api_key &&
    cfg.agent.routing !== 'sdk'
  ) {
    try {
      const baseUrl = providers.openai.base_url || 'https://api.openai.com/v1';
      const oaiRes = await fetch(modelsEndpointForBaseUrl(baseUrl), {
        headers: { 'Authorization': `Bearer ${providers.openai.api_key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (oaiRes.ok) {
        const data = await oaiRes.json() as any;
        const chatModels = (data.data || []).filter((m: any) =>
          m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3') || m.id.startsWith('chatgpt')
        );
        for (const m of chatModels) {
          const id: string = m.id;
          const isCodex = id.endsWith('-codex') || id.includes('-codex-');
          const featuredMeta = (OPENAI_FEATURED_MODELS as Record<string, { label: string; featured: boolean; sortPriority: number; badge?: string }>)[id];
          if (featuredMeta && !isCodex) {
            models.push({
              id,
              name: featuredMeta.label,
              provider: 'openai',
              runtime: 'openai-compat',
              tier: 'included',
              supports_tools: true,
              ref: `openai/${id}`,
              featured: true,
              sortPriority: featuredMeta.sortPriority,
              ...(featuredMeta.badge ? { badge: featuredMeta.badge } : {}),
            });
          } else if (isCodex) {
            // Codex/ChatGPT OAuth is Step 6B — surface but don't feature.
            models.push({
              id,
              name: id,
              provider: 'openai',
              runtime: 'openai-compat',
              tier: 'included',
              supports_tools: true,
              ref: `openai/${id}`,
              featured: false,
              sortPriority: 500,
              badge: 'advanced',
              description: 'Discovered via OpenAI API; Codex/ChatGPT OAuth is Step 6B.',
            });
          } else {
            models.push({
              id,
              name: id,
              provider: 'openai',
              runtime: 'openai-compat',
              tier: 'included',
              supports_tools: true,
              ref: `openai/${id}`,
              featured: false,
              sortPriority: 500,
            });
          }
        }
      }
    } catch { /* OpenAI unreachable */ }
  }

  // Codex (ChatGPT OAuth) — 6B-C Slice 2 catalog exposure.
  // Catalog-ONLY: no auth status, no tokens, no availability gating.
  // Selectability gating lives in GET /api/models/status — catalog truth
  // ≠ usable-right-now. Returned unconditionally (not gated on routing
  // mode) because Codex dispatches through CodexRuntime, not the
  // api-router; routing='sdk' does not refuse it. Matches Claude's
  // unconditional catalog behavior.
  if (!providerFilter || providerFilter === 'openai-codex') {
    models.push(...buildCodexCatalogEntries());
  }

  // Codex-CLI (warm daemon, H2) — catalog exposure. Same unconditional,
  // catalog-only behavior as the openai-codex door above: no auth status, no
  // routing gate (the codex-cli lane dispatches through the warm daemon, not
  // the api-router, so routing='sdk' does not refuse it). The daemon owns its
  // own login (~/.codex/auth.json); usable-right-now is surfaced by the picker
  // itself (codex-cli is always selectable, like claude-cli).
  if (!providerFilter || providerFilter === 'codex-cli') {
    models.push(...buildCodexCliCatalogEntries());
  }

  if ((!providerFilter || providerFilter === 'huggingface') && providers.huggingface?.api_key && cfg.agent.routing !== 'sdk') {
    try {
      const baseUrl = (providers.huggingface.base_url || 'https://router.huggingface.co').replace(/\/+$/, '');
      const hfRes = await fetch(`${baseUrl}/v1/models`, {
        headers: { 'Authorization': `Bearer ${providers.huggingface.api_key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (hfRes.ok) {
        const data = await hfRes.json() as any;
        for (const m of (data.data || [])) {
          models.push({
            id: m.id,
            name: m.id,
            provider: 'huggingface',
            runtime: 'openai-compat',
            tier: 'free',
            ref: `huggingface/${m.id}`,
          });
        }
      }
    } catch { /* HuggingFace unreachable */ }
  }

  res.json(models);
});

// ─── Codex availability — 6B-C Slice 2 ─────────────────────────────────────
// Pure function: snapshot + nowMs → availability shape. Lifted out of the
// route handler so tests can drive it with synthesized snapshots without
// touching the file system / OAuth substrate. Route handler becomes a thin
// wrapper that fetches the snapshot via the documented-safe helper and
// passes it through.
//
// Refresh-on-use verified (codex.ts:674 calls getCodexAccessToken before any
// provider call → triggers refresh when expiry within REFRESH_LEADTIME_MS).
// Therefore expired+refreshable → optimistic available: true per the
// Slice 2 hard refresh verification gate. If pi-ai's refresh flow is ever
// removed, this branch must be downgraded to needsAuth.

/** Per-Codex-status response shape. Canonical provider id, runtime
 *  declared as a static field (no registry — runtime is wired by
 *  module-load construction in services/runtimes/index.ts). */
export interface CodexAvailabilityStatus {
  provider: 'openai-codex';
  runtime: 'codex';
  /** True when a turn dispatched now would succeed. Includes the
   *  optimistic expired+refreshable case (refresh-on-use verified). */
  available: boolean;
  /** True only when the access token is still within its expiry window
   *  (no refresh needed). Stricter than `available`. */
  connected: boolean;
  /** True when the user must complete an OAuth flow before Codex works. */
  needsAuth: boolean;
  reason: 'connected' | 'expired' | 'needs_auth' | 'login_in_progress';
  /** Access token expiry timestamp (ms). null when no credentials file. */
  expiresAt: number | null;
  /** True when a refresh token is present. Slice 3 UI uses this to render
   *  "Reconnect" vs "Will refresh on next turn" copy. */
  refreshable: boolean;
}

/**
 * Compute Codex availability from a safe auth snapshot. Pure function —
 * no I/O, no side effects, no network. Side-effect-free per 6B-C Slice 2
 * pin #1: status polling must never trigger token refresh or external calls.
 */
export function computeCodexAvailability(
  snapshot: CodexAuthSnapshot,
  nowMs: number = Date.now(),
): CodexAvailabilityStatus {
  const { loggedIn, expiresAt, refreshable, loginSession } = snapshot;

  // Connected: credentials file present, access token still within expiry.
  if (loggedIn && expiresAt != null && expiresAt > nowMs) {
    return {
      provider: 'openai-codex',
      runtime: 'codex',
      available: true,
      connected: true,
      needsAuth: false,
      reason: 'connected',
      expiresAt,
      refreshable,
    };
  }

  // Expired but refreshable — optimistic per the Slice 2 hard refresh
  // verification gate. codex.ts:674 fetches the access token before the
  // provider call, which routes through getCodexCredentials →
  // refreshCredentials when the token is within REFRESH_LEADTIME_MS of
  // expiry. The refresh either succeeds (turn proceeds) or fails with
  // an auth_required event surfaced to the WS layer. The picker is
  // honest to keep this selectable.
  if (loggedIn && refreshable) {
    return {
      provider: 'openai-codex',
      runtime: 'codex',
      available: true,
      connected: false,
      needsAuth: false,
      reason: 'expired',
      expiresAt: expiresAt ?? null,
      refreshable: true,
    };
  }

  // Login flow active (URL handed to browser, awaiting callback). Distinct
  // reason value so Slice 3 can show a "Login in progress…" state rather
  // than a generic "needs auth" CTA. Sourced from the already-exposed
  // CodexLoginSnapshot.status — no new state machinery invented per
  // Slice 2 brief.
  if (!loggedIn && loginSession.status === 'awaiting_browser') {
    return {
      provider: 'openai-codex',
      runtime: 'codex',
      available: false,
      connected: false,
      needsAuth: true,
      reason: 'login_in_progress',
      expiresAt: null,
      refreshable: false,
    };
  }

  // All other states: no credentials, or expired with no refresh token, or
  // terminal failure / cancellation. UI should show "Connect" CTA.
  return {
    provider: 'openai-codex',
    runtime: 'codex',
    available: false,
    connected: false,
    needsAuth: true,
    reason: 'needs_auth',
    expiresAt: expiresAt ?? null,
    refreshable,
  };
}

/**
 * GET /api/models/status — quick check of provider connectivity & enabled flags.
 * UI uses this to render the Providers tab without firing the full catalog.
 *
 * 6B-C Slice 2: added `'openai-codex'` key with availability state sourced
 * from the safe non-throwing auth snapshot. Existing sibling keys
 * (`claude`, `ollama`, etc.) intentionally keep their short-form names —
 * canonicalising them is a separate followup, not Slice 2's job.
 *
 * Auth source: `getCodexAuthSnapshot()` is the documented-safe helper —
 * no network, no refresh, no writes. Codex `authPath` (which the snapshot
 * surfaces for the OAuth lifecycle route) is intentionally stripped here:
 * `/api/models/status` consumers don't need it, and Slice 2 security rules
 * forbid auth file paths in responses.
 */
router.get('/models/status', async (_req: Request, res: Response) => {
  const cfg = getBytelightConfig();
  const providers = cfg.providers;

  // Codex availability — read-only snapshot fetch (no token refresh, no
  // network call to OpenAI, no file writes). Side-effect-free per Slice 2
  // pin #1.
  const codexSnapshot = await getCodexAuthSnapshot();
  const codexAvailability = computeCodexAvailability(codexSnapshot);

  res.json({
    routing: cfg.agent.routing,
    claude: { configured: true, runtime: 'claude-sdk' as const },
    ollama: {
      configured: !!providers.ollama?.base_url,
      enabled: !!providers.ollama?.enabled,
      url: providers.ollama?.base_url,
      runtime: 'ollama-native' as const,
    },
    openrouter: { configured: !!providers.openrouter?.api_key, runtime: 'openai-compat' as const },
    groq: { configured: !!providers.groq?.api_key, runtime: 'openai-compat' as const },
    xai: { configured: !!providers.xai?.api_key, runtime: 'openai-compat' as const },
    // OpenAI direct (Step 6A) — Ollama-style configured+enabled+url shape.
    openai: {
      configured: !!providers.openai?.api_key,
      enabled: !!providers.openai?.enabled,
      url: providers.openai?.base_url ?? 'https://api.openai.com/v1',
      runtime: 'openai-compat' as const,
    },
    huggingface: { configured: !!providers.huggingface?.api_key, runtime: 'openai-compat' as const },
    // 6B-C Slice 2: Codex (ChatGPT OAuth) availability. Canonical key,
    // runtime declared as static field. See computeCodexAvailability above.
    'openai-codex': codexAvailability,
  });
});

/**
 * POST /api/models/check — ping a provider's `/v1/models` endpoint to
 * verify connectivity from the Settings UI. Body: { provider, base_url, api_key? }.
 * Returns { ok: boolean, models?: number, error?: string }.
 */
router.post('/models/check', async (req: Request, res: Response) => {
  const { provider, base_url, api_key } = req.body as { provider?: string; base_url?: string; api_key?: string };
  if (!provider || !base_url) {
    res.status(400).json({ ok: false, error: 'provider and base_url are required' });
    return;
  }

  try {
    const headers: Record<string, string> = {};
    if (api_key) headers['Authorization'] = `Bearer ${api_key}`;
    // Ollama uses `/v1/models` off the base URL verbatim (no auto-`/v1` fold);
    // non-Ollama providers go through the shared helper so an OpenAI default
    // base `https://api.openai.com/v1` doesn't become `.../v1/v1/models`.
    const cleanBase = base_url.replace(/\/+$/, '');
    const url = provider === 'ollama'
      ? `${cleanBase}/v1/models`
      : modelsEndpointForBaseUrl(base_url);
    const probe = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!probe.ok) {
      res.json({ ok: false, error: `${probe.status} ${probe.statusText}` });
      return;
    }
    const data = await probe.json() as any;
    res.json({ ok: true, models: Array.isArray(data.data) ? data.data.length : 0 });
  } catch (err) {
    res.json({ ok: false, error: errMessage(err) });
  }
});

// Suppress unused-var warning when the rough provider-id helper isn't called
// (kept as `_unused` so future routes can leverage it).
const _providerIdUnused: (p: string) => ProviderId | undefined = (p) => {
  switch (p) {
    case 'claude':
    case 'anthropic':   return 'claude';
    case 'openrouter':  return 'openrouter';
    case 'ollama':      return 'ollama';
    default:            return undefined;
  }
};
void _providerIdUnused;

export default router;
