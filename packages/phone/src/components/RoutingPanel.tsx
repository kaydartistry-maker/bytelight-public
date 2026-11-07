// Message routing — per-lane overrides on top of the Home thread.
// Behaviour ported from main's Svelte RoutingPanel:
// each ambient lane (Discord, Telegram, autonomous wakes) follows Home unless
// it is aimed at a thread of its own. Backed by main's /api/threads/routing/:source.
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';
import { useHouseRoster } from '../lib/house';
import { apiFetch, useThreads } from '../bytelight';

type RoutingSource = 'discord' | 'telegram' | 'wake';

interface RoutingPanelProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

export function RoutingPanel({ themeConfig, themeMode }: RoutingPanelProps) {
  const colors = themeConfig[themeMode];
  const threads = useThreads();
  const { castLabels } = useHouseRoster();
  const [perSource, setPerSource] = useState<Record<RoutingSource, string | null>>({ discord: null, telegram: null, wake: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<RoutingSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sources: Array<{ key: RoutingSource; label: string; hint: string }> = [
    { key: 'discord', label: 'Discord', hint: 'Where Discord messages route when they reach us — DMs and channels with an @mention.' },
    { key: 'telegram', label: 'Telegram', hint: 'Where Telegram messages route — voice notes included.' },
    {
      key: 'wake',
      label: 'Autonomous wakes',
      hint: `Where ${castLabels.companions || 'the companions'}' own scheduled wakes drop. Leave on Home to keep everything in one place.`,
    },
  ];

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const keys: RoutingSource[] = ['discord', 'telegram', 'wake'];
        const results = await Promise.all(keys.map((k) =>
          apiFetch(`/api/threads/routing/${k}`).then((r) => (r.ok ? r.json() : { threadId: null })).catch(() => ({ threadId: null })),
        ));
        if (stale) return;
        setPerSource({
          discord: results[0]?.threadId ?? null,
          telegram: results[1]?.threadId ?? null,
          wake: results[2]?.threadId ?? null,
        });
      } catch (err) {
        if (!stale) setError(err instanceof Error ? err.message : 'Failed to load routing settings');
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => { stale = true; };
  }, []);

  async function setSource(source: RoutingSource, threadId: string | null) {
    setSaving(source);
    setError(null);
    try {
      const res = await apiFetch(`/api/threads/routing/${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to set ${source} routing`);
      }
      setPerSource((prev) => ({ ...prev, [source]: threadId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save routing');
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className={cn('mb-4 rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
      <h3 className={cn('mb-1 text-sm font-bold', colors.textMain)}>Message routing</h3>
      <p className={cn('mb-3 text-xs leading-relaxed', colors.textMuted)}>
        Everything ambient — Discord, Telegram, autonomous wakes — lands in the Home thread (the house marker in the
        thread list). Aim a lane at its own thread here to split it off.
      </p>
      {loading && (
        <div className={cn('flex items-center gap-2 text-xs', colors.textMuted)}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      )}
      {!loading && error && <div className="mb-2 text-xs" style={{ color: colors.accent }}>{error}</div>}
      {!loading && (
        <div className="flex flex-col gap-3">
          {sources.map((src) => (
            <label key={src.key} className="flex flex-col gap-1.5">
              <span className={cn('text-xs font-semibold', colors.textMain)}>{src.label}</span>
              <span className={cn('text-[11px] leading-snug opacity-70', colors.textMuted)}>{src.hint}</span>
              <select
                value={perSource[src.key] ?? '__home__'}
                disabled={saving === src.key}
                onChange={(e) => void setSource(src.key, e.target.value === '__home__' ? null : e.target.value)}
                className={cn('rounded-lg border px-3 py-2 text-xs', colors.panelBg, colors.panelBorder, colors.textMain)}
              >
                <option value="__home__">Home (default)</option>
                {threads.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
