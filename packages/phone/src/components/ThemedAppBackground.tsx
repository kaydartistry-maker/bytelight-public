import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { normalizeThemeAppearance } from '@bytelight/shared';
import type { AppTheme } from '../types';
import { themeAssetUrl } from '../lib/appearance-css';

// Legacy uploads may be data URLs or remote images. New appearance assets are
// always opaque server IDs. Never allow active schemes or interpolate raw CSS.
export function safeWallpaperSource(value: unknown): string | undefined {
  return typeof value === 'string' && (/^https?:\/\//i.test(value) || /^data:image\/[a-z\d.+-]+[;,]/i.test(value)
    || /^blob:https?:\/\//i.test(value) || /^\/(?!\/)/.test(value)) ? value : undefined;
}

export const AppBackground = React.memo(function AppBackground({ theme }: { theme: AppTheme }) {
  const [slideshowIndex, setSlideshowIndex] = useState(0);
  const settings = normalizeThemeAppearance(theme.appearance);
  const wallpaper = settings.wallpaper;
  const reduced = useReducedMotion();
  const interval = (wallpaper?.slideshowInterval ?? 10) * 1000;
  const wallpapers = theme.wallpapers;
  const slideshow = !wallpaper?.assetId && theme.slideshowEnabled && !!wallpapers?.length;
  useEffect(() => {
    if (!slideshow || !wallpapers || wallpapers.length <= 1) return;
    const timer = setInterval(() => setSlideshowIndex(value => (value + 1) % wallpapers.length), interval);
    return () => clearInterval(timer);
  }, [slideshow, wallpapers, interval]);
  const source = wallpaper?.assetId ? themeAssetUrl(wallpaper.assetId)
    : safeWallpaperSource(slideshow ? wallpapers![slideshowIndex % wallpapers!.length] : theme.wallpaper);
  if (!source) return null;
  const opacity = (wallpaper?.opacity ?? 80) / 100;
  const animate = slideshow && !reduced && settings.motion?.enabled !== false && settings.motion?.wallpaper !== false
    && settings.motion?.reduceMotion !== true;
  const scale = (settings.motion?.scale ?? theme.fx?.motion ?? 100) / 100;
  const duration = animate ? (wallpaper?.transitionDuration ?? (settings.motion?.duration === undefined ? 0.5 : settings.motion.duration / 1000)) * scale : 0;
  const style: React.CSSProperties = {
    objectFit: wallpaper?.fit === 'stretch' ? 'fill' : wallpaper?.fit ?? 'cover',
    objectPosition: `${wallpaper?.positionX ?? 50}% ${wallpaper?.positionY ?? 50}%`,
    transform: wallpaper?.zoom === undefined ? undefined : `scale(${wallpaper.zoom / 100})`,
    filter: wallpaper?.blur === undefined ? undefined : `blur(${wallpaper.blur}px)`,
    mixBlendMode: wallpaper?.blend,
  };
  const repeating = wallpaper?.repeat && wallpaper.repeat !== 'none';
  return <>
    <AnimatePresence>
      {repeating ? <motion.div key={source} data-appearance-wallpaper aria-hidden="true"
        initial={slideshow ? { opacity: 0 } : false} animate={{ opacity }} exit={{ opacity: 0 }} transition={{ duration }}
        className="absolute inset-0 z-0 pointer-events-none w-full h-full"
        style={{ ...style, backgroundImage: `url(${JSON.stringify(source)})`,
          backgroundRepeat: wallpaper.repeat, backgroundPosition: style.objectPosition,
          backgroundSize: wallpaper.fit === 'stretch' ? '100% 100%' : wallpaper.fit ?? 'auto' }} />
      : <motion.img key={source} data-appearance-wallpaper
        initial={slideshow ? { opacity: 0 } : false} animate={{ opacity }} exit={{ opacity: 0 }} transition={{ duration }}
        className="absolute inset-0 z-0 pointer-events-none w-full h-full object-cover"
        src={source} alt={slideshow ? 'Slideshow' : 'Wallpaper'} referrerPolicy="no-referrer" style={style} />}
    </AnimatePresence>
    {!!wallpaper?.dim && <span aria-hidden="true" data-appearance-wallpaper-dim className="absolute inset-0 z-0 pointer-events-none"
      style={{ backgroundColor: '#000', opacity: wallpaper.dim / 100 }} />}
    {wallpaper?.colorWash?.color && <span aria-hidden="true" data-appearance-wallpaper-wash className="absolute inset-0 z-0 pointer-events-none"
      style={{ backgroundColor: wallpaper.colorWash.color, opacity: (wallpaper.colorWash.opacity ?? 100) / 100 }} />}
  </>;
});
