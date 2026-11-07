// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// How the chat bubbles look, apart from drawing them (the Bubbles page of the
// Personalize menu). Each switch starts as the bubbles have always looked, so
// nothing is applied all at once: faces stay on, and names over companion
// bubbles, edges in companion colors and quieter action lines wait to be
// turned on. Kept free of imports so it can be tested.

export interface BubbleLook {
  /** Each companion's face beside their bubbles, and the owner's beside theirs. */
  faces: boolean;
  /** Each companion named in small capitals in their color: over their
   *  bubbles, or under them beside the face when their tails are at the bottom. */
  names: boolean;
  /** A companion bubble's thin border in that companion's color instead of the theme's. */
  edges: boolean;
  /** Action lines (the italics) a little quieter than the words. */
  quietActions: boolean;
  /** The owner's own name in their color, over their bubbles, or under them
   *  beside their face when their tail is at the bottom (a name up top reads
   *  strangely with the face down below). */
  myName: boolean;
  /** Which corner each side's tail comes from: the top, as it always has,
   *  or the bottom, with the face beside it moving down to meet it. With a
   *  bottom tail and a name showing, the name and the time share one line
   *  under the bubble: the name by the face, the time at the far end. The
   *  typing dots and the Settings previews follow
   *  the same switch. */
  tailMine: Tail;
  tailOurs: Tail;
  /** The tail's shape on both sides: the point, or a swoop curling out of
   *  that same corner. */
  tailShape: TailShape;
  /** The rings round every face: each in its own color as set in the house, or all in the theme's two-tone fill, the one
   *  selected things wear. A guest's ring stays the theme's accent either way. */
  rings: Rings;
  /** Names, the companions' and the owner's, in their own colors, or in the theme's plain ink
   *  On is how names have always looked. */
  nameColors: boolean;
  /** The typing dots in the companions' colors, one each, or in the bubble's ink
   *  On is the default. */
  dotColors: boolean;
}

export type Tail = 'top' | 'bottom';
export type TailShape = 'point' | 'swoop';
export type Rings = 'house' | 'theme';

/** The bubbles as they have always looked. */
export const DEFAULT_LOOK: BubbleLook = { faces: true, names: false, edges: false, quietActions: false, myName: false, tailMine: 'top', tailOurs: 'top', tailShape: 'point', rings: 'house', nameColors: true, dotColors: true };

export function bubbleLookOf(theme: { bubbleFaces?: unknown; bubbleNames?: unknown; bubbleEdges?: unknown; bubbleQuietActions?: unknown; bubbleMyName?: unknown; bubbleTailMine?: unknown; bubbleTailOurs?: unknown; bubbleTailShape?: unknown; bubbleRings?: unknown; bubbleNameColors?: unknown; bubbleDotColors?: unknown }): BubbleLook {
  return {
    faces: theme.bubbleFaces !== false,
    names: theme.bubbleNames === true,
    edges: theme.bubbleEdges === true,
    quietActions: theme.bubbleQuietActions === true,
    myName: theme.bubbleMyName === true,
    tailMine: theme.bubbleTailMine === 'bottom' ? 'bottom' : 'top',
    tailOurs: theme.bubbleTailOurs === 'bottom' ? 'bottom' : 'top',
    tailShape: theme.bubbleTailShape === 'swoop' ? 'swoop' : 'point',
    rings: theme.bubbleRings === 'theme' ? 'theme' : 'house',
    nameColors: theme.bubbleNameColors !== false,
    dotColors: theme.bubbleDotColors !== false,
  };
}

export interface BubbleCorners {
  borderTopLeftRadius: string;
  borderTopRightRadius: string;
  borderBottomLeftRadius: string;
  borderBottomRightRadius: string;
}

/** A drawn bubble's four corners as four separate values: the pointed one at
 *  0 and the rest at the shape slider's radius. Always all four. An inline
 *  style that mixes the border-radius shorthand with one corner breaks the
 *  moment the pointed corner moves: React clears the old corner, which wipes
 *  it to 0 instead of handing it back to the shorthand (switching to Bottom
 *  left the top corner pointed too, in the preview only, because the chat
 *  draws its corners with classes). */
