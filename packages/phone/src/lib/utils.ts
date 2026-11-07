import React from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Haptic tick for tile presses — Android Chrome (and installed PWAs)
// exposes the vibration motor; iOS and desktop quietly no-op. Keep the
// durations short (8-20ms): these are texture, not notifications.
export function haptic(ms = 10): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}

// Strip markdown syntax for plain text previews (thread list, etc)
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
    .replace(/\*(.+?)\*/g, '$1')       // italic
    .replace(/__(.+?)__/g, '$1')       // underline
    .replace(/_(.+?)_/g, '$1')         // italic alt
    .replace(/~~(.+?)~~/g, '$1')       // strikethrough
    .replace(/`(.+?)`/g, '$1');        // code
}

// Parse inline markdown to JSX elements for rich display
export function parseInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match bold, italic, or plain text
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|([^*]+)/g;
  let match;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match[1]) {
      // Bold: **text**
      parts.push(React.createElement('strong', { key: key++ }, match[2]));
    } else if (match[3]) {
      // Italic: *text*
      parts.push(React.createElement('em', { key: key++ }, match[4]));
    } else if (match[5]) {
      // Plain text
      parts.push(match[5]);
    }
  }
  return parts.length > 0 ? parts : [text];
}

// Add an alpha channel to a hex color (or rgb()) for translucent tints.
// Returns the input untouched for var(--*) accents and other non-hex
// values — callers handle the fallback themselves.
export function withAlpha(color: string, alpha: number): string {
  if (!color) return color;
  if (color.startsWith('#')) {
    const hex = color.replace('#', '');
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex;
    if (full.length !== 6) return color;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return color;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgbMatch = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgbMatch) return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  return color;
}
