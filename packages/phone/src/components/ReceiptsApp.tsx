// Receipts — the memory ledger: one row per memory write or ambient recall,
// newest first. Port of main's Svelte ReceiptsPanel (read-only: actor,
// action, detail, time) on main's GET /api/memory/ledger.
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';
import { apiFetch, useMemoryBlockVersion } from '../bytelight';

interface LedgerEntry {
  id: number;
  actor: string;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  detail: string;
  metadata_json: string | null;
  seen_at: string | null;
  created_at: string;
}

interface ReceiptsAppProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// The same calm verbs main's panel uses for the ledger's action names.
function actionLabel(action: string): string {
  switch (action) {
    case 'memory.surface': return 'surfaced';
    case 'memory.dejavu': return 'déjà vu';
    case 'memory.append': return 'appended';
    case 'memory.replace': return 'replaced';
    case 'memory.rethink': return 'rewrote';
    case 'memory.delete': return 'deleted';
    default: return action;
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function ReceiptsApp({ themeConfig, themeMode }: ReceiptsAppProps) {
  const colors = themeConfig[themeMode];
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/memory/ledger?limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEntries(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // A block write leaves a receipt, so refresh when main says a block moved.
  const memoryBlockVersion = useMemoryBlockVersion();
  useEffect(() => { void load(); }, [load, memoryBlockVersion]);

  return (
    <div>
      <div className={cn('mb-3 rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <div className="flex items-start gap-3">
          <p className={cn('flex-1 text-xs leading-relaxed', colors.textMuted)}>
            Every memory write and every ambient recall leaves a receipt. Newest first — who acted, what happened, and when.
          </p>
          <button
            onClick={() => void load()}
            disabled={loading}
            className={cn('shrink-0 rounded-full border p-2 disabled:opacity-50', colors.panelBorder, colors.textMuted)}
            aria-label="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      {loading && entries.length === 0 && (
        <div className={cn('flex items-center justify-center gap-2 py-8 text-xs', colors.textMuted)}>
          <Loader2 size={14} className="animate-spin" /> Loading receipts…
        </div>
      )}
      {!loading && error && (
        <div className={cn('rounded-2xl border p-4 text-xs', colors.panelBg, colors.panelBorder)}>
          <div className="mb-1 font-semibold" style={{ color: colors.accent }}>Couldn't load receipts</div>
          <div className={colors.textMuted}>{error}</div>
        </div>
      )}
      {!loading && !error && entries.length === 0 && (
        <div className={cn('py-8 text-center text-xs italic', colors.textMuted)}>
          No receipts yet. They appear as memory is written or recalled.
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {entries.map((e) => {
          const recall = e.action === 'memory.surface' || e.action === 'memory.dejavu';
          return (
            <li
              key={e.id}
              className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}
              style={recall ? { borderColor: colors.accent } : undefined}
            >
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
                <span className={cn('font-bold', colors.textMain)}>{e.actor}</span>
                <span style={{ color: colors.accent }}>{actionLabel(e.action)}</span>
                <span className={cn('ml-auto normal-case tracking-normal', colors.textMuted)}>{fmtTime(e.created_at)}</span>
              </div>
              <p className={cn('mt-1 text-xs leading-relaxed whitespace-pre-wrap', colors.textMain)}>{e.detail}</p>
              {e.subject_id && (
                <p className={cn('mt-1 text-[10px] opacity-70', colors.textMuted)}>
                  {e.subject_type ?? 'subject'}: {e.subject_id}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
