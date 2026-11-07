import React from 'react';
import { Clock } from 'lucide-react';
import { cn } from '../lib/utils';
import { useCompactionNotice } from '../bytelight';
import type { ThemeConfig } from '../lib/theme';

interface CompactionBannerProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// Renders the in-progress / completed compaction notice from the WS.
// Pulses while !isComplete, stays solid once done.
export function CompactionBanner({ themeConfig, themeMode }: CompactionBannerProps) {
  const notice = useCompactionNotice();
  if (!notice) return null;
  const colors = themeConfig[themeMode];

  return (
    <div
      className={cn(
        'mx-3 mt-2 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs',
        colors.panelBg,
        colors.panelBorder,
        !notice.isComplete && 'animate-pulse',
      )}
      style={{ color: colors.accent }}
    >
      <Clock size={14} />
      <span className="flex-1 truncate">{notice.message}</span>
    </div>
  );
}
