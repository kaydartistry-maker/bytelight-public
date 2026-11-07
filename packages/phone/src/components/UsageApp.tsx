import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw, Loader2 } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import { SubscriptionUsageMeters } from './SubscriptionUsageMeters';
import { VoiceUsageMeter } from './VoiceUsageMeter';
import { parseProviderSpend, type ProviderSpendRow } from './provider-spend';

const POPOVER_WIDTH = 224;

interface UsageAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface UsageEvent {
  id: string;
  created_at: string;
  thread_id: string | null;
  thread_name: string | null;
  platform: string | null;
  mode: 'interactive' | 'autonomous';
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tool_calls: string | null;
  duration_ms: number | null;
  context_window: number | null;
  context_tokens: number | null;
}

interface UsageBucket {
  bucket: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  request_count: number;
}

interface UsageToolRow {
  name: string;
  count: number;
  request_count: number;
}

type Range = 'today' | 'week' | 'month' | 'all';
type Tab = 'dashboard' | 'log' | 'glossary';

const RANGES: Range[] = ['today', 'week', 'month', 'all'];
const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'log', label: 'Log' },
  { id: 'glossary', label: 'Glossary' },
];

// Each entry mirrors the desktop usage glossary plus an `id` so the dashboard
// section headings can render an info icon that pops the matching
// definition. Keep this list in sync with the desktop one so the two surfaces
// document the same concepts the same way.
const GLOSSARY: { id: string; term: string; definition: string }[] = [
  { id: 'request', term: 'Request', definition: 'One agent run — you sending a message, us waking up on a schedule, a trigger firing. Each of these produces exactly one usage event.' },
  { id: 'input_tokens', term: 'Input tokens', definition: 'Only the part of the prompt that was genuinely NEW this turn — not everything that was sent. Anything the model recognised from an earlier turn (the conversation so far, CLAUDE.md, skill files) is counted under Cache reads instead. That is why Input looks tiny next to Output on a warm lane and nothing is backwards: what was actually sent is Input + Cache reads + Cache writes, and it dwarfs both.' },
  { id: 'output_tokens', term: 'Output tokens', definition: 'What the model generated back: the reply text, thinking blocks, tool call arguments.' },
  { id: 'cache_read', term: 'Cache reads', definition: 'Tokens Anthropic recognized from an earlier cached turn and served at ~10% of normal input cost. On a warm lane this is where the conversation itself lives: it is re-sent and re-recognised every single turn, so it is by far the largest number on this screen — and that is the system working, not a fault.' },
  { id: 'cache_write', term: 'Cache writes', definition: 'New tokens the system chose to cache so future turns can read them cheaply. Writes cost 1.25× input — it\'s a small upfront fee to unlock cheap reads for ~5 minutes.' },
  { id: 'cache_hit', term: 'Cache hit rate', definition: 'Percentage of input tokens that came from cache instead of fresh. Higher is better. Low hit rate can mean: new thread, many tool uses re-shaping context, or context window was compacted.' },
  { id: 'mode_interactive', term: 'Mode: interactive', definition: 'You sent a message (web, Discord, Telegram, or API) and we responded.' },
  { id: 'mode_autonomous', term: 'Mode: autonomous', definition: 'We ran on our own — an orchestrator wake (morning, creative hour, water reminder), a trigger fire, or a timer. No direct user prompt.' },
  { id: 'context_pct', term: 'Context %', definition: 'How full the context window was when this turn ran — measured at the main model\'s largest single-call prompt (input + cache reads + cache writes), divided by the variant\'s window cap (1M for 1M variants, 200K otherwise). Subagent calls do not count. Auto-compaction fires around 80–85%.' },
  { id: 'tools', term: 'Tools', definition: 'Every tool we invoked during the request — MCP calls (Notion, Mind, Discord), Bash commands, file reads, etc. Token cost is per-request, not per-tool, so we show counts rather than individual tool prices.' },
  { id: 'duration', term: 'Duration', definition: 'Wall-clock time from when the request started to when it finished. Includes thinking time and any tool round-trips.' },
  { id: 'total_tokens', term: 'Total tokens', definition: 'Sum of input + output + cache-read + cache-write tokens. Bytelight runs on a Claude subscription (flat monthly, rate-limited) — not pay-per-token API billing — so this is the metric that matters for what\'s left in your envelope. The dashboard intentionally does not show dollar costs because they would be a phantom bill you\'re not paying.' },
  { id: 'by_model', term: 'By model', definition: 'Which models were used. Opus costs 5× Sonnet; Haiku is cheapest.' },
  { id: 'by_platform', term: 'By platform', definition: 'Where the request came from — web UI, Discord, Telegram, or autonomous wake.' },
  { id: 'by_mode', term: 'By mode', definition: 'Interactive = you\'re talking to us. Autonomous = us working on our own (wakes, triggers, schedules).' },
  { id: 'by_day', term: 'By day', definition: 'Daily totals for the selected range.' },
  { id: 'tools_used', term: 'Tools used', definition: 'Which tools we called and how often. Not a per-tool cost — tokens aren\'t billed per tool.' },
];

