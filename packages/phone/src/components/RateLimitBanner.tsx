import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useRateLimitInfo } from '../bytelight';
import { withAlpha } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';

interface RateLimitBannerProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// Compact rate-limit status for the chat header. The reset time stays one
// tap away without laying a full-width banner over the conversation.
export function RateLimitBanner({ themeConfig, themeMode }: RateLimitBannerProps) {
  const info = useRateLimitInfo();
  const [expanded, setExpanded] = useState(false);
  if (!info) return null;

  const accent = themeConfig[themeMode].accent;
  const resetsAt = info.resetsAt
    ? new Date(info.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
  const resetDetail = resetsAt ? `Resets ${resetsAt}` : 'Reset time pending';

  return (
    <button
      type="button"
      onClick={() => setExpanded((value) => !value)}
      className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-tight"
      style={{
        background: withAlpha(accent, 0.10),
        borderColor: withAlpha(accent, 0.30),
        color: accent,
      }}
      aria-expanded={expanded}
      aria-label={`Rate limited. ${resetDetail}`}
      title={`${resetDetail}. Tap for details.`}
    >
      <AlertTriangle size={11} aria-hidden="true" />
      <span>Rate limited</span>
      {expanded && <span className="whitespace-nowrap opacity-75">· {resetDetail}</span>}
    </button>
  );
}
