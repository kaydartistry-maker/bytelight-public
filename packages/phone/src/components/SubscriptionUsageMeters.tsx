import React, { useEffect, useState } from 'react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

interface ClaudeLimitRow {
  kind: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
}

interface ClaudeExtraUsage {
  enabled: boolean;
  utilization: number | null;
  monthlyLimit: number | null;
  usedCredits: number | null;
  disabledReason: string | null;
}

interface ClaudeSpend {
  usedFormatted: string | null;
  limitFormatted: string | null;
  percent: number | null;
  enabled: boolean;
  canPurchaseCredits: boolean;
}

interface ClaudeUsage {
  fiveHourPercent: number;
  fiveHourResetsAt: string | null;
  weeklyPercent: number;
  weeklyResetsAt: string | null;
  modelWeeklyPercent: number | null;
  modelWeeklyLabel: string | null;
  modelWeeklyResetsAt: string | null;
  extraUsageEnabled: boolean;
  subscriptionType: string;
  limits: ClaudeLimitRow[];
  extraUsage: ClaudeExtraUsage | null;
  spend: ClaudeSpend | null;
}

interface CodexWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}

interface CodexUsage {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
  planType: string;
  capturedAt: string | null;
  secondary: CodexWindow | null;
  credits: { balance: string | null; unlimited: boolean; has: boolean } | null;
  limitReached: string | null;
}

interface SubscriptionUsageMetersProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
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
  if (severity === 'critical' || severity === 'exceeded' || severity === 'blocked') return '#ef4444';
  if (severity !== 'normal') return '#f59e0b';
  return accent;
}

function parseCodexWindow(value: unknown): CodexWindow | null {
  if (!value || typeof value !== 'object') return null;
  const w = value as Record<string, unknown>;
  if (typeof w.usedPercent !== 'number') return null;
  return {
    usedPercent: w.usedPercent,
    windowMinutes: typeof w.windowMinutes === 'number' ? w.windowMinutes : null,
    resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
  };
}

const WAITING_NOTE = 'Waiting on the new backend — restart to light this up.';

