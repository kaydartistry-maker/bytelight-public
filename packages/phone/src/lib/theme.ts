export type ThemeMode = 'light' | 'dark';
export type ThemeId = 'burgundy' | 'crimson' | 'orange' | 'forest' | 'emerald' | 'teal' | 'ocean' | 'sky' | 'cobalt' | 'sapphire' | 'lavender' | 'cosmos' | 'plum' | 'blush' | 'rose' | 'magenta' | 'mocha' | 'monochrome' | 'custom';

export interface ThemeColors {
  pageBg: string;
  panelBg: string;
  panelBorder: string;
  textMain: string;
  textMuted: string;
  userBubbleBg: string;
  userBubbleText: string;
  compBubbleBg: string;
  compBubbleText: string;
  accent: string;
  accentText: string;
  noteText?: string;
}

/**
 * Runtime CSS colors behind the Tailwind-facing ThemeColors contract.
 *
 * Most of the phone predates the shared Bytelight surface layer and therefore
 * passes theme values around as utility-class strings.  Keeping that public
 * shape avoids a risky all-at-once component rewrite; this resolved form is
 * the single bridge used by the semantic CSS variables, canvas games, and
 * any inline style that needs an actual color rather than a class name.
 */
export interface ResolvedThemeColors {
  pageBg: string;
  panelBg: string;
  panelBorder: string;
  textMain: string;
  textMuted: string;
  userBubbleBg: string;
  userBubbleText: string;
  compBubbleBg: string;
  compBubbleText: string;
  accent: string;
  accentText: string;
  noteText?: string;
}

export interface ThemeConfig {
  id: ThemeId;
  name: string;
  fontFamily: string;
  messageFontFamily: string;
  radius: string;
  light: ThemeColors;
  dark: ThemeColors;
}

