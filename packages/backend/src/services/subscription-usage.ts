/**
 * Claude + Codex subscription usage.
 *
 * PORT NOTE: copied as a whole from reference implementation c5c3006e. byte-light already
 * receives Codex rate-limit telemetry directly from its daemon, so the
 * transcript scan remains as a compatibility fallback while live signals
 * are persisted in SQLite through the migration-backed helpers below.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from './db.js';

const CLAUDE_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const USAGE_CACHE_MS = 60_000;
const CODEX_SCAN_FILES = 10;
const ANTIGRAVITY_ROOT = process.env.GEMINI_CLI_ROOT || '/var/lib/bytelight';
const ANTIGRAVITY_BIN = process.env.GEMINI_CLI_BIN || `${ANTIGRAVITY_ROOT}/tools/antigravity/bin/agy`;
const ANTIGRAVITY_HOME = process.env.GEMINI_CLI_HOME || `${ANTIGRAVITY_ROOT}/antigravity-home`;
const execFileAsync = promisify(execFile);

export interface ClaudeLimit {
  kind: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  isActive: boolean;
}

export interface ClaudeExtraUsage {
  enabled: boolean;
  utilization: number | null;
  monthlyLimit: number | null;
  usedCredits: number | null;
  disabledReason: string | null;
}

export interface ClaudeSpend {
  usedFormatted: string | null;
  limitFormatted: string | null;
  percent: number | null;
  enabled: boolean;
  canPurchaseCredits: boolean;
}

export interface ClaudeUsage {
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
  extraUsage: ClaudeExtraUsage;
  spend: ClaudeSpend | null;
}

export interface CodexWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface CodexUsage {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
  planType: string;
  capturedAt: string | null;
  secondary: CodexWindow | null;
  creditsBalance: string | null;
  creditsUnlimited: boolean;
  hasCredits: boolean;
  limitReached: string | null;
}

export interface GeminiUsageBucket {
  id: string;
  label: string;
  window: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
}

export interface GeminiUsageGroup {
  name: string;
  description: string;
  buckets: GeminiUsageBucket[];
}

export interface GeminiUsage {
  groups: GeminiUsageGroup[];
  capturedAt: string;
}

export interface PersistedUsageWindow {
  lane: string;
  windowKey: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
  capturedAt: string;
  metadata: Record<string, unknown> | null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseGeminiUsage(raw: unknown, capturedAt = new Date().toISOString()): GeminiUsage {
  if (!raw || typeof raw !== 'object') throw new Error('Antigravity usage response is invalid');
  const command = (raw as Record<string, unknown>).command;
  const data = command && typeof command === 'object' ? (command as Record<string, unknown>).data : null;
  const sourceGroups = data && typeof data === 'object' ? (data as Record<string, unknown>).groups : null;
  if (!Array.isArray(sourceGroups)) throw new Error('Antigravity usage response has no quota groups');
  const groups = sourceGroups.map((value): GeminiUsageGroup | null => {
    if (!value || typeof value !== 'object') return null;
    const group = value as Record<string, unknown>;
    if (typeof group.name !== 'string' || !Array.isArray(group.buckets)) return null;
    const buckets = group.buckets.map((item): GeminiUsageBucket | null => {
      if (!item || typeof item !== 'object') return null;
      const bucket = item as Record<string, unknown>;
      const remaining = num(bucket.remaining_fraction);
      if (typeof bucket.id !== 'string' || typeof bucket.name !== 'string' || remaining === null) return null;
      const remainingPercent = Math.max(0, Math.min(100, remaining * 100));
      return {
        id: bucket.id,
        label: bucket.name,
        window: typeof bucket.window === 'string' ? bucket.window : '',
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        resetsAt: isoOrNull(bucket.reset_time),
      };
    }).filter((bucket): bucket is GeminiUsageBucket => bucket !== null);
    return { name: group.name, description: typeof group.description === 'string' ? group.description : '', buckets };
  }).filter((group): group is GeminiUsageGroup => group !== null && group.buckets.length > 0);
  if (!groups.length) throw new Error('Antigravity usage response has no readable quota buckets');
  return { groups, capturedAt };
}

let geminiCache: { at: number; data: GeminiUsage } | null = null;

export async function getGeminiUsage(): Promise<GeminiUsage> {
  if (geminiCache && Date.now() - geminiCache.at < USAGE_CACHE_MS) return geminiCache.data;
  const { stdout } = await execFileAsync(ANTIGRAVITY_BIN, ['--print', '/usage', '--output-format', 'json', '--print-timeout', '1m'], {
    env: { ...process.env, HOME: ANTIGRAVITY_HOME }, timeout: 75_000, maxBuffer: 2 * 1024 * 1024,
  });
  const capturedAt = new Date().toISOString();
  const data = parseGeminiUsage(JSON.parse(stdout), capturedAt);
  for (const group of data.groups) for (const bucket of group.buckets) recordUsageWindow({
    lane: 'gemini', windowKey: bucket.id, usedPercent: bucket.usedPercent,
    windowMinutes: bucket.window === '5h' ? 300 : bucket.window === 'weekly' ? 10_080 : null,
    resetsAt: bucket.resetsAt, capturedAt, metadata: { group: group.name, label: bucket.label },
  });
  geminiCache = { at: Date.now(), data };
  return data;
}

function formatMinorAmount(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const money = value as Record<string, unknown>;
  const minor = num(money.amount_minor);
  if (minor === null) return null;
  const exponent = num(money.exponent) ?? 2;
  const currency = typeof money.currency === 'string' ? money.currency : 'USD';
  const amount = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(exponent)} ${currency}`;
  }
}

function limitLabel(kind: string, scope: Record<string, unknown>): string {
  if (kind === 'session') return '5-hour window';
  const model = (scope.model ?? {}) as Record<string, unknown>;
  const scopeName =
    typeof model.display_name === 'string'
      ? model.display_name
      : typeof scope.surface === 'string'
        ? scope.surface
        : null;
  if (kind === 'weekly_all') return 'weekly · all models';
  if (kind === 'weekly_scoped') return `weekly · ${scopeName ?? 'scoped'}`;
  const base = kind.replace(/_/g, ' ');
  return scopeName ? `${base} · ${scopeName}` : base;
}

export function parseClaudeUsage(raw: Record<string, unknown>, subscriptionType: string): ClaudeUsage {
  const fiveHour = (raw.five_hour ?? {}) as Record<string, unknown>;
  const sevenDay = (raw.seven_day ?? {}) as Record<string, unknown>;
  const extra = (raw.extra_usage ?? {}) as Record<string, unknown>;
  const limits: ClaudeLimit[] = [];
  let modelWeeklyPercent: number | null = null;
  let modelWeeklyLabel: string | null = null;
  let modelWeeklyResetsAt: string | null = null;
  if (Array.isArray(raw.limits)) {
    for (const entry of raw.limits) {
      if (!entry || typeof entry !== 'object') continue;
      const limit = entry as Record<string, unknown>;
      const kind = typeof limit.kind === 'string' ? limit.kind : null;
      const percent = num(limit.percent);
      if (kind === null || percent === null) continue;
      const scope = (limit.scope ?? {}) as Record<string, unknown>;
      limits.push({
        kind,
        label: limitLabel(kind, scope),
        percent,
        severity: typeof limit.severity === 'string' ? limit.severity : 'normal',
        resetsAt: isoOrNull(limit.resets_at),
        isActive: limit.is_active === true,
      });
      if (kind === 'weekly_scoped' && modelWeeklyPercent === null) {
        const model = (scope.model ?? {}) as Record<string, unknown>;
        modelWeeklyPercent = percent;
        modelWeeklyLabel = typeof model.display_name === 'string' ? model.display_name : null;
        modelWeeklyResetsAt = isoOrNull(limit.resets_at);
      }
    }
  }
  const spendRaw = raw.spend as Record<string, unknown> | undefined;
  const spend: ClaudeSpend | null =
    spendRaw && typeof spendRaw === 'object'
      ? {
          usedFormatted: formatMinorAmount(spendRaw.used),
          limitFormatted: formatMinorAmount(spendRaw.limit),
          percent: num(spendRaw.percent),
          enabled: spendRaw.enabled === true,
          canPurchaseCredits: spendRaw.can_purchase_credits === true,
        }
      : null;
  return {
    fiveHourPercent: num(fiveHour.utilization) ?? 0,
    fiveHourResetsAt: isoOrNull(fiveHour.resets_at),
    weeklyPercent: num(sevenDay.utilization) ?? 0,
    weeklyResetsAt: isoOrNull(sevenDay.resets_at),
    modelWeeklyPercent,
    modelWeeklyLabel,
    modelWeeklyResetsAt,
    extraUsageEnabled: extra.is_enabled === true,
    subscriptionType,
    limits,
    extraUsage: {
      enabled: extra.is_enabled === true,
      utilization: num(extra.utilization),
      monthlyLimit: num(extra.monthly_limit),
      usedCredits: num(extra.used_credits),
      disabledReason: typeof extra.disabled_reason === 'string' ? extra.disabled_reason : null,
    },
    spend,
  };
}

function parseCodexWindow(value: unknown): CodexWindow | null {
  if (!value || typeof value !== 'object') return null;
  const window = value as Record<string, unknown>;
  const usedPercent = num(window.used_percent ?? window.usedPercent);
  if (usedPercent === null) return null;
  const resetsRaw = window.resets_at ?? window.resetsAt;
  const resetsUnix = num(resetsRaw);
  return {
    usedPercent,
    windowMinutes: num(window.window_minutes ?? window.windowMinutes),
    resetsAt: resetsUnix
      ? new Date(resetsUnix * 1000).toISOString()
      : isoOrNull(typeof resetsRaw === 'string' ? resetsRaw : null),
  };
}

export function parseCodexTokenCountLine(line: Record<string, unknown>): CodexUsage | null {
  const payload = (line.payload ?? {}) as Record<string, unknown>;
  if (payload.type !== 'token_count') return null;
  const rateLimits = payload.rate_limits as Record<string, unknown> | undefined;
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  return parseCodexRateLimits(rateLimits, isoOrNull(line.timestamp));
}

export function parseCodexRateLimits(
  rateLimits: Record<string, unknown>,
  capturedAt: string | null = new Date().toISOString(),
): CodexUsage | null {
  const primary = parseCodexWindow(rateLimits.primary ?? rateLimits);
  if (!primary) return null;
  const credits = (rateLimits.credits ?? {}) as Record<string, unknown>;
  return {
    usedPercent: primary.usedPercent,
    windowMinutes: primary.windowMinutes,
    resetsAt: primary.resetsAt,
    planType: typeof (rateLimits.plan_type ?? rateLimits.planType) === 'string'
      ? String(rateLimits.plan_type ?? rateLimits.planType)
      : 'unknown',
    capturedAt,
    secondary: parseCodexWindow(rateLimits.secondary),
    creditsBalance: typeof credits.balance === 'string' ? credits.balance : null,
    creditsUnlimited: credits.unlimited === true,
    hasCredits: credits.has_credits === true || credits.hasCredits === true,
    limitReached: typeof (rateLimits.rate_limit_reached_type ?? rateLimits.rateLimitReachedType) === 'string'
      ? String(rateLimits.rate_limit_reached_type ?? rateLimits.rateLimitReachedType)
      : null,
  };
}

export function recordUsageWindow(window: PersistedUsageWindow): void {
  getDb().prepare(`
    INSERT INTO subscription_usage_windows
      (lane, window_key, used_percent, window_minutes, resets_at, captured_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lane, window_key) DO UPDATE SET
      used_percent = excluded.used_percent,
      window_minutes = excluded.window_minutes,
      resets_at = excluded.resets_at,
      captured_at = excluded.captured_at,
      metadata = excluded.metadata
    WHERE excluded.captured_at >= subscription_usage_windows.captured_at
  `).run(
    window.lane,
    window.windowKey,
    window.usedPercent,
    window.windowMinutes,
    window.resetsAt,
    window.capturedAt,
    window.metadata ? JSON.stringify(window.metadata) : null,
  );
}

export function captureCodexRateLimits(raw: unknown, capturedAt = new Date().toISOString()): CodexUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage = parseCodexRateLimits(raw as Record<string, unknown>, capturedAt);
  if (!usage) return null;
  const metadata = {
    planType: usage.planType,
    creditsBalance: usage.creditsBalance,
    creditsUnlimited: usage.creditsUnlimited,
    hasCredits: usage.hasCredits,
    limitReached: usage.limitReached,
  };
  recordUsageWindow({
    lane: 'codex',
    windowKey: 'primary',
    usedPercent: usage.usedPercent,
    windowMinutes: usage.windowMinutes,
    resetsAt: usage.resetsAt,
    capturedAt,
    metadata,
  });
  if (usage.secondary) {
    recordUsageWindow({
      lane: 'codex',
      windowKey: 'secondary',
      ...usage.secondary,
      capturedAt,
      metadata,
    });
  }
  codexCache = { at: Date.now(), data: usage };
  return usage;
}

export function listPersistedUsageWindows(lane?: string): PersistedUsageWindow[] {
  const rows = (lane
    ? getDb().prepare('SELECT * FROM subscription_usage_windows WHERE lane = ? ORDER BY window_key').all(lane)
    : getDb().prepare('SELECT * FROM subscription_usage_windows ORDER BY lane, window_key').all()
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    lane: String(row.lane),
    windowKey: String(row.window_key),
    usedPercent: Number(row.used_percent),
    windowMinutes: row.window_minutes === null ? null : Number(row.window_minutes),
    resetsAt: row.resets_at === null ? null : String(row.resets_at),
    capturedAt: String(row.captured_at),
    metadata: typeof row.metadata === 'string'
      ? (() => { try { return JSON.parse(row.metadata) as Record<string, unknown>; } catch { return null; } })()
      : null,
  }));
}

interface ClaudeCredentials {
  accessToken: string;
  subscriptionType: string;
}

async function readClaudeCredentials(): Promise<ClaudeCredentials> {
  const raw = JSON.parse(await fs.readFile(CLAUDE_CREDENTIALS_PATH, 'utf8')) as {
    claudeAiOauth?: { accessToken?: unknown; subscriptionType?: unknown };
  };
  const oauth = raw.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    throw new Error('No Claude OAuth token on disk');
  }
  return {
    accessToken: oauth.accessToken,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : 'unknown',
  };
}

let claudeCache: { at: number; data: ClaudeUsage } | null = null;

export async function getClaudeUsage(): Promise<ClaudeUsage> {
  if (claudeCache && Date.now() - claudeCache.at < USAGE_CACHE_MS) return claudeCache.data;
  const creds = await readClaudeCredentials();
  const res = await fetch(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Claude usage endpoint answered ${res.status}`);
  const data = parseClaudeUsage((await res.json()) as Record<string, unknown>, creds.subscriptionType);
  const capturedAt = new Date().toISOString();
  recordUsageWindow({
    lane: 'claude',
    windowKey: 'five_hour',
    usedPercent: data.fiveHourPercent,
    windowMinutes: 300,
    resetsAt: data.fiveHourResetsAt,
    capturedAt,
    metadata: { subscriptionType: data.subscriptionType },
  });
  recordUsageWindow({
    lane: 'claude',
    windowKey: 'seven_day',
    usedPercent: data.weeklyPercent,
    windowMinutes: 10_080,
    resetsAt: data.weeklyResetsAt,
    capturedAt,
    metadata: { subscriptionType: data.subscriptionType },
  });
  for (const limit of data.limits) {
    if (limit.kind === 'session' || limit.kind === 'weekly_all') continue;
    recordUsageWindow({
      lane: 'claude',
      windowKey: limit.kind + ':' + limit.label,
      usedPercent: limit.percent,
      windowMinutes: null,
      resetsAt: limit.resetsAt,
      capturedAt,
      metadata: { label: limit.label, severity: limit.severity, isActive: limit.isActive },
    });
  }
  claudeCache = { at: Date.now(), data };
  return data;
}

async function newestCodexTranscripts(limit: number): Promise<string[]> {
  const files: { path: string; mtimeMs: number }[] = [];
  let dayDirs: string[] = [];
  try {
    const years = (await fs.readdir(CODEX_SESSIONS_DIR)).sort().reverse().slice(0, 2);
    for (const year of years) {
      const yearDir = path.join(CODEX_SESSIONS_DIR, year);
      const months = (await fs.readdir(yearDir)).sort().reverse().slice(0, 2);
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        const days = (await fs.readdir(monthDir)).sort().reverse().slice(0, 7);
        dayDirs.push(...days.map((day) => path.join(monthDir, day)));
      }
    }
  } catch {
    return [];
  }
  dayDirs = dayDirs.slice(0, 7);
  for (const dayDir of dayDirs) {
    let names: string[] = [];
    try { names = await fs.readdir(dayDir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(dayDir, name);
      try { files.push({ path: filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs }); } catch { /* vanished */ }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((f) => f.path);
}

