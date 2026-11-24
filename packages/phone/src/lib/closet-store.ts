// The Closet's storage (Slice 6). Her saved looks live on the device in their
// own localforage entry; a look with a moving wallpaper also keeps its own
// copy of that file under its id. One device only until the Sync slice.
import localforage from 'localforage';
import { useEffect, useState } from 'react';
import type { AppTheme } from '../types';
import { pickLook, thumbSource, uniqueLookName, type SavedLook } from './closet';
import { readMovingFile, restoreMovingFile, type StoredMoving } from './moving-wallpaper';
import { buildLookFile, lookFileName, type LookFile } from './look-file';
import { markLibraryDirty, recordDeleted } from './sync-local';

const KEY = 'bytelight_closet';
const movingKey = (id: string) => `bytelight_closet_moving_${id}`;

let looks: SavedLook[] = [];
let loaded = false;
const listeners = new Set<(l: SavedLook[]) => void>();
const emit = () => { for (const l of listeners) l(looks); };

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await localforage.getItem<SavedLook[]>(KEY);
    looks = Array.isArray(saved) ? saved : [];
  } catch {
    looks = [];
  }
  emit();
}

async function persist() {
  await localforage.setItem(KEY, looks);
  markLibraryDirty();
}

export function useCloset(): SavedLook[] {
  const [list, setList] = useState<SavedLook[]>(looks);
  useEffect(() => {
    listeners.add(setList);
    void load().then(() => setList(looks));
    return () => { listeners.delete(setList); };
  }, []);
  return list;
}

/** A small JPEG preview (~120x200) of the look's wallpaper, or null. */
async function makeThumb(src: string | null): Promise<string | null> {
  if (!src || typeof document === 'undefined') return null;
  const img = new Image();
  img.src = src;
  try { await img.decode(); } catch { return null; }
  const W = 120, H = 200;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  try { return c.toDataURL('image/jpeg', 0.75); } catch { return null; }
}

async function snapshot(theme: AppTheme, id: string): Promise<Pick<SavedLook, 'look' | 'thumb' | 'hasMoving' | 'bytes'>> {
  const look = pickLook(theme);
  let hasMoving = false;
  let movingBytes = 0;
  if (look.movingWallpaper) {
    const file = await readMovingFile();
    if (file) {
      await localforage.setItem<StoredMoving>(movingKey(id), file);
      hasMoving = true;
      movingBytes = file.blob.size;
    }
  }
  if (!hasMoving) await localforage.removeItem(movingKey(id)).catch(() => {});
  const thumb = await makeThumb(thumbSource(look));
  return { look, thumb, hasMoving, bytes: JSON.stringify(look).length + movingBytes };
}

export type ClosetResult = { ok: true; look: SavedLook } | { ok: false; reason: string };

/** Save what she's wearing now as a new look. */
export async function saveLook(theme: AppTheme, name: string): Promise<ClosetResult> {
  await load();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const snap = await snapshot(theme, id);
    const now = Date.now();
    const saved: SavedLook = { id, name: uniqueLookName(name, looks), ...snap, createdAt: now, updatedAt: now };
    looks = [...looks, saved];
    await persist();
    emit();
    return { ok: true, look: saved };
  } catch {
    await localforage.removeItem(movingKey(id)).catch(() => {});
    return { ok: false, reason: "There wasn't room to save this look on the device. Deleting an old look (especially one with a moving wallpaper) frees space." };
  }
}

/** Save what she's wearing now over an existing look. */
export async function updateLook(id: string, theme: AppTheme): Promise<ClosetResult> {
  await load();
  const i = looks.findIndex((l) => l.id === id);
  if (i < 0) return { ok: false, reason: 'That look is gone.' };
  try {
    const snap = await snapshot(theme, id);
    const next = { ...looks[i], ...snap, updatedAt: Date.now() };
    looks = looks.map((l) => (l.id === id ? next : l));
    await persist();
    emit();
    return { ok: true, look: next };
  } catch {
    return { ok: false, reason: "There wasn't room to update this look on the device." };
  }
}

