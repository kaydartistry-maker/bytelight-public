import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { X, Sticker as StickerIcon, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  loadStickers,
  getStickerPacks,
  type BackendSticker,
  type BackendStickerPack as BackendPack,
} from '../bytelight';
import type { ThemeConfig } from '../lib/theme';

interface StickerPickerProps {
  onSelect: (insertText: string, sticker: BackendSticker, pack: BackendPack) => void;
  onClose: () => void;
  themeConfig?: ThemeConfig;
  themeMode?: 'light' | 'dark';
  /** The colors straight, for a room that holds only those (the game and story tables). */
  colors?: ThemeConfig['light'];
}

export function StickerPicker({ onSelect, onClose, themeConfig, themeMode, colors: given }: StickerPickerProps) {
  const colors = given ?? themeConfig![themeMode ?? 'dark'];
  const initial = getStickerPacks();
  const [packs, setPacks] = useState<BackendPack[]>(initial);
  const [loading, setLoading] = useState(initial.length === 0);
  const [activePackId, setActivePackId] = useState<string | null>(null);

  // Show what is cached instantly, then go and look again every time the tray opens.
  // The cache is primed exactly once when the app connects, so the old early return
  // meant a non-empty cache could NEVER be refreshed: a sticker uploaded in Packs did
  // not appear until the whole app was closed and reopened. A forced load also rebuilds
  // the ref index, so inline ::pack_sticker:: refs resolve for new ones too.
  useEffect(() => {
    if (initial.length === 0) setLoading(true);
    loadStickers(true).then((data) => {
      setPacks(data);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (packs.length > 0 && !activePackId) setActivePackId(packs[0].id);
  }, [packs, activePackId]);

  const activePack = useMemo(() => packs.find((p) => p.id === activePackId) || null, [packs, activePackId]);

  const handlePick = (sticker: BackendSticker, pack: BackendPack) => {
    const insertText = `:${pack.name}_${sticker.name}:`;
    onSelect(insertText, sticker, pack);
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <motion.div
        key="sticker-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[90] bg-black/60"
        onClick={onClose}
      />
      <motion.div
        key="sticker-sheet"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className={cn(
          'fixed bottom-0 left-0 right-0 z-[91] border-t rounded-t-3xl p-4 flex flex-col',
          colors.panelBg,
          colors.panelBorder,
          'backdrop-blur-xl',
        )}
        style={{ maxHeight: '60vh' }}
      >
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <StickerIcon size={16} style={{ color: colors.accent }} />
          <h3 className={cn('text-xs font-bold uppercase tracking-widest', colors.accentText)}>Stickers</h3>
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

      {packs.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2 px-0.5">
          {packs.map((pack) => {
            const active = pack.id === activePackId;
            return (
              <button
                key={pack.id}
                onClick={() => setActivePackId(pack.id)}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                  colors.panelBorder,
                  // Only the selected pill set a colour, so the rest inherited the panel's
                  // and came out near-black on a dark sheet. textMain is white in the dark
                  // themes and black in the daylight ones, which is the whole requirement.
                  !active && colors.textMain,
                )}
                style={active ? { background: colors.accent, color: 'white', borderColor: colors.accent } : undefined}
                title={pack.name}
              >
                {pack.name.slice(0, 8)}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto max-h-60 pr-1 scrollbar-hide">
        {loading ? (
          <div className={cn('flex items-center justify-center gap-2 py-10 text-xs', colors.textMuted)}>
            <Loader2 size={14} className="animate-spin" />
            Loading…
          </div>
        ) : packs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 opacity-40 text-center">
            <StickerIcon size={32} className="mb-2" />
            <p className="text-[10px] uppercase font-bold tracking-tighter">No sticker packs</p>
            <p className="text-[10px] mt-1 italic">Add them in the Packs app</p>
          </div>
        ) : !activePack || !activePack.stickers || activePack.stickers.length === 0 ? (
          <div className={cn('text-[11px] text-center py-10 opacity-60', colors.textMuted)}>
            This pack is empty.
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2 py-1">
            {activePack.stickers.map((sticker) => (
              <button
                key={sticker.id}
                onClick={() => handlePick(sticker, activePack)}
                className="flex aspect-square items-center justify-center rounded-lg p-1 transition-all hover:scale-110 active:scale-95"
                title={`:${activePack.name}_${sticker.name}:`}
              >
                <img
                  src={sticker.url}
                  alt={sticker.name}
                  className="h-full w-full object-contain"
                  referrerPolicy="no-referrer"
                />
              </button>
            ))}
          </div>
        )}
      </div>
      </motion.div>
    </>,
    document.body
  );
}
