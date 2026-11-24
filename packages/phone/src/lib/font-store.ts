// Her uploaded fonts (Slice 4): kept on the device in their own localforage
// entry (not inside the theme, so the theme stays light) and registered with
// the browser through the FontFace API every time the app opens. One device
// only until the Sync slice moves them to the server.
import localforage from 'localforage';
import { useEffect, useState } from 'react';
import type { UserFont } from './fonts';
import { markLibraryDirty, recordDeleted } from './sync-local';

const KEY = 'bytelight_fonts';
let fonts: UserFont[] = [];
let loaded = false;
const listeners = new Set<(f: UserFont[]) => void>();
const registered = new Map<string, FontFace>();

function emit() {
  for (const l of listeners) l(fonts);
}

/** The font file's bytes from its data URL, whatever type label it carries. */
function bytesOf(dataUrl: string): ArrayBuffer | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) return null;
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  } catch {
    return null;
  }
}

/** Result of trying to use a font: ok, or the browser's own reason it refused. */
export type FontLoadResult = { ok: true } | { ok: false; reason: string };

async function register(f: UserFont): Promise<FontLoadResult> {
  if (typeof document === 'undefined' || !('fonts' in document)) return { ok: false, reason: 'this browser cannot add fonts' };
  if (registered.has(f.id)) return { ok: true };
  // Slice 4b: load from the raw bytes, not a URL, so the file's type label
  // (or a missing one) can't matter. And keep the browser's reason when it
  // refuses, so the card can say what actually went wrong.
  const bytes = bytesOf(f.data);
  if (!bytes || bytes.byteLength === 0) return { ok: false, reason: 'the file came through empty' };
  try {
    const face = new FontFace(f.family, bytes, { display: 'swap' });
    await face.load();
    document.fonts.add(face);
    registered.set(f.id, face);
    return { ok: true };
  } catch (e) {
    const why = e instanceof Error && e.message ? e.message : String(e);
    return { ok: false, reason: why || 'the browser could not read it as a font' };
  }
}

function unregister(id: string) {
  const face = registered.get(id);
  if (face && typeof document !== 'undefined') document.fonts.delete(face);
  registered.delete(id);
}

/** Called once at app start: load her fonts from the device and register them. */
export async function loadUserFonts(): Promise<UserFont[]> {
  if (loaded) return fonts;
  loaded = true;
  try {
    const saved = await localforage.getItem<UserFont[]>(KEY);
    fonts = Array.isArray(saved) ? saved.filter((f) => f && typeof f.family === 'string' && typeof f.data === 'string') : [];
  } catch {
    fonts = [];
  }
  await Promise.all(fonts.map((f) => register(f)));
  emit();
  return fonts;
}

async function persist() {
  try {
    await localforage.setItem(KEY, fonts);
  } catch (e) {
    console.error('Failed to save fonts:', e);
  }
}

/** Add one font. Not added (with the reason) if the browser can't use it. */
export async function addUserFont(f: UserFont): Promise<FontLoadResult> {
  const res = await register(f);
  if (!res.ok) return res;
  fonts = [...fonts, f];
  emit();
  await persist();
  markLibraryDirty();
  return res;
}

export async function removeUserFont(id: string) {
  recordDeleted('fonts', id);
  unregister(id);
  fonts = fonts.filter((f) => f.id !== id);
  emit();
  await persist();
}

export async function setUserFontRole(id: string, role: UserFont['role']) {
  fonts = fonts.map((f) => (f.id === id ? { ...f, role } : f));
  emit();
  await persist();
  markLibraryDirty();
}

// ── Sync (Slice 8) ────────────────────────────────────────────────────────

export async function getUserFonts(): Promise<UserFont[]> {
  await loadUserFonts();
  return fonts;
}

/** Replace the library with the merged one from sync; registers what's new. */
export async function setUserFontsFromSync(next: UserFont[]) {
  await loadUserFonts();
  const keep = new Set(next.map((f) => f.id));
  for (const f of fonts) if (!keep.has(f.id)) unregister(f.id);
  const ok: UserFont[] = [];
  for (const f of next) if ((await register(f)).ok) ok.push(f);
  fonts = ok;
  emit();
  await persist();
}

/** React hook: her current font list, kept live. */
export function useUserFonts(): UserFont[] {
  const [list, setList] = useState<UserFont[]>(fonts);
  useEffect(() => {
    listeners.add(setList);
    void loadUserFonts().then(setList);
    return () => { listeners.delete(setList); };
  }, []);
  return list;
}
