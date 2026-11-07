import React from 'react';
import { useContextUsage } from '../bytelight';
import { withAlpha } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';

interface ContextIndicatorProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// Hidden until usage > 50% so it stays out of the way on routine threads.
// Severity is communicated via opacity ramp + pulse-at-critical so the
// indicator blends with each theme instead of jumping to red/orange.
export function ContextIndicator({ themeConfig, themeMode }: ContextIndicatorProps) {
  const usage = useContextUsage();
  if (!usage || usage.percentage <= 50) return null;

  const pct = Math.min(100, Math.max(0, usage.percentage));
  const accent = themeConfig[themeMode].accent;

  const pulse = pct >= 95;
  const fillOpacity = pct >= 95 ? 1 : pct >= 85 ? 0.95 : pct >= 70 ? 0.85 : 0.7;

  const tokens = usage.tokensUsed?.toLocaleString();
  const window = usage.contextWindow?.toLocaleString();

  return (
    <div
      className="flex items-center gap-1.5 text-[10px] tabular-nums"
      title={tokens && window ? `${tokens} / ${window} tokens` : `${pct}% of context used`}
      style={{ color: accent, opacity: fillOpacity }}
    >
      <div
        className="h-1 w-10 rounded-full overflow-hidden"
        style={{ background: withAlpha(accent, 0.15) }}
      >
        <div
          className={pulse ? 'h-full animate-pulse' : 'h-full'}
          style={{ width: `${pct}%`, background: accent }}
        />
      </div>
      <span>{Math.round(pct)}%</span>
    </div>
  );
}
