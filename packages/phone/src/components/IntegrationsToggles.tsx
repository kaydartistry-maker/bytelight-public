import React, { useEffect, useState } from 'react';
import { Toggle } from './Toggle';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

interface IntegrationsTogglesProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

type Key = 'orchestrator' | 'voice' | 'discord' | 'telegram';

const ROWS: { key: Key; label: string; hint?: string }[] = [
  { key: 'orchestrator', label: 'Orchestrator', hint: 'Scheduled wakes, check-ins, failsafe, triggers' },
  { key: 'voice', label: 'Voice', hint: 'ElevenLabs TTS + voice recording' },
  { key: 'discord', label: 'Discord', hint: 'Bot relay (also configurable in the Discord tab)' },
  { key: 'telegram', label: 'Telegram', hint: 'Bot relay' },
];

// "Read actions aloud" is not here: nothing on this backend reads that flag
// yet, so a switch for it would only pretend. It returns with the feature.

// Top-level start/stop flags for the long-running services. Each toggle
// hits a service-specific /toggle endpoint that actually starts or stops
// the running service AND persists the flag — flipping a toggle takes
// effect immediately rather than waiting for the next server restart.
// (Telegram needs a bot token in secrets to have been initialized at
// boot; if it wasn't, the toggle returns 400.)
const TOGGLE_ENDPOINT: Record<Key, string> = {
  orchestrator: '/api/orchestrator/toggle',
  voice: '/api/voice/toggle',
  discord: '/api/discord/toggle',
  telegram: '/api/telegram/toggle',
};

export function IntegrationsToggles({ themeConfig, themeMode }: IntegrationsTogglesProps) {
  const colors = themeConfig[themeMode];
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<Record<Key, boolean>>({
    orchestrator: true,
    voice: false,
    discord: false,
    telegram: false,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/preferences');
        if (!res.ok) throw new Error('load failed');
        const p = await res.json();
        setState({
          orchestrator: p.orchestrator?.enabled ?? true,
          voice: p.voice?.enabled ?? false,
          discord: p.discord?.enabled ?? false,
          telegram: p.telegram?.enabled ?? false,
        });
      } catch {
        setError('Failed to load integration toggles.');
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function patch(key: Key, value: boolean) {
    // Optimistic — service-specific endpoint actually starts/stops the
    // running service and persists the flag. Revert on failure.
    setState((s) => ({ ...s, [key]: value }));
    try {
      const res = await apiFetch(TOGGLE_ENDPOINT[key], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `save failed (${res.status})`);
      }
      setError(null);
    } catch (err) {
      setState((s) => ({ ...s, [key]: !value }));
      setError(err instanceof Error ? err.message : 'Failed to save.');
    }
  }

  return (
    <div className={cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder)}>
      <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted)}>Services</div>
      {ROWS.map((row) => (
        <div key={row.key} className="flex items-center justify-between py-1.5">
          <div className="min-w-0 flex-1 pr-3">
            <div className={cn('text-sm', colors.textMain)}>{row.label}</div>
            {row.hint && <div className={cn('text-[10px] mt-0.5', colors.textMuted)}>{row.hint}</div>}
          </div>
          <Toggle on={state[row.key]} onClick={() => patch(row.key, !state[row.key])} colors={colors} />
        </div>
      ))}
      <p className={cn('text-[10px] mt-2 italic', colors.textMuted)}>
        {loaded ? 'Changes take effect immediately.' : 'Loading…'}
      </p>
      {error && <p className="text-[10px] mt-1" style={{ color: colors.accent }}>{error}</p>}
    </div>
  );
}
