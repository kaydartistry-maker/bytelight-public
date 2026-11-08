import React, { useRef, useState } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { LayoutGrid, Lock } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn, haptic } from '../lib/utils';
import { useBackHandler } from '../lib/use-back-handler';
import { APPS, type AppDef } from '../lib/apps';
import type { AppTheme } from '../types';
import { toggleWidget, type HomeWidget, type Layout } from '../lib/home-widgets';
import { noteColorsForAccent } from '../lib/note-colors';
import { HomeWidgets, QuietLine, WidgetSheet, type WidgetCompanion } from './HomeWidgets';
import { StatusSheet } from './StatusSheet';
import type { OwnerStatus } from '../lib/statuses';

interface HomeScreenProps {
  onOpenApp: (app: AppDef) => void;
  onOpenDrawer: () => void;
  onLock: () => void;
  wallpaper?: string;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  messagesBadge?: number;
  // Resolved AppDef list to show on the dock. App.tsx maps the user's
  // saved dockAppIds against the registry and passes the result here.
  dockApps: AppDef[];
  // The owner's widgets and the quiet line (lib/home-widgets.ts).
  widgets: HomeWidget[];
  // Where each one sits, once any has been moved (lib/home-widgets.ts).
  widgetSpots: Layout;
  quietLine: boolean;
  companions: WidgetCompanion[];
  stickyNoteColors?: string[];
  // The custom theme's accent, the one the Notes app paints from.
  themeAccent?: string;
  onThemeChange: (updates: Partial<AppTheme>) => void;
}