const BASE_THEMES: Record<ThemeId, ThemeConfig> = {
  custom: {
    id: 'custom',
    name: 'Custom',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[var(--custom-pageBg)]',
      panelBg: 'bg-[var(--custom-panelBg)]',
      panelBorder: 'border-[var(--custom-panelBorder)]',
      textMain: 'text-[var(--custom-textMain)]',
      textMuted: 'text-[var(--custom-textMuted)]',
      userBubbleBg: 'bg-[var(--custom-userBubbleBg)]',
      userBubbleText: 'text-[var(--custom-userBubbleText)]',
      compBubbleBg: 'bg-[var(--custom-compBubbleBg)]',
      compBubbleText: 'text-[var(--custom-compBubbleText)]',
      accent: 'var(--custom-accent)',
      accentText: 'text-[var(--custom-accentText)]',
    },
    dark: {
      pageBg: 'bg-[var(--custom-pageBg)]',
      panelBg: 'bg-[var(--custom-panelBg)]',
      panelBorder: 'border-[var(--custom-panelBorder)]',
      textMain: 'text-[var(--custom-textMain)]',
      textMuted: 'text-[var(--custom-textMuted)]',
      userBubbleBg: 'bg-[var(--custom-userBubbleBg)]',
      userBubbleText: 'text-[var(--custom-userBubbleText)]',
      compBubbleBg: 'bg-[var(--custom-compBubbleBg)]',
      compBubbleText: 'text-[var(--custom-compBubbleText)]',
      accent: 'var(--custom-accent)',
      accentText: 'text-[var(--custom-accentText)]',
    }
  },
  mocha: {
    id: 'mocha',
    name: 'Mocha',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#FAF6F3]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#6B4E3D]/15',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#6B4E3D]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#EDE8E5]/90',
      compBubbleText: 'text-black',
      accent: '#6B4E3D',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#0D0A08]',
      panelBg: 'bg-[#17120F]/95',
      panelBorder: 'border-[#A1887F]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#8A7169]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#1A1512]/90',
      compBubbleText: 'text-white',
      accent: '#A1887F',
      accentText: 'text-white',
    }
  },
  monochrome: {
    id: 'monochrome',
    name: 'Mono',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#F4F4F5]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#18181B]/10',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#71717A]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#FAFAFA]/90',
      compBubbleText: 'text-black',
      accent: '#18181B',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#09090B]',
      panelBg: 'bg-[#18181B]/95',
      panelBorder: 'border-[#FAFAFA]/10',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#52525B]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#18181B]/90',
      compBubbleText: 'text-white',
      accent: '#FAFAFA',
      accentText: 'text-white',
    }
  },
  burgundy: {
    id: 'burgundy',
    name: 'Burgundy',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#FDF0F1]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#722F37]/15',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#722F37]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#D4A5A5]/90',
      compBubbleText: 'text-black',
      accent: '#722F37',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#0A0304]',
      panelBg: 'bg-[#150608]/95',
      panelBorder: 'border-[#8B3A42]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#8B3A42]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#3D1518]/90',
      compBubbleText: 'text-white',
      accent: '#8B3A42',
      accentText: 'text-white',
    }
  },
  crimson: {
    id: 'crimson',
    name: 'Crimson',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#FFF0F2]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#C8102E]/10',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#C8102E]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#F19AA8]/90',
      compBubbleText: 'text-black',
      accent: '#C8102E',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#050001]',
      panelBg: 'bg-[#0f0003]/95',
      panelBorder: 'border-[#C8102E]/30',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#C8102E]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#4A000A]/90',
      compBubbleText: 'text-white',
      accent: '#C8102E',
      accentText: 'text-white',
    }
  },
  rose: {
    id: 'rose',
    name: 'Rose',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#FFF1F2]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#E11D48]/10',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#E11D48]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#F2BECA]/90',
      compBubbleText: 'text-black',
      accent: '#E11D48',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#050203]',
      panelBg: 'bg-[#0f0507]/95',
      panelBorder: 'border-[#F43F5E]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#E62F53]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#3D0A15]/90',
      compBubbleText: 'text-white',
      accent: '#F43F5E',
      accentText: 'text-white',
    }
  },
  orange: {
    id: 'orange',
    name: 'Orange',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#FFF7ED]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#EA580C]/10',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#E85D04]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#FED7AA]/90',
      compBubbleText: 'text-black',
      accent: '#EA580C',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#050302]',
      panelBg: 'bg-[#0f0705]/95',
      panelBorder: 'border-[#F97316]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#C2410C]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#7C2D12]/90',
      compBubbleText: 'text-white',
      accent: '#F97316',
      accentText: 'text-white',
    }
  },
  forest: {
    id: 'forest',
    name: 'Forest',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#F0FDF4]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#15803D]/10',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#15803D]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#6BDC96]/90',
      compBubbleText: 'text-black',
      accent: '#15803D',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#020503]',
      panelBg: 'bg-[#050f07]/95',
      panelBorder: 'border-[#22C55E]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#15803D]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#0A2A15]/90',
      compBubbleText: 'text-white',
      accent: '#15803D',
      accentText: 'text-white',
    }
  },
  emerald: {
    id: 'emerald',
    name: 'Emerald',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#F0FDF4]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#059669]/10',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#059669]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#5DF0C3]/90',
      compBubbleText: 'text-black',
      accent: '#059669',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#020503]',
      panelBg: 'bg-[#050f09]/95',
      panelBorder: 'border-[#10B981]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#008A5F]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#0A2A20]/90',
      compBubbleText: 'text-white',
      accent: '#10B981',
      accentText: 'text-white',
    }
  },
  teal: {
    id: 'teal',
    name: 'Teal',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#CCFBF1]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#14B8A6]/20',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#14B8A6]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#92ECE2]/90',
      compBubbleText: 'text-black',
      accent: '#14B8A6',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#010a09]',
      panelBg: 'bg-[#021715]/95',
      panelBorder: 'border-[#2DD4BF]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#00887A]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#0A2A25]/90',
      compBubbleText: 'text-white',
      accent: '#2DD4BF',
      accentText: 'text-white',
    }
  },
  sky: {
    id: 'sky',
    name: 'Sky',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#E0F2FE]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#38BDF8]/20',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#38BDF8]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#E6F6FD]/90',
      compBubbleText: 'text-black',
      accent: '#38BDF8',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#010405]',
      panelBg: 'bg-[#051117]/95',
      panelBorder: 'border-[#7DD3FC]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#2782A9]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#0A1A2A]/90',
      compBubbleText: 'text-white',
      accent: '#7DD3FC',
      accentText: 'text-white',
    }
  },
  ocean: {
    id: 'ocean',
    name: 'Ocean',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#ECFEFF]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#0891B2]/10',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#0891B2]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#7BDAF1]/90',
      compBubbleText: 'text-black',
      accent: '#0891B2',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#02070a]',
      panelBg: 'bg-[#051117]/95',
      panelBorder: 'border-[#06B6D4]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#00849C]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#0A2530]/90',
      compBubbleText: 'text-white',
      accent: '#06B6D4',
      accentText: 'text-white',
    }
  },
  sapphire: {
    id: 'sapphire',
    name: 'Sapphire',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#E8EFFF]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#113285]/15',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#113285]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#B4CAF0]/90',
      compBubbleText: 'text-black',
      accent: '#113285',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#02050a]',
      panelBg: 'bg-[#050a17]/95',
      panelBorder: 'border-[#4785F2]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#3875E1]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#0A1530]/90',
      compBubbleText: 'text-white',
      accent: '#4785F2',
      accentText: 'text-white',
    }
  },
  cobalt: {
    id: 'cobalt',
    name: 'Cobalt',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-xl',
    light: {pageBg: 'bg-[#F0F4F8]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#4A7AAB]/15',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#4A7AAB]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#E8EFF5]/90',
      compBubbleText: 'text-black',
      accent: '#4A7AAB',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#030508]',
      panelBg: 'bg-[#0A1017]/95',
      panelBorder: 'border-[#8BA5C4]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#607896]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#1A2535]/90',
      compBubbleText: 'text-white',
      accent: '#8BA5C4',
      accentText: 'text-white',
    }
  },
  // Cosmos — the operator's celestial skin, carried over from the Svelte house
  // (main:packages/frontend/src/app.css, the [data-skin="cosmos"] block).
  // Identity: violet aura, companion bubbles cool violet, hers warm rose.
  // Midnight = deep purple-black, Daylight = soft lavender. The serif
  // heading voice (Fraunces) waits on a font being added to the kit.
  cosmos: {
    id: 'cosmos',
    name: 'Cosmos',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {
      pageBg: 'bg-[#F5F2FC]',
      panelBg: 'bg-[#FBF9FF]/95',
      panelBorder: 'border-[#7C5CC8]/20',
      textMain: 'text-[#1F1A2E]',
      textMuted: 'text-[#756E8C]',
      userBubbleBg: 'bg-[#F0A6C8]/45',
      userBubbleText: 'text-[#1F1A2E]',
      compBubbleBg: 'bg-[#A78BFA]/25',
      compBubbleText: 'text-[#1F1A2E]',
      accent: '#7C5CC8',
      accentText: 'text-white',
    },
    dark: {
      pageBg: 'bg-[#0A0812]',
      panelBg: 'bg-[#171125]/95',
      panelBorder: 'border-[#A78BFA]/20',
      textMain: 'text-[#ECE9F5]',
      textMuted: 'text-[#A8A2C0]',
      userBubbleBg: 'bg-[#F0A6C8]/25',
      userBubbleText: 'text-[#F8ECF3]',
      compBubbleBg: 'bg-[#A78BFA]/20',
      compBubbleText: 'text-[#ECE9F5]',
      accent: '#A78BFA',
      accentText: 'text-white',
    }
  },
  lavender: {
    id: 'lavender',
    name: 'Lilac',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#F8F6F9]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#A47DAB]/20',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#A47DAB]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#E4DAE4]/90',
      compBubbleText: 'text-black',
      accent: '#A47DAB',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#0B090C]',
      panelBg: 'bg-[#131015]/95',
      panelBorder: 'border-[#C8A2C8]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#916C91]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#2A1A2D]/90',
      compBubbleText: 'text-white',
      accent: '#C8A2C8',
      accentText: 'text-white',
    }
  },
  plum: {
    id: 'plum',
    name: 'Plum',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#FDF4FF]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#A21CAF]/15',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#A21CAF]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#F5D0FE]/90',
      compBubbleText: 'text-black',
      accent: '#A21CAF',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#080208]',
      panelBg: 'bg-[#140414]/95',
      panelBorder: 'border-[#86198F]/30',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#86198F]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#2A0A2D]/90',
      compBubbleText: 'text-white',
      accent: '#86198F',
      accentText: 'text-white',
    }
  },
  magenta: {
    id: 'magenta',
    name: 'Magenta',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#FDF2F8]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#DB2777]/10',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#DB2777]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#F1C4D8]/90',
      compBubbleText: 'text-black',
      accent: '#DB2777',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#0a0205]',
      panelBg: 'bg-[#17050a]/95',
      panelBorder: 'border-[#EC4899]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#DA358A]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#3D0A20]/90',
      compBubbleText: 'text-white',
      accent: '#EC4899',
      accentText: 'text-white',
    }
  },
  blush: {
    id: 'blush',
    name: 'Blush',
    fontFamily: 'font-sans',
    messageFontFamily: 'font-sans',
    radius: 'rounded-2xl',
    light: {pageBg: 'bg-[#FFF1F2]',
      panelBg: 'bg-white/95',
      panelBorder: 'border-[#FDA4AF]/20',
      textMain: 'text-black',
      textMuted: 'text-black/60',
      userBubbleBg: 'bg-[#FDA4AF]/85',
      userBubbleText: 'text-black',
      compBubbleBg: 'bg-[#FDE7EA]/90',
      compBubbleText: 'text-black',
      accent: '#FDA4AF',
      accentText: 'text-black',
    },
    dark: {
      pageBg: 'bg-[#0a0203]',
      panelBg: 'bg-[#170507]/95',
      panelBorder: 'border-[#FDA4AF]/20',
      textMain: 'text-white',
      textMuted: 'text-white/60',
      userBubbleBg: 'bg-[#B2616D]/85',
      userBubbleText: 'text-white',
      compBubbleBg: 'bg-[#3D1A20]/90',
      compBubbleText: 'text-white',
      accent: '#FDA4AF',
      accentText: 'text-white',
    }
  }
};

