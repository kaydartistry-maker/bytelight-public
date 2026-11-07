import React, { useEffect, useState } from 'react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

interface VoiceUsage {
  tier: string;
  characterCount: number;
  characterLimit: number;
  remaining: number;
  usedPercent: number;
  nextResetAt: string | null;
}

interface VoiceUsageMeterProps {
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

// Live ElevenLabs credit balance — reads /api/voice/usage (subscription
// endpoint behind the user_read key permission). Renders a muted note
// instead of disappearing when the backend can't reach ElevenLabs, so a
// missing permission is visible rather than a silent gap.
export function VoiceUsageMeter({ themeConfig, themeMode }: VoiceUsageMeterProps) {
  const colors = themeConfig[themeMode];
  const [usage, setUsage] = useState<VoiceUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/voice/usage');
        const data = await res.json().catch(() => null) as Partial<VoiceUsage> & { error?: unknown } | null;
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(typeof data?.error === 'string' && data.error ? data.error : `load failed (${res.status})`);
        }
        if (typeof data?.characterCount !== 'number' || typeof data?.characterLimit !== 'number') {
          // A backend without this route answers through the SPA fallback —
          // 200 with an HTML page. Anything that isn't the usage shape means
          // the meter isn't live yet, never a reason to crash the app.
          setError('Waiting on the new backend — restart to light this up.');
          return;
        }
        setUsage({
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
        });
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Voice usage unavailable.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className={cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder)}>
      <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted)}>
        ElevenLabs credits
      </div>
      {usage ? (
        <>
          <div className={cn('h-1.5 rounded-full overflow-hidden mb-2', themeMode === 'dark' ? 'bg-white/10' : 'bg-black/10')}>
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.max(2, usage.usedPercent)}%`, backgroundColor: colors.accent }}
            />
          </div>
          <div className={cn('text-sm', colors.textMain)}>
            {usage.characterCount.toLocaleString()} of {usage.characterLimit.toLocaleString()} used
            <span className={cn('ml-1', colors.textMuted)}>({usage.usedPercent}%)</span>
          </div>
          <div className={cn('text-[10px] mt-0.5', colors.textMuted)}>
            {usage.remaining.toLocaleString()} remaining
            {usage.nextResetAt ? ` · resets ${formatReset(usage.nextResetAt)}` : ''}
            {usage.tier && usage.tier !== 'unknown' ? ` · ${usage.tier} tier` : ''}
          </div>
        </>
      ) : (
        <p className={cn('text-[10px] italic', colors.textMuted)}>{error || 'Loading…'}</p>
      )}
    </div>
  );
}
