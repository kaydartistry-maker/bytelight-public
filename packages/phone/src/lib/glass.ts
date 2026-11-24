// The house's one glass, as numbers she controls (Slice 2, Nov 2026).
//
// Slice 1 put every surface on one material (--bl-glass and friends, read by
// the ONE GLASS and GLASS CHIPS blocks in index.css). This file turns her
// Glass card settings into those variables. Pure: no DOM, so it is tested
// directly (glass.test.ts). Anything she hasn't touched falls back to the
// look Slice 1 shipped, so nothing moves until she moves it.

import { contrastTextColor, flattenOver } from './theme';

export type GlassInk = 'auto' | 'theme' | string; // a hex is her own pick

export interface GlassSettings {
  tint?: string | null;        // hex; null/undefined = the theme's panel colour
  opacity?: number;            // 0-100, how much tint (100 = solid)
  blur?: number;               // 0-24 px frost on the big surfaces (never bubbles)
  borderColor?: string | null; // hex; null = the theme's hairline
  borderWidth?: number;        // 0-3 px
  glow?: number;               // 0-100, light around every glass edge
  ink?: GlassInk;              // text on glass
  bubbleFrost?: 'plain' | 'painted';
  // Slice 3: the glass can be a Colour (above) or a Texture she uploads.
  mode?: 'colour' | 'texture';
  texture?: string | null;     // her uploaded image (shrunk), a data URL
  textureStrength?: number;    // 0-100, how strongly the texture shows
  textureFit?: TextureFit;
}

// How the texture sits on surfaces (The operator: One sheet by default).
//   sheet: one pane across the whole screen; every surface is a window onto it
//   fill:  each surface shows the whole texture (cropped to fit, not stretched)
//   tile:  the texture repeats like wallpaper
export type TextureFit = 'sheet' | 'fill' | 'tile';

export const GLASS_DEFAULTS = {
  opacity: 72,
  blur: 14,
  borderWidth: 1,
  glow: 0,
  ink: 'auto' as GlassInk,
  bubbleFrost: 'plain' as const,
  mode: 'colour' as const,
  textureStrength: 100,
  textureFit: 'sheet' as TextureFit,
};

/** Texture is showing only in Texture mode AND with an image uploaded. */
export function textureOn(g: GlassSettings | undefined): boolean {
  return (g?.mode ?? GLASS_DEFAULTS.mode) === 'texture' && typeof g?.texture === 'string' && g.texture.startsWith('data:image/');
}

/** The CSS for how her texture sits, per Fit. */
export function textureFitVars(g: GlassSettings | undefined): Record<string, string> {
  const fit = g?.textureFit === 'fill' || g?.textureFit === 'tile' ? g.textureFit : GLASS_DEFAULTS.textureFit;
  if (fit === 'tile') return { '--bl-tex-size': '180px auto', '--bl-tex-repeat': 'repeat', '--bl-tex-attach': 'scroll' };
  if (fit === 'fill') return { '--bl-tex-size': 'cover', '--bl-tex-repeat': 'no-repeat', '--bl-tex-attach': 'scroll' };
  return { '--bl-tex-size': 'cover', '--bl-tex-repeat': 'no-repeat', '--bl-tex-attach': 'fixed' };
}

/** Texture strength as a 0-1 alpha for baking (lib/texture.ts). */
export function textureAlpha(g: GlassSettings | undefined): number {
  const v = typeof g?.textureStrength === 'number' && Number.isFinite(g.textureStrength) ? g.textureStrength : GLASS_DEFAULTS.textureStrength;
  return Math.min(100, Math.max(0, v)) / 100;
}

export interface GlassInputs {
  panel: string;      // the theme's panel colour (any CSS colour)
  page: string;       // the page colour the glass is judged against
  hairline: string;   // the theme's border colour
  text: string;       // the theme's text (already includes her Text pick)
  accent: string;     // her accent, the glow's colour when no border colour is set
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(hi, Math.max(lo, v));
};

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

export function glassVars(g: GlassSettings | undefined, t: GlassInputs): Record<string, string> {
  const s = g || {};
  const tint = isHex(s.tint) ? s.tint : flattenOver(t.panel, t.page);
  const opacity = Math.round(clamp(s.opacity, 0, 100, GLASS_DEFAULTS.opacity));
  const blur = Math.round(clamp(s.blur, 0, 24, GLASS_DEFAULTS.blur));
  const borderWidth = clamp(s.borderWidth, 0, 3, GLASS_DEFAULTS.borderWidth);
  const glow = Math.round(clamp(s.glow, 0, 100, GLASS_DEFAULTS.glow));
  const border = isHex(s.borderColor) ? s.borderColor : t.hairline;
  const glowColor = isHex(s.borderColor) ? s.borderColor : t.accent;

  // Text on glass. 'theme' = the theme's own text. A hex = hers. 'auto' = the
  // theme's text until she picks her own tint, then whichever of light or dark
  // ink reads on that tint (laid over the page at her opacity).
  let ink = t.text;
  if (isHex(s.ink)) ink = s.ink;
  else if ((s.ink ?? GLASS_DEFAULTS.ink) === 'auto' && isHex(s.tint)) {
    const fill = `${s.tint}${Math.round((opacity / 100) * 255).toString(16).padStart(2, '0')}`;
    ink = contrastTextColor(fill, '#ffffff', flattenOver(t.page, '#000000'));
  }

  return {
    '--bl-glass-tint': tint,
    '--bl-glass': `color-mix(in srgb, ${tint} ${opacity}%, transparent)`,
    '--bl-glass-border': border,
    '--bl-glass-border-width': `${borderWidth}px`,
    '--bl-glass-ink': ink,
    // Frost 0 still paints a (zero) filter, never 'none': on an Android web
    // view dropping the filter entirely also dropped the tint (Nov 21, Opacity
    // at 72 and the cards went clear). Same paint path at every Frost value.
    '--bl-glass-blur': `blur(${blur}px) saturate(${blur > 0 ? 1.18 : 1})`,
    // One glow, her colour, around every glass edge. 0 = none at all.
    '--bl-glass-glow': glow > 0
      ? `0 0 ${Math.round(4 + glow * 0.2)}px color-mix(in srgb, ${glowColor} ${Math.round(glow * 0.7)}%, transparent)`
      : '0 0 0 0 transparent',
  };
}
