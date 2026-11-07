// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// One rule for a companion's own color used as words or a small icon: it has
// to read on whatever the theme puts under it, in both modes (a deep navy on
// a dark theme was nearly invisible). The color is fitted
// against the page AND the panel a card is painted with, the same two solid
// colors App.tsx lays down as --bytelight-page and --bytelight-surface.

import { inkOn } from './bubble-look';
import { resolveThemeColor, type ThemeColors, type ResolvedThemeColors } from './theme';

type Rgba = { r: number; g: number; b: number; a: number };

function parse(color: string): Rgba | null {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(c);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
  // The palettes' panel: color-mix(in srgb, <color> N%, transparent).
  const mix = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/i.exec(c);
  if (mix) {
    const inner = parse(mix[1]);
    return inner ? { ...inner, a: inner.a * (+mix[2] / 100) } : null;
  }
  return null;
}

function hexOf({ r, g, b }: Rgba): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** A color laid over a solid backdrop, as solid hex; null if either won't parse. */
function solidOver(color: string, backdrop: Rgba | null): string | null {
  const top = parse(color);
  if (!top) return null;
  if (top.a >= 1 || !backdrop) return top.a >= 1 ? hexOf(top) : null;
  const ch = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return hexOf({ r: ch(top.r, backdrop.r), g: ch(top.g, backdrop.g), b: ch(top.b, backdrop.b), a: 1 });
}

function cssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The solid colors words in a companion's color sit on: the page, the panel laid over
 *  it, and on a palette its surface. The custom theme's colors are CSS
 *  variables only, so there it reads what App.tsx painted. */
export function themeBackdrops(colors?: ThemeColors | ResolvedThemeColors | null): string[] {
  let page = colors ? resolveThemeColor(colors.pageBg, '') : '';
  let panel = colors ? resolveThemeColor(colors.panelBg, '') : '';
  if (!parse(page)) page = cssVar('--bytelight-page');
  const pageRgba = parse(page);
  const out: string[] = [];
  const pageHex = solidOver(page, null);
  if (pageHex) out.push(pageHex);
  let panelHex = solidOver(panel, pageRgba);
  if (!panelHex) panelHex = solidOver(cssVar('--bytelight-surface'), pageRgba);
  if (panelHex) out.push(panelHex);
  if (colors && colors.pageBg.includes('--pal-')) {
    const surface = solidOver(resolveThemeColor('bg-[var(--pal-surface)]', ''), pageRgba);
    if (surface) out.push(surface);
  }
  return out;
}

function isDark(hex: string): boolean {
  const c = parse(hex);
  if (!c) return true;
  const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b) < 0.18;
}

/** A companion's own color, fitted to read as words on this theme (4.5 to 1
 *  against the page and the panel). With no mode given it is read off the
 *  page itself. */
export function themeInk(
  slug: string | null | undefined,
  color: string | null | undefined,
  colors?: ThemeColors | ResolvedThemeColors | null,
  mode?: 'light' | 'dark',
): string {
  const under = themeBackdrops(colors);
  const m = mode ?? (under[0] ? (isDark(under[0]) ? 'dark' : 'light') : 'dark');
  return inkOn(slug ?? '', color ?? null, m, under);
}
