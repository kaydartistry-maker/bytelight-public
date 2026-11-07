// Sticker pack cache shared by the chat composer's picker and the
// MessageBubble inline-ref renderer. The backend persists packs +
// stickers — we just mirror them client-side.

import { apiFetch } from './api';

export interface BackendSticker {
  id: string;
  name: string;
  filename: string;
  pack_id: string;
  url: string;
  created_at: string;
  aliases?: string[];
}

// Main's /api/stickers/packs-with-stickers answers with a flat list — one row
// per sticker carrying its pack's name — not packs with stickers nested. Fold
// it back into packs so every reader here keeps one shape.
interface FlatStickerRow extends BackendSticker {
  pack_name: string;
}

function foldFlatRows(rows: FlatStickerRow[]): BackendStickerPack[] {
  const byId = new Map<string, BackendStickerPack>();
  for (const row of rows) {
    let pack = byId.get(row.pack_id);
    if (!pack) {
      pack = { id: row.pack_id, name: row.pack_name, stickers: [] };
      byId.set(row.pack_id, pack);
    }
    pack.stickers!.push(row);
  }
  return [...byId.values()];
}

function toPacks(data: unknown): BackendStickerPack[] {
  if (!Array.isArray(data)) return [];
  if (data.length > 0 && 'pack_name' in (data[0] as object)) return foldFlatRows(data as FlatStickerRow[]);
  return data as BackendStickerPack[];
}

export interface BackendStickerPack {
  id: string;
  name: string;
  description?: string;
  stickers?: BackendSticker[];
}

let cachedPacks: BackendStickerPack[] = [];
let inflight: Promise<BackendStickerPack[]> | null = null;
let loaded = false;

// Map `${packName}_${stickerName}` → url for fast inline rendering. Keys are
// lowercased and include aliases, the same lookup main's Svelte client and the
// companions' prompt use (`:packname_stickername:`, aliases also work).
let refIndex: Map<string, string> = new Map();

// Anything showing stickers needs telling when this cache changes, not just the
// thing that asked for the change. The sticker SHEET refreshes itself on open,
// which fixed the sheet — and the composer's `::` tray reads the same cache and
// was never told, so a sticker uploaded in Packs stayed missing from the tray
// until the whole app was reloaded. One cache, several readers, one signal.
type StickerListener = () => void;
const listeners = new Set<StickerListener>();

export function subscribeStickers(listener: StickerListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function rebuildIndex() {
  refIndex = new Map();
  for (const pack of cachedPacks) {
    for (const sticker of pack.stickers || []) {
      const packName = pack.name.toLowerCase();
      refIndex.set(`${packName}_${sticker.name.toLowerCase()}`, sticker.url);
      for (const alias of sticker.aliases || []) {
        refIndex.set(`${packName}_${alias.toLowerCase()}`, sticker.url);
      }
    }
  }
  for (const listener of listeners) {
    try { listener(); } catch { /* a bad listener must not poison a refresh */ }
  }
}

export async function loadStickers(force = false): Promise<BackendStickerPack[]> {
  if (loaded && !force && cachedPacks.length > 0) return cachedPacks;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await apiFetch('/api/stickers/packs-with-stickers');
      if (!res.ok) throw new Error(`Stickers fetch failed: ${res.status}`);
      cachedPacks = toPacks(await res.json());
      rebuildIndex();
      loaded = true;
      return cachedPacks;
    } catch (err) {
      console.warn('[Bytelight] Stickers fetch failed:', err);
      return cachedPacks;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getStickerPacks(): BackendStickerPack[] {
  return cachedPacks;
}

export function resolveStickerRef(ref: string): string | null {
  return refIndex.get(ref.toLowerCase()) || null;
}
