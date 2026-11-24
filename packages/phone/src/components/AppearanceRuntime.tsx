import React from 'react';
import { normalizeThemeAppearance, type ThemeAppearance } from '@bytelight/shared';
import { buildAppearanceCss } from '../lib/appearance-css';

export const AppearanceRuntime = React.memo(function AppearanceRuntime({ appearance, section, legacyMotion }: {
  appearance?: ThemeAppearance; section?: string; legacyMotion?: number;
}) {
  const normalized = normalizeThemeAppearance(appearance);
  // The legacy phone slider already persisted this value; finally consume it.
  // 100/absent adds no CSS. New motion settings always take precedence.
  if (normalized.motion?.scale === undefined && normalized.motion?.duration === undefined && legacyMotion !== undefined && legacyMotion !== 100) {
    normalized.motion = { ...normalized.motion, scale: Math.max(0, Math.min(200, legacyMotion)) };
  }
  const css = buildAppearanceCss(normalized, { section });
  return css ? <style data-appearance-runtime>{css}</style> : null;
});

/** A cheap inert paint plane, beneath glyphs and independent of text opacity.
 * Existing painted-glass ::before remains untouched; no backdrop compositor.
 */
export function BubblePaintLayers() {
  return <>
    <span aria-hidden="true" className="appearance-paint" />
    <span aria-hidden="true" className="appearance-border" />
  </>;
}
