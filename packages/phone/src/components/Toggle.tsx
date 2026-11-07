import React from 'react';
import { cn } from '../lib/utils';
import { ThemeColors } from '../lib/theme';

// Single toggle component used across all apps so the orange "on" pill
// matches in size and alignment everywhere. Previously OrchestratorApp,
// DiscordApp, PreferencesApp, and DiscordRules each had their own
// inline toggle markup at different sizes (h-[22px] w-10 vs h-5 w-9 vs
// w-8 h-4), which left the toggle column ragged across the system apps.
//
// Sized to match what SettingsDashboard already uses (h-[22px] w-10
// track, h-4 w-4 knob) — that gives a touch target that's still small
// enough to right-align cleanly in a row without overflowing.

interface ToggleProps {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  colors: ThemeColors;
  ariaLabel?: string;
}

export function Toggle({ on, onClick, disabled, colors, ariaLabel }: ToggleProps) {
  // Track: 40px outer × 22px tall. With box-sizing: border-box the 1px
  // border eats into that, leaving 38px × 20px of padding-box for the
  // knob to live in. Knob is 16px × 16px so there's 2px of margin on
  // each side; off rests at left-[2px], on slides to right-[2px] (a
  // translateX(20px) shift). Anchoring with explicit `left` instead of
  // letting `absolute` use its static position is what stopped the knob
  // drifting to the right edge on first render.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={ariaLabel}
      className={cn(
        'relative h-[22px] w-10 rounded-full border transition-colors shrink-0',
        'disabled:opacity-50 disabled:cursor-not-allowed',
      )}
      style={{
        background: on ? colors.accent : 'transparent',
        borderColor: on ? colors.accent : 'rgba(127,127,127,0.4)',
      }}
    >
      <span
        className="absolute top-[2px] left-[2px] h-4 w-4 rounded-full transition-transform"
        style={{
          background: on ? '#fff' : 'rgba(127,127,127,0.55)',
          transform: on ? 'translateX(20px)' : 'translateX(0)',
        }}
      />
    </button>
  );
}
