import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { X, Sparkles, Inbox, Smile } from 'lucide-react';
import { cn } from '../lib/utils';
import { ThemeConfig } from '../lib/theme';
import { ThemeMode, CustomEmoji, EmojiPack } from '../types';
import { EMOJI_SECTIONS } from '../lib/emoji';

interface EmojiPickerProps {
  // text is what to insert into the composer — a literal Unicode emoji
  // for a standard tab (e.g. "🔥") or a `:shortcode:` for a custom one.
  onSelect: (text: string) => void;
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
  customEmojis?: CustomEmoji[];
  emojiPacks?: EmojiPack[];
}

// Tab id encoding: 'pack:<id>' for a custom pack, 'loose' for emojis with
// no pack_id, and the section.label for one of the four standard sets.
type TabId = string;

// Icon for each standard section. Picked so the tab strip reads at a
// glance without text — one representative emoji per category.
const SECTION_ICON: Record<string, string> = {
  'Smileys & Emotion': '😀',
  'People & Body': '👋',
  'Animals & Nature': '🐱',
  'Food & Drink': '🍕',
  'Activities': '⚽',
  'Travel & Places': '✈️',
  'Objects': '💡',
  'Symbols': '❤️',
  'Flags': '🏳️',
};

export function EmojiPicker({ onSelect, onClose, themeConfig, themeMode, customEmojis, emojiPacks }: EmojiPickerProps) {
  const colors = themeConfig[themeMode];

  // Group custom emojis by pack so each pack gets its own tab. Emojis
  // with no pack_id fall into a 'loose' bucket surfaced as an Unpacked
  // tab when it isn't empty.
  const { packBuckets, looseBucket } = useMemo(() => {
    const buckets = new Map<string, CustomEmoji[]>();
    const loose: CustomEmoji[] = [];
    for (const e of customEmojis ?? []) {
      if (e.pack_id) {
        if (!buckets.has(e.pack_id)) buckets.set(e.pack_id, []);
        buckets.get(e.pack_id)!.push(e);
      } else {
        loose.push(e);
      }
    }
    return { packBuckets: buckets, looseBucket: loose };
  }, [customEmojis]);

  // Build the ordered tab list. Custom packs first (so they're easy to
  // reach), then Unpacked if non-empty, then the four standard sections.
  // Default to the first available custom tab; otherwise the first
  // standard section.
  const orderedPacks = useMemo(
    () => (emojiPacks ?? []).filter((p) => packBuckets.has(p.id)),
    [emojiPacks, packBuckets],
  );
  const hasLoose = looseBucket.length > 0;
  const defaultTab: TabId =
    orderedPacks[0] ? `pack:${orderedPacks[0].id}` :
    hasLoose ? 'loose' :
    EMOJI_SECTIONS[0].label;
  const [tab, setTab] = useState<TabId>(defaultTab);

  const activeSection =
    tab.startsWith('pack:') || tab === 'loose'
      ? null
      : EMOJI_SECTIONS.find((s) => s.label === tab);
  const activePackId = tab.startsWith('pack:') ? tab.slice(5) : null;
  const activePackName =
    activePackId
      ? (emojiPacks?.find((p) => p.id === activePackId)?.name ?? 'Pack')
      : null;
  const activeCustomEmojis: CustomEmoji[] | null =
    activePackId ? packBuckets.get(activePackId) ?? [] :
    tab === 'loose' ? looseBucket :
    null;

  // Pick a representative emoji from a pack for its tab icon — first
  // emoji in the pack, displayed as an <img>. Falls back to a Sparkles
  // icon when the pack is empty (shouldn't happen since we filtered).
  function PackTabIcon({ pack }: { pack: EmojiPack }) {
    const first = packBuckets.get(pack.id)?.[0];
    if (!first) return <Sparkles size={14} />;
    return (
      <img
        src={first.url}
        alt={pack.name}
        className="h-[1.2em] w-auto object-contain"
        referrerPolicy="no-referrer"
      />
    );
  }

  function tabButton(id: TabId, content: React.ReactNode, title: string) {
    const isActive = tab === id;
    return (
      <button
        key={id}
        onClick={() => setTab(id)}
        className={cn(
          "shrink-0 flex items-center justify-center w-7 h-7 rounded-full text-base leading-none transition-colors",
          // Most of these are emoji, which carry their own colour — but the Unpacked
          // icon and the bullet fallback draw in currentColor, and inheriting the panel's
          // is the same dark-on-dark the sticker pills had.
          colors.textMain,
          isActive ? '' : 'opacity-60 hover:opacity-100',
        )}
        style={isActive ? { background: `${colors.accent}25` } : undefined}
        title={title}
      >
        {content}
      </button>
    );
  }

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <motion.div
        key="emoji-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[90] bg-black/60"
        onClick={onClose}
      />
      <motion.div
        key="emoji-sheet"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[91] border-t rounded-t-3xl p-3 flex flex-col",
          colors.panelBg,
          colors.panelBorder,
          "backdrop-blur-xl"
        )}
        style={{ maxHeight: '60vh' }}
      >
      {/* Same header as Stickers and GIFs. This tray had none at all — the close
          button lived in the tab strip, so the strip lost width to it and the sheet
          opened with no name on it. */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Smile size={16} style={{ color: colors.accent }} />
          <h3 className={cn('text-xs font-bold uppercase tracking-widest', colors.accentText)}>Emojis</h3>
        </div>
        <button
          onClick={onClose}
          className={cn(
            'p-1.5 rounded-full transition-colors opacity-60 hover:opacity-100',
            colors.textMuted,
            'hover:bg-black/5 dark:hover:bg-white/5',
          )}
        >
          <X size={14} />
        </button>
      </div>

      {/* Tab strip — horizontally scrollable so it never overflows the
          picker width regardless of how many packs are added. Full width now that
          the close button has a header to live in. */}
      <div className="flex items-center mb-2 gap-1.5">
        <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-hide flex-1 min-w-0">
          {orderedPacks.map((p) => tabButton(`pack:${p.id}`, <PackTabIcon pack={p} />, p.name))}
          {hasLoose && tabButton('loose', <Inbox size={14} />, 'Unpacked')}
          {EMOJI_SECTIONS.map((section) =>
            tabButton(section.label, SECTION_ICON[section.label] ?? '•', section.label),
          )}
        </div>
      </div>

      {/* Active-tab label */}
      <div className={cn('text-[9px] font-bold uppercase tracking-widest mb-2 px-1 truncate', colors.textMuted)}>
        {activePackName ?? (tab === 'loose' ? 'Unpacked' : tab)}
      </div>

      {/* Grid — single tab's contents */}
      <div className="overflow-y-auto max-h-44 pr-1 scrollbar-hide">
        {activeCustomEmojis ? (
          activeCustomEmojis.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 opacity-40 text-center">
              <Sparkles size={24} className="mb-1.5" />
              <p className="text-[10px] uppercase font-bold tracking-tighter">Empty</p>
              <p className="text-[10px] mt-0.5 italic">Add emojis in the Packs app</p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5 px-0.5 py-1">
              {activeCustomEmojis.map((emoji) => (
                <button
                  key={emoji.id}
                  onClick={() => onSelect(`:${emoji.shortcode}:`)}
                  className="p-0.5 flex items-center justify-center transition-all duration-300 hover:scale-125 active:scale-95"
                  title={`:${emoji.shortcode}:`}
                >
                  <img
                    src={emoji.url}
                    alt={emoji.shortcode}
                    className="h-[1.4em] w-auto object-contain rounded-sm"
                    referrerPolicy="no-referrer"
                  />
                </button>
              ))}
            </div>
          )
        ) : (
          activeSection && (
            <div className="grid grid-cols-8 gap-0.5">
              {activeSection.emojis.map((emoji, i) => (
                <button
                  key={`${activeSection.label}-${i}`}
                  onClick={() => onSelect(emoji)}
                  className="text-xl p-1 rounded transition-transform hover:scale-125 active:scale-95"
                  title={emoji}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )
        )}
      </div>
      </motion.div>
    </>,
    document.body
  );
}