export function HomeScreen({
  onOpenApp,
  onOpenDrawer,
  onLock,
  themeConfig,
  themeMode,
  messagesBadge = 0,
  dockApps,
  widgets,
  widgetSpots,
  quietLine,
  companions,
  stickyNoteColors,
  themeAccent,
  onThemeChange,
}: HomeScreenProps) {
  const colors = themeConfig[themeMode];
  const [pressedAppId, setPressedAppId] = useState<string | null>(null);
  // A long press on the home screen opens the widget sheet, the way a phone's
  // home screen does. Not from inside a text box, where a long press selects,
  // and not on a widget, where a long press picks the widget up to move it.
  const [sheet, setSheet] = useState(false);
  // Back closes the widget sheet rather than putting the whole app away.
  useBackHandler(sheet, () => setSheet(false));
  // Her status sheet, opened from her line on the Status widget, with the
  // status she has now (null for none). Undefined is closed.
  const [statusSheet, setStatusSheet] = useState<OwnerStatus | null | undefined>(undefined);
  useBackHandler(statusSheet !== undefined, () => setStatusSheet(undefined));
  const holdTimer = useRef<number | null>(null);
  const cancelHold = () => { if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; } };
  const holdHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      // Holding a widget lifts that widget instead (HomeWidgets.tsx).
      if ((e.target as HTMLElement).closest('input, textarea, [data-widget-cell]')) return;
      cancelHold();
      holdTimer.current = window.setTimeout(() => { haptic(55); setSheet(true); }, 550);
    },
    onPointerUp: cancelHold,
    onPointerMove: (e: React.PointerEvent) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) cancelHold(); },
    onPointerCancel: cancelHold,
    onPointerLeave: cancelHold,
  };
  const openById = (id: string) => { const app = APPS.find((a) => a.id === id); if (app) onOpenApp(app); };
  // Notes wear the theme's own note colors, the way the Notes app paints them.
  const notePalette = React.useMemo(() => {
    if (stickyNoteColors && stickyNoteColors.length) return stickyNoteColors;
    const accent = (themeAccent || (typeof colors.accent === 'string' ? colors.accent : '')).trim();
    const generated = accent.startsWith('#') ? noteColorsForAccent(accent, themeMode) : [];
    return generated.length ? generated : ['#FDE68A', '#FBCFE8', '#BFDBFE', '#BBF7D0'];
  }, [stickyNoteColors, themeAccent, colors.accent, themeMode]);
  // False for the whole of the exit animation, while this is still mounted.
  const present = useIsPresent();

  // Press-and-hold shows the tile's accent glow for as long as the finger
  // stays down; the app opens on RELEASE. Click can't do this — Android
  // suppresses the click event after a long-press, which showed the glow
  // and then never opened the app. Pointer events fire regardless of hold
  // duration; sliding off the tile cancels instead of opening.
  const pressHandlers = (id: string, action: () => void) => ({
    // Press tick comes from the global button listener in App.tsx.
    onPointerDown: () => setPressedAppId(id),
    onPointerUp: () => {
      setPressedAppId((current) => {
        if (current === id) {
          haptic(55); // firmer pulse as the app opens
          window.setTimeout(action, 90);
        }
        return current;
      });
    },
    onPointerLeave: () => setPressedAppId((current) => (current === id ? null : current)),
    onPointerCancel: () => setPressedAppId((current) => (current === id ? null : current)),
    // Android long-press otherwise opens the context menu mid-hold.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  return (
    <motion.div
      className={cn('absolute inset-0 z-40 flex flex-col overflow-hidden', colors.textMain)}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.05, transition: { duration: 0.3 } }}
      // On the way out this stays mounted for the length of its fade, at z-40,
      // over a Messages app that lives at z-10 and is already fully painted and
      // tappable. Without this, a tap into the chat input during those 300ms
      // lands on whichever icon happens to sit at those coordinates and opens
      // that app instead. Leaving means leaving: stop taking taps immediately.
      style={{ pointerEvents: present ? undefined : 'none' }}
    >
      {/* Header */}
      <div
        className="z-10 flex w-full items-center justify-end px-6 py-6 gap-3"
        style={{ paddingTop: 'calc(var(--sat) + 1.5rem)' }}
      >
        <button
          onClick={onLock}
          className={cn('bytelight-glass-button p-2 rounded-full opacity-80 hover:opacity-100', colors.textMain)}
          title="Lock Screen"
        >
          <Lock size={18} strokeWidth={1.5} />
        </button>
      </div>

      {/* The middle: the widgets, sitting low so the wallpaper keeps the top,
          and the long press that opens the widget sheet. */}
      <div
        className="flex flex-1 flex-col justify-end px-5"
        style={{ paddingBottom: quietLine ? 150 : 106 }}
        {...holdHandlers}
        onContextMenu={(e) => e.preventDefault()}
      >
        <HomeWidgets
          widgets={widgets}
          spots={widgetSpots}
          companions={companions}
          notePalette={notePalette}
          onOpenAppId={openById}
          onPlace={(layout) => onThemeChange({ homeWidgetSpots: layout })}
          onEditStatus={(current) => setStatusSheet(current)}
        />
      </div>

      {/* Dock — each button gets a fixed width so swapping the theme font
          (sans/serif/mono) can't make the labels widen the row and push
          the dock past the viewport. Long labels truncate; the icon is
          the primary affordance. */}
      <div className="absolute bottom-4 left-0 right-0 flex flex-col items-center gap-2 px-4">
        {quietLine && (
          <div className="w-full max-w-[380px]">
            <QuietLine companions={companions} onOpen={() => openById('messages')} />
          </div>
        )}
        <div className="bytelight-dock flex items-center gap-2 rounded-[1.4rem] px-3 py-2 max-w-full overflow-hidden">
          {/* Quick picks scroll sideways when there are more than fit;
              the Apps launcher stays pinned on the right. */}
          <div
            className="bytelight-dock-scroll flex min-w-0 snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain pt-1"
            style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
          >
          {dockApps.map((app) => (
            <motion.button
              key={`dock-${app.id}`}
              whileHover={{ y: -2 }}
              {...pressHandlers(app.id, () => onOpenApp(app))}
              className="bytelight-dock-button relative flex w-12 shrink-0 snap-start flex-col items-center gap-1"
              data-pressed={pressedAppId === app.id}
              aria-pressed={pressedAppId === app.id}
            >
              <div
                className="bytelight-dock-tile flex h-10 w-10 items-center justify-center rounded-xl"
                data-pressed={pressedAppId === app.id}
              >
                <app.icon className="h-5 w-5" />
              </div>
              {app.id === 'messages' && messagesBadge > 0 && (
                <span
                  className="absolute top-0 -right-0.5 min-w-[16px] h-[16px] rounded-full text-[10px] font-bold flex items-center justify-center px-1 border-2"
                  style={{
                    backgroundColor: colors.accent,
                    color: '#090807',
                    borderColor: 'var(--bytelight-surface-strong)',
                  }}
                >
                  {messagesBadge}
                </span>
              )}
              <span className="bytelight-dock-label w-full truncate text-center text-[8px] font-medium tracking-[0.1em] uppercase opacity-80">{app.name}</span>
            </motion.button>
          ))}
          </div>

          {/* App drawer launcher */}
          <motion.button
            whileHover={{ y: -2 }}
            {...pressHandlers('apps', onOpenDrawer)}
            className="bytelight-dock-button flex w-12 shrink-0 flex-col items-center gap-1 pt-1"
            data-pressed={pressedAppId === 'apps'}
            aria-pressed={pressedAppId === 'apps'}
          >
            <div
              className="bytelight-dock-tile flex h-10 w-10 items-center justify-center rounded-xl"
              data-pressed={pressedAppId === 'apps'}
            >
              <LayoutGrid className="h-5 w-5" />
            </div>
            <span className="bytelight-dock-label w-full truncate text-center text-[8px] font-medium tracking-[0.1em] uppercase opacity-80">Apps</span>
          </motion.button>
        </div>
      </div>
      {sheet && (
        <WidgetSheet
          widgets={widgets}
          quietLine={quietLine}
          onToggle={(id) => onThemeChange({ homeWidgets: toggleWidget(widgets, id) })}
          onQuietLine={(on) => onThemeChange({ homeQuietLine: on })}
          onClose={() => setSheet(false)}
        />
      )}
      {statusSheet !== undefined && (
        <StatusSheet current={statusSheet} onClose={() => setStatusSheet(undefined)} />
      )}
    </motion.div>
  );
}
