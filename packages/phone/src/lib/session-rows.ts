// The house's /api/sessions returns real session_history rows (snake_case,
// joined to thread name + per-session usage totals). The Sessions screen came
// over from Aerie expecting Claude SDK session files (sessionId, summary,
// fileSize), so it read `s.sessionId.slice` on undefined and took the whole
// app down. This maps the house's actual shape into what the card shows, and
// tolerates any field being absent.

export interface SessionHistoryRow {
  id: string;
  thread_id?: string | null;
  session_id?: string | null;
  session_type?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  end_reason?: string | null;
  thread_name?: string | null;
  platform?: string | null;
  usage_turns?: number | null;
  usage_input_tokens?: number | null;
  usage_output_tokens?: number | null;
  usage_cache_read_tokens?: number | null;
  usage_cache_creation_tokens?: number | null;
  usage_cost_usd?: number | null;
  last_context_tokens?: number | null;
  last_context_window?: number | null;
}

export interface SessionCard {
  key: string;
  shortId: string;
  title: string;
  platform: string | null;
  startedMs: number | null;
  endedMs: number | null;
  open: boolean;
  endReason: string | null;
  turns: number;
  outputTokens: number | null;
  costUsd: number | null;
  contextTokens: number | null;
  contextPercent: number | null;
}

// SQLite datetime('now') stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone.
function parseWhen(v?: string | null): number | null {
  if (!v) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function toSessionCard(r: SessionHistoryRow): SessionCard {
  const ctx = r.last_context_tokens ?? null;
  const win = r.last_context_window ?? null;
  const pct = ctx != null && win ? Math.max(0, Math.min(100, Math.round((ctx / win) * 100))) : null;
  return {
    key: r.id ?? r.session_id ?? Math.random().toString(36),
    shortId: (r.session_id ?? '').slice(0, 8),
    title: r.thread_name || 'Untitled session',
    platform: r.platform ?? null,
    startedMs: parseWhen(r.started_at),
    endedMs: parseWhen(r.ended_at),
    open: !r.ended_at,
    endReason: r.end_reason ?? null,
    turns: r.usage_turns ?? 0,
    outputTokens: r.usage_output_tokens ?? null,
    costUsd: r.usage_cost_usd ?? null,
    contextTokens: ctx,
    contextPercent: pct,
  };
}
