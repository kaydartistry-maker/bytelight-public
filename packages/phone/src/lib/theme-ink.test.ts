// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, flattenOver, resolveThemeColors, type ThemeConfig } from './theme.js';
import { contrastRatio } from './bubble-look.js';
import { themeInk } from './theme-ink.js';

// The colors on a set of companion rows.
const OURS = [
  { slug: 'companion-a', color: '#e85d04' },
  { slug: 'companion-b', color: '#1e3a5f' },
  { slug: 'echo', color: '#7c3aed' },
];

function hex(color: string): string {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color);
  if (!m) return color;
  return '#' + [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('');
}

// What is really under the words, worked out the way App.tsx paints it
// (--bytelight-page and --bytelight-surface), not by the rule under test.
function under(theme: ThemeConfig, mode: 'light' | 'dark'): string[] {
  // byte-light themes carry no Aerie palette, so the panel is always the
  // resolved panel color flattened over the page.
  const resolved = resolveThemeColors(theme[mode]);
  const page = hex(resolved.pageBg);
  const panel = hex(flattenOver(resolved.panelBg, resolved.pageBg));
  return [page, panel];
}

// Every theme but Custom, whose colors are the owner's to type and live only as CSS variables.
const fixed = Object.values(THEMES).filter((t) => t.id !== 'custom');

test('there are themes to measure, and their backdrops are real colors', () => {
  // Aerie ships 40+ themes; this house has fewer, and every one is measured.
  assert.ok(fixed.length >= 10, `${fixed.length} themes`);
  for (const theme of fixed) for (const mode of ['light', 'dark'] as const) {
    for (const b of under(theme, mode)) assert.match(b, /^#[0-9a-f]{6}$/i, `${theme.id} ${mode}: ${b}`);
  }
});

test("drawn raw, the companions' own colors do not read on every theme (the reason for the rule)", () => {
  const misses: string[] = [];
  for (const theme of fixed) for (const mode of ['light', 'dark'] as const) {
    for (const { slug, color } of OURS) {
      for (const b of under(theme, mode)) if (contrastRatio(color, b) < 4.5) misses.push(`${slug} ${theme.id} ${mode}`);
    }
  }
  assert.ok(misses.some((m) => m.startsWith('companion-b') && m.endsWith('dark')), 'Companion B raw at night');
});

test('after the rule, each companion reads at 4.5 to 1 on every theme, day and night', () => {
  const misses: string[] = [];
  for (const theme of fixed) for (const mode of ['light', 'dark'] as const) {
    const backdrops = under(theme, mode);
    for (const { slug, color } of OURS) {
      const ink = themeInk(slug, color, theme[mode], mode);
      for (const b of backdrops) {
        const r = contrastRatio(ink, b);
        if (r < 4.5) misses.push(`${slug} ${theme.id} ${mode}: ${ink} on ${b} = ${r.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(misses, []);
});

test('a companion is fitted from their own row color, and without a mode the page tells it', () => {
  for (const theme of fixed) for (const mode of ['light', 'dark'] as const) {
    const backdrops = under(theme, mode);
    const ink = themeInk('juniper', '#1e3a5f', theme[mode]);
    for (const b of backdrops) assert.ok(contrastRatio(ink, b) >= 4.5, `${theme.id} ${mode}: ${ink} on ${b}`);
  }
});

test('a color that already reads is left exactly as it was', () => {
  assert.equal(themeInk('juniper', '#ffffff', THEMES.monochrome.dark, 'dark'), '#ffffff');
});