// Both subscription meters — Claude (the CLI's own OAuth usage endpoint)
// and Codex (rate-limit stamps from the daemon's session transcripts).
// Same SPA-fallback discipline as the ElevenLabs card: an old backend
// answers these routes with 200 + HTML, so shape is checked before trust.
// The detail fields (limits list, extra-usage breakdown, spend, Codex
// credits) are optional — a backend from before they existed still renders
// the core bars.
export function SubscriptionUsageMeters({ themeConfig, themeMode }: SubscriptionUsageMetersProps) {
  const colors = themeConfig[themeMode];
  const barTrack = themeMode === 'dark' ? 'bg-white/10' : 'bg-black/10';
  const [claude, setClaude] = useState<ClaudeUsage | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [codex, setCodex] = useState<CodexUsage | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/usage/claude');
        const data = await res.json().catch(() => null) as (Partial<ClaudeUsage> & { error?: unknown }) | null;
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(typeof data?.error === 'string' && data.error ? data.error : `load failed (${res.status})`);
        }
        if (typeof data?.fiveHourPercent !== 'number' || typeof data?.weeklyPercent !== 'number') {
          setClaudeError(WAITING_NOTE);
          return;
        }
        const limits: ClaudeLimitRow[] = Array.isArray(data.limits)
          ? data.limits
              .filter((l): l is ClaudeLimitRow =>
                !!l && typeof l === 'object'
                && typeof (l as ClaudeLimitRow).label === 'string'
                && typeof (l as ClaudeLimitRow).percent === 'number')
              .map((l) => ({
                kind: typeof l.kind === 'string' ? l.kind : '',
                label: l.label,
                percent: l.percent,
                severity: typeof l.severity === 'string' ? l.severity : 'normal',
                resetsAt: typeof l.resetsAt === 'string' ? l.resetsAt : null,
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
        const spend: ClaudeSpend | null = spendRaw && typeof spendRaw === 'object'
          ? {
              usedFormatted: typeof spendRaw.usedFormatted === 'string' ? spendRaw.usedFormatted : null,
              limitFormatted: typeof spendRaw.limitFormatted === 'string' ? spendRaw.limitFormatted : null,
              percent: typeof spendRaw.percent === 'number' ? spendRaw.percent : null,
              enabled: spendRaw.enabled === true,
              canPurchaseCredits: spendRaw.canPurchaseCredits === true,
            }
          : null;
        setClaude({
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
        });
        setClaudeError(null);
      } catch (err) {
        if (!cancelled) setClaudeError(err instanceof Error ? err.message : 'Claude usage unavailable.');
      }
    })();
    (async () => {
      try {
        const res = await apiFetch('/api/usage/codex');
        const data = await res.json().catch(() => null) as (Partial<CodexUsage> & { hasCredits?: unknown; creditsBalance?: unknown; creditsUnlimited?: unknown; error?: unknown }) | null;
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(typeof data?.error === 'string' && data.error ? data.error : `load failed (${res.status})`);
        }
        if (typeof data?.usedPercent !== 'number') {
          setCodexError(WAITING_NOTE);
          return;
        }
        setCodex({
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
        });
        setCodexError(null);
      } catch (err) {
        if (!cancelled) setCodexError(err instanceof Error ? err.message : 'Codex usage unavailable.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const extraOn = claude ? (claude.extraUsage ? claude.extraUsage.enabled : claude.extraUsageEnabled) : false;

  return (
    <>
      <div className={cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder)}>
        <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted)}>
          Claude usage
        </div>
        {claude ? (
          <>
            {claude.limits.length > 0 ? (
              <div className="space-y-2">
                {claude.limits.map((limit, i) => (
                  <div key={`${limit.kind}-${limit.label}`}>
                    <div className={cn('rounded-full overflow-hidden mb-1', barTrack, i === 0 ? 'h-1.5' : 'h-1')}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.max(2, limit.percent)}%`,
                          backgroundColor: severityColor(limit.severity, colors.accent),
                        }}
                      />
                    </div>
                    <div className={cn(i === 0 ? 'text-sm' : 'text-[11px]', colors.textMain)}>
                      {limit.label} {limit.percent}% used
                      {limit.resetsAt ? (
                        <span className={cn('ml-1', colors.textMuted)}>· resets {formatReset(limit.resetsAt)}</span>
                      ) : null}
                      {limit.severity !== 'normal' ? (
                        <span className="ml-1 font-semibold" style={{ color: severityColor(limit.severity, colors.accent) }}>
                          · {limit.severity}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className={cn('h-1.5 rounded-full overflow-hidden mb-2', barTrack)}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${Math.max(2, claude.fiveHourPercent)}%`, backgroundColor: colors.accent }}
                  />
                </div>
                <div className={cn('text-sm', colors.textMain)}>
                  5-hour window {claude.fiveHourPercent}% used
                  {claude.fiveHourResetsAt ? (
                    <span className={cn('ml-1', colors.textMuted)}>· resets {formatReset(claude.fiveHourResetsAt)}</span>
                  ) : null}
                </div>
                <div className={cn('text-[10px] mt-0.5', colors.textMuted)}>
                  weekly {claude.weeklyPercent}%
                  {claude.modelWeeklyPercent !== null
                    ? ` · ${claude.modelWeeklyLabel || 'model'} ${claude.modelWeeklyPercent}%`
                    : ''}
                  {claude.weeklyResetsAt ? ` · resets ${formatReset(claude.weeklyResetsAt)}` : ''}
                </div>
              </>
            )}
            <div
              className={cn('flex items-center gap-1.5 text-[10px] mt-2', extraOn ? 'font-semibold' : colors.textMuted)}
              style={extraOn ? { color: '#ef4444' } : undefined}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: extraOn ? '#ef4444' : colors.accent }}
              />
              <span>
                {extraOn ? 'extra usage ON — overage bills to credits' : 'extra usage off — stops at limits, never bills'}
                {claude.extraUsage?.enabled && claude.extraUsage.utilization !== null
                  ? ` · ${claude.extraUsage.utilization}% of monthly cap`
                  : ''}
                {claude.extraUsage?.enabled && claude.extraUsage.usedCredits !== null
                  ? ` · ${claude.extraUsage.usedCredits} credits used`
                  : ''}
                {!extraOn && claude.extraUsage?.disabledReason ? ` (${claude.extraUsage.disabledReason})` : ''}
              </span>
            </div>
            <div className={cn('text-[10px] mt-0.5', colors.textMuted)}>
              {claude.subscriptionType !== 'unknown' ? `${claude.subscriptionType} plan` : 'plan unknown'}
              {claude.spend
                ? ` · usage credits ${claude.spend.usedFormatted ?? '$0.00'} spent${claude.spend.limitFormatted ? ` of ${claude.spend.limitFormatted}` : ''}${claude.spend.canPurchaseCredits ? '' : ' · credit purchasing off'}`
                : ''}
            </div>
          </>
        ) : (
          <p className={cn('text-[10px] italic', colors.textMuted)}>{claudeError || 'Loading…'}</p>
        )}
      </div>

      <div className={cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder)}>
        <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted)}>
          Codex usage
        </div>
        {codex ? (
          <>
            <div className={cn('h-1.5 rounded-full overflow-hidden mb-2', barTrack)}>
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${Math.max(2, codex.usedPercent)}%`, backgroundColor: colors.accent }}
              />
            </div>
            <div className={cn('text-sm', colors.textMain)}>
              {windowLabel(codex.windowMinutes)} {codex.usedPercent}% used
              {codex.resetsAt ? (
                <span className={cn('ml-1', colors.textMuted)}>· resets {formatReset(codex.resetsAt)}</span>
              ) : null}
            </div>
            {codex.secondary ? (
              <>
                <div className={cn('h-1 rounded-full overflow-hidden mt-2 mb-1', barTrack)}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${Math.max(2, codex.secondary.usedPercent)}%`, backgroundColor: colors.accent }}
                  />
                </div>
                <div className={cn('text-[11px]', colors.textMain)}>
                  {windowLabel(codex.secondary.windowMinutes)} {codex.secondary.usedPercent}% used
                  {codex.secondary.resetsAt ? (
                    <span className={cn('ml-1', colors.textMuted)}>· resets {formatReset(codex.secondary.resetsAt)}</span>
                  ) : null}
                </div>
              </>
            ) : null}
            {codex.limitReached ? (
              <div className="text-[10px] mt-1 font-semibold" style={{ color: '#f59e0b' }}>
                limit reached: {codex.limitReached}
              </div>
            ) : null}
            <div className={cn('text-[10px] mt-0.5', colors.textMuted)}>
              {codex.planType !== 'unknown' ? `${codex.planType} plan` : 'plan unknown'}
              {codex.credits
                ? codex.credits.unlimited
                  ? ' · credits unlimited'
                  : codex.credits.has && codex.credits.balance
                    ? ` · credits balance ${codex.credits.balance}`
                    : ' · no overage credits'
                : ''}
              {codex.capturedAt ? ` · as of ${formatReset(codex.capturedAt)}` : ''}
            </div>
          </>
        ) : (
          <p className={cn('text-[10px] italic', colors.textMuted)}>{codexError || 'Loading…'}</p>
        )}
      </div>
    </>
  );
}
