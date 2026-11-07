// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0.
import type { AspectRatioValue, ThemeMode } from './types';

export const CODEX_MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', desc: 'Latest Workhorse' },
  // Needs Codex CLI >= 0.153.0; older clients are not even told it exists.
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', desc: 'Most Capable' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', desc: 'Workhorse' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', desc: 'Fast' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', desc: 'New Frontier' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', desc: 'New Strong' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', desc: 'New Fast' },
  { id: 'gpt-5.5', name: 'GPT-5.5', desc: 'Frontier' },
  { id: 'gpt-5.4', name: 'GPT-5.4', desc: 'Strong' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', desc: 'Faster' },
];

// Hand-typed, and it must match ANTIGRAVITY_MODELS in the backend's
// image-gen.ts — a model the backend does not recognise is silently ignored
// and the request quietly runs on the default instead. Refreshed Sep 5 2026;
// the 3.5 family was retired upstream and had been dead in here for months.
export const ANTIGRAVITY_MODELS = [
  { id: 'Gemini 3.8 Flash (High)', name: 'Flash 3.8 High', desc: 'Newest Flash' },
  { id: 'Gemini 3.8 Flash (Medium)', name: 'Flash 3.8 Med', desc: 'Balanced' },
  { id: 'Gemini 3.8 Flash (Low)', name: 'Flash 3.8 Low', desc: 'Fastest' },
  { id: 'Gemini 3.7 Flash (High)', name: 'Flash 3.7 High', desc: 'Previous Flash' },
  { id: 'Gemini 3.7 Flash (Medium)', name: 'Flash 3.7 Med', desc: 'Balanced' },
  { id: 'Gemini 3.7 Flash (Low)', name: 'Flash 3.7 Low', desc: 'Fastest' },
  { id: 'Gemini 3.6 Flash (High)', name: 'Flash 3.6 High', desc: 'Older Flash' },
  { id: 'Gemini 3.6 Flash (Medium)', name: 'Flash 3.6 Med', desc: 'Balanced' },
  { id: 'Gemini 3.6 Flash (Low)', name: 'Flash 3.6 Low', desc: 'Fastest' },
  { id: 'Gemini 3.1 Pro (High)', name: 'Pro 3.1 High', desc: 'Best Quality' },
  { id: 'Gemini 3.1 Pro (Low)', name: 'Pro 3.1 Low', desc: 'Pro Fast' },
];

/** The one that has actually taken a picture here. Also the recovery value for
 *  a phone still holding a retired model in localStorage. */
export const ANTIGRAVITY_DEFAULT_MODEL = 'Gemini 3.1 Pro (High)';

// OpenArt models — key is the picker value (kling-3-omni appears twice, once
// per media). Credit costs are list price at default config; MCP-originated
// generations get the account's 10% discount.
export const OPENART_MODELS: Array<{ key: string; id: string; media: 'image' | 'video'; name: string; desc: string }> = [
  // Images
  { key: 'nano-banana-2-lite', id: 'nano-banana-2-lite', media: 'image', name: 'Nano Banana 2 Lite', desc: 'Fast 1K · 15cr' },
  { key: 'nano-banana-2', id: 'nano-banana-2', media: 'image', name: 'Nano Banana 2', desc: '4K · 20cr' },
  { key: 'nano-banana-pro', id: 'nano-banana-pro', media: 'image', name: 'Nano Banana Pro', desc: 'Best 4K · 40cr' },
  { key: 'gpt-image-2', id: 'gpt-image-2', media: 'image', name: 'GPT Image 2', desc: 'Hyperreal · 40cr' },
  { key: 'seedream-4-5', id: 'byte-plus-seedream-4-5', media: 'image', name: 'Seedream 4.5', desc: 'Anime/2D · 15cr' },
  { key: 'seedream-5-lite', id: 'byte-plus-seedream-5-lite', media: 'image', name: 'Seedream 5 Lite', desc: 'Anime/2D · 15cr' },
  { key: 'kling-3-omni-image', id: 'kling-3-omni', media: 'image', name: 'Kling 3 Omni', desc: 'Cheapest · 10cr' },
  // Video (5s clips at default config)
  { key: 'pixverse-v6', id: 'pixverseV6', media: 'video', name: 'PixVerse V6', desc: 'Video · Budget 50cr' },
  { key: 'wan-2-7', id: 'wan2-7', media: 'video', name: 'Wan 2.7', desc: 'Video · Cinematic 125cr' },
  { key: 'kling-3-omni-video', id: 'kling-3-omni', media: 'video', name: 'Kling 3 Omni', desc: 'Video+Sound · 175cr' },
  { key: 'seedance-2-mini', id: 'byte-plus-seedance-2-mini', media: 'video', name: 'Seedance 2.0 Mini', desc: 'Video+Audio · 200cr' },
  { key: 'gemini-omni-flash', id: 'gemini-omni-flash', media: 'video', name: 'Gemini Omni Flash', desc: 'Video · 250cr' },
  { key: 'seedance-2-fast', id: 'byte-plus-seedance-2-fast', media: 'video', name: 'Seedance 2.0 Fast', desc: 'Video+Audio · 350cr' },
  { key: 'seedance-2', id: 'byte-plus-seedance-2', media: 'video', name: 'Seedance 2.0', desc: 'Best Video+Audio · 400cr' },
  { key: 'grok-imagine-1-5', id: 'grok-imagine-1-5', media: 'video', name: 'Grok Imagine 1.5', desc: 'Img→Video only · 405cr' },
];