export async function renameLook(id: string, name: string) {
  await load();
  const others = looks.filter((l) => l.id !== id);
  looks = looks.map((l) => (l.id === id ? { ...l, name: uniqueLookName(name, others), updatedAt: Date.now() } : l));
  await persist();
  emit();
}

export async function deleteLook(id: string) {
  recordDeleted('looks', id);
  await load();
  looks = looks.filter((l) => l.id !== id);
  await localforage.removeItem(movingKey(id)).catch(() => {});
  await persist();
  emit();
}

/** Before wearing a look: put its moving file back in place if it has one. */
export async function prepareToWear(look: SavedLook): Promise<boolean> {
  if (!look.hasMoving) return true;
  try {
    const file = await localforage.getItem<StoredMoving>(movingKey(look.id));
    return file ? await restoreMovingFile(file) : false;
  } catch {
    return false;
  }
}

// ── Slice 6b: share and import looks ─────────────────────────────────────


const blobToDataUrl = (b: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(b);
});

/** One saved look as a .bllook file (font names only, never font files). */
export async function exportLook(look: SavedLook): Promise<{ fileName: string; text: string }> {
  let moving: LookFile['moving'];
  if (look.hasMoving) {
    const file = await localforage.getItem<StoredMoving>(movingKey(look.id)).catch(() => null);
    if (file?.blob) moving = { kind: file.kind, name: file.name, data: await blobToDataUrl(file.blob) };
  }
  const out = buildLookFile(look.name, moving ? look.look : { ...look.look, movingWallpaper: false }, moving);
  return { fileName: lookFileName(look.name), text: JSON.stringify(out) };
}

/** Add a checked look file (lib/look-file.ts parseLookFile) to the closet. Never wears it. */
export async function importLook(file: LookFile): Promise<ClosetResult> {
  await load();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    let hasMoving = false;
    let movingBytes = 0;
    if (file.moving) {
      const blob = await (await fetch(file.moving.data)).blob();
      await localforage.setItem<StoredMoving>(movingKey(id), { blob, kind: file.moving.kind, name: file.moving.name, type: blob.type });
      hasMoving = true;
      movingBytes = blob.size;
    }
    const look = hasMoving ? file.look : { ...file.look, movingWallpaper: false };
    const thumb = await makeThumb(thumbSource(look));
    const now = Date.now();
    const saved: SavedLook = { id, name: uniqueLookName(file.name, looks), look, thumb, hasMoving, bytes: JSON.stringify(look).length + movingBytes, createdAt: now, updatedAt: now };
    looks = [...looks, saved];
    await persist();
    emit();
    return { ok: true, look: saved };
  } catch {
    await localforage.removeItem(movingKey(id)).catch(() => {});
    return { ok: false, reason: "There wasn't room to add this look on the device." };
  }
}

// ── Sync (Slice 8) ────────────────────────────────────────────────────────

export async function getLooks(): Promise<SavedLook[]> {
  await load();
  return looks;
}

export async function readMovingCopy(id: string): Promise<StoredMoving | null> {
  try { return (await localforage.getItem<StoredMoving>(movingKey(id))) || null; } catch { return null; }
}

/** Replace the closet with the merged one from sync (with any moving copies). */
export async function setLooksFromSync(next: SavedLook[], movingCopies: Map<string, StoredMoving>) {
  await load();
  const keep = new Set(next.map((l) => l.id));
  for (const l of looks) if (!keep.has(l.id)) await localforage.removeItem(movingKey(l.id)).catch(() => {});
  for (const [id, file] of movingCopies) await localforage.setItem<StoredMoving>(movingKey(id), file);
  looks = next;
  await localforage.setItem(KEY, looks); // not persist(): taking the server's copy isn't a local change
  emit();
}
