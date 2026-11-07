import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { X, Pencil, Search, ChevronLeft } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn, haptic } from '../lib/utils';
import { APPS, applyAppLayout, loadAppLayout, saveAppLayout, type AppDef, type AppSlot } from '../lib/apps';

interface AppDrawerProps {
  onClose: () => void;
  onOpenApp: (app: AppDef) => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// Sparse grid of launchable apps. Cells can be empty so the user can
// place tiles wherever they want — e.g. centering the last row of an
// odd count. Edit mode unlocks drag-to-move; dropping a tile onto an
// empty slot moves it there (origin slot becomes empty), dropping onto
// a filled slot swaps the two. Tap-to-open is suppressed while editing.
export function AppDrawer({ onClose, onOpenApp, themeConfig, themeMode }: AppDrawerProps) {
  const colors = themeConfig[themeMode];
  // False for the whole of the exit animation, while this is still mounted.
  const present = useIsPresent();

  const [slots, setSlots] = useState<Array<AppDef | null>>(() =>
    applyAppLayout(APPS, loadAppLayout()),
  );
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');

  // While the user is searching, the drag-to-reorder layout doesn't make
  // sense — we collapse to a flat filtered grid instead. Filter is a
  // simple case-insensitive substring on the app name; category match
  // could be added later if 14 apps grows much larger.
  const filteredApps = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.trim().toLowerCase();
    return APPS.filter((a) => a.name.toLowerCase().includes(q));
  }, [query]);

  // Fold any newly-added apps into the layout on mount so a later build
  // doesn't hide them behind a saved layout.
  useEffect(() => {
    setSlots((current) =>
      applyAppLayout(APPS, current.map((a) => (a ? a.id : null))),
    );
  }, []);

  // When entering edit mode, top up the trailing row to a multiple of
  // cols AND add two full empty rows on top, so the user has plenty of
  // room to shuffle and leave gaps wherever they want. (Earlier we
  // tried 0 then +1 row of slack — both turned out too tight in
  // practice.) The pad stays in the saved layout (harmless —
  // applyAppLayout iterates it on next load and the same logic
  // re-applies on next edit).
  useEffect(() => {
    if (!editing) return;
    const cols = 4;
    const trailing = (cols - (slots.length % cols)) % cols;
    const extras = trailing + cols * 2;
    setSlots((current) => [...current, ...Array(extras).fill(null)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // --- 2D drag state ----------------------------------------------------
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const tileSizeRef = useRef<{ w: number; h: number }>({ w: 56, h: 56 });
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  function startDrag(e: React.PointerEvent, idx: number) {
    if (!editing) return;
    if (!slotsRef.current[idx]) return; // empty cells aren't draggable
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    tileSizeRef.current = { w: rect.width, h: rect.height };
    setDragIdx(idx);
    setPointer({ x: e.clientX, y: e.clientY });
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* some platforms reject setPointerCapture on already-released pointers */
    }
  }

  useEffect(() => {
    if (dragIdx === null) return;
    function move(e: PointerEvent) {
      e.preventDefault();
      setPointer({ x: e.clientX, y: e.clientY });
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const tile = (el as HTMLElement | null)?.closest('[data-slot-idx]') as HTMLElement | null;
      const overAttr = tile?.getAttribute('data-slot-idx');
      const overIdx = overAttr ? parseInt(overAttr, 10) : null;
      if (overIdx === null || Number.isNaN(overIdx) || overIdx === dragIdx) return;
      const current = slotsRef.current;
      // Move-into-empty when the target is null; swap when the target is
      // another tile. Both operations leave the array length unchanged so
      // the grid layout stays stable while dragging.
      const next = current.slice();
      const moved = next[dragIdx as number];
      next[dragIdx as number] = next[overIdx];
      next[overIdx] = moved;
      setSlots(next);
      setDragIdx(overIdx);
    }
    function up() {
      saveAppLayout(slotsRef.current.map((a) => (a ? a.id : null)) as AppSlot[]);
      setDragIdx(null);
      setPointer(null);
    }
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragIdx]);

  const draggingApp = dragIdx !== null ? slots[dragIdx] : null;

  return (
    // Transparent like the home screen — the wallpaper shows through and
    // the tiles carry their own glass (owner's call, Jul 12 2026).
    <motion.div
      key="appdrawer"
      className={cn('absolute inset-0 z-40 flex flex-col', colors.textMain)}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.05, transition: { duration: 0.25 } }}
      // Still mounted at z-40 through the fade, over a Messages app at z-10
      // that is already painted and tappable. Leaving means leaving.
      style={{ pointerEvents: present ? undefined : 'none' }}
    >
      <header
        className={cn('bytelight-shell-header flex items-center gap-2 px-3 pb-3', colors.pageBg)}
        style={{ paddingTop: 'calc(var(--sat) + 0.75rem)' }}
      >
        {/* Back to home — a normal header back arrow like every other app.
            The X is reserved for exiting edit mode, never for closing the
            drawer itself (owner's call, Jul 13 2026). */}
        <button
          onClick={() => { haptic(55); onClose(); }}
          className={cn('rounded-full p-2 -ml-1 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Back to home"
        >
          <ChevronLeft size={20} />
        </button>
        <h1 className={cn('text-base font-semibold', colors.textMain)}>Apps</h1>
        <div className="ml-auto flex items-center gap-1">
          {editing ? (
            <button
              onClick={() => { haptic(55); setEditing(false); }}
              className={cn(
                'rounded-full p-1.5 transition-colors hover:bg-black/10 dark:hover:bg-white/10 border',
                colors.panelBorder,
              )}
              style={{ color: colors.accent, borderColor: colors.accent }}
              title="Done moving apps"
            >
              <X size={16} />
            </button>
          ) : (
            <button
              onClick={() => { haptic(55); setEditing(true); }}
              className={cn(
                'rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10 border',
                colors.panelBorder,
                colors.textMuted,
              )}
              title="Move apps"
            >
              <Pencil size={18} />
            </button>
          )}
        </div>
      </header>

      {editing && (
        <div className={cn('mx-5 mt-1 mb-2 px-3 py-2 rounded-xl border backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
          <p className="text-[11px]" style={{ color: colors.accent }}>
            Drag tiles to rearrange. Drop on an empty cell to leave a gap. Tap the check when you're done.
          </p>
        </div>
      )}

      {!editing && (
        <div className="px-5 pb-2">
          <div className={cn('bytelight-field flex items-center gap-2 rounded-full px-3 py-2', colors.textMain)}>
            <Search size={14} className={colors.textMuted} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search apps"
              className={cn('flex-1 bg-transparent border-none outline-none text-sm', colors.textMain)}
            />
            {query && (
              <button onClick={() => setQuery('')} className={cn('opacity-60 hover:opacity-100', colors.textMuted)}>
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="bytelight-app-body flex-1 overflow-y-auto scrollbar-hide px-5 py-4">
        {filteredApps ? (
          filteredApps.length === 0 ? (
            <p className={cn('text-center py-12 text-xs', colors.textMuted)}>No apps match "{query}"</p>
          ) : (
            <div className="grid grid-cols-4 gap-x-3 gap-y-5">
              {filteredApps.map((app) => (
                <div
                  key={`search-${app.id}`}
                  onClick={() => { haptic(55); onOpenApp(app); }}
                  className="flex flex-col items-center gap-1.5 select-none cursor-pointer"
                >
                  <div
                    className="bytelight-app-tile flex h-14 w-14 items-center justify-center rounded-2xl"
                  >
                    <app.icon className="h-7 w-7" />
                  </div>
                  <span className={cn('bytelight-app-label text-[10px] font-medium tracking-wide text-center', colors.textMain)}>{app.name}</span>
                </div>
              ))}
            </div>
          )
        ) : (
        <div className="grid grid-cols-4 gap-x-3 gap-y-5">
          {slots.map((app, idx) => {
            if (!app) {
              // Empty slot — renders as a same-size invisible target so
              // the grid stays aligned and drops can land on the gap.
              return (
                <div
                  key={`empty-${idx}`}
                  data-slot-idx={idx}
                  className={cn(
                    'flex flex-col items-center gap-1.5 select-none',
                    editing && 'opacity-60',
                  )}
                  style={editing ? { touchAction: 'none' } : undefined}
                >
                  <div
                    className={cn(
                      'h-14 w-14 rounded-2xl border-2 border-dashed',
                      editing ? colors.panelBorder : 'border-transparent',
                    )}
                  />
                  <span className="text-[10px] opacity-0 select-none">·</span>
                </div>
              );
            }
            const isDragging = idx === dragIdx;
            return (
              <div
                key={`${app.id}-${idx}`}
                data-slot-idx={idx}
                onPointerDown={editing ? (e) => startDrag(e, idx) : undefined}
                onClick={editing ? undefined : () => { haptic(55); onOpenApp(app); }}
                className={cn(
                  'flex flex-col items-center gap-1.5 select-none transition-opacity',
                  editing && 'cursor-grab active:cursor-grabbing animate-pulse',
                  isDragging && 'opacity-30',
                )}
                style={editing ? { touchAction: 'none' } : undefined}
              >
                <div
                  className="bytelight-app-tile flex h-14 w-14 items-center justify-center rounded-2xl"
                >
                  <app.icon className="h-7 w-7" />
                </div>
                <span className={cn('bytelight-app-label text-[10px] font-medium tracking-wide text-center', colors.textMain)}>{app.name}</span>
              </div>
            );
          })}
        </div>
        )}
      </div>

      {/* Floating ghost — follows the pointer while dragging. */}
      {draggingApp && pointer && (
        <div
          className="pointer-events-none fixed z-50 flex flex-col items-center gap-1.5 transition-transform"
          style={{
            left: pointer.x - dragOffsetRef.current.x,
            top: pointer.y - dragOffsetRef.current.y,
            width: tileSizeRef.current.w,
            transform: 'scale(1.08)',
            filter: 'drop-shadow(0 8px 20px rgba(0,0,0,0.25))',
          }}
        >
          <div
            className="bytelight-app-tile flex h-14 w-14 items-center justify-center rounded-2xl shadow-md"
          >
            <draggingApp.icon className="h-7 w-7" />
          </div>
          <span className={cn('bytelight-app-label text-[10px] font-medium tracking-wide text-center', colors.textMain)}>{draggingApp.name}</span>
        </div>
      )}
    </motion.div>
  );
}