let codexCache: { at: number; data: CodexUsage } | null = null;

export async function getCodexUsage(): Promise<CodexUsage> {
  if (codexCache && Date.now() - codexCache.at < USAGE_CACHE_MS) return codexCache.data;
  const persisted = listPersistedUsageWindows('codex');
  const primary = persisted.find((row) => row.windowKey === 'primary');
  if (primary) {
    const secondary = persisted.find((row) => row.windowKey === 'secondary') ?? null;
    const metadata = primary.metadata ?? {};
    const data: CodexUsage = {
      usedPercent: primary.usedPercent,
      windowMinutes: primary.windowMinutes,
      resetsAt: primary.resetsAt,
      planType: typeof metadata.planType === 'string' ? metadata.planType : 'unknown',
      capturedAt: primary.capturedAt,
      secondary: secondary ? {
        usedPercent: secondary.usedPercent,
        windowMinutes: secondary.windowMinutes,
        resetsAt: secondary.resetsAt,
      } : null,
      creditsBalance: typeof metadata.creditsBalance === 'string' ? metadata.creditsBalance : null,
      creditsUnlimited: metadata.creditsUnlimited === true,
      hasCredits: metadata.hasCredits === true,
      limitReached: typeof metadata.limitReached === 'string' ? metadata.limitReached : null,
    };
    codexCache = { at: Date.now(), data };
    return data;
  }
  for (const filePath of await newestCodexTranscripts(CODEX_SCAN_FILES)) {
    let content: string;
    try { content = await fs.readFile(filePath, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('rate_limits')) continue;
      try {
        const usage = parseCodexTokenCountLine(JSON.parse(line) as Record<string, unknown>);
        if (usage) {
          captureCodexRateLimits(
            ((JSON.parse(line) as Record<string, any>).payload?.rate_limits),
            usage.capturedAt ?? new Date().toISOString(),
          );
          return usage;
        }
      } catch { /* torn line */ }
    }
  }
  throw new Error('No Codex rate-limit stamp found in recent sessions');
}

