import type { AppTheme } from '../types';

/** The server normally holds a complete snapshot. Missing optional fields in
 * that snapshot are removals, not permission to resurrect an older cache.
 * Partial historical payloads retain their former merge behavior. */
export function reconcileThemeSnapshot(current: AppTheme, incoming: AppTheme, defaults: AppTheme): AppTheme {
  const complete = incoming && (incoming.mode === 'light' || incoming.mode === 'dark') && typeof incoming.id === 'string' && incoming.id.length > 0;
  return { ...(complete ? defaults : current), ...incoming };
}

/** Large/possibly stale wallpapers still wait for IndexedDB/server hydration.
 * Newly uploaded wallpaper IDs follow the same rule as legacy data URLs. */
export function themeFirstPaintCache(theme: AppTheme): AppTheme {
  const cache = { ...theme };
  delete cache.wallpaper;
  delete cache.lockScreenWallpaper;
  delete cache.wallpapers;
  if (cache.appearance?.wallpaper?.assetId) {
    cache.appearance = { ...cache.appearance, wallpaper: { ...cache.appearance.wallpaper } };
    delete cache.appearance.wallpaper!.assetId;
  }
  return cache;
}
