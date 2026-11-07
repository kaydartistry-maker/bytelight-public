import React from 'react';
import { ThemeConfig, ThemeMode } from '../lib/theme';
import { cn } from '../lib/utils';

// The sibling of CommandPalette: same shape, same keyboard contract, pointed
// at `:` instead of `/`. Where that one lists commands, this lists the things
// you already own.
//
// One colon is emoji, two is stickers, and the caller keeps them apart — the
// two namespaces are separate deliberately, so the same name can belong to a
// sticker and an emoji at once.
//
// Unlike the command palette this can open mid-message, so the caller matches
// the token at the caret rather than the start of the box.

export interface ShortcodeMatch {
  /** What gets inserted, complete: `:name:` or `::pack_name::`. */
  code: string;
  /** What is shown beside the picture — the code without its colons. */
  label: string;
  kind: 'emoji' | 'sticker';
  /** Image url, or undefined for a unicode glyph. */
  url?: string;
  /** Unicode glyph, when this is a plain emoji rather than an image. */
  glyph?: string;
}

interface ShortcodePaletteProps {
  matches: ShortcodeMatch[];
  query: string;
  /** ':' or '::' — shown in the heading so it is clear which list this is. */
  prefix: string;
  selectedIndex: number;
  onSelect: (match: ShortcodeMatch) => void;
  onHoverIndex: (index: number) => void;
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
}

export function ShortcodePalette({
  matches,
  query,
  prefix,
  selectedIndex,
  onSelect,
  onHoverIndex,
  themeConfig,
  themeMode,
}: ShortcodePaletteProps) {
  const colors = themeConfig[themeMode];
  if (matches.length === 0) return null;
  const kind = matches[0].kind;

  return (
    <div
      className={cn('rounded-2xl border overflow-hidden mb-1', colors.panelBg, colors.panelBorder)}
      role="listbox"
      aria-label={`${kind === 'sticker' ? 'Stickers' : 'Emoji'} matching ${prefix}${query}`}
    >
      <div className={cn('px-3 pt-2 pb-1 text-[11px] uppercase tracking-wider', colors.textMuted)}>
        {kind === 'sticker' ? 'Stickers' : 'Emoji'} matching {prefix}{query}
      </div>
      {/* Capped and scrollable: a two-letter query can match most of a pack,
          and the composer must not get pushed off the top of the screen. */}
      <div className="max-h-56 overflow-y-auto">
        {matches.map((m, i) => (
          <button
            key={`${m.kind}:${m.code}`}
            type="button"
            role="option"
            aria-selected={i === selectedIndex}
            onMouseEnter={() => onHoverIndex(i)}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(m);
            }}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 text-left transition-colors',
              i === selectedIndex ? 'bg-black/10 dark:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <span className="w-8 h-8 flex items-center justify-center shrink-0">
              {m.url
                ? <img src={m.url} alt="" className="max-w-8 max-h-8 object-contain" loading="lazy" />
                : <span className="text-xl leading-none">{m.glyph}</span>}
            </span>
            <span className={cn('text-sm truncate', colors.textMain)}>{m.code}</span>

          </button>
        ))}
      </div>
    </div>
  );
}