function applyOpacity(color: string, opacity?: string): string {
  if (!opacity || opacity === '100') return color;
  const alpha = Math.max(0, Math.min(100, Number(opacity))) / 100;
  if (!Number.isFinite(alpha)) return color;

  const shortHex = color.match(/^#([0-9a-f]{3})$/i)?.[1];
  const longHex = color.match(/^#([0-9a-f]{6})$/i)?.[1];
  const hex = longHex || (shortHex ? shortHex.split('').map((part) => part + part).join('') : null);
  if (hex) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Custom colors can be CSS variables. color-mix preserves their alpha
  // without requiring us to inspect the DOM or duplicate the custom editor.
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

/** Resolve a theme utility (or a raw CSS color) to a value usable in CSS. */
export function resolveThemeColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (trimmed.startsWith('#') || trimmed.startsWith('rgb') || trimmed.startsWith('hsl') || trimmed.startsWith('var(') || trimmed.startsWith('color-mix(')) {
    return trimmed;
  }

  // Arbitrary Tailwind colors: bg-[#123456]/80, text-[var(--token)], etc.
  const arbitrary = trimmed.match(/(?:^|\s)(?:bg|text|border)-\[(.+?)\](?:\/(\d+))?(?:\s|$)/);
  if (arbitrary) return applyOpacity(arbitrary[1], arbitrary[2]);

  const named = trimmed.match(/(?:^|\s)(?:bg|text|border)-(white|black)(?:\/(\d+))?(?:\s|$)/);
  if (named) return applyOpacity(named[1] === 'white' ? '#ffffff' : '#000000', named[2]);

  return fallback;
}

export function resolveThemeColors(colors: ThemeColors): ResolvedThemeColors {
  return {
    pageBg: resolveThemeColor(colors.pageBg, '#09090b'),
    panelBg: resolveThemeColor(colors.panelBg, 'rgba(24, 24, 27, 0.95)'),
    panelBorder: resolveThemeColor(colors.panelBorder, 'rgba(255, 255, 255, 0.16)'),
    textMain: resolveThemeColor(colors.textMain, '#fafafa'),
    textMuted: resolveThemeColor(colors.textMuted, 'rgba(250, 250, 250, 0.62)'),
    userBubbleBg: resolveThemeColor(colors.userBubbleBg, 'rgba(82, 82, 91, 0.86)'),
    userBubbleText: resolveThemeColor(colors.userBubbleText, '#ffffff'),
    compBubbleBg: resolveThemeColor(colors.compBubbleBg, 'rgba(24, 24, 27, 0.9)'),
    compBubbleText: resolveThemeColor(colors.compBubbleText, '#ffffff'),
    accent: resolveThemeColor(colors.accent, '#f97316'),
    accentText: resolveThemeColor(colors.accentText, '#ffffff'),
    noteText: colors.noteText ? resolveThemeColor(colors.noteText, '#ffffff') : undefined,
  };
}

type Rgba = { r: number; g: number; b: number; a: number };

function parseCssColor(color: string): Rgba | null {
  const hexMatch = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex.split('').map((part) => part + part).join('');
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }

  const rgbMatch = color.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!rgbMatch) return null;
  return { r: Number(rgbMatch[1]), g: Number(rgbMatch[2]), b: Number(rgbMatch[3]), a: rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]) };
}