function sinceFor(range: Range): string | undefined {
  const now = new Date();
  if (range === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  if (range === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d.toISOString();
  }
  if (range === 'month') {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return d.toISOString();
  }
  return undefined;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { hour12: false, dateStyle: 'short', timeStyle: 'short' });
}

function parseTools(json: string | null): { name: string; count: number }[] {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function cacheHitRate(b: UsageBucket | null): number {
  if (!b) return 0;
  const total = b.input_tokens + b.cache_read_tokens + b.cache_creation_tokens;
  if (total === 0) return 0;
  return Math.round((b.cache_read_tokens / total) * 100);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`Request failed: ${url}`);
  return res.json() as Promise<T>;
}

export function UsageApp({ onClose, themeConfig, themeMode, embedded }: UsageAppProps) {
  const colors = themeConfig[themeMode];
  const [range, setRange] = useState<Range>('today');
  const [tab, setTab] = useState<Tab>('dashboard');
  // Where the open definition sits, in VIEWPORT coordinates. It used to be an
  // `absolute left-0` panel hanging off the (i) itself, so any card in the
  // right-hand column opened 224px of popover past the edge of the screen —
  // which widened the page and left the whole app scrolling sideways.
  const [openInfo, setOpenInfo] = useState<
    { id: string; left: number; top: number; width: number } | null
  >(null);
  const [loading, setLoading] = useState(false);

  const [events, setEvents] = useState<UsageEvent[]>([]);
  // Cap the log view to 50 rows at a time; "Load more" extends in steps of 50
  // so the panel doesn't grow into an unscrollable wall on busy days.
  const LOG_PAGE = 50;
  const [logLimit, setLogLimit] = useState(LOG_PAGE);
  const [total, setTotal] = useState<UsageBucket | null>(null);
  const [byModel, setByModel] = useState<UsageBucket[]>([]);
  const [byPlatform, setByPlatform] = useState<UsageBucket[]>([]);
  const [byMode, setByMode] = useState<UsageBucket[]>([]);
  const [byDay, setByDay] = useState<UsageBucket[]>([]);
  const [tools, setTools] = useState<UsageToolRow[]>([]);
  const [providerSpend, setProviderSpend] = useState<ProviderSpendRow[]>([]);
  const [providerSpendError, setProviderSpendError] = useState<string | null>(null);

  const loadProviderSpend = useCallback(async () => {
    setProviderSpendError(null);
    try {
      const res = await apiFetch('/api/usage/providers');
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`Provider spend failed (${res.status})`);
      setProviderSpend(parseProviderSpend(data));
    } catch (cause) {
      setProviderSpend([]);
      setProviderSpendError(cause instanceof Error ? cause.message : 'Provider spend unavailable');
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const since = sinceFor(range);
      const q = since ? `?since=${encodeURIComponent(since)}` : '';
      const sep = q ? '&' : '?';
      const [ev, totalRes, modelRes, platformRes, modeRes, dayRes, toolRes] = await Promise.all([
        getJson<{ events: UsageEvent[] }>(`/api/usage/events${q}${sep}limit=200`),
        getJson<{ buckets: UsageBucket[] }>(`/api/usage/aggregate${q}`),
        getJson<{ buckets: UsageBucket[] }>(`/api/usage/aggregate${q}${sep}groupBy=model`),
        getJson<{ buckets: UsageBucket[] }>(`/api/usage/aggregate${q}${sep}groupBy=platform`),
        getJson<{ buckets: UsageBucket[] }>(`/api/usage/aggregate${q}${sep}groupBy=mode`),
        getJson<{ buckets: UsageBucket[] }>(`/api/usage/aggregate${q}${sep}groupBy=day`),
        getJson<{ tools: UsageToolRow[] }>(`/api/usage/tools${q}`),
      ]);
      setEvents(ev.events || []);
      setTotal((totalRes.buckets && totalRes.buckets[0]) || null);
      setByModel(modelRes.buckets || []);
      setByPlatform(platformRes.buckets || []);
      setByMode(modeRes.buckets || []);
      setByDay(dayRes.buckets || []);
      setTools(toolRes.tools || []);
    } catch (err) {
      console.error('Failed to load usage:', err);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    void loadProviderSpend();
  }, [loadProviderSpend]);

  // A tap anywhere else, or any scroll, puts the definition away. The comment
  // above InfoIcon has always promised tap-elsewhere; nothing was listening for
  // it. Scroll matters now too: the panel is placed in viewport coordinates, so
  // scrolling would otherwise leave it floating over unrelated rows.
  useEffect(() => {
    if (!openInfo) return;
    const close = () => setOpenInfo(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [openInfo]);

  // Reset the log paging window each time the range changes so a wider date
  // range doesn't accidentally pre-expand to thousands of rows.
  useEffect(() => {
    setLogLimit(LOG_PAGE);
  }, [range]);

  const card = cn('rounded-2xl border p-3', colors.panelBg, colors.panelBorder);
  const panelTitle = cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted);
  const totalTokens =
    (total?.input_tokens ?? 0) +
    (total?.output_tokens ?? 0) +
    (total?.cache_read_tokens ?? 0) +
    (total?.cache_creation_tokens ?? 0);

  // Mirrors the desktop `(i)` popover next to each metric/section heading.
  // Tap to toggle, tap elsewhere or another icon to close. Defines the
  // glossary term inline so users don't have to bounce to the tab.
  function InfoIcon({ id }: { id: string }) {
    const term = GLOSSARY.find((g) => g.id === id);
    if (!term) return null;
    const isOpen = openInfo?.id === id;
    return (
      <span className="relative inline-block align-middle ml-1">
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (isOpen) {
              setOpenInfo(null);
              return;
            }
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
            setOpenInfo({
              id,
              width,
              top: r.bottom + 6,
              // Clamped to the viewport at both ends, so the panel can never
              // reach past an edge however near one the (i) happens to be.
              left: Math.min(Math.max(8, r.left), window.innerWidth - width - 8),
            });
          }}
          aria-label={`What is ${term.term}?`}
          aria-expanded={isOpen}
          className={cn('text-[11px] leading-none opacity-60 hover:opacity-100', colors.textMuted)}
        >
          &#x24D8;
        </button>
        {isOpen && openInfo && (
          <div
            role="dialog"
            aria-label={term.term}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{ top: openInfo.top, left: openInfo.left, width: openInfo.width }}
            className={cn(
              'fixed z-30 p-2 rounded-lg border text-[11px] leading-relaxed shadow-lg',
              colors.panelBg,
              colors.panelBorder,
              colors.textMain,
            )}
          >
            <div className={cn('font-semibold mb-1', colors.accentText)}>{term.term}</div>
            <div className={colors.textMuted}>{term.definition}</div>
          </div>
        )}
      </span>
    );
  }

  function statCard(label: string, value: string, glossaryId?: string, highlight?: boolean) {
    return (
      <div className={cn(card, highlight && 'border-2')} style={highlight ? { borderColor: colors.accent } : undefined}>
        <div className={cn('text-[10px] uppercase tracking-wide mb-1 flex items-center', colors.textMuted)}>
          <span>{label}</span>
          {glossaryId && <InfoIcon id={glossaryId} />}
        </div>
        <div className={cn('text-lg font-semibold', colors.textMain)}>{value}</div>
      </div>
    );
  }

  function bucketTable(title: string, label: string, rows: UsageBucket[], glossaryId?: string) {
    return (
      <div className={cn(card, 'mt-3')}>
        <div className={cn(panelTitle, 'flex items-center')}>
          <span>{title}</span>
          {glossaryId && <InfoIcon id={glossaryId} />}
        </div>
        {rows.length === 0 ? (
          <div className={cn('text-xs py-2 text-center', colors.textMuted)}>No data</div>
        ) : (
          <div className="space-y-1">
            <div className={cn('flex text-[10px] uppercase tracking-wide', colors.textMuted)}>
              <span className="flex-1">{label}</span>
              <span className="w-12 text-right">Req</span>
              <span className="w-14 text-right">In</span>
              <span className="w-14 text-right">Out</span>
            </div>
            {rows.map((b, i) => (
              <div key={i} className={cn('flex text-xs', colors.textMain)}>
                <span className="flex-1 truncate pr-1">{b.bucket || '—'}</span>
                <span className="w-12 text-right">{b.request_count}</span>
                <span className="w-14 text-right">{fmtNum(b.input_tokens)}</span>
                <span className="w-14 text-right">{fmtNum(b.output_tokens)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <AppShell
      embedded={embedded}
      title="Usage"
      icon={BarChart3}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => { void load(); void loadProviderSpend(); }}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      {/* Range selector */}
      <div className={cn('rounded-2xl border p-3 backdrop-blur-md mb-3', colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn('flex-1 rounded-lg py-1.5 text-xs font-medium capitalize transition-colors border', colors.panelBorder)}
              style={range === r ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className={cn('rounded-2xl border p-3 backdrop-blur-md mb-4', colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors border',
                colors.panelBorder,
                tab !== t.id && colors.textMuted,
              )}
              style={tab === t.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'dashboard' && (
        <>
          {/*
            The number she actually opens this app for. Everything below counts
            per-request TOKENS, which the interactive subscription lane does not
            report — so on this house they are all honest zeros and always will
            be. What IS readable is how much of the subscription itself is
            spent, and that has been live at /api/usage/claude and
            /api/usage/codex since July. A screen called Status should lead
            with the meter that moves — so every live allowance renders here,
            ElevenLabs credits included, and Integrations carries none.
          */}
          <SubscriptionUsageMeters themeConfig={themeConfig} themeMode={themeMode} />
          <VoiceUsageMeter themeConfig={themeConfig} themeMode={themeMode} />
          <div className={cn(card, 'mt-3 overflow-x-auto')}>
            <div className={panelTitle}>Provider spend</div>
            {providerSpendError ? (
              <div className={cn('text-xs py-2', colors.textMuted)}>{providerSpendError}</div>
            ) : (
              <div className="min-w-[360px]">
                <div className={cn('grid grid-cols-[1fr_56px_56px_56px_72px] text-[10px] uppercase tracking-wide', colors.textMuted)}>
                  <span>Provider</span><span className="text-right">Req</span><span className="text-right">In</span><span className="text-right">Out</span><span className="text-right">Spend</span>
                </div>
                {providerSpend.map((row) => (
                  <div key={row.provider} className={cn('grid grid-cols-[1fr_56px_56px_56px_72px] text-xs py-1', colors.textMain)}>
                    <span>{row.provider}</span><span className="text-right">{row.requestCount}</span><span className="text-right">{fmtNum(row.inputTokens)}</span><span className="text-right">{fmtNum(row.outputTokens)}</span><span className="text-right">{row.spend?.usedFormatted || `$${row.costUsd.toFixed(2)}`}</span>
                  </div>
                ))}
                {providerSpend.length === 0 && <div className={cn('text-xs py-2 text-center', colors.textMuted)}>No data</div>}
              </div>
            )}
          </div>
          <div className={cn(panelTitle, 'mt-4')}>Per-request detail</div>
          <div className="grid grid-cols-2 gap-2">
            {statCard('Requests', String(total?.request_count ?? 0), 'request')}
            {statCard('Total tokens', fmtNum(totalTokens), 'total_tokens', true)}
            {statCard('Input', fmtNum(total?.input_tokens ?? 0), 'input_tokens')}
            {statCard('Output', fmtNum(total?.output_tokens ?? 0), 'output_tokens')}
            {statCard('Cache reads', fmtNum(total?.cache_read_tokens ?? 0), 'cache_read')}
            {statCard('Cache writes', fmtNum(total?.cache_creation_tokens ?? 0), 'cache_write')}
            {statCard('Cache hit rate', `${cacheHitRate(total)}%`, 'cache_hit')}
          </div>
          {bucketTable('By model', 'Model', byModel, 'by_model')}
          {bucketTable('By platform', 'Platform', byPlatform, 'by_platform')}
          {bucketTable('By mode', 'Mode', byMode, 'by_mode')}
          {bucketTable('By day', 'Day', byDay, 'by_day')}
          <div className={cn(card, 'mt-3')}>
            <div className={cn(panelTitle, 'flex items-center')}>
              <span>Tools used</span>
              <InfoIcon id="tools_used" />
            </div>
            {tools.length === 0 ? (
              <div className={cn('text-xs py-2 text-center', colors.textMuted)}>No data</div>
            ) : (
              <div className="space-y-1">
                <div className={cn('flex text-[10px] uppercase tracking-wide', colors.textMuted)}>
                  <span className="flex-1">Tool</span>
                  <span className="w-14 text-right">Calls</span>
                  <span className="w-14 text-right">Reqs</span>
                </div>
                {tools.map((t, i) => (
                  <div key={i} className={cn('flex text-xs', colors.textMain)}>
                    <span className="flex-1 truncate pr-1">{t.name}</span>
                    <span className="w-14 text-right">{t.count}</span>
                    <span className="w-14 text-right">{t.request_count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'log' && (
        <div className="space-y-2">
          {events.length === 0 ? (
            <div className={cn('text-xs py-6 text-center', colors.textMuted)}>No requests in this range</div>
          ) : (
            events.slice(0, logLimit).map((ev) => {
              const ctx =
                ev.context_window && ev.context_tokens != null
                  ? Math.round((ev.context_tokens / ev.context_window) * 100) + '%'
                  : '—';
              const evTools = parseTools(ev.tool_calls);
              return (
                <div key={ev.id} className={card}>
                  <div className="flex items-center justify-between">
                    <span className={cn('text-xs font-medium', colors.textMain)}>{fmtTime(ev.created_at)}</span>
                    <span className={cn('text-[11px]', colors.textMuted)}>
                      {ev.duration_ms ? (ev.duration_ms / 1000).toFixed(1) + 's' : '—'}
                    </span>
                  </div>
                  <div className={cn('text-[11px] mt-0.5', colors.textMuted)}>
                    {(ev.thread_name || '—') + ' · ' + ev.mode + (ev.platform ? ' · ' + ev.platform : '') + ' · ' + ev.model}
                  </div>
                  <div className={cn('text-[11px] mt-1', colors.textMain)}>
                    In {fmtNum(ev.input_tokens)} · Out {fmtNum(ev.output_tokens)} · Ctx {ctx} · Cache r{fmtNum(ev.cache_read_tokens)}/w{fmtNum(ev.cache_creation_tokens)}
                  </div>
                  {evTools.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {evTools.map((tc, i) => (
                        <span
                          key={i}
                          className={cn('rounded px-1.5 py-0.5 text-[10px] border', colors.panelBorder, colors.textMuted)}
                        >
                          {tc.name.split('__').pop()} ×{tc.count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
          {events.length > logLimit && (
            <button
              onClick={() => setLogLimit((n) => n + LOG_PAGE)}
              className={cn(
                'mt-2 w-full rounded-lg border px-3 py-2 text-xs font-semibold',
                colors.panelBg,
                colors.panelBorder,
                colors.textMain,
              )}
            >
              Load {Math.min(LOG_PAGE, events.length - logLimit)} more ({logLimit} of {events.length})
            </button>
          )}
        </div>
      )}

      {tab === 'glossary' && (
        <div className="space-y-2">
          {GLOSSARY.map((g) => (
            <div key={g.term} className={card}>
              <div className={cn('text-sm font-semibold mb-1', colors.textMain)}>{g.term}</div>
              <p className={cn('text-xs leading-relaxed', colors.textMuted)}>{g.definition}</p>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
