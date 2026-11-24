// Her moving wallpaper (Slice 5): an MP4 / WebM video, or a GIF / animated
// WebP, playing behind the whole house.
//
// The file lives on the device as a file (a Blob in localforage, its own
// entry), never inside her theme, so the theme stays light. A still frame is
// taken from it on upload (theme.movingPoster, a small JPEG): it shows while
// the video loads, and it is what painted frost, the lock screen cards and
// the status bar read, so nothing has to read a moving picture.
import localforage from 'localforage';
import { useEffect, useState } from 'react';

const KEY = 'bytelight_moving_wallpaper';
export const MOVING_MAX_BYTES = 20 * 1024 * 1024;

export type MovingKind = 'video' | 'image';
interface Stored { blob: Blob; kind: MovingKind; name: string; type: string }

export function movingKindOf(file: { name: string; type: string }): MovingKind | null {
  const t = (file.type || '').toLowerCase();
  const n = file.name.toLowerCase();
  if (t === 'video/mp4' || t === 'video/webm' || t === 'video/quicktime' || /\.(mp4|m4v|webm|mov)$/.test(n)) return 'video';
  if (t === 'image/gif' || t === 'image/webp' || /\.(gif|webp)$/.test(n)) return 'image';
  return null;
}

let current: { url: string; kind: MovingKind } | null = null;
let loaded = false;
const listeners = new Set<(c: typeof current) => void>();
const emit = () => { for (const l of listeners) l(current); };

function setCurrent(blob: Blob | null, kind: MovingKind | null) {
  if (current) URL.revokeObjectURL(current.url);
  current = blob && kind ? { url: URL.createObjectURL(blob), kind } : null;
  emit();
}

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await localforage.getItem<Stored>(KEY);
    if (saved?.blob) setCurrent(saved.blob, saved.kind);
  } catch {
    /* nothing saved, or storage unavailable: no moving wallpaper */
  }
}

/** Live: the moving wallpaper's playable URL and kind, or null. */
export function useMovingWallpaper(): { url: string; kind: MovingKind } | null {
  const [c, setC] = useState(current);
  useEffect(() => {
    listeners.add(setC);
    void loadOnce().then(() => setC(current));
    return () => { listeners.delete(setC); };
  }, []);
  return c;
}

/** First frame as a small JPEG, for frost / lock cards / status bar / loading. */
async function posterFrom(url: string, kind: MovingKind): Promise<string | null> {
  const draw = (src: CanvasImageSource, w: number, h: number) => {
    if (!w || !h) return null;
    const scale = Math.min(1, 1080 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, c.width, c.height);
    try { return c.toDataURL('image/jpeg', 0.82); } catch { return null; }
  };
  if (kind === 'image') {
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { return null; }
    return draw(img, img.naturalWidth, img.naturalHeight);
  }
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  const ok = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 10000);
    v.onloadeddata = () => { clearTimeout(t); resolve(true); };
    v.onerror = () => { clearTimeout(t); resolve(false); };
  });
  if (!ok) return null;
  // A hair in, so a fade-from-black first frame doesn't become the poster.
  await new Promise<void>((resolve) => {
    v.onseeked = () => resolve();
    try { v.currentTime = Math.min(0.5, (v.duration || 1) / 4); } catch { resolve(); }
    setTimeout(resolve, 1500);
  });
  return draw(v, v.videoWidth, v.videoHeight);
}

export type MovingSaveResult = { ok: true; poster: string } | { ok: false; reason: string };

/** Check, save and switch to a new moving wallpaper. */
export async function saveMovingWallpaper(file: File): Promise<MovingSaveResult> {
  const kind = movingKindOf(file);
  if (!kind) return { ok: false, reason: `${file.name} isn't a video or animated picture. Use MP4, WebM, GIF or animated WebP.` };
  if (file.size > MOVING_MAX_BYTES) {
    return { ok: false, reason: `${file.name} is ${(file.size / 1048576).toFixed(1)} MB. The limit is 20 MB; a gentle 10-20 second loop is usually 3-8 MB.` };
  }
  const probeUrl = URL.createObjectURL(file);
  const poster = await posterFrom(probeUrl, kind);
  URL.revokeObjectURL(probeUrl);
  if (!poster) {
    return {
      ok: false,
      reason: kind === 'video'
        ? `${file.name} won't play on this device. MP4 (H.264) plays everywhere; try converting it to that.`
        : `${file.name} couldn't be read as a picture.`,
    };
  }
  try {
    await localforage.setItem<Stored>(KEY, { blob: file, kind, name: file.name, type: file.type });
  } catch {
    return { ok: false, reason: 'There was no room to save it on this device. Try a smaller file.' };
  }
  loaded = true;
  markMovingTouched();
  setCurrent(file, kind);
  return { ok: true, poster };
}

export async function removeMovingWallpaper() {
  markMovingTouched();
  try { await localforage.removeItem(KEY); } catch { /* already gone */ }
  loaded = true;
  setCurrent(null, null);
}

// ── For the Closet (Slice 6): a look keeps its own copy of the moving file. ──

export type StoredMoving = Stored;

/** The moving wallpaper file currently on this device, or null. */
export async function readMovingFile(): Promise<StoredMoving | null> {
  try {
    const saved = await localforage.getItem<Stored>(KEY);
    return saved?.blob ? saved : null;
  } catch {
    return null;
  }
}

/** Put a look's saved moving file back as the one that plays. */
export async function restoreMovingFile(stored: StoredMoving): Promise<boolean> {
  markMovingTouched();
  try {
    await localforage.setItem<Stored>(KEY, stored);
  } catch {
    return false;
  }
  loaded = true;
  setCurrent(stored.blob, stored.kind);
  return true;
}

// ── Apply (Slice 7): a moving upload inside Settings isn't kept until Apply. ──
// Uploading replaces the file on the device at once, so while Settings is open
// the file that was there is held aside: Discard puts it back (or removes the
// new one if there wasn't one), Apply lets it go.

let draft: { active: boolean; touched: boolean; backup: Stored | null } = { active: false, touched: false, backup: null };

export async function beginMovingDraft() {
  let backup: Stored | null = null;
  try { backup = (await localforage.getItem<Stored>(KEY)) || null; } catch { backup = null; }
  draft = { active: true, touched: false, backup };
}

/** Called by every change to the stored file. */
export function markMovingTouched() {
  if (draft.active) draft.touched = true;
}

export function commitMovingDraft() {
  draft = { active: false, touched: false, backup: null };
}

export async function discardMovingDraft() {
  const d = draft;
  draft = { active: false, touched: false, backup: null };
  if (!d.active || !d.touched) return;
  if (d.backup) {
    try { await localforage.setItem<Stored>(KEY, d.backup); } catch { /* keep what's there */ }
    loaded = true;
    setCurrent(d.backup.blob, d.backup.kind);
  } else {
    try { await localforage.removeItem(KEY); } catch { /* already gone */ }
    loaded = true;
    setCurrent(null, null);
  }
}
