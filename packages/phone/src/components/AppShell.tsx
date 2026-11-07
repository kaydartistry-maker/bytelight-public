import React from 'react';
import { motion, useIsPresent } from 'motion/react';
import { ChevronLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';

interface AppShellProps {
  title: string;
  icon?: LucideIcon;
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  headerRight?: React.ReactNode;
  bodyClassName?: string;
  children: React.ReactNode;
  /**
   * When true, render only the body content (no outer chrome, header, or
   * scroll container). Used by grouped wrapper apps (Status, Integrations,
   * Agent) that supply their own AppShell + tab strip and embed several
   * standalone apps inside.
   */
  embedded?: boolean;
}

// Shared chrome for feature-apps: a back-button header and a scrollable body.
export function AppShell({ title, icon: Icon, onClose, themeConfig, themeMode, headerRight, bodyClassName, children, embedded }: AppShellProps) {
  const colors = themeConfig[themeMode];
  // False for the whole of the exit animation, while this is still mounted.
  const present = useIsPresent();

  if (embedded) {
    return <>{children}</>;
  }

  return (
    // No opaque surface here — the wallpaper (App.tsx z-0) shows through
    // app bodies by design; only the drawer paints its own background.
    <motion.div
      className={cn('absolute inset-0 z-40 flex flex-col', colors.textMain)}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.03, transition: { duration: 0.25 } }}
      // Still mounted at z-40 through the fade, over a Messages app at z-10
      // that is already painted and tappable. Leaving means leaving.
      style={{ pointerEvents: present ? undefined : 'none' }}
    >
      <header
        className={cn('bytelight-shell-header flex items-center gap-2 px-3 pb-3', colors.pageBg)}
        style={{ paddingTop: 'calc(var(--sat) + 0.75rem)' }}
      >
        <button
          onClick={onClose}
          className={cn('rounded-full p-2 -ml-1 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
        >
          <ChevronLeft size={20} />
        </button>
        {Icon && <Icon size={18} className={colors.textMuted} />}
        <h1 className={cn('text-base font-semibold', colors.textMain)}>{title}</h1>
        <div className="ml-auto flex items-center gap-1">{headerRight}</div>
      </header>
      <div className={cn('bytelight-app-body min-h-0 flex-1 overflow-y-auto scrollbar-hide px-4 py-4', bodyClassName)}>{children}</div>
    </motion.div>
  );
}
