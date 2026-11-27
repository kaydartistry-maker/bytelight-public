import React from 'react';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';

// Where Discord talk is happening now, drawn like the date line but quieter
// and in the room's own words (lib/discord-rooms.ts).
export function RoomDivider({ label, themeConfig, themeMode }: { label: string; themeConfig: ThemeConfig; themeMode: 'light' | 'dark' }) {
  const colors = themeConfig[themeMode];
  return (
    <div className="flex items-center gap-2 my-3 px-2" role="separator" aria-label={`Discord: ${label}`}>
      <div className={cn('flex-1 h-px border-t', colors.panelBorder)} />
      <span className={cn('max-w-[75%] truncate text-[11px] italic opacity-70', colors.textMuted)}>{label}</span>
      <div className={cn('flex-1 h-px border-t', colors.panelBorder)} />
    </div>
  );
}
