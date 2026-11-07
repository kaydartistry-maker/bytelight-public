import React from 'react';
import { format } from 'date-fns';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';

interface DateDividerProps {
  timestamp: string;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// Pretty label for a date relative to today: Today / Yesterday / weekday /
// "Mar 5" within the same year / "Mar 5, 2024" otherwise.
function labelFor(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  const diffDays = (now.getTime() - d.getTime()) / 86_400_000;
  if (diffDays > 0 && diffDays < 7) return format(d, 'EEEE');
  if (d.getFullYear() === now.getFullYear()) return format(d, 'MMM d');
  return format(d, 'MMM d, yyyy');
}

export function DateDivider({ timestamp, themeConfig, themeMode }: DateDividerProps) {
  const colors = themeConfig[themeMode];
  const label = labelFor(timestamp);
  if (!label) return null;
  return (
    <div className="flex items-center gap-2 my-4 px-2">
      <div className={cn('flex-1 h-px', colors.panelBorder, 'border-t')} />
      <span className={cn('text-[10px] font-bold uppercase tracking-widest opacity-60', colors.textMuted)}>
        {label}
      </span>
      <div className={cn('flex-1 h-px', colors.panelBorder, 'border-t')} />
    </div>
  );
}
