<script lang="ts">
  /**
   * Chat-header model pill — Step 4B.
   *
   * Thread-scoped interactive-tier override control. Talks ONLY to
   * /api/companion-settings/* — never to /api/preferences (that's the
   * Settings panel's job). Apply writes a `scope='thread'` row; clear
   * deletes only that row.
   *
   * Sources of truth read here:
   *   - GET /api/companion-settings/effective?... → current effective config
   *   - GET /api/models/status                    → provider availability
   *   - GET /api/models?provider=ollama          → Ollama discovery
   *   - MODEL_VARIANTS (shared)                   → Claude variant list
   *
   * State-changing calls (PUT/DELETE) flow through apiFetch for
   * session credentials.
   */

  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { apiFetch } from '../utils/api.js';
  import { getActiveThreadId } from '$lib/stores/websocket.svelte';
  import { MODEL_VARIANTS, getVariant, type ProviderId, type ThinkingEffort } from '@bytelight/shared';
  import { getProfile } from '$lib/stores/profiles.svelte';

  // The shared brain the two residents run on (migrations/014_companions.sql).
  // A pick can be for the brain as a whole or for one companion alone; a
  // companion with no pick of its own follows the brain's (the resolver falls
  // through companion → brain at every scope), and a brain-wide thread pick
  // still beats any one companion's default.
  const COMPANION_ID = 'companion-a-b';
  const MEMBERS = ['companion-a', 'companion-b'] as const;
  const TIER = 'interactive' as const;

  const memberName = (id: string) => getProfile(id).name || id.charAt(0).toUpperCase() + id.slice(1);
  let brainName = $derived(MEMBERS.map(memberName).join(' & '));
  let target = $state<string>(COMPANION_ID);
  let targetIsMember = $derived(target !== COMPANION_ID);

  // ---------- Effort options ----------
  // Mirrors VALID_EFFORT in @bytelight/shared (and preferences-routes.ts).
  // The resolver coerces per-provider at dispatch time, so we offer the
  // full union here and hint at coercion in the label.
  const EFFORT_OPTIONS: ThinkingEffort[] = [
    'auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
  ];

  // ---------- Provider list ----------
  // Display + interactive ordering for the dropdown. Live availability
  // comes from /api/models/status — see `providerEnabled()`.
  interface ProviderRow {
    id: ProviderId | 'huggingface';
    label: string;
    /** "Coming soon" providers are listed but disabled until their step ships. */
    placeholder: boolean;
  }
  // 6B-C Slice 4: the Codex row uses the canonical ProviderId 'openai-codex'.
  // The pre-Slice-4 cosmetic 'codex' row id was never persisted (verified
  // Slice 0); renaming is safe. providerEnabled() gates the row on the
  // Slice 2 availability state — see status['openai-codex'].
  const PROVIDER_ROWS: ProviderRow[] = [
    { id: 'claude',       label: 'Claude',     placeholder: false },
    // H1b: Claude via the warm `claude` CLI session (subscription/OAuth — no
    // BYOK key). Same Claude model list as the SDK lane (MODEL_VARIANTS).
    { id: 'claude-cli',   label: 'Claude (CLI · subscription)', placeholder: false },
    { id: 'ollama',       label: 'Ollama',     placeholder: false },
    { id: 'openai',       label: 'OpenAI',     placeholder: false },
    { id: 'openrouter',   label: 'OpenRouter', placeholder: false },
    { id: 'groq',         label: 'Groq',       placeholder: false },
    { id: 'xai',          label: 'Grok (xAI)', placeholder: false },
    { id: 'openai-codex', label: 'Codex',      placeholder: false },
    // H2: OpenAI/Codex via the warm Codex app-server daemon (subscription/CLI-login
    // — no BYOK key). Catalog fetched from /api/models?provider=codex-cli; always
    // selectable like claude-cli (no availability status object gates it).
    { id: 'codex-cli',    label: 'Codex (CLI · subscription)', placeholder: false },
    { id: 'huggingface',  label: 'HuggingFace', placeholder: true },
  ];

  // ---------- Reactive state ----------
  let open = $state(false);

  // Effective config (the closed-pill view). `source==='thread'` means an
  // override is active for this thread; pill shows a "Thread" prefix.
  let effective = $state<null | {
    provider: ProviderId;
    model: string;
    thinkingEffort: ThinkingEffort;
    source: 'thread' | 'companion' | 'system';
    /** Whose row answered — a companion may be following the brain's. */
    matchedCompanionId: string | null;
  }>(null);

  type Effective = NonNullable<typeof effective>;
  // Each companion's effective engine, for the closed pill's split label.
  let memberEffective = $state<Array<{ id: string; eff: Effective }>>([]);
  let split = $derived(
    memberEffective.length > 1 &&
      memberEffective.some((m) =>
        m.eff.provider !== memberEffective[0].eff.provider ||
        m.eff.model !== memberEffective[0].eff.model ||
        m.eff.thinkingEffort !== memberEffective[0].eff.thinkingEffort),
  );

  // Provider availability + routing mode from /api/models/status.
  // 6B-C Slice 4: 'openai-codex' field added (Slice 2 backend truth).
  // Codex carries its own state machine (available/needsAuth/reason)
  // unlike the configured+enabled pattern used by BYOK providers.
  type CodexAvailabilityStatus = {
    provider: 'openai-codex';
    runtime: 'codex';
    available: boolean;
    connected: boolean;
    needsAuth: boolean;
    reason: 'connected' | 'expired' | 'needs_auth' | 'login_in_progress';
    expiresAt: number | null;
    refreshable: boolean;
  };
  let providerStatus = $state<null | {
    routing: string;
    claude: { configured: boolean };
    ollama: { configured: boolean; enabled: boolean };
    openrouter: { configured: boolean };
    groq: { configured: boolean };
    xai: { configured: boolean };
    openai: { configured: boolean; enabled?: boolean; url?: string };
    huggingface: { configured: boolean };
    'openai-codex'?: CodexAvailabilityStatus;
  }>(null);

  // Per-provider model lists. Claude is static (MODEL_VARIANTS); Ollama is
  // fetched on first open. OpenAI direct mirrors the Ollama lazy-fetch.
  let ollamaModels = $state<Array<{ id: string; name: string }>>([]);
  let ollamaLoaded = $state(false);
  let ollamaLoading = $state(false);

  // Step 6A: OpenAI direct catalog. Sorted featured-first by sortPriority so
  // GPT-4o etc surface visibly.
  let openaiModels = $state<Array<{ id: string; name: string; featured?: boolean; sortPriority?: number; badge?: string }>>([]);
  let openaiLoaded = $state(false);
  let openaiLoading = $state(false);

  // 6B-C Slice 4: Codex (ChatGPT OAuth) catalog. Same lazy-fetch pattern as
  // Ollama/OpenAI. Source: /api/models?provider=openai-codex (Slice 2 truth).
  // A fetch error surfaces a retry state in the dropdown — NEVER an
  // empty-but-enabled provider row.
  let codexModels = $state<Array<{ id: string; name: string }>>([]);
  let codexLoaded = $state(false);
  let codexLoading = $state(false);
  let codexFetchError = $state<string | null>(null);

  // H2: Codex-CLI (warm daemon) catalog. Same lazy-fetch pattern as the Codex
  // (ChatGPT OAuth) catalog above, sourced from /api/models?provider=codex-cli.
  // Unlike openai-codex, the codex-cli row is always selectable (no availability
  // status object) — a fetch error still surfaces a retry state in the dropdown.
  let codexCliModels = $state<Array<{ id: string; name: string }>>([]);
  let codexCliLoaded = $state(false);
  let codexCliLoading = $state(false);
  let codexCliFetchError = $state<string | null>(null);

  // H3b-1: generic OpenAI-compat discovery catalogs (OpenRouter / Groq / xAI).
  // Same lazy-fetch pattern as Ollama, keyed by provider id. These providers
  // gate on api_key + routing!=sdk only (no two-stage enabled flag), and their
  // model refs resolve through the generic openai-compat dispatch path.
  type CompatProviderId = 'openrouter' | 'groq' | 'xai';
  const COMPAT_PROVIDERS: readonly CompatProviderId[] = ['openrouter', 'groq', 'xai'];
  function isCompatProvider(p: string): p is CompatProviderId {
    return p === 'openrouter' || p === 'groq' || p === 'xai';
  }
  let compatModels = $state<Record<CompatProviderId, Array<{ id: string; name: string }>>>({
    openrouter: [], groq: [], xai: [],
  });
  let compatLoaded = $state<Record<CompatProviderId, boolean>>({ openrouter: false, groq: false, xai: false });
  let compatLoading = $state<Record<CompatProviderId, boolean>>({ openrouter: false, groq: false, xai: false });

  // Working draft (what the user has selected but not yet applied). Starts
  // mirrored to effective; Apply commits it via PUT.
  let draftProvider = $state<ProviderId>('claude');
  let draftModel = $state<string>('claude-sonnet-4-6');
  let draftEffort = $state<ThinkingEffort>('auto');

  let applying = $state(false);
  let clearing = $state(false);
  let lastError = $state<string | null>(null);

  // ---------- Derived ----------
  // Closed-pill label. Shows source prefix when override exists so the
  // user can see at a glance that the thread is pinned.
  let pillLabel = $derived.by(() => {
    if (!effective) return 'Model…';
    const providerLabel = providerDisplayLabel(effective.provider);
    const modelLabel = modelDisplayLabel(effective.provider, effective.model);
    const effortLabel = effortDisplayLabel(effective.thinkingEffort);
    const prefix = effective.source === 'thread' ? 'Thread · ' : '';
    return `${prefix}${providerLabel} · ${modelLabel} · ${effortLabel}`;
  });

  // Compact closed-pill label. The OPEN dropdown always shows full names;
  // this only shrinks the collapsed pill so a long "Provider · Model · Effort"
  // string never crowds the companion names in the header. Examples the
  // operator gave: "A/O4.7 MAX", "GPT 5.5 HIGH", "OL GLM 5.1 AUTO".
  // Display-only — reads `effective`, mutates nothing.
  let compactPillLabel = $derived.by(() => {
    if (split) {
      return memberEffective
        .map((m) => `${memberName(m.id)} ${compactProviderPrefix(m.eff.provider)}${compactModelRef(m.eff.provider, m.eff.model)}`.replace(/\s+/g, ' ').trim())
        .join(' | ');
    }
    if (!effective) return 'Model…';
    const prefix = compactProviderPrefix(effective.provider);
    const model = compactModelRef(effective.provider, effective.model);
    const effort = effective.thinkingEffort.toUpperCase();
    return `${prefix}${model} ${effort}`.replace(/\s+/g, ' ').trim();
  });

  // Only a thread pick that belongs to THIS target can be cleared here; one
  // it inherits from the brain is cleared from the brain's chip.
  let canClearOverride = $derived(
    effective?.source === 'thread' && (effective.matchedCompanionId ?? target) === target,
  );
  let targetNote = $derived.by(() => {
    if (!targetIsMember || !effective) return null;
    const name = memberName(target);
    if (canClearOverride) return `${name} has his own engine in this thread.`;
    if (effective.source === 'thread') return `${name} is following ${brainName}'s pick here. Apply sets his alone.`;
    return `${name} is following the default. Apply sets his alone, in this thread only.`;
  });

  // Routing 'sdk' means non-Claude providers throw at dispatch. UI must
  // gate them off so we never write a row the dispatcher would refuse.
  let routingIsSdk = $derived(providerStatus?.routing === 'sdk');

  // ---------- Helpers ----------
  function providerDisplayLabel(p: string): string {
    const row = PROVIDER_ROWS.find((r) => r.id === p);
    return row?.label ?? p;
  }

  function modelDisplayLabel(provider: string, modelId: string): string {
    if (provider === 'claude' || provider === 'claude-cli') {
      const v = getVariant(modelId);
      return v.label;
    }
    if (provider === 'openai') {
      return openaiModels.find((m) => m.id === modelId)?.name ?? modelId;
    }
    if (provider === 'openai-codex') {
      return codexModels.find((m) => m.id === modelId)?.name ?? modelId;
    }
    if (provider === 'codex-cli') {
      return codexCliModels.find((m) => m.id === modelId)?.name ?? modelId;
    }
    if (isCompatProvider(provider)) {
      return compatModels[provider].find((m) => m.id === modelId)?.name ?? modelId;
    }
    return modelId;
  }

  function effortDisplayLabel(e: ThinkingEffort): string {
    // Capitalize first letter for display.
    return e.charAt(0).toUpperCase() + e.slice(1);
  }

  // ---------- Compact pill label helpers (display-only) ----------
  // Short provider prefix for the collapsed pill. New providers just add a
  // row here; unknown ids fall back to no prefix (the model ref still shows).
  // Anthropic/Claude → "A/", OpenAI direct carries "GPT" in the name so no
  // prefix, ChatGPT/Codex → "CX ", Ollama → "OL ", etc.
  const COMPACT_PROVIDER_PREFIX: Record<string, string> = {
    claude: 'A/',
    'claude-cli': 'CLI ',
    openai: '',
    'openai-codex': 'CX ',
    'codex-cli': 'CX-CLI ',
    ollama: 'OL ',
    openrouter: 'OR ',
    groq: 'GQ ',
    xai: 'X ',
    huggingface: 'HF ',
  };

  function compactProviderPrefix(provider: string): string {
    return COMPACT_PROVIDER_PREFIX[provider] ?? '';
  }

  /**
   * Shorten a model ref for the collapsed pill.
   * - Claude: initial + version, e.g. "Opus 4.6" → "O4.6", "Sonnet 4.6" → "S4.6".
   * - Others: uppercase, drop vendor path + ollama :tag, hyphens→spaces,
   *   e.g. "GPT-5.5" → "GPT 5.5", "glm-5.1" → "GLM 5.1".
   * Anything that doesn't map cleanly still yields a readable uppercase
   * fragment (never a cryptic invented code); the pill's ellipsis truncates it.
   */
  function compactModelRef(provider: string, modelId: string): string {
    const name = modelDisplayLabel(provider, modelId).trim();
    if (!name) return '';
    if (provider === 'claude' || provider === 'claude-cli') {
      return name
        .split(/\s+/)
        .map((tok) => (/^[A-Za-z]+$/.test(tok) ? tok[0].toUpperCase() : tok))
        .join('');
    }
    return name
      .replace(/^.*\//, '') // drop "library/…" vendor path
      .replace(/:.*$/, '') // drop ollama ":tag"
      .replace(/[-_]+/g, ' ') // hyphen/underscore → space
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  /**
   * Whether a provider row is enabled for selection.
   * - Placeholder providers (openrouter/huggingface): disabled.
   * - Claude: always enabled.
   * - Ollama: enabled iff status reports configured+enabled AND routing != 'sdk'.
   * - OpenAI (Step 6A): enabled iff status reports configured+enabled AND
   *   routing != 'sdk' — same discipline as Ollama. The dispatcher refuses
   *   OpenAI direct under routing=sdk, so we must gate the UI to match.
   * - openai-codex (6B-C Slice 4): enabled iff Slice 2's availability state
   *   says available. Routing mode does NOT gate Codex — CodexRuntime
   *   dispatches independently of the api-router; routing='sdk' permits it.
   *   See computeCodexAvailability in backend/routes/models.ts.
   */
  function providerEnabled(row: ProviderRow): boolean {
    if (row.placeholder) return false;
    if (row.id === 'claude') return true;
    // H1b: Claude-CLI is always selectable — no BYOK key (subscription/OAuth)
    // and no routing gate (it dispatches through the heartbeat runtime, not
    // the api-router). If CLAUDE_CLI_HEARTBEAT_ENABLED is off server-side, the
    // runtime surfaces a clear in-thread error on send rather than the pick
    // being blocked here.
    if (row.id === 'claude-cli') return true;
    // H2: Codex-CLI is always selectable — no BYOK key (subscription/CLI-login)
    // and no availability status object gates it. If the daemon can't start
    // server-side, the runtime surfaces a clear in-thread error on send rather
    // than the pick being blocked here.
    if (row.id === 'codex-cli') return true;
    if (row.id === 'ollama') {
      if (!providerStatus) return false;
      if (routingIsSdk) return false;
      return providerStatus.ollama.configured && providerStatus.ollama.enabled;
    }
    if (row.id === 'openai') {
      if (!providerStatus) return false;
      if (routingIsSdk) return false;
      return providerStatus.openai.configured && !!providerStatus.openai.enabled;
    }
    if (row.id === 'openai-codex') {
      if (!providerStatus) return false;
      return providerStatus['openai-codex']?.available === true;
    }
    // H3b-1: OpenAI-compat BYOK lanes (OpenRouter / Groq / xAI). Gated on
    // api_key presence (configured) AND routing != 'sdk' — matching the
    // catalog probe + dispatcher, which refuse these under routing=sdk.
    // No two-stage enabled flag exists for these providers.
    if (isCompatProvider(row.id)) {
      if (!providerStatus) return false;
      if (routingIsSdk) return false;
      return providerStatus[row.id].configured;
    }
    return false;
  }

  /**
   * Reason-driven hint for the Codex row when it's disabled. Returns null
   * when the row is enabled (no hint needed) or when status hasn't loaded
   * yet (the row is disabled but with a quiet "checking…" placeholder
   * handled at the template level).
   */
  function codexDisabledHint(): string | null {
    const codex = providerStatus?.['openai-codex'];
    if (!codex) return null;
    if (codex.available) return null;
    switch (codex.reason) {
      case 'needs_auth':
        return codex.expiresAt != null && !codex.refreshable
          ? 'reconnect'
          : 'needs auth';
      case 'expired':
        return codex.refreshable ? null : 'reconnect';
      case 'login_in_progress':
        return 'login in progress';
      default:
        return 'unavailable';
    }
  }

  // ---------- Fetchers ----------
  async function readEffective(companionId: string): Promise<Effective | null> {
    const threadId = getActiveThreadId();
    const qs = new URLSearchParams({ companionId, tier: TIER });
    if (threadId) qs.set('threadId', threadId);
    // Read-only GET — apiFetch gives us credentials:'include'.
    const res = await apiFetch(`/api/companion-settings/effective?${qs.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      provider: data.provider,
      model: data.model,
      thinkingEffort: data.thinkingEffort,
      source: data.source,
      matchedCompanionId: data.matchedCompanionId ?? null,
    };
  }

  async function fetchEffective(): Promise<void> {
    try {
      const next = await readEffective(target);
      if (next) {
        effective = next;
        // Sync the draft to the effective view whenever we re-pull.
        draftProvider = next.provider;
        draftModel = next.model;
        draftEffort = next.thinkingEffort;
      }
      const reads = await Promise.all(MEMBERS.map(async (id) => ({ id, eff: await readEffective(id) })));
      memberEffective = reads.filter((r): r is { id: (typeof MEMBERS)[number]; eff: Effective } => !!r.eff);
    } catch (err) {
      console.warn('Failed to fetch effective companion settings:', err);
    }
  }

  async function fetchProviderStatus(): Promise<void> {
    try {
      const res = await apiFetch('/api/models/status');
      if (!res.ok) return;
      providerStatus = await res.json();
    } catch (err) {
      console.warn('Failed to fetch provider status:', err);
    }
  }

  async function fetchOllamaModels(): Promise<void> {
    if (ollamaLoaded || ollamaLoading) return;
    ollamaLoading = true;
    try {
      const res = await apiFetch('/api/models?provider=ollama');
      if (res.ok) {
        const data = await res.json();
        ollamaModels = Array.isArray(data)
          ? data.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name ?? m.id }))
          : [];
      }
    } catch (err) {
      console.warn('Failed to fetch Ollama models:', err);
    } finally {
      ollamaLoading = false;
      ollamaLoaded = true;
    }
  }

  async function fetchOpenaiModels(): Promise<void> {
    if (openaiLoaded || openaiLoading) return;
    openaiLoading = true;
    try {
      const res = await apiFetch('/api/models?provider=openai');
      if (res.ok) {
        const data = await res.json();
        const mapped = Array.isArray(data)
          ? data.map((m: { id: string; name?: string; featured?: boolean; sortPriority?: number; badge?: string }) => ({
              id: m.id,
              name: m.name ?? m.id,
              featured: m.featured,
              sortPriority: m.sortPriority ?? 500,
              badge: m.badge,
            }))
          : [];
        mapped.sort((a, b) => {
          if ((a.featured ? 1 : 0) !== (b.featured ? 1 : 0)) return a.featured ? -1 : 1;
          return (a.sortPriority ?? 500) - (b.sortPriority ?? 500);
        });
        openaiModels = mapped;
      }
    } catch (err) {
      console.warn('Failed to fetch OpenAI models:', err);
    } finally {
      openaiLoading = false;
      openaiLoaded = true;
    }
  }

  /**
   * 6B-C Slice 4: fetch the Codex catalog. A fetch failure (network / 5xx)
   * sets `codexFetchError` and leaves `codexModels` empty; the dropdown
   * branches on the error state and offers a Retry — never an
   * empty-but-enabled provider row. Lazy: only fires on first open or after
   * a manual retry.
   */
  async function fetchCodexModels(opts: { force?: boolean } = {}): Promise<void> {
    if (codexLoading) return;
    if (codexLoaded && !opts.force) return;
    codexLoading = true;
    codexFetchError = null;
    if (opts.force) {
      codexModels = [];
      codexLoaded = false;
    }
    try {
      const res = await apiFetch('/api/models?provider=openai-codex');
      if (res.ok) {
        const data = await res.json();
        codexModels = Array.isArray(data)
          ? data.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name ?? m.id }))
          : [];
      } else {
        codexFetchError = `Couldn't load Codex models (${res.status})`;
      }
    } catch (err) {
      codexFetchError = err instanceof Error
        ? `Couldn't load Codex models — ${err.message}`
        : "Couldn't load Codex models — network error";
    } finally {
      codexLoading = false;
      codexLoaded = true;
    }
  }

  /**
   * H2: fetch the Codex-CLI (warm daemon) catalog. Mirrors fetchCodexModels
   * but hits /api/models?provider=codex-cli and writes the codexCli* state.
   * A fetch failure sets `codexCliFetchError` and leaves `codexCliModels`
   * empty; the dropdown branches on the error state and offers a Retry. Lazy:
   * only fires on first open or after a manual retry.
   */
  async function fetchCodexCliModels(opts: { force?: boolean } = {}): Promise<void> {
    if (codexCliLoading) return;
    if (codexCliLoaded && !opts.force) return;
    codexCliLoading = true;
    codexCliFetchError = null;
    if (opts.force) {
      codexCliModels = [];
      codexCliLoaded = false;
    }
    try {
      const res = await apiFetch('/api/models?provider=codex-cli');
      if (res.ok) {
        const data = await res.json();
        codexCliModels = Array.isArray(data)
          ? data.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name ?? m.id }))
          : [];
      } else {
        codexCliFetchError = `Couldn't load Codex CLI models (${res.status})`;
      }
    } catch (err) {
      codexCliFetchError = err instanceof Error
        ? `Couldn't load Codex CLI models — ${err.message}`
        : "Couldn't load Codex CLI models — network error";
    } finally {
      codexCliLoading = false;
      codexCliLoaded = true;
    }
  }

  // H3b-1: lazy-fetch an OpenAI-compat provider's catalog (OpenRouter/Groq/xAI).
  // Fires on provider selection / open when that provider is the active draft,
  // mirroring the Ollama lazy-fetch. Empty result → "no models" row; the
  // provider stays disabled until a key is saved (see providerEnabled).
  async function fetchCompatModels(provider: CompatProviderId): Promise<void> {
    if (compatLoaded[provider] || compatLoading[provider]) return;
    compatLoading[provider] = true;
    try {
      const res = await apiFetch(`/api/models?provider=${provider}`);
      if (res.ok) {
        const data = await res.json();
        compatModels[provider] = Array.isArray(data)
          ? data.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name ?? m.id }))
          : [];
      }
    } catch (err) {
      console.warn(`Failed to fetch ${provider} models:`, err);
    } finally {
      compatLoading[provider] = false;
      compatLoaded[provider] = true;
    }
  }

  // ---------- Open/close ----------
  function toggle() {
    open = !open;
    if (open) {
      // Refresh status + provider catalogs on open so the dropdown reflects
      // current state without a route remount. Fetch-on-open keeps the
      // status read cheap (Slice 2 verified side-effect-free) without
      // standing up a polling loop.
      void fetchProviderStatus();
      void fetchOllamaModels();
      void fetchOpenaiModels();
      void fetchCodexModels();
      void fetchCodexCliModels();
      if (isCompatProvider(draftProvider)) void fetchCompatModels(draftProvider);
      lastError = null;
    }
  }

  function handleWindowClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.model-selector')) {
      open = false;
    }
  }

  // ---------- Selection handlers (draft only) ----------
  function selectProvider(p: ProviderId) {
    draftProvider = p;
    // Reset model to a sensible default per provider so the user doesn't
    // see a stale Claude id in another provider's section.
    if (p === 'claude' || p === 'claude-cli') {
      // Both Claude lanes share the static MODEL_VARIANTS list.
      draftModel = 'claude-sonnet-4-6';
    } else if (p === 'ollama') {
      draftModel = ollamaModels[0]?.id ?? '';
    } else if (p === 'openai') {
      // First model after featured-sort is the highest-priority featured id
      // (e.g. gpt-5.5 if discoverable, otherwise the first non-featured).
      draftModel = openaiModels[0]?.id ?? '';
    } else if (p === 'openai-codex') {
      // 6B-C Slice 4: Codex catalog is the static Slice 1 manifest (10
      // entries). First entry in the catalog returned by /api/models —
      // the order mirrors the pi-ai registry. gpt-5-nano is guaranteed
      // absent (Slice 1 manifest test + Slice 2 catalog branch).
      draftModel = codexModels[0]?.id ?? '';
    } else if (p === 'codex-cli') {
      // H2: Codex-CLI catalog mirrors the openai-codex id list under the
      // codex-cli/ prefix. Seed from cache if present, then lazy-fetch so the
      // model list populates on selection.
      draftModel = codexCliModels[0]?.id ?? '';
      void fetchCodexCliModels();
    } else if (isCompatProvider(p)) {
      // H3b-1: OpenAI-compat discovery provider. Seed from cache if present,
      // then lazy-fetch the catalog so the model list populates on selection.
      draftModel = compatModels[p][0]?.id ?? '';
      void fetchCompatModels(p);
    }
  }

  function selectModel(modelId: string) {
    draftModel = modelId;
  }

  function selectEffort(e: ThinkingEffort) {
    draftEffort = e;
  }

  // ---------- Apply / Clear ----------
  async function applyOverride() {
    const threadId = getActiveThreadId();
    if (!threadId) {
      lastError = 'No active thread — open a thread first.';
      return;
    }
    if (!draftModel) {
      lastError = 'Pick a model first.';
      return;
    }
    applying = true;
    lastError = null;
    try {
      const res = await apiFetch('/api/companion-settings/thread', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companionId: target,
          tier: TIER,
          threadId,
          providerId: draftProvider,
          modelId: draftModel,
          thinkingEffort: draftEffort,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        lastError = err.error ?? `Apply failed: ${res.status}`;
        return;
      }
      await fetchEffective();
      open = false;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Apply failed';
    } finally {
      applying = false;
    }
  }

  async function clearOverride() {
    const threadId = getActiveThreadId();
    if (!threadId) {
      lastError = 'No active thread.';
      return;
    }
    clearing = true;
    lastError = null;
    try {
      const res = await apiFetch('/api/companion-settings/thread', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companionId: target,
          tier: TIER,
          threadId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        lastError = err.error ?? `Clear failed: ${res.status}`;
        return;
      }
      await fetchEffective();
      open = false;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Clear failed';
    } finally {
      clearing = false;
    }
  }

  // Re-pull the thread-scoped effective model whenever the active thread changes,
  // so the pill reflects the model this specific thread is running (not the mount-time one).
  $effect(() => {
    getActiveThreadId(); // track active thread id
    target; // and whose engine is being shown
    void fetchEffective();
  });

  // ---------- Mount ----------
  onMount(() => {
    void fetchProviderStatus();
  });
