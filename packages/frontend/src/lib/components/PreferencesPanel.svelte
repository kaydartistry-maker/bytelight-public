<script lang="ts">
  import { localBrainId } from '$lib/stores/companions.svelte';
  import { onMount } from 'svelte';
  import { apiFetch } from '../utils/api.js';
  import { updateSetting, getConfig } from '../stores/settings.svelte';
  import { MODEL_VARIANTS, resolveEffortForModel, getVariant, type ProviderId, type ThinkingEffort } from '@bytelight/shared';

  interface Preferences {
    identity: { companion_name: string; user_name: string; timezone: string };
    agent: {
      model: string;
      model_autonomous: string;
      thinking_effort: string;
      // PR #10: optional autonomous-tier override. Undefined when unset
      // (autonomous tier inherits chat's effort — pre-PR-#10 behavior).
      thinking_effort_autonomous?: string;
    };
    orchestrator: { enabled: boolean };
    voice: { enabled: boolean };
    discord: { enabled: boolean };
    telegram: { enabled: boolean };
    auth: { has_password: boolean };
  }

  let prefs = $state<Preferences | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let message = $state<string | null>(null);
  let error = $state<string | null>(null);

  // Editable drafts
  let companionName = $state('');
  let userName = $state('');
  let timezone = $state('');
  let model = $state('');
  let modelAutonomous = $state('');
  let thinkingEffort = $state('auto');
  // PR #10: empty string = "match chat tier" (the default, no override).
  // Any other value = explicit autonomous-tier override.
  let thinkingEffortAutonomous = $state('');
  let orchestratorEnabled = $state(true);
  let voiceEnabled = $state(false);
  let discordEnabled = $state(false);
  let telegramEnabled = $state(false);
  let newPassword = $state('');

  // ---------------------------------------------------------------------------
  // Companion-scope DEFAULT ENGINE (provider + model) — interactive & autonomous
  //
  // H (companion-default): the operator now chooses a companion-wide default
  // ENGINE (provider) per tier here. On save the panel writes a COMPANION-scope
  // row via PUT /api/companion-settings/default, which WINS over the legacy
  // agent.model / agent.model_autonomous config (now systemFallback only) in
  // the resolver (companion-resolver.ts:127-144). Autonomous resolves at
  // companion scope with threadId forced null (model-resolution.ts), so the
  // autonomous row drives wakes. The resolver keys on the house's own brain id
  // (local-brain.ts), served by GET /api/companions as localBrainId.
  //
  // Provider→model selection mirrors ModelSelector.svelte (the per-thread pill):
  // same provider list, same lazy catalogs, MODEL_VARIANTS for Claude/claude-cli.
  const COMPANION_ID = $derived(localBrainId());

  // Provider per tier. The Model dropdown follows the selected provider.
  let provider = $state<ProviderId>('claude');
  let providerAutonomous = $state<ProviderId>('claude');

  // "Use a different engine for autonomous wakes." OFF (default) = unified:
  // the primary picker drives BOTH tiers, the autonomous picker stays hidden
  // and on save the primary values are mirrored to the autonomous row. ON =
  // split: the autonomous picker is revealed and saved as its own engine.
  // Hydration flips this on when the two effective tiers already differ.
  let splitAutonomous = $state(false);

  // Provider list + labels — mirrors ModelSelector's PROVIDER_ROWS. claude-cli
  // labelled clearly as the subscription lane. huggingface (placeholder there)
  // is omitted — nothing to select yet.
  interface PanelProviderRow { id: ProviderId; label: string; }
  const PROVIDER_ROWS: PanelProviderRow[] = [
    { id: 'claude',       label: 'Claude' },
    { id: 'claude-cli',   label: 'Claude (CLI · subscription)' },
    { id: 'ollama',       label: 'Ollama' },
    { id: 'openai',       label: 'OpenAI' },
    { id: 'openrouter',   label: 'OpenRouter' },
    { id: 'groq',         label: 'Groq' },
    { id: 'xai',          label: 'Grok (xAI)' },
    { id: 'openai-codex', label: 'Codex' },
    // H2: OpenAI/Codex via the warm Codex app-server daemon (subscription/CLI-login).
    // Always selectable like claude-cli; catalog from /api/models?provider=codex-cli.
    { id: 'codex-cli',    label: 'Codex (CLI · subscription)' },
  ];

  // Provider availability from /api/models/status (mirrors ModelSelector).
  let providerStatus = $state<null | {
    routing: string;
    claude: { configured: boolean };
    ollama: { configured: boolean; enabled: boolean };
    openrouter: { configured: boolean };
    groq: { configured: boolean };
    xai: { configured: boolean };
    openai: { configured: boolean; enabled?: boolean };
    'openai-codex'?: { available: boolean };
  }>(null);
  let routingIsSdk = $derived(providerStatus?.routing === 'sdk');

  // Per-provider model catalogs (lazy-fetched, mirroring ModelSelector).
  let ollamaModels = $state<Array<{ id: string; name: string }>>([]);
  let openaiModels = $state<Array<{ id: string; name: string }>>([]);
  let codexModels = $state<Array<{ id: string; name: string }>>([]);
  // H2: Codex-CLI (warm daemon) catalog — same lazy-fetch shape as codexModels,
  // sourced from /api/models?provider=codex-cli.
  let codexCliModels = $state<Array<{ id: string; name: string }>>([]);
  type CompatProviderId = 'openrouter' | 'groq' | 'xai';
  const COMPAT_PROVIDERS: readonly CompatProviderId[] = ['openrouter', 'groq', 'xai'];
  function isCompatProvider(p: string): p is CompatProviderId {
    return p === 'openrouter' || p === 'groq' || p === 'xai';
  }
  let compatModels = $state<Record<CompatProviderId, Array<{ id: string; name: string }>>>({
    openrouter: [], groq: [], xai: [],
  });

  // Provider availability gate — mirrors ModelSelector.providerEnabled().
  // Claude + claude-cli are always selectable; foreign lanes gate on
  // configured (+ enabled where applicable) and routing != 'sdk'.
  function providerEnabled(id: ProviderId): boolean {
    if (id === 'claude' || id === 'claude-cli') return true;
    // H2: Codex-CLI is always selectable — subscription/CLI-login, no BYOK key
    // and no availability status object gates it (mirrors ModelSelector).
    if (id === 'codex-cli') return true;
    if (!providerStatus) return false;
    if (id === 'openai-codex') return providerStatus['openai-codex']?.available === true;
    if (routingIsSdk) return false;
    if (id === 'ollama') return providerStatus.ollama.configured && providerStatus.ollama.enabled;
    if (id === 'openai') return providerStatus.openai.configured && !!providerStatus.openai.enabled;
    if (isCompatProvider(id)) return providerStatus[id].configured;
    return false;
  }

  // Provider→model list. Claude/claude-cli share MODEL_VARIANTS (+ legacy for
  // classic Claude); foreign providers use their discovered catalogs.
  function modelsForProvider(p: ProviderId): Array<{ id: string; label: string }> {
    if (p === 'claude' || p === 'claude-cli') {
      return [
        ...MODEL_VARIANTS.map((v) => ({ id: v.modelApiId, label: v.label })),
        ...(p === 'claude' ? LEGACY_MODELS : []),
      ];
    }
    if (p === 'ollama') return ollamaModels.map((m) => ({ id: m.id, label: m.name }));
    if (p === 'openai') return openaiModels.map((m) => ({ id: m.id, label: m.name }));
    if (p === 'openai-codex') return codexModels.map((m) => ({ id: m.id, label: m.name }));
    if (p === 'codex-cli') return codexCliModels.map((m) => ({ id: m.id, label: m.name }));
    if (isCompatProvider(p)) return compatModels[p].map((m) => ({ id: m.id, label: m.name }));
    return [];
  }

  // Provider-aware model label for hints/warnings (replaces the Claude-only
  // labelFor for the two tier displays).
  function modelLabelFor(p: ProviderId, id: string): string {
    if (p === 'claude' || p === 'claude-cli') {
      return MODELS.find((m) => m.id === id)?.label ?? id;
    }
    return modelsForProvider(p).find((m) => m.id === id)?.label ?? id;
  }

  // Model option lists per tier, reactive to provider + catalog loads.
  let chatModels = $derived(modelsForProvider(provider));
  let autoModels = $derived(modelsForProvider(providerAutonomous));

  // When the provider changes, reset that tier's model to the provider's first
  // option (mirrors ModelSelector.selectProvider — no stale cross-provider id).
  function onProviderChange(tier: 'interactive' | 'autonomous') {
    if (tier === 'interactive') model = modelsForProvider(provider)[0]?.id ?? '';
    else modelAutonomous = modelsForProvider(providerAutonomous)[0]?.id ?? '';
  }

  // ---- Catalog fetchers (mirror ModelSelector; eager on mount for a settings
  // page rather than lazy-on-open) ----
  async function fetchProviderStatus(): Promise<void> {
    try {
      const res = await apiFetch('/api/models/status');
      if (res.ok) providerStatus = await res.json();
    } catch { /* leave null → foreign lanes stay disabled */ }
  }
  async function fetchOllamaModels(): Promise<void> {
    try {
      const res = await apiFetch('/api/models?provider=ollama');
      if (res.ok) {
        const data = await res.json();
        ollamaModels = Array.isArray(data)
          ? data.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name ?? m.id }))
          : [];
      }
    } catch { /* empty catalog */ }
  }
  async function fetchOpenaiModels(): Promise<void> {
    try {
      const res = await apiFetch('/api/models?provider=openai');
      if (res.ok) {
        const data = await res.json();
        openaiModels = Array.isArray(data)
          ? data.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name ?? m.id }))
          : [];
      }
    } catch { /* empty catalog */ }
  }
  async function fetchCodexModels(): Promise<void> {
    try {
      const res = await apiFetch('/api/models?provider=openai-codex');
      if (res.ok) {
        const data = await res.json();
        codexModels = Array.isArray(data)
          ? data.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name ?? m.id }))
          : [];
      }
    } catch { /* empty catalog */ }
  }
  async function fetchCodexCliModels(): Promise<void> {
    try {
      const res = await apiFetch('/api/models?provider=codex-cli');
      if (res.ok) {
        const data = await res.json();
        codexCliModels = Array.isArray(data)
          ? data.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name ?? m.id }))
          : [];
      }
    } catch { /* empty catalog */ }
  }
  async function fetchCompatModels(p: CompatProviderId): Promise<void> {
    try {
      const res = await apiFetch(`/api/models?provider=${p}`);
      if (res.ok) {
        const data = await res.json();
        compatModels[p] = Array.isArray(data)
          ? data.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name ?? m.id }))
          : [];
      }
    } catch { /* empty catalog */ }
  }

  // Hydrate the current companion-scope default per tier via the resolver's
  // effective read (no threadId → companion→system→fallback cascade). Even
  // with no companion row this returns the live default, so the selectors
  // always show what the tier resolves to today.
  async function fetchEffectiveDefault(
    tier: 'interactive' | 'autonomous',
  ): Promise<{ provider: ProviderId; model: string; effort: string } | null> {
    try {
      const qs = new URLSearchParams({ companionId: COMPANION_ID, tier });
      const res = await apiFetch(`/api/companion-settings/effective?${qs.toString()}`);
      if (!res.ok) return null;
      const d = await res.json();
      return {
        provider: d.provider as ProviderId,
        model: d.model as string,
        effort: (d.thinkingEffort as string) ?? 'auto',
      };
    } catch {
      return null;
    }
  }
  async function loadCompanionDefaults(): Promise<void> {
    const [inter, auto] = await Promise.all([
      fetchEffectiveDefault('interactive'),
      fetchEffectiveDefault('autonomous'),
    ]);
    if (inter) { provider = inter.provider; model = inter.model; }
    if (auto) { providerAutonomous = auto.provider; modelAutonomous = auto.model; }
    // Decide the initial split state: if both tiers resolve to the SAME engine
    // (provider + model + effort), the operator never diverged them — start in
    // the clean unified view (toggle OFF). If they DIFFER, someone set a
    // distinct wake engine — reveal it (toggle ON) so it isn't silently lost.
    if (inter && auto) {
      splitAutonomous = !(
        inter.provider === auto.provider &&
        inter.model === auto.model &&
        inter.effort === auto.effort
      );
    }
  }

  // Write one companion-scope default row. Throws on non-ok so savePrefs can
  // surface a single error.
  async function saveCompanionDefault(
    tier: 'interactive' | 'autonomous',
    providerId: ProviderId,
    modelId: string,
    effort: string,
  ): Promise<void> {
    const res = await apiFetch('/api/companion-settings/default', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companionId: COMPANION_ID,
        tier,
        providerId,
        modelId,
        thinkingEffort: effort,
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error ?? `Failed to save ${tier} default (${res.status})`);
    }
  }

  // Theme + Accent
  const THEMES = [
    { id: 'rose',  label: 'Midnight', bg: '#111113', accent: '#909090' },
    { id: 'petal', label: 'Daylight', bg: '#f0f0ee', accent: '#505050' },
  ];

  let currentTheme = $state(
    typeof localStorage !== 'undefined'
      ? (localStorage.getItem('bytelight-theme') ?? 'rose')
      : 'rose'
  );

  function setTheme(id: string) {
    currentTheme = id;
    document.documentElement.setAttribute('data-theme', id);
    localStorage.setItem('bytelight-theme', id);
  }

  const ACCENTS = [
    { id: 'crimson',  label: 'Crimson',  color: '#c43040' },
    { id: 'burgundy', label: 'Burgundy', color: '#d01850' },
    { id: 'rose',     label: 'Rose',     color: '#c04068' },
    { id: 'orange',   label: 'Orange',   color: '#d87818' },
    { id: 'amber',    label: 'Amber',    color: '#c88818' },
    { id: 'forest',   label: 'Forest',   color: '#1e7840' },
    { id: 'emerald',  label: 'Emerald',  color: '#1a9868' },
    { id: 'mint',     label: 'Mint',     color: '#1aaa90' },
    { id: 'teal',     label: 'Teal',     color: '#18b8a8' },
    { id: 'ocean',    label: 'Ocean',    color: '#1880c0' },
    { id: 'sapphire', label: 'Sapphire', color: '#1848c8' },
    { id: 'lavender', label: 'Lavender', color: '#8068d0' },
    { id: 'amethyst', label: 'Amethyst', color: '#6040b8' },
    { id: 'plum',     label: 'Plum',     color: '#7020a0' },
    { id: 'magenta',  label: 'Magenta',  color: '#c81878' },
    { id: 'blush',    label: 'Blush',    color: '#b88890' },
    { id: 'slate',    label: 'Slate',    color: '#707070' },
    { id: 'silver',   label: 'Silver',   color: '#a0a0a0' },
  ];

  let currentAccent = $state(
    typeof localStorage !== 'undefined'
      ? (localStorage.getItem('bytelight-accent') ?? '')
      : ''
  );

  function setAccent(id: string) {
    currentAccent = id;
    if (id) {
      document.documentElement.setAttribute('data-accent', id);
      localStorage.setItem('bytelight-accent', id);
    } else {
      document.documentElement.removeAttribute('data-accent');
      localStorage.removeItem('bytelight-accent');
    }
  }

  // Settings-panel labels prefix with "Claude " for clarity. The id is the raw
  // Anthropic API id so backend prefs storage stays unchanged.
  // Legacy 3.x / 3.5 ids are kept selectable but are not in the shared catalog.
  const LEGACY_MODELS = [
    { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
    { id: 'claude-3-opus-20240229',    label: 'Claude 3 Opus' },
  ];
  const MODELS = [
    ...MODEL_VARIANTS.map(v => ({ id: v.modelApiId, label: `Claude ${v.label}` })),
    ...LEGACY_MODELS,
  ];

  // (labelFor removed — the two tier displays now use the provider-aware
  // modelLabelFor defined above; MODELS still backs it for the Claude lanes.)

  // 'max' is documented as "Opus 4.6+ only" in the SDK type comments.
  // Picking it on a tier whose model is Sonnet/Haiku is a quiet footgun:
  // chat works, but that tier can fail at the API. Match by id substring
  // so both pinned ids (`claude-opus-4-7`) and the family alias (`opus`)
  // count as Opus. Sonnet / Haiku / aliases / unknown future models all
  // trip the warning.
  function isOpus(id: string): boolean {
    return /opus/i.test(id);
  }

  // PR #10: the autonomous-tier effort that's actually in effect right
  // now. When the override is unset (empty string), autonomous inherits
  // from chat — that's the back-compat fallback. Used for both the
  // dynamic resolution display and the per-tier Max warning logic.
  let effectiveAutonomousEffort = $derived(
    thinkingEffortAutonomous || thinkingEffort,
  );

  // Auto-resolution display per tier — surfaces what each tier would
  // resolve to when effort is 'auto'. Driven by `$derived` so values
  // update live as the user changes either model dropdown. Mirrors the
  // backend resolver via the shared `resolveEffortForModel` helper.
  let autoChatResolved = $derived(resolveEffortForModel(model, 'auto'));
  let autoAutonomousResolved = $derived(resolveEffortForModel(modelAutonomous, 'auto'));

  // PR #10: Max-effort warnings PER TIER. The dilemma the warning
  // surfaced in PR #9 (one tier wants Max, another can't accept it)
  // is now resolvable via the per-tier override — but the warning
  // still has value when a user explicitly picks Max on a non-Opus
  // tier. Both can fire simultaneously.
  let chatMaxWarning = $derived(
    thinkingEffort === 'max' && !isOpus(model)
      ? `Max may fail on ${modelLabelFor(provider, model)}. Consider Auto or XHigh.`
      : null,
  );
  let autonomousMaxWarning = $derived(
    effectiveAutonomousEffort === 'max' && !isOpus(modelAutonomous)
      ? `Max may fail on ${modelLabelFor(providerAutonomous, modelAutonomous)}. Consider Auto or XHigh.`
      : null,
  );

  const COMMON_TIMEZONES = [
    'UTC',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
    'Australia/Sydney', 'Pacific/Auckland',
  ];

  async function loadPrefs() {
    try {
      const res = await apiFetch('/api/preferences');
      if (!res.ok) throw new Error('Failed to load');
      prefs = await res.json();
      // Populate drafts
      companionName = prefs!.identity.companion_name;
      userName = prefs!.identity.user_name;
      timezone = prefs!.identity.timezone;
      const dbConfig = getConfig();
      // H (companion-default): the per-tier provider+model are NO LONGER
      // hydrated from agent.model / agent.model_autonomous config here — those
      // are systemFallback only now. loadCompanionDefaults() (called from
      // onMount) reads the companion-scope effective default via the resolver
      // and owns `provider`/`model` + `providerAutonomous`/`modelAutonomous`.
      // Thinking-effort still round-trips through config below (unchanged).
      // ORDER: DB-backed thinking_effort wins over YAML so the dropdown
      // reflects what the backend actually uses. Mirrors the model field
      // above (line 113-114) and the backend's getConfiguredThinkingEffort
      // cascade (DB > YAML > default). Without this, toggling effort via
      // the dropdown writes to DB but the panel reload reads YAML only,
      // showing a stale value while the chat is using the new one.
      thinkingEffort = dbConfig['agent.thinking_effort'] || prefs!.agent.thinking_effort || 'auto';
      // PR #10: autonomous-tier override. Same DB > YAML cascade as the
      // chat-tier field. Empty string when unset means "match chat tier"
      // — that's the UI's representation of the back-compat fallback.
      thinkingEffortAutonomous = dbConfig['agent.thinking_effort_autonomous']
        || prefs!.agent.thinking_effort_autonomous
        || '';
      orchestratorEnabled = prefs!.orchestrator.enabled;
      voiceEnabled = prefs!.voice.enabled;
      discordEnabled = prefs!.discord.enabled;
      telegramEnabled = prefs!.telegram.enabled;
    } catch (e) {
      error = 'Failed to load preferences';
    } finally {
      loading = false;
    }
  }

  async function savePrefs() {
    saving = true;
    message = null;
    error = null;
    // Guard: the companion-default route rejects an empty modelId. A provider
    // with no discoverable models (e.g. Ollama offline) can leave a tier's
    // model blank — catch it here with a clear message rather than a 400.
    // When split is OFF the autonomous row mirrors the primary, so only the
    // primary model must be present; when ON the autonomous model matters too.
    if (!model || (splitAutonomous && !modelAutonomous)) {
      error = splitAutonomous
        ? 'Pick a model for both your engine and the autonomous engine before saving.'
        : 'Pick a model for your engine before saving.';
      saving = false;
      return;
    }
    try {
      // /api/preferences still owns identity, feature toggles, security, and
      // thinking-effort. H (companion-default): it NO LONGER carries the model
      // — provider+model now live in companion-scope rows written below. The
      // legacy agent.model / agent.model_autonomous config is systemFallback
      // only and is not written from this panel anymore.
      const updates: Record<string, unknown> = {
        identity: { companion_name: companionName, user_name: userName, timezone },
        agent: {
          thinking_effort: thinkingEffort,
          // PR #10: empty string clears the override at the API layer
          // (deletes the YAML field, returns to chat-tier fallback). When
          // split is OFF the autonomous tier mirrors the primary, so the
          // override is always cleared (null) — the wake effort follows chat.
          thinking_effort_autonomous: splitAutonomous ? (thinkingEffortAutonomous || null) : null,
        },
        orchestrator: { enabled: orchestratorEnabled },
        voice: { enabled: voiceEnabled },
        discord: { enabled: discordEnabled },
        telegram: { enabled: telegramEnabled },
      };
      if (newPassword) {
        updates.auth = { password: newPassword };
      }
      const res = await apiFetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) {
        error = data.error || 'Failed to save';
        return;
      }
      // Write the companion-scope DEFAULT ENGINE per tier — the authoritative
      // path (wins over agent.* config in the resolver). Interactive drives
      // chat; autonomous drives wakes (resolver forces threadId=null and reads
      // at companion scope).
      //
      // Split OFF (unified): the primary engine IS the whole answer — mirror it
      // to BOTH rows so wakes silently follow the one engine the operator set.
      // Split ON: interactive gets the primary; autonomous gets its own picker's
      // values, with effectiveAutonomousEffort resolving "match chat" (empty
      // override) to a concrete effort for the stored row.
      await saveCompanionDefault('interactive', provider, model, thinkingEffort);
      if (splitAutonomous) {
        await saveCompanionDefault('autonomous', providerAutonomous, modelAutonomous, effectiveAutonomousEffort);
      } else {
        await saveCompanionDefault('autonomous', provider, model, thinkingEffort);
      }

      message = data.message || 'Saved';
      newPassword = '';
      // Keep the thinking-effort DB config in sync (unchanged from before —
      // effort still round-trips through config; model no longer does).
      await updateSetting('agent.thinking_effort', thinkingEffort);
      // PR #10: empty string clears via the same delete-on-empty semantics.
      // Split OFF mirrors the primary, so the override is cleared to keep the
      // config in lockstep with the mirrored companion row written above.
      await updateSetting('agent.thinking_effort_autonomous', splitAutonomous ? thinkingEffortAutonomous : '');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save preferences';
    } finally {
      saving = false;
    }
  }

  onMount(async () => {
    await loadPrefs();
    // Catalogs + availability, then hydrate the per-tier default engine from
    // the resolver's effective read. Eager fetch (settings page, not the hot
    // chat path) so the model dropdowns are populated when defaults land.
    await Promise.all([
      fetchProviderStatus(),
      fetchOllamaModels(),
      fetchOpenaiModels(),
      fetchCodexModels(),
      fetchCodexCliModels(),
      ...COMPAT_PROVIDERS.map((p) => fetchCompatModels(p)),
    ]);
    await loadCompanionDefaults();
  });
