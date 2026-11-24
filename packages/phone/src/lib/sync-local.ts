// Small device-local bookkeeping for sync (Slice 8), kept apart so the font
// and closet stores can use it without importing the sync engine.
const DELETED = 'bytelight_sync_deleted';
const DIRTY = 'bytelight_sync_library_dirty';
const AT = 'bytelight_sync_at';

type Deleted = { fonts: string[]; looks: string[] };

export function readDeleted(): Deleted {
  try {
    const v = JSON.parse(localStorage.getItem(DELETED) || '{}');
    return { fonts: Array.isArray(v.fonts) ? v.fonts : [], looks: Array.isArray(v.looks) ? v.looks : [] };
  } catch {
    return { fonts: [], looks: [] };
  }
}

export function writeDeleted(d: Deleted) {
  try { localStorage.setItem(DELETED, JSON.stringify({ fonts: d.fonts.slice(-500), looks: d.looks.slice(-500) })); } catch { /* best effort */ }
}

/** A font or look was deleted here: other devices must drop it too. */
export function recordDeleted(kind: 'fonts' | 'looks', id: string) {
  const d = readDeleted();
  if (!d[kind].includes(id)) d[kind].push(id);
  writeDeleted(d);
  markLibraryDirty();
}

/** Fonts / Closet changed here since the last send. */
export function markLibraryDirty() {
  try { localStorage.setItem(DIRTY, '1'); } catch { /* best effort */ }
}
export function libraryDirty(): boolean {
  try { return localStorage.getItem(DIRTY) === '1'; } catch { return false; }
}
export function clearLibraryDirty() {
  try { localStorage.removeItem(DIRTY); } catch { /* best effort */ }
}

/** The server time of the setup this device last sent or took. */
export function lastSyncAt(): number {
  try { return Number(localStorage.getItem(AT)) || 0; } catch { return 0; }
}
export function setLastSyncAt(t: number) {
  try { localStorage.setItem(AT, String(t)); } catch { /* best effort */ }
}