export function bubbleCorners(side: 'mine' | 'ours', tail: Tail): BubbleCorners {
  const round = 'var(--shape-bubble)';
  const pointed = side === 'mine' ? (tail === 'bottom' ? 'br' : 'tr') : (tail === 'bottom' ? 'bl' : 'tl');
  return {
    borderTopLeftRadius: pointed === 'tl' ? '0' : round,
    borderTopRightRadius: pointed === 'tr' ? '0' : round,
    borderBottomLeftRadius: pointed === 'bl' ? '0' : round,
    borderBottomRightRadius: pointed === 'br' ? '0' : round,
  };
}

function rgbOf(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** How well one color reads on another, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const x = rgbOf(a), y = rgbOf(b);
  if (!x || !y) return 21;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

function toHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// OKLCH, so lifting a color moves its lightness the way an eye sees it and
// keeps its hue: a navy rises to a readable blue rather than going gray.
function srgbToLinear(v: number): number { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }
function linearToSrgb(v: number): number { const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; return s * 255; }

function toOklch([r, g, b]: [number, number, number]): [number, number, number] {
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

/** Linear sRGB for an OKLCH color, possibly outside 0..1 (out of gamut). */
function oklchToLinear(L: number, C: number, h: number): [number, number, number] {
  const A = C * Math.cos(h), B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** An OKLCH color as sRGB, shedding chroma (never hue or lightness) until it fits. */
function fromOklch(L: number, C: number, h: number): [number, number, number] {
  const inGamut = (c: number) => oklchToLinear(L, c, h).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let c = C;
  if (!inGamut(c)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (inGamut(mid)) lo = mid; else hi = mid; }
    c = lo;
  }
  return oklchToLinear(L, c, h).map((v) => Math.max(0, Math.min(255, linearToSrgb(Math.max(0, Math.min(1, v)))))) as [number, number, number];
}

/** A companion's color as lettering over everything it may sit on. It starts
 *  from their own color; if that does not read at
 *  4.5 to 1 on every backdrop given, its OKLCH lightness is raised at night
 *  (lowered by day) until it does, hue kept. A color that already reads comes
 *  back exactly as it was. Backdrops it cannot parse are skipped, and with none
 *  left it measures against black at night and white by day. */
export function inkOn(slug: string, color: string | null, mode: 'light' | 'dark', backdrops: string[]): string {
  const start = rgbOf(color || '') ? color! : '#888888';
  const under = backdrops.filter((b) => rgbOf(b));
  if (under.length === 0) under.push(mode === 'dark' ? '#000000' : '#ffffff');
  const reads = (hex: string) => under.every((b) => contrastRatio(hex, b) >= 4.5);
  if (reads(start)) return start;
  const [L0, C, h] = toOklch(rgbOf(start)!);
  for (let step = 1; step <= 100; step++) {
    const L = mode === 'dark' ? L0 + (1 - L0) * step / 100 : L0 * (1 - step / 100);
    const hex = toHex(fromOklch(L, C, h));
    if (reads(hex)) return hex;
  }
  return mode === 'dark' ? '#ffffff' : '#000000';
}

/** A companion's name color on this page (see inkOn). */
export function nameColor(slug: string, color: string | null, mode: 'light' | 'dark', page: string): string {
  return inkOn(slug, color, mode, [page]);
}

/** Three colors from one accent, for themes that only have one: the accent
 *  itself and its neighbors either side on the color wheel, in OKLCH so all
 *  three sit at the same lightness (the Theme dots). */
export function accentTriad(accent: string): string[] {
  const rgb = rgbOf(accent);
  if (!rgb) return [accent, accent, accent];
  const [L, C, h] = toOklch(rgb);
  return [toHex(fromOklch(L, C, h - 28)), accent, toHex(fromOklch(L, C, h + 28))];
}
