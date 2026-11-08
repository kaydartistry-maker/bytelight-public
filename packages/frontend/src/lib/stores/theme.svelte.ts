// Theme store — manages mode, accent, and full UI customization

export type ThemeMode = 'dark' | 'light';

// Visual skin — the "vibe", independent of light/dark lighting.
// 'classic' is the default look (no data-skin attribute, :root tokens only).
export type ThemeSkin = 'classic' | 'cosmos' | 'ember' | 'rose' | 'petal';

// ember/rose/petal are parked legacy experiments — kept in the type/CSS so
// any saved value still resolves, but not offered in the picker for now.
export const THEME_SKINS: { id: ThemeSkin; label: string }[] = [
  { id: 'classic', label: 'Classic' },
  { id: 'cosmos', label: 'Cosmos' },
];

export interface AccentPalette {
  name: string;
  dark: { main: string; bright: string; dim: string };
  light: { main: string; bright: string; dim: string };
}

export interface CustomTheme {
  // Colors
  accentColor: string | null;        // null = use palette
  bgPrimary: string | null;
  bgSecondary: string | null;
  bgSurface: string | null;
  textColor: string | null;          // null = theme default text colors
  userBubble: string | null;
  companionBubble: string | null;
  // Typography
  fontHeading: string;
  fontBody: string;
  fontMono: string;
  fontSize: number;                  // 0.85 - 1.15 scale
  lineHeight: number;                // 1.3 - 1.9
  letterSpacing: number;             // -0.02 - 0.06 em
  // Layout
  borderRadius: number;              // 0 - 1.5 rem scale
  // Effects — multipliers into the Cosmos skin + transitions; 1 = current look
  auraIntensity: number;             // 0 - 1.5
  glowIntensity: number;             // 0 - 1.5
  motionIntensity: number;           // 0 - 1.5
}

const DEFAULT_CUSTOM: CustomTheme = {
  accentColor: null,
  bgPrimary: null,
  bgSecondary: null,
  bgSurface: null,
  textColor: null,
  userBubble: null,
  companionBubble: null,
  fontHeading: 'Inter',
  fontBody: 'Inter',
  fontMono: 'JetBrains Mono',
  fontSize: 1,
  lineHeight: 1.6,
  letterSpacing: 0,
  borderRadius: 0.75,
  auraIntensity: 1,
  glowIntensity: 1,
  motionIntensity: 1,
};

// Only fonts actually loaded in app.html — keeps the picker honest so a
// selection always renders. 'System UI' resolves to the platform default.
export const FONT_OPTIONS = {
  heading: ['Inter', 'Fraunces', 'Space Grotesk', 'System UI'],
  body: ['Inter', 'Fraunces', 'Space Grotesk', 'System UI'],
  mono: ['JetBrains Mono', 'System UI'],
};

