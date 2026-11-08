<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import type { UsageEvent, UsageBucket, UsageToolRow } from '@bytelight/shared';
  import { apiFetch } from '$lib/utils/api';

  type Tab = 'dashboard' | 'limits' | 'log' | 'glossary';
  const tabs: { id: Tab; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'limits', label: 'Limits' },
    { id: 'log', label: 'Request Log' },
    { id: 'glossary', label: 'Glossary' },
  ];

  type Spend = {
    usedFormatted: string | null;
    limitFormatted: string | null;
    percent: number | null;
    enabled: boolean;
    canPurchaseCredits: boolean;
  };

  type ClaudeLimit = {
    kind: string;
    label: string;
    percent: number;
    severity: string;
    resetsAt: string | null;
  };

  type ClaudeExtraUsage = {
    enabled: boolean;
    utilization: number | null;
    monthlyLimit: number | null;
    usedCredits: number | null;
    disabledReason: string | null;
  };

  type ClaudeUsage = {
    fiveHourPercent: number;
    fiveHourResetsAt: string | null;
    weeklyPercent: number;
    weeklyResetsAt: string | null;
    modelWeeklyPercent: number | null;
    modelWeeklyLabel: string | null;
    modelWeeklyResetsAt: string | null;
    extraUsageEnabled: boolean;
    subscriptionType: string;
    limits: ClaudeLimit[];
    extraUsage: ClaudeExtraUsage | null;
    spend: Spend | null;
  };

  type CodexWindow = {
    usedPercent: number;
    windowMinutes: number | null;
    resetsAt: string | null;
  };

  type CodexUsage = {
    usedPercent: number;
    windowMinutes: number | null;
    resetsAt: string | null;
    planType: string;
    capturedAt: string | null;
    secondary: CodexWindow | null;
    credits: { balance: string | null; unlimited: boolean; has: boolean } | null;
    limitReached: string | null;
  };

  type ProviderUsage = {
    provider: string;
    periodStart: string;
    periodEnd: string;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    spend: Spend;
  };

  type VoiceUsage = {
    tier: string;
    characterCount: number;
    characterLimit: number;
    remaining: number;
    usedPercent: number;
    nextResetAt: string | null;
  };

  const WAITING_NOTE = 'Waiting on the new backend — restart to light this up.';

  type Range = 'today' | 'week' | 'month' | 'all';
  const ranges: readonly Range[] = ['today', 'week', 'month', 'all'];

  let activeTab = $state<Tab>('dashboard');
  let range = $state<Range>('today');
  let error = $state<string | null>(null);

  let events = $state<UsageEvent[]>([]);
  let byModel = $state<UsageBucket[]>([]);
  let byPlatform = $state<UsageBucket[]>([]);
  let byMode = $state<UsageBucket[]>([]);
  let byDay = $state<UsageBucket[]>([]);
  let tools = $state<UsageToolRow[]>([]);
  let total = $state<UsageBucket | null>(null);
  let loading = $state(false);

  let claudeUsage = $state<ClaudeUsage | null>(null);
  let claudeError = $state<string | null>(null);
  let codexUsage = $state<CodexUsage | null>(null);
  let codexError = $state<string | null>(null);
  let providers = $state<ProviderUsage[]>([]);
  let voiceUsage = $state<VoiceUsage | null>(null);
  let voiceError = $state<string | null>(null);
  let limitsLoading = $state(false);
  let limitsError = $state<string | null>(null);

  function sinceFor(range: string): string | undefined {
    const now = new Date();
    if (range === 'today') {
      const d = new Date(now); d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    if (range === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - 7);
      return d.toISOString();
    }
    if (range === 'month') {
      const d = new Date(now); d.setDate(d.getDate() - 30);
      return d.toISOString();
    }
    return undefined;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const since = sinceFor(range);
      const q = since ? `?since=${encodeURIComponent(since)}` : '';

      const [evRes, totalRes, modelRes, platformRes, modeRes, dayRes, toolRes] = await Promise.all([
        apiFetch(`/api/usage/events${q}${q ? '&' : '?'}limit=200`).then(r => r.json()),
        apiFetch(`/api/usage/aggregate${q}`).then(r => r.json()),
        apiFetch(`/api/usage/aggregate${q}${q ? '&' : '?'}groupBy=model`).then(r => r.json()),
        apiFetch(`/api/usage/aggregate${q}${q ? '&' : '?'}groupBy=platform`).then(r => r.json()),
        apiFetch(`/api/usage/aggregate${q}${q ? '&' : '?'}groupBy=mode`).then(r => r.json()),
        apiFetch(`/api/usage/aggregate${q}${q ? '&' : '?'}groupBy=day`).then(r => r.json()),
        apiFetch(`/api/usage/tools${q}`).then(r => r.json()),
      ]);

      events = evRes.events || [];
      total = (totalRes.buckets && totalRes.buckets[0]) || null;
      byModel = modelRes.buckets || [];
      byPlatform = platformRes.buckets || [];
      byMode = modeRes.buckets || [];
      byDay = dayRes.buckets || [];
      tools = toolRes.tools || [];
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load usage data';
    } finally {
      loading = false;
    }
  }

  async function loadLimits() {
    limitsLoading = true;
    limitsError = null;
    const loadClaude = async () => {
      try {
        const res = await apiFetch('/api/usage/claude');
        const data = await res.json().catch(() => null) as (Partial<ClaudeUsage> & { error?: unknown }) | null;
        if (!res.ok) throw new Error(typeof data?.error === 'string' && data.error ? data.error : `load failed (${res.status})`);
        if (typeof data?.fiveHourPercent !== 'number' || typeof data?.weeklyPercent !== 'number') {
          claudeUsage = null;
          claudeError = WAITING_NOTE;
          return;
        }
        const limits: ClaudeLimit[] = Array.isArray(data.limits)
          ? data.limits
              .filter((limit): limit is ClaudeLimit =>
                !!limit && typeof limit === 'object'
                && typeof (limit as ClaudeLimit).label === 'string'
                && typeof (limit as ClaudeLimit).percent === 'number')
              .map((limit) => ({
                kind: typeof limit.kind === 'string' ? limit.kind : '',
                label: limit.label,
                percent: limit.percent,
                severity: typeof limit.severity === 'string' ? limit.severity : 'normal',
                resetsAt: typeof limit.resetsAt === 'string' ? limit.resetsAt : null,
              }))
          : [];
        const extraRaw = data.extraUsage;
        const extraUsage: ClaudeExtraUsage | null = extraRaw && typeof extraRaw === 'object'
          ? {
              enabled: extraRaw.enabled === true,
              utilization: typeof extraRaw.utilization === 'number' ? extraRaw.utilization : null,
              monthlyLimit: typeof extraRaw.monthlyLimit === 'number' ? extraRaw.monthlyLimit : null,
              usedCredits: typeof extraRaw.usedCredits === 'number' ? extraRaw.usedCredits : null,
              disabledReason: typeof extraRaw.disabledReason === 'string' ? extraRaw.disabledReason : null,
            }
          : null;
        const spendRaw = data.spend;
        const spend: Spend | null = spendRaw && typeof spendRaw === 'object'
          ? {
              usedFormatted: typeof spendRaw.usedFormatted === 'string' ? spendRaw.usedFormatted : null,
              limitFormatted: typeof spendRaw.limitFormatted === 'string' ? spendRaw.limitFormatted : null,
              percent: typeof spendRaw.percent === 'number' ? spendRaw.percent : null,
              enabled: spendRaw.enabled === true,
              canPurchaseCredits: spendRaw.canPurchaseCredits === true,
            }
          : null;
        claudeUsage = {
          fiveHourPercent: data.fiveHourPercent,
          fiveHourResetsAt: typeof data.fiveHourResetsAt === 'string' ? data.fiveHourResetsAt : null,
          weeklyPercent: data.weeklyPercent,
          weeklyResetsAt: typeof data.weeklyResetsAt === 'string' ? data.weeklyResetsAt : null,
          modelWeeklyPercent: typeof data.modelWeeklyPercent === 'number' ? data.modelWeeklyPercent : null,
          modelWeeklyLabel: typeof data.modelWeeklyLabel === 'string' ? data.modelWeeklyLabel : null,
          modelWeeklyResetsAt: typeof data.modelWeeklyResetsAt === 'string' ? data.modelWeeklyResetsAt : null,
          extraUsageEnabled: data.extraUsageEnabled === true,
          subscriptionType: typeof data.subscriptionType === 'string' ? data.subscriptionType : 'unknown',
          limits,
          extraUsage,
          spend,
        };
        claudeError = null;
      } catch (e) {
        claudeUsage = null;
        claudeError = e instanceof Error ? e.message : 'Claude usage unavailable.';
      }
    };
    const loadCodex = async () => {
      try {
        const res = await apiFetch('/api/usage/codex');
        const data = await res.json().catch(() => null) as (Partial<CodexUsage> & {
          hasCredits?: unknown;
          creditsBalance?: unknown;
          creditsUnlimited?: unknown;
          error?: unknown;
        }) | null;
        if (!res.ok) throw new Error(typeof data?.error === 'string' && data.error ? data.error : `load failed (${res.status})`);
        if (typeof data?.usedPercent !== 'number') {
          codexUsage = null;
          codexError = WAITING_NOTE;
          return;
        }
        codexUsage = {
          usedPercent: data.usedPercent,
          windowMinutes: typeof data.windowMinutes === 'number' ? data.windowMinutes : null,
          resetsAt: typeof data.resetsAt === 'string' ? data.resetsAt : null,
          planType: typeof data.planType === 'string' ? data.planType : 'unknown',
          capturedAt: typeof data.capturedAt === 'string' ? data.capturedAt : null,
          secondary: parseCodexWindow(data.secondary),
          credits: 'hasCredits' in data
            ? {
                balance: typeof data.creditsBalance === 'string' ? data.creditsBalance : null,
                unlimited: data.creditsUnlimited === true,
                has: data.hasCredits === true,
              }
            : null,
          limitReached: typeof data.limitReached === 'string' ? data.limitReached : null,
        };
        codexError = null;
      } catch (e) {
        codexUsage = null;
        codexError = e instanceof Error ? e.message : 'Codex usage unavailable.';
      }
    };
    const loadProviders = async () => {
      try {
        const res = await apiFetch('/api/usage/providers');
        const data = await res.json().catch(() => null) as { providers?: ProviderUsage[]; error?: unknown } | null;
        if (!res.ok) throw new Error(typeof data?.error === 'string' && data.error ? data.error : `load failed (${res.status})`);
        providers = Array.isArray(data?.providers) ? data.providers : [];
      } catch (e) {
        providers = [];
        limitsError = e instanceof Error ? e.message : 'Failed to load provider spend';
      }
    };
    const loadVoice = async () => {
      try {
        const res = await apiFetch('/api/voice/usage');
        const data = await res.json().catch(() => null) as (Partial<VoiceUsage> & { error?: unknown }) | null;
        if (!res.ok) throw new Error(typeof data?.error === 'string' && data.error ? data.error : `load failed (${res.status})`);
        if (typeof data?.characterCount !== 'number' || typeof data?.characterLimit !== 'number') {
          voiceUsage = null;
          voiceError = WAITING_NOTE;
          return;
        }
        voiceUsage = {
          tier: typeof data.tier === 'string' ? data.tier : 'unknown',
          characterCount: data.characterCount,
          characterLimit: data.characterLimit,
          remaining: typeof data.remaining === 'number'
            ? data.remaining
            : Math.max(0, data.characterLimit - data.characterCount),
          usedPercent: typeof data.usedPercent === 'number'
            ? data.usedPercent
            : data.characterLimit > 0
              ? Math.min(100, Math.round((data.characterCount / data.characterLimit) * 1000) / 10)
              : 0,
          nextResetAt: typeof data.nextResetAt === 'string' ? data.nextResetAt : null,
        };
        voiceError = null;
      } catch (e) {
        voiceUsage = null;
        voiceError = e instanceof Error ? e.message : 'Voice usage unavailable.';
      }
    };

    await Promise.all([loadClaude(), loadCodex(), loadProviders(), loadVoice()]);
    limitsLoading = false;
  }

  onMount(() => {
    const hash = window.location.hash.replace('#', '') as Tab;
    if (tabs.some(t => t.id === hash)) activeTab = hash;
    load();
    loadLimits();
  });

  function setTab(tab: Tab) {
    activeTab = tab;
    window.location.hash = tab;
  }

  function fmtNum(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  function fmtUsd(n: number | null | undefined): string {
    if (n == null) return '—';
    if (n < 0.01) return '<$0.01';
    return '$' + n.toFixed(2);
  }

  function fmtTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { hour12: false, dateStyle: 'short', timeStyle: 'medium' });
  }

  function formatReset(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function windowLabel(minutes: number | null): string {
    if (minutes === 10080) return 'weekly window';
    if (minutes === 300) return '5-hour window';
    if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour window`;
    return 'window';
  }

  function severityColor(severity: string, accent: string): string {
    // the operator's call: bars ride her preferences accent, never a hardcoded clashing
    // hue. How close to the wall reads off the fill + the severity label, not
    // a bright red/amber that would knife the cosmic-cyber-witch palette.
    return accent;
  }

  function parseCodexWindow(value: unknown): CodexWindow | null {
    if (!value || typeof value !== 'object') return null;
    const window = value as Record<string, unknown>;
    if (typeof window.usedPercent !== 'number') return null;
    return {
      usedPercent: window.usedPercent,
      windowMinutes: typeof window.windowMinutes === 'number' ? window.windowMinutes : null,
      resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
    };
  }

  function parseTools(json: string | null): Array<{ name: string; count: number }> {
    if (!json) return [];
    try { return JSON.parse(json); } catch { return []; }
  }

  function cacheHitRate(b: UsageBucket | null): number {
    if (!b) return 0;
    const total = b.input_tokens + b.cache_read_tokens + b.cache_creation_tokens;
    if (total === 0) return 0;
    return Math.round((b.cache_read_tokens / total) * 100);
  }

  const GLOSSARY: Array<{ id: string; term: string; definition: string }> = [
    { id: 'request', term: 'Request', definition: 'One agent run — you sending a message, us waking up on a schedule, a trigger firing. Each of these produces exactly one usage event.' },
    { id: 'input_tokens', term: 'Input tokens', definition: 'Everything the system sent to Claude: your message, the orientation block (time, thread, presence), skill files on first message, tool results from earlier turns, and conversation history.' },
    { id: 'output_tokens', term: 'Output tokens', definition: 'What Claude generated back: the reply text, thinking blocks, tool call arguments.' },
    { id: 'cache_read', term: 'Cache reads', definition: 'Tokens Anthropic recognized from an earlier cached turn and served at ~10% of normal input cost. High cache reads = we\'re saving money on repeated context (like CLAUDE.md on every turn).' },
    { id: 'cache_write', term: 'Cache writes', definition: 'New tokens the system chose to cache so future turns can read them cheaply. Writes cost 1.25× input — it\'s a small upfront fee to unlock cheap reads for ~5 minutes.' },
    { id: 'cache_hit', term: 'Cache hit rate', definition: 'Percentage of input tokens that came from cache instead of fresh. Higher is better. Low hit rate can mean: new thread, many tool uses re-shaping context, or context window was compacted.' },
    { id: 'mode_interactive', term: 'Mode: interactive', definition: 'You sent a message (web, Discord, Telegram, or API) and we responded.' },
    { id: 'mode_autonomous', term: 'Mode: autonomous', definition: 'We ran on our own — an orchestrator wake (morning, creative hour, water reminder), a trigger fire, or a timer. No direct user prompt.' },
    { id: 'context_pct', term: 'Context %', definition: 'How full the context window was when this turn ran — measured at the main model\'s largest single-call prompt (input + cache reads + cache writes), divided by the variant\'s window cap (1M for 1M variants, 200K otherwise). Subagent calls do not count. Auto-compaction fires around 80–85%.' },
    { id: 'tools', term: 'Tools', definition: 'Every tool we invoked during the request — MCP calls (Notion, Mind, Discord), Bash commands, file reads, etc. Token cost is per-request, not per-tool, so we show counts rather than individual tool prices.' },
    { id: 'duration', term: 'Duration', definition: 'Wall-clock time from when the request started to when it finished. Includes our thinking time and any tool round-trips.' },
    { id: 'total_tokens', term: 'Total tokens', definition: 'Sum of input + output + cache-read + cache-write tokens. This is the metric that matters for what is left in your envelope.' },
    { id: 'by_model', term: 'By model', definition: 'Which models were used. Opus costs 5× Sonnet; Haiku is cheapest.' },
    { id: 'by_platform', term: 'By platform', definition: 'Where the request came from — web UI, Discord, Telegram, or autonomous wake.' },
    { id: 'by_mode', term: 'By mode', definition: 'Interactive = you\'re talking to us. Autonomous = us working on our own (wakes, triggers, schedules).' },
    { id: 'by_day', term: 'By day', definition: 'Daily totals for the selected range.' },
    { id: 'tools_used', term: 'Tools used', definition: 'Which tools we called and how often. Not a per-tool cost — tokens aren\'t billed per tool.' },
    { id: 'cost', term: 'Cost', definition: 'Estimated USD cost based on Anthropic\'s published API pricing. Calculated from input tokens, output tokens, cache reads (0.1× input), and cache writes (1.25× input). Unknown models default to Opus pricing to avoid underestimating.' },
  ];

  function getTerm(id: string) {
    return GLOSSARY.find(g => g.id === id);
  }

  let openPopover = $state<string | null>(null);

  function togglePopover(id: string, e: MouseEvent) {
    e.stopPropagation();
    openPopover = openPopover === id ? null : id;
  }

  function handleDocClick() {
    openPopover = null;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') openPopover = null;
  }
</script>

<svelte:window onclick={handleDocClick} onkeydown={handleKeydown} />

{#snippet helpIcon(id: string)}
  {@const t = getTerm(id)}
  {#if t}
    <span class="info-wrap">
      <button
        type="button"
        class="info"
        aria-label="What is {t.term}?"
        aria-expanded={openPopover === id}
        onclick={(e) => togglePopover(id, e)}
      >ⓘ</button>
      {#if openPopover === id}
        <div class="popover" role="dialog" aria-label={t.term} onclick={(e) => e.stopPropagation()}>
          <div class="popover-term">{t.term}</div>
          <div class="popover-def">{t.definition}</div>
        </div>
      {/if}
    </span>
  {/if}
{/snippet}

<div class="usage-page">
  <div class="usage-topbar">
  <header class="usage-header">
    <a href="{base}/chat" class="back-link">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 12H5M12 19l-7-7 7-7"/>
      </svg>
      Chat
    </a>
    <h1 class="header-title">Usage</h1>
    {#if activeTab === 'dashboard' || activeTab === 'log'}
      <div class="range-controls">
        {#each ranges as r}
          <button
            class="range-btn"
            class:active={range === r}
            onclick={() => { range = r; load(); }}
          >{r[0].toUpperCase() + r.slice(1)}</button>
        {/each}
      </div>
    {/if}
  </header>

  <nav class="tabs">
    {#each tabs as tab}
      <button class="tab" class:active={activeTab === tab.id} onclick={() => setTab(tab.id)}>
        {tab.label}
      </button>
    {/each}
  </nav>
  </div>

  {#if loading && (activeTab === 'dashboard' || activeTab === 'log')}
    <div class="loading">Loading…</div>
  {/if}

  {#if error && (activeTab === 'dashboard' || activeTab === 'log')}
    <div class="error">{error}</div>
  {/if}

  {#if activeTab === 'limits'}
    {#if limitsLoading}
      <div class="loading">Loading…</div>
    {/if}

    {#if limitsError}
      <div class="error">{limitsError}</div>
    {/if}

    <section class="limits-dashboard">
      <div class="limits-panel">
        <div class="limits-heading">ElevenLabs credits</div>
        {#if voiceUsage}
          <div class="usage-track usage-track-primary usage-track-fallback">
            <div class="usage-fill" style:width={`${Math.max(2, voiceUsage.usedPercent)}%`}></div>
          </div>
          <div class="usage-primary">
            {voiceUsage.characterCount.toLocaleString()} of {voiceUsage.characterLimit.toLocaleString()} used
            <span class="usage-muted usage-ml">({voiceUsage.usedPercent}%)</span>
          </div>
          <div class="usage-detail">
            {voiceUsage.remaining.toLocaleString()} remaining{voiceUsage.nextResetAt ? ` · resets ${formatReset(voiceUsage.nextResetAt)}` : ''}{voiceUsage.tier && voiceUsage.tier !== 'unknown' ? ` · ${voiceUsage.tier} tier` : ''}
          </div>
        {:else}
          <p class="usage-note">{voiceError || 'Loading…'}</p>
        {/if}
      </div>

      <div class="limits-panel">
        <div class="limits-heading">Claude usage</div>
        {#if claudeUsage}
          {#if claudeUsage.limits.length > 0}
            <div class="limit-rows">
              {#each claudeUsage.limits as limit, index (`${limit.kind}-${limit.label}`)}
                <div>
                  <div class:usage-track-primary={index === 0} class:usage-track-secondary={index !== 0} class="usage-track usage-track-row">
                    <div
                      class="usage-fill"
                      style:width={`${Math.max(2, limit.percent)}%`}
                      style:background-color={severityColor(limit.severity, 'var(--accent)')}
                    ></div>
                  </div>
                  <div class:usage-primary={index === 0} class:usage-secondary={index !== 0}>
                    {limit.label} {limit.percent}% used
                    {#if limit.resetsAt}<span class="usage-muted usage-ml">· resets {formatReset(limit.resetsAt)}</span>{/if}
                    {#if limit.severity !== 'normal'}
                      <span class="severity usage-ml" style:color={severityColor(limit.severity, 'var(--accent)')}>· {limit.severity}</span>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {:else}
            <div class="usage-track usage-track-primary usage-track-fallback">
              <div class="usage-fill" style:width={`${Math.max(2, claudeUsage.fiveHourPercent)}%`}></div>
            </div>
            <div class="usage-primary">
              5-hour window {claudeUsage.fiveHourPercent}% used
              {#if claudeUsage.fiveHourResetsAt}<span class="usage-muted usage-ml">· resets {formatReset(claudeUsage.fiveHourResetsAt)}</span>{/if}
            </div>
            <div class="usage-detail">
              weekly {claudeUsage.weeklyPercent}%{claudeUsage.modelWeeklyPercent !== null ? ` · ${claudeUsage.modelWeeklyLabel || 'model'} ${claudeUsage.modelWeeklyPercent}%` : ''}{claudeUsage.weeklyResetsAt ? ` · resets ${formatReset(claudeUsage.weeklyResetsAt)}` : ''}
            </div>
          {/if}
          {@const extraOn = claudeUsage.extraUsage ? claudeUsage.extraUsage.enabled : claudeUsage.extraUsageEnabled}
          <div class:extra-on={extraOn} class="extra-usage">
            <span class:extra-dot-on={extraOn} class="extra-dot"></span>
            <span>
              {extraOn ? 'extra usage ON — overage bills to credits' : 'extra usage off — stops at limits, never bills'}{claudeUsage.extraUsage?.enabled && claudeUsage.extraUsage.utilization !== null ? ` · ${claudeUsage.extraUsage.utilization}% of monthly cap` : ''}{claudeUsage.extraUsage?.enabled && claudeUsage.extraUsage.usedCredits !== null ? ` · ${claudeUsage.extraUsage.usedCredits} credits used` : ''}{!extraOn && claudeUsage.extraUsage?.disabledReason ? ` (${claudeUsage.extraUsage.disabledReason})` : ''}
            </span>
          </div>
          <div class="usage-detail">
            {claudeUsage.subscriptionType !== 'unknown' ? `${claudeUsage.subscriptionType} plan` : 'plan unknown'}{claudeUsage.spend ? ` · usage credits ${claudeUsage.spend.usedFormatted ?? '$0.00'} spent${claudeUsage.spend.limitFormatted ? ` of ${claudeUsage.spend.limitFormatted}` : ''}${claudeUsage.spend.canPurchaseCredits ? '' : ' · credit purchasing off'}` : ''}
          </div>
        {:else}
          <p class="usage-note">{claudeError || 'Loading…'}</p>
        {/if}
      </div>

      <div class="limits-panel">
        <div class="limits-heading">Codex usage</div>
        {#if codexUsage}
          <div class="usage-track usage-track-primary usage-track-fallback">
            <div class="usage-fill" style:width={`${Math.max(2, codexUsage.usedPercent)}%`}></div>
          </div>
          <div class="usage-primary">
            {windowLabel(codexUsage.windowMinutes)} {codexUsage.usedPercent}% used
            {#if codexUsage.resetsAt}<span class="usage-muted usage-ml">· resets {formatReset(codexUsage.resetsAt)}</span>{/if}
          </div>
          {#if codexUsage.secondary}
            <div class="usage-track usage-track-secondary usage-track-codex-secondary">
              <div class="usage-fill" style:width={`${Math.max(2, codexUsage.secondary.usedPercent)}%`}></div>
            </div>
            <div class="usage-secondary">
              {windowLabel(codexUsage.secondary.windowMinutes)} {codexUsage.secondary.usedPercent}% used
              {#if codexUsage.secondary.resetsAt}<span class="usage-muted usage-ml">· resets {formatReset(codexUsage.secondary.resetsAt)}</span>{/if}
            </div>
          {/if}
          {#if codexUsage.limitReached}
            <div class="limit-reached">limit reached: {codexUsage.limitReached}</div>
          {/if}
          <div class="usage-detail">
            {codexUsage.planType !== 'unknown' ? `${codexUsage.planType} plan` : 'plan unknown'}{codexUsage.credits ? codexUsage.credits.unlimited ? ' · credits unlimited' : codexUsage.credits.has && codexUsage.credits.balance ? ` · credits balance ${codexUsage.credits.balance}` : ' · no overage credits' : ''}{codexUsage.capturedAt ? ` · as of ${formatReset(codexUsage.capturedAt)}` : ''}
          </div>
        {:else}
          <p class="usage-note">{codexError || 'Loading…'}</p>
        {/if}
      </div>

      <div class="limits-panel provider-panel">
        <div class="limits-heading">Provider spend</div>
        <table>
          <thead><tr><th>Provider</th><th>Requests</th><th>In</th><th>Out</th><th>Spend</th></tr></thead>
          <tbody>
            {#each providers as provider}
              <tr>
                <td>{provider.provider}</td>
                <td>{provider.requestCount}</td>
                <td>{fmtNum(provider.inputTokens)}</td>
                <td>{fmtNum(provider.outputTokens)}</td>
                <td>{provider.spend?.usedFormatted || fmtUsd(provider.costUsd)}</td>
              </tr>
            {/each}
            {#if providers.length === 0}<tr><td colspan="5" class="empty">No data</td></tr>{/if}
          </tbody>
        </table>
      </div>
    </section>
  {/if}

  {#if activeTab === 'dashboard'}
    <section class="dashboard">
      <div class="cards">
        <div class="card">
          <div class="card-label">Total requests {@render helpIcon('request')}</div>
          <div class="card-value">{total?.request_count ?? 0}</div>
        </div>
        <div class="card">
          <div class="card-label">Input tokens {@render helpIcon('input_tokens')}</div>
          <div class="card-value">{fmtNum(total?.input_tokens ?? 0)}</div>
        </div>
        <div class="card">
          <div class="card-label">Output tokens {@render helpIcon('output_tokens')}</div>
          <div class="card-value">{fmtNum(total?.output_tokens ?? 0)}</div>
        </div>
        <div class="card">
          <div class="card-label">Cache reads {@render helpIcon('cache_read')}</div>
          <div class="card-value">{fmtNum(total?.cache_read_tokens ?? 0)}</div>
        </div>
        <div class="card">
          <div class="card-label">Cache writes {@render helpIcon('cache_write')}</div>
          <div class="card-value">{fmtNum(total?.cache_creation_tokens ?? 0)}</div>
        </div>
        <div class="card">
          <div class="card-label">Cache hit rate {@render helpIcon('cache_hit')}</div>
          <div class="card-value">{cacheHitRate(total)}%</div>
        </div>
        <div class="card highlight">
          <div class="card-label">Total tokens {@render helpIcon('total_tokens')}</div>
          <div class="card-value">{fmtNum((total?.input_tokens ?? 0) + (total?.output_tokens ?? 0) + (total?.cache_read_tokens ?? 0) + (total?.cache_creation_tokens ?? 0))}</div>
        </div>
        <div class="card highlight">
          <div class="card-label">Total cost {@render helpIcon('cost')}</div>
          <div class="card-value">{fmtUsd(total?.cost_usd)}</div>
        </div>
      </div>

      <div class="panels">
        <div class="panel">
          <h3>By model {@render helpIcon('by_model')}</h3>
          <table>
            <thead><tr><th>Model</th><th>Requests</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
            <tbody>
              {#each byModel as b}
                <tr>
                  <td>{b.bucket || '—'}</td>
                  <td>{b.request_count}</td>
                  <td>{fmtNum(b.input_tokens)}</td>
                  <td>{fmtNum(b.output_tokens)}</td>
                  <td>{fmtUsd(b.cost_usd)}</td>
                </tr>
              {/each}
              {#if byModel.length === 0}<tr><td colspan="5" class="empty">No data</td></tr>{/if}
            </tbody>
          </table>
        </div>

        <div class="panel">
          <h3>By platform {@render helpIcon('by_platform')}</h3>
          <table>
            <thead><tr><th>Platform</th><th>Requests</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
            <tbody>
              {#each byPlatform as b}
                <tr>
                  <td>{b.bucket || '—'}</td>
                  <td>{b.request_count}</td>
                  <td>{fmtNum(b.input_tokens)}</td>
                  <td>{fmtNum(b.output_tokens)}</td>
                  <td>{fmtUsd(b.cost_usd)}</td>
                </tr>
              {/each}
              {#if byPlatform.length === 0}<tr><td colspan="5" class="empty">No data</td></tr>{/if}
            </tbody>
          </table>
        </div>

        <div class="panel">
          <h3>By mode {@render helpIcon('by_mode')}</h3>
          <table>
            <thead><tr><th>Mode</th><th>Requests</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
            <tbody>
              {#each byMode as b}
                <tr>
                  <td>{b.bucket || '—'}</td>
                  <td>{b.request_count}</td>
                  <td>{fmtNum(b.input_tokens)}</td>
                  <td>{fmtNum(b.output_tokens)}</td>
                  <td>{fmtUsd(b.cost_usd)}</td>
                </tr>
              {/each}
              {#if byMode.length === 0}<tr><td colspan="5" class="empty">No data</td></tr>{/if}
            </tbody>
          </table>
        </div>

        <div class="panel">
          <h3>By day {@render helpIcon('by_day')}</h3>
          <table>
            <thead><tr><th>Day</th><th>Requests</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
            <tbody>
              {#each byDay as b}
                <tr>
                  <td>{b.bucket || '—'}</td>
                  <td>{b.request_count}</td>
                  <td>{fmtNum(b.input_tokens)}</td>
                  <td>{fmtNum(b.output_tokens)}</td>
                  <td>{fmtUsd(b.cost_usd)}</td>
                </tr>
              {/each}
              {#if byDay.length === 0}<tr><td colspan="5" class="empty">No data</td></tr>{/if}
            </tbody>
          </table>
        </div>

        <div class="panel wide">
          <h3>Tools used {@render helpIcon('tools_used')}</h3>
          <table>
            <thead><tr><th>Tool</th><th>Total calls</th><th>Requests using it</th></tr></thead>
            <tbody>
              {#each tools as t}
                <tr>
                  <td>{t.name}</td>
                  <td>{t.count}</td>
                  <td>{t.request_count}</td>
                </tr>
              {/each}
              {#if tools.length === 0}<tr><td colspan="3" class="empty">No data</td></tr>{/if}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  {/if}

  {#if activeTab === 'log'}
    <section class="log">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Thread</th>
            <th>Mode</th>
            <th>Platform</th>
            <th>Model</th>
            <th title="Input tokens — what we sent to Claude">In</th>
            <th title="Output tokens — what Claude wrote back">Out</th>
            <th title="How full the context window was during this turn — main model's biggest single-call prompt as % of window cap">Context %</th>
            <th title="Cache read tokens">Cache read</th>
            <th title="Cache creation tokens">Cache write</th>
            <th>Tools</th>
            <th>Duration</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {#each events as ev}
            <tr>
              <td>{fmtTime(ev.created_at)}</td>
              <td class="thread-cell" title={ev.thread_id ?? ''}>{ev.thread_name ?? '—'}</td>
              <td>{ev.mode}</td>
              <td>{ev.platform || '—'}</td>
              <td>{ev.model}</td>
              <td>{fmtNum(ev.input_tokens)}</td>
              <td>{fmtNum(ev.output_tokens)}</td>
              <td>{ev.context_window && ev.context_tokens != null ? Math.round((ev.context_tokens / ev.context_window) * 100) + '%' : '—'}</td>
              <td>{fmtNum(ev.cache_read_tokens)}</td>
              <td>{fmtNum(ev.cache_creation_tokens)}</td>
              <td>
                {#each parseTools(ev.tool_calls) as tc}
                  <span class="tool-chip" title={tc.name}>{tc.name.split('__').pop()} ×{tc.count}</span>
                {/each}
              </td>
              <td>{ev.duration_ms ? (ev.duration_ms / 1000).toFixed(1) + 's' : '—'}</td>
              <td>{fmtUsd(ev.cost_usd)}</td>
            </tr>
          {/each}
          {#if events.length === 0}<tr><td colspan="13" class="empty">No requests yet in this range</td></tr>{/if}
        </tbody>
      </table>
    </section>
  {/if}

  {#if activeTab === 'glossary'}
    <section class="glossary dashboard">
      <div class="panels">
        {#each GLOSSARY as g}
          <div class="panel glossary-card">
            <h3>{g.term}</h3>
            <p class="glossary-def">{g.definition}</p>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .usage-page { height: 100dvh; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; -webkit-overflow-scrolling: touch; background: var(--bg-primary); color: var(--text-primary); }
  /* Pin the title + tab row to the top of the scroll area so the tabs stop
     sliding under the viewport edge and getting clipped/hard to tap. */
  .usage-topbar { position: sticky; top: 0; z-index: 20; background: var(--bg-primary); }
  .usage-header { display: flex; align-items: center; gap: 16px; padding: 16px 24px; border-bottom: 1px solid var(--border); }
  .back-link { display: flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; opacity: 0.75; }
  .back-link:hover { opacity: 1; }
  .header-title { margin: 0; font-size: 20px; font-weight: 600; flex: 1; }
  .range-controls { display: flex; gap: 4px; }
  .range-btn { padding: 6px 12px; border: 1px solid var(--border); background: transparent; color: inherit; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .range-btn.active { background: var(--accent); color: var(--bg-primary); border-color: var(--accent); }
  .tabs { display: flex; gap: 4px; padding: 12px 24px; border-bottom: 1px solid var(--border); overflow-x: auto; }
  .tab { display: inline-flex; align-items: center; min-height: 40px; padding: 8px 16px; background: transparent; border: none; color: inherit; cursor: pointer; border-radius: 6px; font-size: 14px; opacity: 0.6; white-space: nowrap; }
  .tab:hover { opacity: 0.9; }
  .tab.active { background: var(--accent); color: var(--bg-primary); opacity: 1; }
  .loading { padding: 24px; text-align: center; opacity: 0.6; }
  .error { padding: 24px; text-align: center; color: var(--color-error); }
  .limits-dashboard { padding: 24px; flex: 1 1 auto; }
  .limits-panel { padding: 12px; margin-bottom: 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 16px; }
  .limits-heading { margin-bottom: 8px; color: var(--text-secondary); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; }
  .usage-track { overflow: hidden; background: rgba(255,255,255,0.10); border-radius: 9999px; }
  .usage-track-primary { height: 6px; }
  .usage-track-secondary { height: 4px; }
  .usage-track-fallback { margin-bottom: 8px; }
  .usage-track-row { margin-bottom: 4px; }
  .usage-track-codex-secondary { margin-top: 8px; margin-bottom: 4px; }
  .usage-fill { height: 100%; background: var(--accent); border-radius: 9999px; transition: all .2s; }
  .usage-primary { color: var(--text-primary); font-size: 14px; }
  .usage-secondary { color: var(--text-primary); font-size: 11px; }
  .usage-muted, .usage-detail { color: var(--text-secondary); }
  .usage-detail { margin-top: 2px; font-size: 10px; }
  .usage-ml { margin-left: 4px; }
  .usage-note { margin: 0; color: var(--text-secondary); font-size: 10px; font-style: italic; }
  .limit-rows { display: flex; flex-direction: column; gap: 8px; }
  .severity { font-weight: 600; }
  .extra-usage { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--text-secondary); font-size: 10px; }
  .extra-usage.extra-on { color: var(--accent); font-weight: 600; }
  .extra-dot { display: inline-block; width: 6px; height: 6px; flex-shrink: 0; background: var(--accent); border-radius: 9999px; }
  .extra-dot.extra-dot-on { background: var(--accent); }
  .limit-reached { margin-top: 4px; color: var(--accent); font-size: 10px; font-weight: 600; }
  .provider-panel { overflow-x: auto; }
  .dashboard { padding: 24px; flex: 1 1 auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { padding: 14px 16px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; }
  .card.highlight { border-color: var(--accent); }
  .card-label { font-size: 12px; opacity: 0.7; display: flex; align-items: center; gap: 4px; margin-bottom: 6px; }
  .card-value { font-size: 22px; font-weight: 600; }
  .info-wrap { position: relative; display: inline-block; }
  .info {
    opacity: 0.5;
    cursor: pointer;
    font-size: 11px;
    background: transparent;
    border: none;
    color: inherit;
    padding: 0 2px;
    line-height: 1;
    transition: opacity 0.15s;
  }
  .info:hover, .info[aria-expanded="true"] { opacity: 1; }
  .info:focus-visible { outline: 1px solid var(--accent); border-radius: 3px; }
  .popover {
    position: absolute;
    top: calc(100% + 6px);
    left: -8px;
    z-index: 100;
    width: 280px;
    padding: 12px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-lg);
    cursor: default;
    animation: popoverIn 0.12s ease-out;
  }
  .popover-term {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .popover-def {
    font-size: 12.5px;
    line-height: 1.5;
    opacity: 0.85;
  }
  @keyframes popoverIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (max-width: 480px) {
    .popover { width: min(280px, calc(100vw - 32px)); left: auto; right: -8px; }
  }
  .panels { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; }
  .panel { padding: 16px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; }
  .panel.wide { grid-column: 1 / -1; }
  .panel h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); }
  th { font-weight: 500; opacity: 0.7; font-size: 12px; }
  td.empty { text-align: center; opacity: 0.5; padding: 20px; }
  .log { padding: 16px 24px; overflow-x: auto; flex: 1 1 auto; }
  .log table { min-width: 1000px; }
  .log th { white-space: nowrap; }
  .tool-chip { display: inline-block; padding: 1px 6px; margin: 1px 2px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 4px; font-size: 11px; opacity: 0.85; }
  .glossary { padding: 24px; flex: 1 1 auto; }
  .glossary-card h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
  .glossary-def { margin: 0; opacity: 0.8; font-size: 13px; line-height: 1.55; }

  @media (max-width: 768px) {
    .usage-header { flex-wrap: wrap; padding: calc(env(safe-area-inset-top, 0px) + 12px) 12px 12px; gap: 10px; }
    .header-title { font-size: 18px; width: 100%; order: 2; }
    .back-link { order: 1; }
    .range-controls { order: 3; width: 100%; overflow-x: auto; }
    .range-btn { padding: 6px 10px; font-size: 12px; flex: 1; }
    .tabs { padding: 8px 12px; gap: 4px; }
    .tab { padding: 8px 14px; font-size: 14px; }
    .dashboard { padding: 12px; }
    .limits-dashboard { padding: 12px; }
    .cards { grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .card { padding: 10px 12px; }
    .card-value { font-size: 18px; }
    .card-label { font-size: 11px; }
    .panels { grid-template-columns: 1fr; gap: 12px; }
    .panel { padding: 12px; overflow-x: hidden; }
    .panel table { min-width: 0; width: 100%; table-layout: auto; }
    .panel th, .panel td { padding: 6px 4px; font-size: 12px; }
    .panel.wide { grid-column: 1; }
    .log { padding: 12px; }
    .log table { font-size: 12px; }
    .log th, .log td { padding: 4px 6px; }
    .glossary { padding: 16px; }
  }
</style>
