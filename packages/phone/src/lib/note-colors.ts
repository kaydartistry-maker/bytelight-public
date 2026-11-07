// Note colours, derived from whatever theme is on.
//
// The old set was five fixed hex values and one font colour for the whole app.
// That failed twice over: pale notes got near-white text and the writing melted
// into them, and any two themes whose accents sat near each other on the wheel
// produced the same palette — Orange and Mocha are nine degrees apart in hue and
// came out twins, because the recipe kept the hue and threw away the fact that
// one is vivid and the other is muted.
//
// Two things fix it.
//
// ONE: work in OKLCH rather than HSL. HSL's lightness is arithmetic, not
// perception — a yellow and a blue at the same HSL lightness are nowhere near
// the same brightness, which is exactly why one "darker on midnight" number
// turned orange to mud while navy was fine. In OKLCH equal numbers look equal,
// so a single lightness target holds across every hue.
//
// TWO: give each note a ROLE instead of fanning the hue evenly. An even fan is
// the cheapest possible harmony and it looks it.

export type NoteMode = 'light' | 'dark';

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function parseHex(hex: string): [number, number, number] | null {
  const h = hex.trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function toHex(r: number, g: number, b: number): string {
  const ch = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

export function hexToOklch(hex: string): { l: number; c: number; h: number } | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(srgbToLinear);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  return { l: L, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinear(L: number, C: number, H: number): [number, number, number] {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function oklchToHex(L: number, C: number, H: number): string {
  const [r, g, b] = oklchToLinear(L, C, H).map(linearToSrgb);
  return toHex(r, g, b);
}

/** Largest chroma at this lightness and hue that sRGB can actually show. Asking
 *  for more just clips, and clipping is what makes a generated set look dirty. */
function fitChroma(L: number, C: number, H: number): number {
  const fits = (c: number) => oklchToLinear(L, c, H).every(v => v >= -0.0005 && v <= 1.0005);
  if (fits(C)) return C;
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const NOTE_INK_DARK = '#17171B';
export const NOTE_INK_LIGHT = '#F7F7F5';

/** Lay a translucent colour over what is behind it and return what actually
 *  lands. The notes are drawn see-through by design, so the ink has to be
 *  chosen against THIS rather than against the colour on paper — otherwise a
 *  note that computes as light arrives dark and takes the wrong writing. */
export function blendOver(fg: string, bg: string, alpha: number): string {
  const f = parseHex(fg);
  const b = parseHex(bg);
  if (!f || !b) return fg;
  return toHex(...(f.map((v, i) => v * alpha + b[i] * (1 - alpha)) as [number, number, number]));
}

/** Dark writing on a light note, light writing on a dark one. One font colour
 *  for every note is what made the pale ones melt. */
export function inkFor(background: string): string {
  return contrastRatio(background, NOTE_INK_DARK) >= contrastRatio(background, NOTE_INK_LIGHT)
    ? NOTE_INK_DARK
    : NOTE_INK_LIGHT;
}

// The role NAMES are canonical in @bytelight/shared, because the agent-facing note
// route has to validate the same set. The tuning below is this file's business.
import {
  NOTE_ROLES as SHARED_NOTE_ROLES,
  isNoteRole,
  noteRoleToken,
  roleFromToken,
  type NoteRole,
} from '@bytelight/shared';
export type { NoteRole };
export { SHARED_NOTE_ROLES as NOTE_ROLES, isNoteRole, noteRoleToken, roleFromToken };

// hue offset, how much of the theme's own chroma it keeps, and its own nudge in
// lightness so the five are not one flat step.
const ROLES: { role: NoteRole; dh: number; kc: number; dl: number }[] = [
  { role: 'dominant', dh: 0, kc: 1.0, dl: 0 },
  { role: 'support', dh: 34, kc: 1.12, dl: 0.035 },
  { role: 'quiet', dh: -30, kc: 0.72, dl: -0.03 },
  { role: 'accent', dh: 168, kc: 0.62, dl: 0.015 },
  { role: 'paper', dh: 14, kc: 0.22, dl: 0.055 },
];

const BASE_L: Record<NoteMode, number> = { light: 0.9, dark: 0.62 };

/** The five note colours for a theme. The accent's own chroma carries through,
 *  so a muted theme gets muted notes and a vivid one gets vivid notes rather
 *  than every theme being handed the same five sticky-note colours. */
export function noteColorsForAccent(accentHex: string, mode: NoteMode): string[] {
  const base = hexToOklch(accentHex);
  if (!base) return [];
  const baseL = BASE_L[mode];
  const baseC = Math.min(0.16, Math.max(0.018, base.c * (mode === 'light' ? 0.55 : 0.72)));
  return ROLES.map(({ dh, kc, dl }) => {
    const L = Math.min(0.96, Math.max(0.3, baseL + dl));
    const H = (base.h + dh + 360) % 360;
    return oklchToHex(L, fitChroma(L, baseC * kc, H), H);
  });
}

/** The five roles, in the same order as noteColorsForAccent returns them. */
/** Exported for the drift test: the tuning table must cover every role in the
 *  canonical list, in the same order, or resolveNoteColor picks the wrong swatch. */
export const NOTE_ROLE_TUNING = ROLES.map(r => r.role);

// ── A note's colour is a JOB, not a hex ──────────────────────────────────────
//
// Notes used to store the literal colour they were written in, which meant a
// note kept that exact hex forever and a theme change slid out from under it —
// one was written in orange, switched themes, and it stayed orange in a room that
// no longer had any orange in it.
//
// So a note stores its ROLE instead ("role:quiet") and looks up the actual
// colour in whatever palette is on when she opens the app. Old notes still hold
// a hex; those are matched to the nearest swatch at render, so they follow the
// theme from now on too. Nothing is rewritten in the database to do it.
//
// Resolution works against a PALETTE rather than an accent on purpose: her
// Settings override replaces the derived five, and a note must follow the
// colours she is actually looking at.


/** Which swatch in a palette a loose hex is closest to, perceptually. Gives a
 *  note written before roles existed a job, so it re-tints like the rest. */
export function nearestSwatchIndex(hex: string, palette: string[]): number {
  const target = hexToOklch(hex);
  if (!target || !palette.length) return -1;
  let best = -1;
  let bestD = Infinity;
  palette.forEach((swatch, i) => {
    const s = hexToOklch(swatch);
    if (!s) return;
    // Hue is circular; lightness and chroma are not. Hue carries most of the
    // identity of a sticky note, so it is weighted heaviest. dh is 0 for the
    // same hue and 1 for the opposite one.
    const dh = Math.abs(((s.h - target.h + 540) % 360) - 180) / 180;
    const d = dh * 2 + Math.abs(s.l - target.l) + Math.abs(s.c - target.c) * 3;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/** The colour a stored note value should actually be painted, in this palette. */
export function resolveNoteColor(stored: string | null | undefined, palette: string[]): string | null {
  if (!stored || !palette.length) return null;
  const role = roleFromToken(stored);
  if (role) {
    const i = SHARED_NOTE_ROLES.indexOf(role);
    return i >= 0 && palette[i] ? palette[i] : null;
  }
  if (!stored.startsWith('#')) return null;
  const i = nearestSwatchIndex(stored, palette);
  return i >= 0 ? palette[i] : stored;
}
