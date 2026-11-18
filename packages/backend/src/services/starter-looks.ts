/**
 * The old Studio Create word presets, now seeded once as ordinary looks with a
 * small "starter" tag. They are editable and deletable like any look; seeding
 * runs once per house (config flag), so a deleted starter never comes back.
 */

export const STARTER_LOOKS_FLAG = 'spellbook.starter_looks_seeded';

export const STARTER_LOOKS: ReadonlyArray<{ name: string; recipe: string }> = [
  // Basics
  { name: 'Photorealistic', recipe: 'photorealistic, high detail, 8k resolution, cinematic lighting, professional photography' },
  { name: 'Painterly', recipe: 'in a lush painterly style with visible brushstrokes and rich textures' },
  { name: 'Oil Painting', recipe: 'classic oil painting on canvas, dramatic chiaroscuro lighting' },
  { name: 'Watercolor', recipe: 'soft watercolor painting, bleeding colors, paper texture, delicate washes' },
  { name: 'Pencil Sketch', recipe: 'detailed pencil sketch on textured paper, fine graphite lines, hand-drawn look' },
  // Stylized
  { name: 'Studio Ghibli', recipe: 'in the whimsical and hand-drawn animation style of Studio Ghibli' },
  { name: 'Comic', recipe: 'in a bold comic book style with vibrant colors and strong ink lines' },
  { name: 'Pop Art', recipe: 'Andy Warhol style pop art, vibrant contrasting colors, halftone dots, screen print effect' },
  { name: 'Pixel Art', recipe: 'retro 8-bit pixel art, limited color palette, blocky aesthetic, video game nostalgia' },
  { name: 'Ukiyo-e', recipe: 'traditional Japanese woodblock print style, flat colors, bold outlines, Edo period aesthetic' },
  // Digital/3D
  { name: '3D Render', recipe: 'octane render, unreal engine 5, 3d digital art, ray tracing, volumetric lighting, hyper-detailed' },
  { name: 'Isometric', recipe: 'isometric 3D art, low poly, clean geometry, soft lighting, miniature world look' },
  { name: 'Claymation', recipe: 'stop-motion clay animation style, hand-sculpted textures, tactile feel' },
  // Aesthetic
  { name: 'Cyberpunk', recipe: 'cyberpunk aesthetic, neon lights, futuristic city, high tech low life, rainy night' },
  { name: 'Synthwave', recipe: 'synthwave aesthetic, retro-futurism, grid landscapes, sunset gradients, 80s synth vibes' },
  { name: 'Vaporwave', recipe: 'vaporwave aesthetic, pink and teal colors, 80s nostalgia, glitch art' },
  { name: 'Steampunk', recipe: 'steampunk aesthetic, brass gears, steam-powered machinery, Victorian era tech, sepia tones' },
  { name: 'Gothic', recipe: 'dark gothic aesthetic, ornate architecture, dramatic shadows, mysterious atmosphere' },
  // Design
  { name: 'Art Deco', recipe: '1920s art deco style, geometric patterns, gold accents, elegant symmetry, vintage poster look' },
  { name: 'Bauhaus', recipe: 'Bauhaus design movement style, primary colors, simple geometric forms, functional aesthetic' },
  { name: 'Minimalist', recipe: 'minimalist design, clean lines, simple shapes, limited color palette' },
  { name: 'Blueprint', recipe: 'technical blueprint drawing, white lines on blue background, architectural schematic' },
  // Special
  { name: 'Double Exposure', recipe: 'artistic double exposure photography, blending two images into one surreal composition' },
  { name: 'Origami', recipe: 'folded paper art, origami style, sharp creases, paper textures' },
  // House additions
  { name: 'Zine', recipe: 'raw stylized hand-drawn illustration in a dark indie pop-surrealism style, spooky-cute aesthetic, scratchy graphite pencil and fine-liner ink textures, loose cross-hatching, minimalist background, prominent oversized deeply shaded expressive eyes, long slender neck, delicate features, melancholic expression, high contrast, sharp angular details mixed with organic curves, gothic whimsy, lowbrow art style, zine illustration' },
];

/** Stable id per starter, so a re-run can never insert a second copy. */
export function starterLookId(name: string): string {
  return `starter-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}
