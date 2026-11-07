// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// How the lock screen's cards look (the owner's idea, Oct 20 2026, after the Spotify
// card came out the theme's light surface in Daylight while the other two
// stayed dark). One switch in Settings > Lock
// screen sets the message card, the note card and the Spotify card at once:
// dark (the see-through black they have always been, light words), light (a
// see-through white with dark words, for a light wallpaper), or auto (a companion's
// offer: read the wallpaper behind the cards and pick). A dark or light the owner
// chose overrules auto. Unset is dark, so nothing the owner already has changes.
//
// Nothing here is blurred: a card is a see-through tint over their wallpaper.

import { useEffect, useState } from 'react';

export type LockCardLook = 'dark' | 'light';
export type LockCardChoice = LockCardLook | 'auto';

/** The owner switch. Unset, or anything that is not one of the three, is dark. */
export function lockCardsOf(value: unknown): LockCardChoice {
  return value === 'light' || value === 'auto' ? value : 'dark';
}

/** Each look as the cards wear it: the card, its quieter words, its first line, a face's ring when the face has no color, and the sheet under a card's buttons. */
export const LOCK_CARD_LOOKS = {
  dark: {
    card: 'border-white/15 bg-black/45 text-white',
    muted: 'text-white/60',
    line: 'text-white/75',
    ring: 'rgba(255,255,255,0.6)',
    face: 'bg-black',
    sheet: 'oklch(1 0 0 / 0.14)',
  },
  light: {
    card: 'border-black/10 bg-white/75 text-neutral-900',
    muted: 'text-neutral-900/60',
    line: 'text-neutral-900/75',
    ring: 'rgba(23,23,23,0.45)',
    face: 'bg-white',
    sheet: 'oklch(0 0 0 / 0.08)',
  },
} as const satisfies Record<LockCardLook, Record<string, string>>;

// ─── Reading the wallpaper (auto) ────────────────────────────────────

/** How light a wallpaper has to be behind the cards, as CIE L* (0 black, 100 white), for light cards. Mid gray is about 54. */
export const LIGHT_WALLPAPER_L = 60;

/**
 * The part of the picture that sits behind the cards, in the picture's own
 * pixels: the lower half of the screen, inside the cards' side margins. The
 * lock screen draws its wallpaper the way CSS `background-size: cover;
 * background-position: center` does, so the picture is scaled to cover the
 * screen and centered, and this works out which pixels land where.
 */
export function behindTheCards(
  picture: { width: number; height: number },
  screen: { width: number; height: number },
  margin = 20,
): { sx: number; sy: number; sw: number; sh: number } | null {
  if (!(picture.width > 0 && picture.height > 0 && screen.width > 0 && screen.height > 0)) return null;
  const scale = Math.max(screen.width / picture.width, screen.height / picture.height);
  const left = (screen.width - picture.width * scale) / 2;
  const top = (screen.height - picture.height * scale) / 2;
  const fromX = Math.min(margin, screen.width / 2);
  const toX = Math.max(screen.width - margin, screen.width / 2);
  const sx = (fromX - left) / scale;
  const sy = (screen.height / 2 - top) / scale;
  const sw = (toX - fromX) / scale;
  const sh = (screen.height / 2) / scale;
  return { sx, sy, sw, sh };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Light or dark, from RGBA pixels (as a canvas hands them out): the average
 * lightness, CIE L*, of what shows. A see-through pixel shows the black the
 * lock screen sits on, so it counts as that much darker. The picture is judged
 * as the owner chose it, not as the lock screen dims it, so a light wallpaper reads
 * as light.
 */
export function lookFromPixels(data: ArrayLike<number>): LockCardLook {
  let total = 0;
  let count = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    const y = 0.2126 * toLinear((data[i] / 255) * alpha) + 0.7152 * toLinear((data[i + 1] / 255) * alpha) + 0.0722 * toLinear((data[i + 2] / 255) * alpha);
    total += y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
    count += 1;
  }
  if (count === 0) return 'dark';
  return total / count >= LIGHT_WALLPAPER_L ? 'light' : 'dark';
}

/** What each wallpaper read as, so the cards never flash the wrong look on the lock screen's next showing. */
const seen = new Map<string, LockCardLook>();

/**
 * Read a wallpaper behind the cards, in a small canvas. Null when it cannot
 * be read (no picture, a picture that will not load, or one from somewhere
 * that will not let its pixels be read): the cards then stay dark.
 */
export function readWallpaperLook(url: string, screen: { width: number; height: number }): Promise<LockCardLook | null> {
  const known = seen.get(url);
  if (known) return Promise.resolve(known);
  if (typeof Image === 'undefined' || typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const picture = new Image();
    picture.decoding = 'async';
    picture.onload = () => {
      try {
        const rect = behindTheCards({ width: picture.naturalWidth, height: picture.naturalHeight }, screen);
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const pen = canvas.getContext('2d', { willReadFrequently: true });
        if (!rect || !pen) return resolve(null);
        pen.drawImage(picture, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
        const look = lookFromPixels(pen.getImageData(0, 0, canvas.width, canvas.height).data);
        seen.set(url, look);
        resolve(look);
      } catch {
        resolve(null);
      }
    };
    picture.onerror = () => resolve(null);
    picture.src = url;
  });
}

/** The look the cards wear now: theirs when the owner chose dark or light, else what the wallpaper reads as (dark until it has been read). */
export function useLockCardLook(choice: LockCardChoice, wallpaper: string | undefined): LockCardLook {
  const [read, setRead] = useState<{ url: string; look: LockCardLook } | null>(() => {
    const known = wallpaper ? seen.get(wallpaper) : undefined;
    return wallpaper && known ? { url: wallpaper, look: known } : null;
  });
  useEffect(() => {
    if (choice !== 'auto' || !wallpaper) return;
    let gone = false;
    void readWallpaperLook(wallpaper, { width: window.innerWidth, height: window.innerHeight }).then((look) => {
      if (!gone) setRead(look ? { url: wallpaper, look } : null);
    });
    return () => {
      gone = true;
    };
  }, [choice, wallpaper]);
  if (choice !== 'auto') return choice;
  return read && read.url === wallpaper ? read.look : 'dark';
}
