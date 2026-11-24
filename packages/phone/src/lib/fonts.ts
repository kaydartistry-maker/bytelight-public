// Her Type card (Slice 4): real fonts, chosen by role, with guard rails so a
// display font can't end up on whole paragraphs.
//
// Roles: title (headings, names, card titles), text (everything you read),
// and three optional overrides that follow text unless she sets them: her
// messages, our messages, code. Pure: tested in fonts.test.ts.

import { fontStack, monoStack, TYPOGRAPHY_PRESETS } from './theme';

export type FontRole = 'title' | 'text';

export interface TypeSettings {
  title?: string | null;
  text?: string | null;
  userMsg?: string | null;
  compMsg?: string | null;
  code?: string | null;
}

export interface UserFont {
  id: string;
  family: string;      // the name CSS uses
  role: FontRole;      // she tags it on upload; the Text list only offers 'text'
  data: string;        // the font file, as a data URL
  fileName?: string;
}

/** Fonts that genuinely ship with the app (public/fonts + @font-face in index.css). */
export const BUILTIN_FONTS: { family: string; roles: ('title' | 'text' | 'code')[] }[] = [
  { family: 'Geist', roles: ['text'] },
  { family: 'Inter', roles: ['text'] },
  { family: 'Space Grotesk', roles: ['title', 'text'] },
  { family: 'Fraunces', roles: ['title', 'text'] },
  { family: 'JetBrains Mono', roles: ['code', 'text'] },
];

/** One-tap pairings built only from real fonts, each visibly different. */
export const TYPE_PAIRINGS: { name: string; title: string; text: string }[] = [
  { name: 'Clean', title: 'Space Grotesk', text: 'Geist' },
  { name: 'Soft Occult', title: 'Fraunces', text: 'Inter' },
  { name: 'Studio', title: 'Space Grotesk', text: 'Inter' },
  { name: 'Storybook', title: 'Fraunces', text: 'Fraunces' },
  { name: 'Terminal', title: 'JetBrains Mono', text: 'JetBrains Mono' },
];

export const DEFAULT_TEXT = 'Geist';

export function titleChoices(user: UserFont[]): string[] {
  return [...BUILTIN_FONTS.filter((f) => f.roles.includes('title')).map((f) => f.family), ...user.filter((f) => f.role === 'title').map((f) => f.family)];
}

export function textChoices(user: UserFont[]): string[] {
  return [...BUILTIN_FONTS.filter((f) => f.roles.includes('text')).map((f) => f.family), ...user.filter((f) => f.role === 'text').map((f) => f.family)];
}

export function codeChoices(user: UserFont[]): string[] {
  return ['JetBrains Mono', ...user.map((f) => f.family)];
}

/**
 * What's in effect. Her Type card wins. Before she has touched it, the old
 * controls are honoured so nothing changes on update: an old Typography
 * preset maps across as-is, and the old System Font Serif/Mono map to a real
 * serif (Fraunces, since the 'Playfair' it asked for was never loaded) and to
 * JetBrains Mono.
 */
export function effectiveType(type: TypeSettings | undefined, legacyPreset?: string | null, legacySystemFont?: string | null): TypeSettings {
  if (type) return type;
  const preset = TYPOGRAPHY_PRESETS.find((p) => p.name === legacyPreset);
  if (preset) return { title: preset.heading, text: preset.body, code: preset.mono };
  if (legacySystemFont === 'font-serif') return { text: 'Fraunces' };
  if (legacySystemFont === 'font-mono') return { text: 'JetBrains Mono' };
  return {};
}

/** The CSS variables for the effective type. Missing roles are removed (null). */
export function typeVars(t: TypeSettings): Record<string, string | null> {
  const stack = (f?: string | null) => (f ? fontStack(f) : null);
  return {
    '--font-heading': stack(t.title),
    '--font-body': stack(t.text),
    '--font-msg-user': stack(t.userMsg),
    '--font-msg-comp': stack(t.compMsg),
    '--font-mono-choice': t.code ? monoStack(t.code) : null,
  };
}

/** A clean family name from a file name, never clashing with one already taken. */
export function familyFromFile(fileName: string, taken: string[]): string {
  const base = fileName
    .replace(/\.(ttf|otf|woff2?|)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/["'\\]/g, '')
    .trim() || 'My Font';
  let name = base;
  let n = 2;
  const lower = taken.map((t) => t.toLowerCase());
  while (lower.includes(name.toLowerCase())) name = `${base} ${n++}`;
  return name;
}

export function isFontFile(fileName: string): boolean {
  return /\.(ttf|otf|woff2?)$/i.test(fileName);
}