</script>

<div class="prefs-panel">
  {#if loading}
    <p class="loading-text">Loading preferences...</p>
  {:else if prefs}
    <!-- Identity -->
    <section class="section">
      <h3 class="section-title">Identity</h3>
      <p class="section-desc">Names and timezone used throughout the system.</p>

      <div class="field">
        <label class="field-label" for="pref-companion">Companion Name</label>
        <input id="pref-companion" type="text" class="field-input" bind:value={companionName} placeholder="Echo" />
      </div>

      <div class="field">
        <label class="field-label" for="pref-user">Your Name</label>
        <input id="pref-user" type="text" class="field-input" bind:value={userName} placeholder="Alex" />
      </div>

      <div class="field">
        <label class="field-label" for="pref-tz">Timezone</label>
        <select id="pref-tz" class="field-select" bind:value={timezone}>
          {#each COMMON_TIMEZONES as tz}
            <option value={tz}>{tz}</option>
          {/each}
          {#if !COMMON_TIMEZONES.includes(timezone)}
            <option value={timezone}>{timezone}</option>
          {/if}
        </select>
      </div>
    </section>

    <!-- Your Engine — one companion-wide provider + model that drives
         EVERYTHING (chat + autonomous), with an optional split for wakes. -->
    <section class="section">
      <h3 class="section-title">Your Engine</h3>
      <p class="section-desc">
        The provider and model your companion runs on — for everything, chat
        replies and autonomous wakes alike. A per-thread pick in the chat header
        still overrides this for that one thread.
      </p>

      <!-- Primary picker — always visible, the single knob most operators
           ever touch. Applies to both tiers unless the split below is on. -->
      <div class="engine-col">
        <div class="field">
          <label class="field-label" for="pref-chat-provider">Provider</label>
          <select id="pref-chat-provider" class="field-select" bind:value={provider} onchange={() => onProviderChange('interactive')}>
            {#each PROVIDER_ROWS as p}
              <option value={p.id} disabled={!providerEnabled(p.id)}>
                {p.label}{providerEnabled(p.id) ? '' : ' — unavailable'}
              </option>
            {/each}
          </select>
        </div>

        <div class="field">
          <label class="field-label" for="pref-chat-model">Model</label>
          <select id="pref-chat-model" class="field-select" bind:value={model}>
            {#each chatModels as m}
              <option value={m.id}>{m.label}</option>
            {/each}
            <!-- Fallback option so a hydrated model outside the loaded
                 catalog (offline provider, exotic id) still shows selected. -->
            {#if model && !chatModels.some((m) => m.id === model)}
              <option value={model}>{model}</option>
            {/if}
            {#if chatModels.length === 0 && !model}
              <option value="" disabled>No models available for this provider</option>
            {/if}
          </select>
        </div>

        <div class="field">
          <label class="field-label" for="pref-chat-effort">Thinking Effort</label>
          <select id="pref-chat-effort" class="field-select" bind:value={thinkingEffort}>
            <option value="auto">Auto — picks safely per model (recommended)</option>
            <option value="max">Max — frontier reasoning, spend freely (Opus 4.6+ only)</option>
            <option value="xhigh">XHigh — deep agentic/coding work</option>
            <option value="high">High — solid reasoning</option>
            <option value="medium">Medium — thinks when needed</option>
            <option value="low">Low — minimal thinking, fastest responses</option>
          </select>
          {#if thinkingEffort === 'auto'}
            <span class="field-hint resolved-hint">
              Auto on <strong>{modelLabelFor(provider, model)}</strong> → {autoChatResolved}
            </span>
          {/if}
          {#if chatMaxWarning}
            <span class="field-hint warning-hint">⚠️ {chatMaxWarning}</span>
          {/if}
        </div>
      </div>

      <!-- Optional split — OFF by default. When off, wakes silently mirror the
           engine above. When on, the autonomous picker below is revealed. -->
      <label class="engine-split-row">
        <input type="checkbox" bind:checked={splitAutonomous} />
        <span class="engine-split-text">
          <span class="engine-split-label">Use a different engine for autonomous wakes</span>
          <span class="engine-split-desc">Watchers, scribe, impulses — when the agent acts on its own</span>
        </span>
      </label>

      {#if splitAutonomous}
        <div class="engine-col">
          <h4 class="tier-title">Autonomous engine</h4>
          <p class="tier-sub">Wakes, watchers, scribe, impulses — when the agent acts on its own</p>

          <div class="field">
            <label class="field-label" for="pref-auto-provider">Provider</label>
            <select id="pref-auto-provider" class="field-select" bind:value={providerAutonomous} onchange={() => onProviderChange('autonomous')}>
              {#each PROVIDER_ROWS as p}
                <option value={p.id} disabled={!providerEnabled(p.id)}>
                  {p.label}{providerEnabled(p.id) ? '' : ' — unavailable'}
                </option>
              {/each}
            </select>
          </div>

          <div class="field">
            <label class="field-label" for="pref-auto-model">Model</label>
            <select id="pref-auto-model" class="field-select" bind:value={modelAutonomous}>
              {#each autoModels as m}
                <option value={m.id}>{m.label}</option>
              {/each}
              {#if modelAutonomous && !autoModels.some((m) => m.id === modelAutonomous)}
                <option value={modelAutonomous}>{modelAutonomous}</option>
              {/if}
              {#if autoModels.length === 0 && !modelAutonomous}
                <option value="" disabled>No models available for this provider</option>
              {/if}
            </select>
          </div>

          <div class="field">
            <label class="field-label" for="pref-auto-effort">Thinking Effort</label>
            <select id="pref-auto-effort" class="field-select" bind:value={thinkingEffortAutonomous}>
              <!-- PR #10: Empty string = "match chat tier" — preserves
                   pre-PR-#10 back-compat behavior when the user hasn't
                   customized. Sending empty/null clears the override
                   server-side. -->
              <option value="">Match your engine (currently {thinkingEffort})</option>
              <option value="auto">Auto — picks safely per model (recommended)</option>
              <option value="max">Max — frontier reasoning, spend freely (Opus 4.6+ only)</option>
              <option value="xhigh">XHigh — deep agentic/coding work</option>
              <option value="high">High — solid reasoning</option>
              <option value="medium">Medium — thinks when needed</option>
              <option value="low">Low — minimal thinking, fastest responses</option>
            </select>
            {#if effectiveAutonomousEffort === 'auto'}
              <span class="field-hint resolved-hint">
                Auto on <strong>{modelLabelFor(providerAutonomous, modelAutonomous)}</strong> → {autoAutonomousResolved}
              </span>
            {/if}
            {#if autonomousMaxWarning}
              <span class="field-hint warning-hint">⚠️ {autonomousMaxWarning}</span>
            {/if}
          </div>
        </div>
      {/if}
    </section>

    <!-- Toggles -->
    <section class="section">
      <h3 class="section-title">Features</h3>
      <p class="section-desc">Enable or disable system features.</p>

      <label class="toggle-row">
        <input type="checkbox" bind:checked={orchestratorEnabled} />
        <span class="toggle-label">Orchestrator</span>
        <span class="toggle-desc">Scheduled wake-ups and autonomous actions</span>
      </label>

      <label class="toggle-row">
        <input type="checkbox" bind:checked={voiceEnabled} />
        <span class="toggle-label">Voice</span>
        <span class="toggle-desc">ElevenLabs TTS and Groq transcription</span>
      </label>
      {#if voiceEnabled}
        <div class="setup-guide">
          <p class="guide-title">Voice Setup</p>
          <ol class="guide-steps">
            <li>Get an API key from <strong>ElevenLabs</strong> — <a href="https://elevenlabs.io" target="_blank" rel="noopener">elevenlabs.io</a> → Profile → API Keys</li>
            <li>Create or choose a voice, copy the <strong>Voice ID</strong> from the voice settings</li>
            <li>For transcription, get a <strong>Groq</strong> API key — <a href="https://console.groq.com" target="_blank" rel="noopener">console.groq.com</a> → API Keys</li>
            <li>Add to your <code>.env</code> file:
              <pre class="guide-code">ELEVENLABS_API_KEY=your_key_here
ELEVENLABS_VOICE_ID=your_voice_id
GROQ_API_KEY=your_groq_key</pre>
            </li>
            <li>Restart the server</li>
          </ol>
        </div>
      {/if}

      <label class="toggle-row">
        <input type="checkbox" bind:checked={discordEnabled} />
        <span class="toggle-label">Discord</span>
        <span class="toggle-desc">Discord bot gateway integration</span>
      </label>
      {#if discordEnabled}
        <div class="setup-guide">
          <p class="guide-title">Discord Setup</p>
          <ol class="guide-steps">
            <li>Go to the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a></li>
            <li>Create a <strong>New Application</strong>, then go to <strong>Bot</strong> → Reset Token → copy the token</li>
            <li>Under <strong>Privileged Gateway Intents</strong>, enable: Message Content, Server Members, Presence</li>
            <li>Go to <strong>OAuth2</strong> → URL Generator → select <code>bot</code> scope with permissions: Send Messages, Read Message History, Add Reactions, Embed Links, Attach Files</li>
            <li>Use the generated URL to invite the bot to your server</li>
            <li>Right-click your username in Discord → Copy User ID (enable Developer Mode in Discord settings first)</li>
            <li>Add to your <code>.env</code> file:
              <pre class="guide-code">DISCORD_BOT_TOKEN=your_bot_token</pre>
            </li>
            <li>Set your owner user ID in <code>bytelight.yaml</code>:
              <pre class="guide-code">discord:
  enabled: true
  owner_user_id: "your_discord_user_id"</pre>
            </li>
            <li>Restart the server. Configure rules in the Discord tab in settings.</li>
          </ol>
        </div>
      {/if}

      <label class="toggle-row">
        <input type="checkbox" bind:checked={telegramEnabled} />
        <span class="toggle-label">Telegram</span>
        <span class="toggle-desc">Telegram bot integration</span>
      </label>
      {#if telegramEnabled}
        <div class="setup-guide">
          <p class="guide-title">Telegram Setup</p>
          <ol class="guide-steps">
            <li>Open Telegram, search for <strong>@BotFather</strong></li>
            <li>Send <code>/newbot</code>, follow the prompts to name your bot</li>
            <li>Copy the <strong>bot token</strong> BotFather gives you</li>
            <li>Send a message to your new bot, then visit:<br/>
              <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code><br/>
              Find your <strong>chat ID</strong> in the response JSON under <code>message.chat.id</code></li>
            <li>Add to your <code>.env</code> file:
              <pre class="guide-code">TELEGRAM_BOT_TOKEN=your_bot_token</pre>
            </li>
            <li>Set your chat ID in <code>bytelight.yaml</code>:
              <pre class="guide-code">telegram:
  enabled: true
  owner_chat_id: "your_chat_id"</pre>
            </li>
            <li>Restart the server</li>
          </ol>
        </div>
      {/if}
    </section>

    <!-- Security -->
    <section class="section">
      <h3 class="section-title">Security</h3>
      <p class="section-desc">
        {#if prefs.auth.has_password}
          Password is set. Leave blank to keep current password.
        {:else}
          No password set. Access is open to anyone on the network.
        {/if}
      </p>

      <div class="field">
        <label class="field-label" for="pref-password">
          {prefs.auth.has_password ? 'Change Password' : 'Set Password'}
        </label>
        <input id="pref-password" type="password" class="field-input" bind:value={newPassword} placeholder="Leave blank to keep unchanged" />
      </div>
    </section>

    <!-- Save -->
    <div class="save-area">
      {#if message}
        <p class="save-message success">{message}</p>
      {/if}
      {#if error}
        <p class="save-message error">{error}</p>
      {/if}
      <button class="res-btn res-btn--primary" onclick={savePrefs} disabled={saving}>
        {saving ? 'Saving...' : 'Save Preferences'}
      </button>
      <p class="save-hint">Some changes require a server restart to take effect.</p>
    </div>
  {:else}
    <p class="loading-text">{error || 'Unable to load preferences'}</p>
  {/if}
</div>

<style>
  .prefs-panel {
    max-width: 540px;
  }

  .loading-text {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    padding: 1rem 0;
  }

  .section {
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .section:last-of-type {
    border-bottom: none;
  }

  .section-title {
    font-family: var(--font-heading);
    font-size: 0.9375rem;
    font-weight: 400;
    color: var(--text-accent);
    letter-spacing: 0.04em;
    margin: 0 0 0.375rem;
  }

  .section-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 1rem;
    line-height: 1.5;
  }

  .field {
    margin-bottom: 1rem;
  }

  .field-label {
    display: block;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    margin-bottom: 0.375rem;
    letter-spacing: 0.02em;
  }

  .field-input,
  .field-select {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    font-family: inherit;
    color: var(--text-primary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .field-input:focus,
  .field-select:focus {
    outline: none;
    border-color: var(--gold-dim);
    box-shadow: 0 0 0 2px rgba(196, 168, 114, 0.08);
  }

  .field-hint {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  /* One unified engine card (primary picker + optional autonomous picker).
     Stacked, full width — the primary is the single knob most operators
     ever touch; the autonomous card only appears behind the split toggle. */
  .engine-col {
    border: 1px solid rgba(155, 114, 207, 0.2);
    border-radius: 0.5rem;
    padding: 0.875rem;
    background: rgba(255, 255, 255, 0.015);
  }
  .engine-col .field:last-child {
    margin-bottom: 0;
  }

  /* Split toggle — sits between the primary card and the (conditional)
     autonomous card. Clean inline row, no divider (unlike the Features
     toggles) so it reads as part of the engine group. */
  .engine-split-row {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    margin: 0.875rem 0;
    cursor: pointer;
  }
  .engine-split-row input[type="checkbox"] {
    margin-top: 0.15rem;
    width: 1rem;
    height: 1rem;
    accent-color: var(--gold);
    flex-shrink: 0;
  }
  .engine-split-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .engine-split-label {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    letter-spacing: 0.02em;
  }
  .engine-split-desc {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .tier-title {
    margin: 0 0 0.125rem 0;
    font-size: 0.95rem;
  }
  .tier-sub {
    margin: 0 0 0.75rem 0;
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .resolved-hint {
    margin-top: 0.25rem;
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .resolved-hint strong {
    color: var(--text);
    font-weight: 500;
  }

  .warning-hint {
    margin-top: 0.375rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.25rem;
    background: rgba(220, 180, 80, 0.1);
    color: rgb(200, 160, 80);
    font-size: 0.75rem;
  }

  .toggle-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 0;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }

  .toggle-row:last-of-type {
    border-bottom: none;
  }

  .toggle-row input[type="checkbox"] {
    margin-top: 0.125rem;
    width: 1rem;
    height: 1rem;
    accent-color: var(--gold);
    flex-shrink: 0;
  }

  .toggle-label {
    font-size: 0.875rem;
    color: var(--text-primary);
    min-width: 5rem;
    flex-shrink: 0;
  }

  .toggle-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    flex: 1;
  }

  .save-area {
    padding-top: 0.5rem;
  }

  .save-message {
    font-size: 0.8125rem;
    padding: 0.5rem 0;
    margin: 0;
  }

  .save-message.success {
    color: var(--gold);
  }

  .save-message.error {
    color: var(--color-error);
  }

  .save-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.5rem;
  }

  .setup-guide {
    margin: 0.5rem 0 1rem 1.75rem;
    padding: 1rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-left: 2px solid var(--gold-dim);
    border-radius: 6px;
  }

  .guide-title {
    font-family: var(--font-heading);
    font-size: 0.8125rem;
    font-weight: 400;
    color: var(--text-accent);
    letter-spacing: 0.04em;
    margin: 0 0 0.75rem;
  }

  .guide-steps {
    margin: 0;
    padding-left: 1.25rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.7;
  }

  .guide-steps li {
    margin-bottom: 0.5rem;
  }

  .guide-steps a {
    color: var(--gold);
    text-decoration: none;
    border-bottom: 1px solid var(--gold-dim);
  }

  .guide-steps a:hover {
    border-bottom-color: var(--gold);
  }

  .guide-steps code {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.75rem;
    padding: 0.125rem 0.375rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--gold);
  }

  .guide-code {
    display: block;
    margin: 0.5rem 0;
    padding: 0.625rem 0.75rem;
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.75rem;
    line-height: 1.6;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow-x: auto;
    white-space: pre;
  }
</style>