// One-tap font moods, built from the loaded families.
export const TYPOGRAPHY_PRESETS: { name: string; heading: string; body: string; mono: string }[] = [
  { name: 'Cosmic Clean', heading: 'Space Grotesk', body: 'Inter', mono: 'JetBrains Mono' },
  { name: 'Celestial Serif', heading: 'Fraunces', body: 'Inter', mono: 'JetBrains Mono' },
  { name: 'Soft Occult', heading: 'Fraunces', body: 'Fraunces', mono: 'JetBrains Mono' },
  { name: 'Ritual Terminal', heading: 'Space Grotesk', body: 'JetBrains Mono', mono: 'JetBrains Mono' },
  { name: 'System', heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
];

export const ACCENT_PALETTES: AccentPalette[] = [
  { name: 'Crimson',  dark: { main: '#e05252', bright: '#ef6b6b', dim: '#c24444' }, light: { main: '#c24444', bright: '#a83a3a', dim: '#e05252' } },
  { name: 'Burgundy', dark: { main: '#a8416a', bright: '#c25580', dim: '#8e3659' }, light: { main: '#8e3659', bright: '#752d4a', dim: '#a8416a' } },
  { name: 'Rose',     dark: { main: '#e8829a', bright: '#f09db1', dim: '#d06b84' }, light: { main: '#c25b75', bright: '#a84d65', dim: '#d06b84' } },
  { name: 'Orange',   dark: { main: '#e07840', bright: '#ef9060', dim: '#c26835' }, light: { main: '#c26835', bright: '#a8582d', dim: '#e07840' } },
  { name: 'Amber',    dark: { main: '#d4a030', bright: '#e4b548', dim: '#b88a28' }, light: { main: '#b88a28', bright: '#9e7622', dim: '#d4a030' } },
  { name: 'Forest',   dark: { main: '#4a8c5c', bright: '#5ea872', dim: '#3d7a4e' }, light: { main: '#3d7a4e', bright: '#336842', dim: '#4a8c5c' } },
  { name: 'Emerald',  dark: { main: '#3daa7a', bright: '#50c490', dim: '#329068' }, light: { main: '#329068', bright: '#2a7a58', dim: '#3daa7a' } },
  { name: 'Mint',     dark: { main: '#44b8a0', bright: '#5cd0b6', dim: '#389e88' }, light: { main: '#389e88', bright: '#2e8674', dim: '#44b8a0' } },
  { name: 'Teal',     dark: { main: '#5eaba5', bright: '#7cc5c0', dim: '#4a908b' }, light: { main: '#3d8b86', bright: '#327570', dim: '#5eaba5' } },
  { name: 'Ocean',    dark: { main: '#4090b0', bright: '#52a8cc', dim: '#357a98' }, light: { main: '#357a98', bright: '#2c6680', dim: '#4090b0' } },
  { name: 'Sapphire', dark: { main: '#5080c0', bright: '#6898d8', dim: '#426ca8' }, light: { main: '#426ca8', bright: '#385c90', dim: '#5080c0' } },
  { name: 'Lavender', dark: { main: '#9a8cc8', bright: '#b0a0dc', dim: '#8478b0' }, light: { main: '#7a6cb0', bright: '#685c98', dim: '#9a8cc8' } },
  { name: 'Amethyst', dark: { main: '#8866bb', bright: '#9e7ed3', dim: '#7456a5' }, light: { main: '#7456a5', bright: '#634890', dim: '#8866bb' } },
  { name: 'Plum',     dark: { main: '#9060a0', bright: '#a878b8', dim: '#7c5090' }, light: { main: '#7c5090', bright: '#6a4480', dim: '#9060a0' } },
  { name: 'Magenta',  dark: { main: '#c85ca0', bright: '#dc74b4', dim: '#b04c8c' }, light: { main: '#a84888', bright: '#903c74', dim: '#c85ca0' } },
  { name: 'Blush',    dark: { main: '#dca0b0', bright: '#eab4c2', dim: '#c88e9e' }, light: { main: '#b88090', bright: '#a06e7e', dim: '#c88e9e' } },
];

// Reactive state
let mode = $state<ThemeMode>('dark');
let skin = $state<ThemeSkin>('classic');
let accentName = $state<string>('Teal');
let custom = $state<CustomTheme>({ ...DEFAULT_CUSTOM });

const VALID_SKINS: ThemeSkin[] = ['classic', 'cosmos', 'ember', 'rose', 'petal'];

// Initialize from localStorage on module load
if (typeof window !== 'undefined') {
  const savedMode = localStorage.getItem('bytelight-theme') as ThemeMode | null;
  const savedSkin = localStorage.getItem('bytelight-skin') as ThemeSkin | null;
  const savedAccent = localStorage.getItem('bytelight-accent');
  const savedCustom = localStorage.getItem('bytelight-custom-theme');
  if (savedMode === 'light' || savedMode === 'dark') mode = savedMode;
  if (savedSkin && VALID_SKINS.includes(savedSkin)) skin = savedSkin;
  if (savedAccent) accentName = savedAccent;
  if (savedCustom) {
    try {
      custom = { ...DEFAULT_CUSTOM, ...JSON.parse(savedCustom) };
    } catch {}
  }
}

function findPalette(name: string): AccentPalette {
  return ACCENT_PALETTES.find(p => p.name === name) || ACCENT_PALETTES[8]; // default Teal
}

function applyTheme() {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  const palette = findPalette(accentName);
  const paletteColors = mode === 'dark' ? palette.dark : palette.light;

  // Lighting (mode) and vibe (skin) are separate knobs.
  html.setAttribute('data-theme', mode === 'dark' ? 'dark' : 'light');
  if (skin === 'classic') html.removeAttribute('data-skin');
  else html.setAttribute('data-skin', skin);

  // Apply accent — custom color or palette
  const accent = custom.accentColor || paletteColors.main;
  const accentBright = custom.accentColor ? lightenColor(custom.accentColor, 15) : paletteColors.bright;
  const accentDim = custom.accentColor ? darkenColor(custom.accentColor, 15) : paletteColors.dim;

  html.style.setProperty('--gold', accent);
  html.style.setProperty('--gold-bright', accentBright);
  html.style.setProperty('--gold-dim', accentDim);
  html.style.setProperty('--gold-glow', hexToRgba(accent, 0.1));
  html.style.setProperty('--gold-ember', hexToRgba(accent, 0.06));
  html.style.setProperty('--shadow-gold', hexToRgba(accent, 0.04));

  // Apply custom backgrounds
  if (custom.bgPrimary) html.style.setProperty('--bg-primary', custom.bgPrimary);
  else html.style.removeProperty('--bg-primary');
  if (custom.bgSecondary) html.style.setProperty('--bg-secondary', custom.bgSecondary);
  else html.style.removeProperty('--bg-secondary');
  if (custom.bgSurface) html.style.setProperty('--bg-surface', custom.bgSurface);
  else html.style.removeProperty('--bg-surface');

  // Apply custom text color — one pick sets the main text and derives the
  // softer secondary/muted shades from it so the hierarchy stays readable.
  if (custom.textColor) {
    html.style.setProperty('--text-primary', custom.textColor);
    html.style.setProperty('--text-secondary', hexToRgba(custom.textColor, 0.78));
    html.style.setProperty('--text-muted', hexToRgba(custom.textColor, 0.6));
  } else {
    html.style.removeProperty('--text-primary');
    html.style.removeProperty('--text-secondary');
    html.style.removeProperty('--text-muted');
  }

  // Apply custom message bubbles
  if (custom.userBubble) html.style.setProperty('--user-bg', custom.userBubble);
  else html.style.removeProperty('--user-bg');
  if (custom.companionBubble) html.style.setProperty('--companion-bg', custom.companionBubble);
  else html.style.removeProperty('--companion-bg');

  // Apply typography
  const fontStack = (font: string) => `'${font}', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;
  const monoStack = (font: string) => `'${font}', ui-monospace, monospace`;
  html.style.setProperty('--font-heading', fontStack(custom.fontHeading));
  html.style.setProperty('--font-body', fontStack(custom.fontBody));
  html.style.setProperty('--font-mono', monoStack(custom.fontMono));

  // Apply font size scale via a variable the content inherits (same proven
  // path as --font-body). The old root html.style.fontSize override didn't
  // reach the chat message text; --font-scale on body does.
  html.style.setProperty('--font-scale', String(custom.fontSize));

  // Apply reading rhythm
  html.style.setProperty('--msg-line-height', String(custom.lineHeight));
  html.style.setProperty('--letter-spacing', `${custom.letterSpacing}em`);

  // Apply border radius
  html.style.setProperty('--radius', `${custom.borderRadius}rem`);
  html.style.setProperty('--radius-sm', `${custom.borderRadius * 0.5}rem`);
  html.style.setProperty('--radius-lg', `${custom.borderRadius * 2}rem`);

  // Apply effect intensities — multipliers the Cosmos skin + transitions read.
  // 1 = today's look; sliders scale from there.
  html.style.setProperty('--fx-aura', String(custom.auraIntensity));
  html.style.setProperty('--fx-glow', String(custom.glowIntensity));
  html.style.setProperty('--fx-motion', String(custom.motionIntensity));
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightenColor(hex: string, percent: number): string {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + Math.round(255 * percent / 100));
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + Math.round(255 * percent / 100));
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + Math.round(255 * percent / 100));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function darkenColor(hex: string, percent: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - Math.round(255 * percent / 100));
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - Math.round(255 * percent / 100));
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - Math.round(255 * percent / 100));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function saveCustom() {
  localStorage.setItem('bytelight-custom-theme', JSON.stringify(custom));
}

export function setMode(newMode: ThemeMode) {
  mode = newMode;
  localStorage.setItem('bytelight-theme', mode);
  applyTheme();
}

export function setAccent(name: string) {
  accentName = name;
  localStorage.setItem('bytelight-accent', name);
  applyTheme();
}

export function setSkin(newSkin: ThemeSkin) {
  skin = newSkin;
  localStorage.setItem('bytelight-skin', skin);
  applyTheme();
}

export function initTheme() {
  applyTheme();
}

export function getMode(): ThemeMode { return mode; }
export function getSkin(): ThemeSkin { return skin; }
export function getAccentName(): string { return accentName; }
export function getCustom(): CustomTheme { return custom; }

// Custom theme setters
export function setCustomAccent(color: string | null) {
  custom.accentColor = color;
  saveCustom();
  applyTheme();
}

export function setCustomBackground(key: 'bgPrimary' | 'bgSecondary' | 'bgSurface', color: string | null) {
  custom[key] = color;
  saveCustom();
  applyTheme();
}

export function setCustomTextColor(color: string | null) {
  custom.textColor = color;
  saveCustom();
  applyTheme();
}

export function setCustomBubble(key: 'userBubble' | 'companionBubble', color: string | null) {
  custom[key] = color;
  saveCustom();
  applyTheme();
}

export function setCustomFont(key: 'fontHeading' | 'fontBody' | 'fontMono', font: string) {
  custom[key] = font;
  saveCustom();
  applyTheme();
}

export function setFontPreset(p: { heading: string; body: string; mono: string }) {
  custom.fontHeading = p.heading;
  custom.fontBody = p.body;
  custom.fontMono = p.mono;
  saveCustom();
  applyTheme();
}

export function setFontSize(scale: number) {
  custom.fontSize = Math.max(0.85, Math.min(1.15, scale));
  saveCustom();
  applyTheme();
}

export function setLineHeight(value: number) {
  custom.lineHeight = Math.max(1.3, Math.min(1.9, value));
  saveCustom();
  applyTheme();
}

export function setLetterSpacing(value: number) {
  custom.letterSpacing = Math.max(-0.02, Math.min(0.06, value));
  saveCustom();
  applyTheme();
}

export function setBorderRadius(radius: number) {
  custom.borderRadius = Math.max(0, Math.min(1.5, radius));
  saveCustom();
  applyTheme();
}

export function setAuraIntensity(value: number) {
  custom.auraIntensity = Math.max(0, Math.min(1.5, value));
  saveCustom();
  applyTheme();
}

export function setGlowIntensity(value: number) {
  custom.glowIntensity = Math.max(0, Math.min(1.5, value));
  saveCustom();
  applyTheme();
}

export function setMotionIntensity(value: number) {
  custom.motionIntensity = Math.max(0, Math.min(1.5, value));
  saveCustom();
  applyTheme();
}

export function resetCustomTheme() {
  custom = { ...DEFAULT_CUSTOM };
  saveCustom();
  applyTheme();
}
