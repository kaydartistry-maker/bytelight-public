/** Portable appearance overrides. Omitted fields inherit the existing theme.
 * Opacity/scale/maxWidth are percentages; geometry is px, tracking is em.
 * Assets are opaque local IDs, never URLs, paths or executable CSS strings.
 */
export interface AppearanceOverlay {
  assetId?: string;
  opacity?: number;
  scale?: number;
  repeat?: 'none' | 'repeat' | 'repeat-x' | 'repeat-y';
  blend?: 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'hard-light';
}
export interface AppearanceText {
  font?: string;
  assetId?: string;
  size?: number;
  weight?: number;
  lineHeight?: number;
  tracking?: number;
  color?: string;
  opacity?: number;
}
export interface AppearanceSurface {
  fill?: { color?: string; opacity?: number };
  overlay?: AppearanceOverlay;
  border?: {
    color?: string; width?: number; style?: 'solid' | 'dashed' | 'dotted' | 'double' | 'none';
    opacity?: number; radius?: number; overlay?: AppearanceOverlay;
  };
  shadow?: { color?: string; opacity?: number; blur?: number; x?: number; y?: number; inset?: boolean };
  gradient?: { from?: string; to?: string; angle?: number; opacity?: number };
  text?: AppearanceText;
  layout?: {
    padding?: number; gap?: number; maxWidth?: number;
    alignment?: 'left' | 'center' | 'right'; tail?: 'none' | 'left' | 'right';
  };
  avatar?: {
    size?: number; shape?: 'circle' | 'rounded' | 'square';
    ringColor?: string; ringWidth?: number; showName?: boolean; showTimestamp?: boolean;
  };
  /** Cards only. Bubble compositor blur is intentionally unsupported on iOS. */
  blur?: number;
}
export type AppearanceBubble = Omit<AppearanceSurface, 'blur'>;
export type AppearanceControlState = 'hover' | 'pressed' | 'selected' | 'disabled';
export type AppearanceControlStates = Partial<Record<AppearanceControlState, AppearanceSurface>>;
export interface AppearanceWallpaper {
  assetId?: string;
  opacity?: number;
  blur?: number;
  dim?: number;
  zoom?: number;
  positionX?: number;
  positionY?: number;
  fit?: 'cover' | 'contain' | 'stretch';
  repeat?: AppearanceOverlay['repeat'];
  blend?: AppearanceOverlay['blend'];
  slideshowInterval?: number;
  transitionDuration?: number;
  colorWash?: { color?: string; opacity?: number };
}
export interface ThemeAppearance {
  version: 1;
  cards?: AppearanceSurface;
  sectionOverrides?: Record<string, AppearanceSurface>;
  chat?: { defaults?: AppearanceBubble; user?: AppearanceBubble; companions?: Record<string, AppearanceBubble> };
  typography?: { heading?: AppearanceText; body?: AppearanceText; mono?: AppearanceText };
  wallpaper?: AppearanceWallpaper;
  controls?: {
    buttons?: AppearanceSurface;
    tabs?: AppearanceSurface;
    buttonStates?: AppearanceControlStates;
    tabStates?: AppearanceControlStates;
    icons?: { size?: number; color?: string; opacity?: number; strokeWidth?: number };
  };
  motion?: {
    enabled?: boolean; scale?: number; duration?: number; reduceMotion?: boolean;
    hover?: boolean; press?: boolean; entrance?: boolean; wallpaper?: boolean;
  };
  details?: {
    dividerColor?: string; dividerWidth?: number; scrollbarColor?: string; scrollbarWidth?: number;
    focusColor?: string; focusWidth?: number; unreadColor?: string; loadingColor?: string; selectionColor?: string;
  };
}