</script>

<svelte:window onclick={handleWindowClick} />

<div class="model-selector">
  <button
    class="model-pill"
    class:override={effective?.source === 'thread'}
    onclick={toggle}
    aria-label="Select model for this thread"
    title={pillLabel}
  >
    {compactPillLabel}
  </button>

  {#if open}
    <div class="model-dropdown" role="dialog" aria-label="Thread model override">
      <!-- Whose engine: both residents, or one of them alone -->
      <div class="section">
        <div class="section-title">For</div>
        <div class="target-chips">
          {#each [COMPANION_ID, ...MEMBERS] as id}
            <button class="target-chip" class:active={target === id} onclick={() => (target = id)}>
              {id === COMPANION_ID ? brainName : memberName(id)}
            </button>
          {/each}
        </div>
        {#if targetNote}
          <div class="target-note">{targetNote}</div>
          <div class="target-note">In one shared lane, {brainName}'s pick runs both voices. His own pick takes over when he has a lane of his own.</div>
        {/if}
      </div>

      <!-- Provider section -->
      <div class="section">
        <div class="section-title">Provider</div>
        {#each PROVIDER_ROWS as row}
          {@const enabled = providerEnabled(row)}
          {@const codexHint = row.id === 'openai-codex' ? codexDisabledHint() : null}
          <button
            class="row"
            class:active={draftProvider === row.id}
            class:disabled={!enabled}
            disabled={!enabled}
            onclick={() => enabled && selectProvider(row.id as ProviderId)}
            title={row.placeholder
              ? 'Coming soon'
              : (row.id === 'ollama' || isCompatProvider(row.id)) && routingIsSdk
                ? 'Routing is SDK-only — switch routing in Settings'
                : isCompatProvider(row.id) && providerStatus && !providerStatus[row.id].configured
                  ? 'Add an API key in Providers'
                  : row.id === 'openai-codex' && codexHint
                    ? 'Connect ChatGPT / Codex in Providers'
                    : ''}
          >
            <span>{row.label}</span>
            {#if row.placeholder}
              <span class="hint">coming soon</span>
            {:else if row.id === 'ollama' && routingIsSdk}
              <span class="hint">routing=sdk</span>
            {:else if row.id === 'ollama' && providerStatus && !providerStatus.ollama.enabled}
              <span class="hint">disabled</span>
            {:else if isCompatProvider(row.id) && routingIsSdk}
              <span class="hint">routing=sdk</span>
            {:else if isCompatProvider(row.id) && providerStatus && !providerStatus[row.id].configured}
              <span class="hint">add key</span>
            {:else if row.id === 'openai-codex' && codexHint}
              <span class="hint">{codexHint}</span>
            {/if}
          </button>
        {/each}
      </div>

      <!-- Model section -->
      <div class="section">
        <div class="section-title">Model</div>
        {#if draftProvider === 'claude' || draftProvider === 'claude-cli'}
          <!-- H1b: the CLI subscription lane runs the same Claude models as the
               SDK lane, so both share the static MODEL_VARIANTS list. -->
          {#each MODEL_VARIANTS as variant}
            <button
              class="row"
              class:active={draftModel === variant.modelApiId}
              onclick={() => selectModel(variant.modelApiId)}
            >
              {variant.label}
            </button>
          {/each}
        {:else if draftProvider === 'ollama'}
          {#if ollamaLoading}
            <div class="row disabled">Loading…</div>
          {:else if ollamaModels.length === 0}
            <div class="row disabled">No Ollama models found — check provider settings</div>
          {:else}
            {#each ollamaModels as m}
              <button
                class="row"
                class:active={draftModel === m.id}
                onclick={() => selectModel(m.id)}
              >
                {m.name}
              </button>
            {/each}
          {/if}
        {:else if draftProvider === 'openai'}
          {#if openaiLoading}
            <div class="row disabled">Loading…</div>
          {:else if openaiModels.length === 0}
            <div class="row disabled">No OpenAI chat models found — check API key/base URL.</div>
          {:else}
            {#each openaiModels as m}
              <button
                class="row"
                class:active={draftModel === m.id}
                onclick={() => selectModel(m.id)}
              >
                <span>{m.name}</span>
                {#if m.badge}
                  <span class="hint">{m.badge}</span>
                {/if}
              </button>
            {/each}
          {/if}
        {:else if draftProvider === 'openai-codex'}
          {#if codexLoading}
            <div class="row disabled">Loading…</div>
          {:else if codexFetchError}
            <!-- Catalog fetch failure UX (Slice 4 rail): error + retry,
                 never an empty-but-enabled provider row. -->
            <div class="row catalog-error">
              <span>{codexFetchError}</span>
              <button
                type="button"
                class="retry-btn"
                onclick={() => void fetchCodexModels({ force: true })}
              >Retry</button>
            </div>
          {:else if codexModels.length === 0}
            <div class="row disabled">No supported Codex models found</div>
          {:else}
            {#each codexModels as m}
              <button
                class="row"
                class:active={draftModel === m.id}
                onclick={() => selectModel(m.id)}
              >
                {m.name}
              </button>
            {/each}
          {/if}
        {:else if draftProvider === 'codex-cli'}
          <!-- H2: Codex-CLI (warm daemon) — catalog from /api/models?provider=codex-cli. -->
          {#if codexCliLoading}
            <div class="row disabled">Loading…</div>
          {:else if codexCliFetchError}
            <div class="row catalog-error">
              <span>{codexCliFetchError}</span>
              <button
                type="button"
                class="retry-btn"
                onclick={() => void fetchCodexCliModels({ force: true })}
              >Retry</button>
            </div>
          {:else if codexCliModels.length === 0}
            <div class="row disabled">No Codex CLI models found</div>
          {:else}
            {#each codexCliModels as m}
              <button
                class="row"
                class:active={draftModel === m.id}
                onclick={() => selectModel(m.id)}
              >
                {m.name}
              </button>
            {/each}
          {/if}
        {:else if isCompatProvider(draftProvider)}
          <!-- H3b-1: OpenRouter / Groq / xAI — generic openai-compat discovery. -->
          {#if compatLoading[draftProvider]}
            <div class="row disabled">Loading…</div>
          {:else if compatModels[draftProvider].length === 0}
            <div class="row disabled">No models found — check API key (and routing ≠ sdk).</div>
          {:else}
            {#each compatModels[draftProvider] as m}
              <button
                class="row"
                class:active={draftModel === m.id}
                onclick={() => selectModel(m.id)}
              >
                {m.name}
              </button>
            {/each}
          {/if}
        {/if}
      </div>

      <!-- Effort section -->
      <div class="section">
        <div class="section-title">Thinking effort</div>
        {#each EFFORT_OPTIONS as e}
          <button
            class="row"
            class:active={draftEffort === e}
            onclick={() => selectEffort(e)}
            title={draftProvider !== 'claude' && draftProvider !== 'claude-cli' && (e === 'none' || e === 'minimal') ? 'Will coerce to auto for this provider' : ''}
          >
            <span>{effortDisplayLabel(e)}</span>
            {#if draftProvider !== 'claude' && draftProvider !== 'claude-cli' && (e === 'none' || e === 'minimal')}
              <span class="hint">↪ coerces</span>
            {/if}
          </button>
        {/each}
      </div>

      <!-- Actions -->
      {#if lastError}
        <div class="error">{lastError}</div>
      {/if}
      <div class="actions">
        <button
          class="action primary"
          disabled={applying || !draftModel}
          onclick={applyOverride}
        >
          {applying ? 'Applying…' : 'Apply to this thread'}
        </button>
        <button
          class="action"
          disabled={!canClearOverride || clearing}
          onclick={clearOverride}
        >
          {clearing ? 'Clearing…' : targetIsMember ? `${memberName(target)} follows ${brainName} again` : 'Clear thread override'}
        </button>
        <a class="action link" href="{base}/settings">Open Settings</a>
      </div>
    </div>
  {/if}
</div>

<style>
  .model-selector {
    position: relative;
  }

  .model-pill {
    font-family: var(--font-heading);
    font-size: 0.6875rem;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 1rem;
    padding: 0.2rem 0.625rem;
    cursor: pointer;
    transition: all var(--transition);
    white-space: nowrap;
    max-width: 22rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .model-pill:hover {
    color: var(--gold-dim);
    border-color: rgba(245, 197, 66, 0.2);
  }

  .model-pill.override {
    color: var(--gold);
    border-color: rgba(245, 197, 66, 0.35);
    background: rgba(245, 197, 66, 0.08);
  }

  .model-dropdown {
    position: absolute;
    top: calc(100% + 0.375rem);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.5rem;
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 18rem;
    max-height: 32rem;
    overflow-y: auto;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    animation: dropIn 0.15s ease-out;
  }

  @keyframes dropIn {
    from { opacity: 0; transform: translateX(-50%) translateY(-0.25rem); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .section-title {
    font-family: var(--font-heading);
    font-size: 0.625rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 0.25rem 0.5rem 0.125rem;
    opacity: 0.6;
  }

  .target-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0 0.5rem 0.25rem;
  }

  .target-chip {
    font-family: var(--font-heading);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
    border-radius: 999px;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    transition: all var(--transition);
  }

  .target-chip:hover {
    color: var(--text-primary);
  }

  .target-chip.active {
    color: var(--gold);
    border-color: var(--gold);
    background: rgba(245, 197, 66, 0.1);
  }

  .target-note {
    font-size: 0.6875rem;
    line-height: 1.35;
    color: var(--text-muted);
    padding: 0.125rem 0.5rem;
    white-space: normal;
  }

  .row {
    font-family: var(--font-heading);
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: transparent;
    border: none;
    border-radius: 0.375rem;
    padding: 0.375rem 0.625rem;
    cursor: pointer;
    text-align: left;
    transition: all var(--transition);
    white-space: nowrap;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .row:hover:not(.disabled):not(:disabled) {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-primary);
  }

  .row.active {
    color: var(--gold);
    background: rgba(245, 197, 66, 0.1);
  }

  .row.disabled,
  .row:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .hint {
    font-size: 0.625rem;
    opacity: 0.6;
    font-style: italic;
  }

  .error {
    font-size: 0.7rem;
    color: #ff7a7a;
    padding: 0.25rem 0.5rem;
    background: rgba(255, 122, 122, 0.08);
    border-radius: 0.25rem;
  }

  .row.catalog-error {
    font-size: 0.7rem;
    color: #ffb070;
    background: rgba(255, 176, 112, 0.08);
    cursor: default;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .retry-btn {
    font-family: var(--font-heading);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    color: var(--gold);
    background: transparent;
    border: 1px solid rgba(245, 197, 66, 0.35);
    border-radius: 0.25rem;
    padding: 0.125rem 0.5rem;
    cursor: pointer;
    transition: all var(--transition);
  }

  .retry-btn:hover {
    background: rgba(245, 197, 66, 0.1);
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-top: 0.25rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  .action {
    font-family: var(--font-heading);
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.375rem;
    padding: 0.4rem 0.625rem;
    cursor: pointer;
    text-align: center;
    transition: all var(--transition);
    text-decoration: none;
    display: block;
  }

  .action:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-primary);
  }

  .action.primary {
    color: var(--gold);
    border-color: rgba(245, 197, 66, 0.35);
    background: rgba(245, 197, 66, 0.08);
  }

  .action.primary:hover:not(:disabled) {
    background: rgba(245, 197, 66, 0.15);
  }

  .action:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .action.link {
    opacity: 0.7;
  }

  /* Mobile: the header lets this pill wrap onto its own line beneath the
     companion name (see chat/+page.svelte). On a narrow line the long
     label must truncate within the available width rather than overflow,
     so cap it to the line and let its existing ellipsis do the work. */
  @media (max-width: 768px) {
    .model-selector {
      min-width: 0;
      max-width: 100%;
    }

    .model-pill {
      max-width: 100%;
    }
  }
</style>