/**
 * Lay a possibly see-through color over a backdrop and hand back the solid
 * result, so a surface shows its color and none of the wallpaper behind it.
 * Anything it cannot parse comes back unchanged. (Ported from Aerie's
 * lib/theme.ts; Copyright 2026 Aerie Systems, Apache License 2.0.)
 */
export function flattenOver(color: string, backdrop: string): string {
  const top = parseCssColor(color);
  const under = parseCssColor(backdrop);
  if (!top || !under) return color;
  const a = top.a;
  const ch = (t: number, u: number) => Math.round(t * a + u * (1 - a));
  return `rgb(${ch(top.r, under.r)}, ${ch(top.g, under.g)}, ${ch(top.b, under.b)})`;
}

/** Pick the higher-contrast ink, compositing translucent fills when possible. */
export function contrastTextColor(color: string, fallback = '#ffffff', backdrop?: string): '#090807' | '#ffffff' {
  let parsed = parseCssColor(color);
  if (!parsed) return fallback === '#090807' ? '#090807' : '#ffffff';
  if (parsed.a < 1 && backdrop) {
    const behind = parseCssColor(backdrop);
    if (behind) {
      parsed = {
        r: parsed.r * parsed.a + behind.r * (1 - parsed.a),
        g: parsed.g * parsed.a + behind.g * (1 - parsed.a),
        b: parsed.b * parsed.a + behind.b * (1 - parsed.a),
        a: 1,
      };
    }
  }

  const channels = [parsed.r, parsed.g, parsed.b].map((channel) => channel / 255);
  const [r, g, b] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  ));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const whiteContrast = 1.05 / (luminance + 0.05);
  const inkContrast = (luminance + 0.05) / 0.05;
  return inkContrast >= whiteContrast ? '#090807' : '#ffffff';
}