type RecordValue = Record<string, unknown>;
type Reader = (input: unknown) => unknown;
type Schema = Record<string, Reader>;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function record(value: unknown): RecordValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as RecordValue : undefined;
}
function own(source: RecordValue, key: string): unknown {
  // Do not invoke accessors when called directly with non-JSON input.
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
const number = (min: number, max: number): Reader => input =>
  typeof input === 'number' && Number.isFinite(input) ? Math.min(max, Math.max(min, input)) : undefined;
const boolean: Reader = input => typeof input === 'boolean' ? input : undefined;
const choices = (...values: string[]): Reader => input =>
  typeof input === 'string' && values.includes(input) ? input : undefined;
const color: Reader = input => typeof input === 'string' &&
  (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(input) || input === 'transparent' || input === 'currentColor')
  ? input : undefined;
const identifier: Reader = input => typeof input === 'string' &&
  /^[a-z\d][a-z\d_-]{0,127}$/i.test(input) && !forbidden.has(input) ? input : undefined;
const font: Reader = input => typeof input === 'string' &&
  /^[a-z\d][a-z\d _-]{0,79}$/i.test(input) ? input : undefined;
function object(schema: Schema): Reader {
  return input => {
    const source = record(input);
    if (!source) return undefined;
    const result: RecordValue = {};
    for (const [key, read] of Object.entries(schema)) {
      const value = read(own(source, key));
      if (value !== undefined) result[key] = value;
    }
    return Object.keys(result).length ? result : undefined;
  };
}
function dictionary(read: Reader): Reader {
  return input => {
    const source = record(input);
    if (!source) return undefined;
    const result: RecordValue = {};
    for (const key of Object.keys(source).slice(0, 100)) {
      if (identifier(key) === undefined) continue;
      const value = read(own(source, key));
      if (value !== undefined) result[key] = value;
    }
    return Object.keys(result).length ? result : undefined;
  };
}
const opacity = number(0, 100);
const repeat = choices('none', 'repeat', 'repeat-x', 'repeat-y');
const blend = choices('normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light');
const overlay = object({ assetId: identifier, opacity, scale: number(10, 400), repeat, blend });
const text = object({ font, assetId: identifier, size: number(8, 96), weight: number(100, 900),
  lineHeight: number(0.8, 3), tracking: number(-0.1, 0.5), color, opacity });
const surfaceSchema: Schema = {
  fill: object({ color, opacity }),
  overlay,
  border: object({ color, width: number(0, 16), style: choices('solid', 'dashed', 'dotted', 'double', 'none'),
    opacity, radius: number(0, 80), overlay }),
  shadow: object({ color, opacity, blur: number(0, 100), x: number(-100, 100), y: number(-100, 100), inset: boolean }),
  gradient: object({ from: color, to: color, angle: number(0, 360), opacity }),
  text,
  layout: object({ padding: number(0, 64), gap: number(0, 48), maxWidth: number(20, 100),
    alignment: choices('left', 'center', 'right'), tail: choices('none', 'left', 'right') }),
  avatar: object({ size: number(16, 96), shape: choices('circle', 'rounded', 'square'),
    ringColor: color, ringWidth: number(0, 12), showName: boolean, showTimestamp: boolean }),
};
const bubble = object(surfaceSchema);
const surface = object({ ...surfaceSchema, blur: number(0, 40) });
const controlStates = object({ hover: surface, pressed: surface, selected: surface, disabled: surface });
const appearance = object({
  cards: surface,
  sectionOverrides: dictionary(surface),
  chat: object({ defaults: bubble, user: bubble, companions: dictionary(bubble) }),
  typography: object({ heading: text, body: text, mono: text }),
  wallpaper: object({ assetId: identifier, opacity, blur: number(0, 40), dim: opacity,
    zoom: number(10, 400), positionX: opacity, positionY: opacity,
    fit: choices('cover', 'contain', 'stretch'), repeat, blend,
    slideshowInterval: number(1, 3600), transitionDuration: number(0, 10),
    colorWash: object({ color, opacity }) }),
  controls: object({ buttons: surface, tabs: surface, buttonStates: controlStates, tabStates: controlStates,
    icons: object({ size: number(8, 64), color, opacity, strokeWidth: number(0.5, 6) }) }),
  motion: object({ enabled: boolean, scale: number(0, 200), duration: number(0, 3000),
    reduceMotion: boolean, hover: boolean, press: boolean, entrance: boolean, wallpaper: boolean }),
  details: object({ dividerColor: color, dividerWidth: number(0, 8), scrollbarColor: color,
    scrollbarWidth: number(0, 24), focusColor: color, focusWidth: number(0, 8),
    unreadColor: color, loadingColor: color, selectionColor: color }),
});

/** Allowlisted, bounded, detached data suitable for load/import boundaries.
 * Unsupported versions return an inherited/default appearance, not guessed data.
 */
export function normalizeThemeAppearance(input: unknown): ThemeAppearance {
  const source = record(input);
  const version = source ? own(source, 'version') : undefined;
  if (version !== undefined && version !== 1) return { version: 1 };
  return { version: 1, ...(appearance(input) as Omit<ThemeAppearance, 'version'> | undefined) };
}

function merge<T extends object>(base: T | undefined, override: T | undefined): T {
  const result = { ...base } as RecordValue;
  for (const [key, value] of Object.entries(override ?? {})) {
    const left = record(result[key]);
    const right = record(value);
    result[key] = right ? merge(left, right) : value;
  }
  // Clone inherited nested data too: consumers must not mutate saved preferences.
  for (const [key, value] of Object.entries(result)) {
    if (record(value)) result[key] = merge(undefined, value as RecordValue);
  }
  return result as T;
}

export function resolveCardAppearance(settings: ThemeAppearance | unknown, section?: string): AppearanceSurface {
  const normalized = normalizeThemeAppearance(settings);
  const override = section && identifier(section) !== undefined ? normalized.sectionOverrides?.[section] : undefined;
  return merge(normalized.cards, override);
}

/** Deliberately never reads cards, section overrides or card backdrop blur. */
export function resolveBubbleAppearance(settings: ThemeAppearance | unknown, speaker: 'user' | string): AppearanceBubble {
  const { chat } = normalizeThemeAppearance(settings);
  const override = speaker === 'user' ? chat?.user
    : identifier(speaker) !== undefined ? chat?.companions?.[speaker] : undefined;
  return merge(chat?.defaults, override);
}

/** States inherit only their own control kind's base, never cards or chat. */
export function resolveControlAppearance(settings: unknown, kind: 'buttons' | 'tabs', state?: AppearanceControlState): AppearanceSurface {
  const { controls } = normalizeThemeAppearance(settings);
  const states = kind === 'buttons' ? controls?.buttonStates : controls?.tabStates;
  return merge(controls?.[kind], state ? states?.[state] : undefined);
}

/** Stable unique asset IDs, including every override/preset surface represented here. */
export function collectThemeAssetIds(settings: ThemeAppearance | unknown): string[] {
  const ids = new Set<string>();
  function visit(value: unknown): void {
    const source = record(value);
    if (!source) return;
    for (const [key, child] of Object.entries(source)) {
      if (key === 'assetId' && typeof child === 'string') ids.add(child);
      else visit(child);
    }
  }
  visit(normalizeThemeAppearance(settings));
  return [...ids].sort();
}