export const PROMPT_STYLES = [
  { name: 'None', style: '' },
  // Basics
  { name: 'Photorealistic', style: 'photorealistic, high detail, 8k resolution, cinematic lighting, professional photography' },
  { name: 'Painterly', style: 'in a lush painterly style with visible brushstrokes and rich textures' },
  { name: 'Oil Painting', style: 'classic oil painting on canvas, dramatic chiaroscuro lighting' },
  { name: 'Watercolor', style: 'soft watercolor painting, bleeding colors, paper texture, delicate washes' },
  { name: 'Pencil Sketch', style: 'detailed pencil sketch on textured paper, fine graphite lines, hand-drawn look' },
  // Stylized
  { name: 'Studio Ghibli', style: 'in the whimsical and hand-drawn animation style of Studio Ghibli' },
  { name: 'Comic', style: 'in a bold comic book style with vibrant colors and strong ink lines' },
  { name: 'Pop Art', style: 'Andy Warhol style pop art, vibrant contrasting colors, halftone dots, screen print effect' },
  { name: 'Pixel Art', style: 'retro 8-bit pixel art, limited color palette, blocky aesthetic, video game nostalgia' },
  { name: 'Ukiyo-e', style: 'traditional Japanese woodblock print style, flat colors, bold outlines, Edo period aesthetic' },
  // Digital/3D
  { name: '3D Render', style: 'octane render, unreal engine 5, 3d digital art, ray tracing, volumetric lighting, hyper-detailed' },
  { name: 'Isometric', style: 'isometric 3D art, low poly, clean geometry, soft lighting, miniature world look' },
  { name: 'Claymation', style: 'stop-motion clay animation style, hand-sculpted textures, tactile feel' },
  // Aesthetic
  { name: 'Cyberpunk', style: 'cyberpunk aesthetic, neon lights, futuristic city, high tech low life, rainy night' },
  { name: 'Synthwave', style: 'synthwave aesthetic, retro-futurism, grid landscapes, sunset gradients, 80s synth vibes' },
  { name: 'Vaporwave', style: 'vaporwave aesthetic, pink and teal colors, 80s nostalgia, glitch art' },
  { name: 'Steampunk', style: 'steampunk aesthetic, brass gears, steam-powered machinery, Victorian era tech, sepia tones' },
  { name: 'Gothic', style: 'dark gothic aesthetic, ornate architecture, dramatic shadows, mysterious atmosphere' },
  // Design
  { name: 'Art Deco', style: '1920s art deco style, geometric patterns, gold accents, elegant symmetry, vintage poster look' },
  { name: 'Bauhaus', style: 'Bauhaus design movement style, primary colors, simple geometric forms, functional aesthetic' },
  { name: 'Minimalist', style: 'minimalist design, clean lines, simple shapes, limited color palette' },
  { name: 'Blueprint', style: 'technical blueprint drawing, white lines on blue background, architectural schematic' },
  // Special
  { name: 'Double Exposure', style: 'artistic double exposure photography, blending two images into one surreal composition' },
  { name: 'Origami', style: 'folded paper art, origami style, sharp creases, paper textures' },
  // House additions
  { name: 'Zine', style: 'raw stylized hand-drawn illustration in a dark indie pop-surrealism style, spooky-cute aesthetic, scratchy graphite pencil and fine-liner ink textures, loose cross-hatching, minimalist background, prominent oversized deeply shaded expressive eyes, long slender neck, delicate features, melancholic expression, high contrast, sharp angular details mixed with organic curves, gothic whimsy, lowbrow art style, zine illustration' },
];

export const SIZE_PRESETS: { label: string; value: AspectRatioValue; dims?: string }[] = [
  { label: 'Square', value: 'square', dims: '1024×1024' },
  { label: 'Portrait', value: 'portrait', dims: '1024×1536' },
  { label: 'Landscape', value: 'landscape', dims: '1536×1024' },
  { label: '16:9', value: '16:9', dims: '1536×864' },
  { label: '9:16', value: '9:16', dims: '864×1536' },
  { label: '21:9', value: '21:9', dims: '1536×658' },
  { label: '2:3', value: '2:3', dims: '1024×1536' },
  { label: '3:2', value: '3:2', dims: '1536×1024' },
  { label: '4:5', value: '4:5', dims: '1024×1280' },
  { label: '5:4', value: '5:4', dims: '1280×1024' },
  { label: '3:4', value: '3:4', dims: '1152×1536' },
  { label: '4:3', value: '4:3', dims: '1536×1152' },
  { label: 'Custom', value: 'custom' },
];

export const DRAW_COLORS = [
  '#ffffff', '#ff4444', '#44ff44', '#4444ff',
  '#ffff44', '#ff44ff', '#44ffff', '#ff8800',
  '#8844ff', '#44ff88', '#888888', '#000000',
];

export const ACCENT_TEXT_COLOR_BY_THEME: Record<ThemeMode, string> = {
  light: 'var(--bytelight-on-accent)',
  dark: 'var(--bytelight-on-accent)',
};

export const DRAW_CANVAS_BACKGROUND_BY_THEME: Record<ThemeMode, string> = {
  light: '#f0f0f0',
  dark: '#111111',
};

export const MIN_DIMENSION = 256;
export const MAX_DIMENSION = 2048;

export function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_DIMENSION;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(value)));
}

export const EDIT_CROP_ASPECT_OPTIONS = [
  { label: '1:1', value: 1 },
  { label: '4:5', value: 4 / 5 },
  { label: '2:3', value: 2 / 3 },
  { label: '9:16', value: 9 / 16 },
  { label: '3:2', value: 3 / 2 },
  { label: '5:4', value: 5 / 4 },
  { label: '16:9', value: 16 / 9 },
];