/**
 * Add semantic surface hooks once at the theme boundary. Every existing
 * component already consumes panelBg/userBubbleBg/compBubbleBg, so this one
 * decoration makes cards, sheets, fields, and message bubbles share the same
 * theme-derived gradient without hunting through hundreds of call sites.
 */
function decorateTheme(config: ThemeConfig): ThemeConfig {
  const decorateColors = (colors: ThemeColors): ThemeColors => ({
    ...colors,
    panelBg: `${colors.panelBg} bytelight-theme-panel`,
    userBubbleBg: `${colors.userBubbleBg} bytelight-theme-user-bubble`,
    compBubbleBg: `${colors.compBubbleBg} bytelight-theme-comp-bubble`,
  });

  return {
    ...config,
    light: decorateColors(config.light),
    dark: decorateColors(config.dark),
  };
}

export const THEMES = Object.fromEntries(
  Object.entries(BASE_THEMES).map(([id, config]) => [id, decorateTheme(config)]),
) as Record<ThemeId, ThemeConfig>;

// Shape. The radius token above is a Tailwind class, which cannot slide —
// so the slider works in pixels: the theme's class supplies the default,
// theme.shapeRadius overrides it, and CSS variables carry the result so a
// corner is chosen by what a thing IS (bubble, surface, control, chip).
const RADIUS_CLASS_PX: Record<string, number> = {
  'rounded-none': 0,
  'rounded-sm': 2,
  'rounded': 4,
  'rounded-md': 6,
  'rounded-lg': 8,
  'rounded-xl': 12,
  'rounded-2xl': 16,
  'rounded-3xl': 24,
};
export function themeRadiusPx(radiusClass: string): number {
  return RADIUS_CLASS_PX[radiusClass] ?? 16;
}
export function shapeVarsFor(base: number): Record<string, string> {
  return {
    '--shape-bubble': `${base}px`,
    '--shape-surface': `${base}px`,
    '--shape-control': `${base}px`,
    // A chip is a few pixels tall; past ~12px the browser is clamping to a
    // pill anyway, so capping keeps small things from outracing big ones.
    '--shape-chip': `${Math.min(base, 12)}px`,
  };
}


/**
 * BL's accent model: the accent is HER lever, independent of the palette.
 * When an override is set it replaces the accent in both modes; everything
 * that reads colors.accent / --bytelight-accent follows. The Cosmos aura
 * stays its own atmosphere (BL: "the accent color stays whatever the user
 * picked" — and vice versa: the skin never eats the accent).
 */
export function withAccentOverride(config: ThemeConfig, accent?: string | null, paletteName?: string | null): ThemeConfig {
  const r = resolveAccentChoice(accent, paletteName);
  if (!r.light && !r.dark) return config;
  return {
    ...config,
    light: { ...config.light, accent: r.light ?? config.light.accent },
    dark: { ...config.dark, accent: r.dark ?? config.dark.accent },
  };
}


/** BL's accent registry — copied verbatim from main
 *  (frontend/src/lib/stores/theme.svelte.ts ACCENT_PALETTES). */
export interface AccentPalette {
  name: string;
  dark: { main: string; bright: string; dim: string };
  light: { main: string; bright: string; dim: string };
}
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

/** Resolve the accent BL's way: custom hex wins, then a named palette
 *  (mode-aware), then whatever the base theme says. */
export function resolveAccentChoice(
  custom: string | null | undefined,
  paletteName: string | null | undefined,
): { light: string | null; dark: string | null } {
  if (custom) return { light: custom, dark: custom };
  if (paletteName) {
    const p = ACCENT_PALETTES.find((x) => x.name === paletteName);
    if (p) return { light: p.light.main, dark: p.dark.main };
  }
  return { light: null, dark: null };
}


/** BL's typography presets — copied verbatim from main
 *  (frontend/src/lib/stores/theme.svelte.ts TYPOGRAPHY_PRESETS). */
export const TYPOGRAPHY_PRESETS: { name: string; heading: string; body: string; mono: string }[] = [
  { name: 'Cosmic Clean', heading: 'Space Grotesk', body: 'Inter', mono: 'JetBrains Mono' },
  { name: 'Celestial Serif', heading: 'Fraunces', body: 'Inter', mono: 'JetBrains Mono' },
  { name: 'Soft Occult', heading: 'Fraunces', body: 'Fraunces', mono: 'JetBrains Mono' },
  { name: 'Ritual Terminal', heading: 'Space Grotesk', body: 'JetBrains Mono', mono: 'JetBrains Mono' },
  { name: 'System', heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
];

/** BL's font stacks, verbatim (theme.svelte.ts fontStack/monoStack). */
export const fontStack = (font: string) => `'${font}', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;
export const monoStack = (font: string) => `'${font}', ui-monospace, monospace`;
