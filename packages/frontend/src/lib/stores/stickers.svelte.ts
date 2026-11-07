// Sticker store — state management and ref map for inline sticker rendering
// Ported from reference implementation (reference implementation-Resonant)

import type { Sticker, StickerPack } from '@bytelight/shared';
import { apiFetch } from '$lib/utils/api';

let packs = $state<StickerPack[]>([]);
let stickers = $state<Sticker[]>([]);
let loaded = $state(false);

let stickerRefMap = $state<Map<string, string>>(new Map());

function rebuildRefMap() {
  const map = new Map<string, string>();
  const packNames = new Map(packs.map(p => [p.id, p.name.toLowerCase()]));
  for (const s of stickers) {
    const packName = packNames.get(s.pack_id);
    if (!packName) continue;
    map.set(`:${packName}_${s.name.toLowerCase()}:`, s.url);
    for (const alias of s.aliases) {
      map.set(`:${packName}_${alias.toLowerCase()}:`, s.url);
    }
  }
  stickerRefMap = map;
}

export async function loadStickers(): Promise<void> {
  try {
    const [packsRes, stickersRes] = await Promise.all([
      apiFetch('/api/sticker-packs'),
      apiFetch('/api/stickers'),
    ]);
    if (packsRes.ok) {
      const data = await packsRes.json();
      packs = data.packs || [];
    }
    if (stickersRes.ok) {
      const data = await stickersRes.json();
      stickers = data.stickers || [];
    }
    rebuildRefMap();
    loaded = true;
  } catch (err) {
    console.error('Failed to load stickers:', err);
  }
}

export async function refreshStickers(): Promise<void> {
  await loadStickers();
}

export function getStickerUrl(ref: string): string | null {
  return stickerRefMap.get(ref.toLowerCase()) || null;
}

export function getStickerRefMap(): Map<string, string> {
  return stickerRefMap;
}

export function getStickerPacks() { return packs; }
export function getAllStickers() { return stickers; }
export function getStickersForPack(packId: string) { return stickers.filter(s => s.pack_id === packId); }
export function isStickersLoaded() { return loaded; }

// Match exactly `:packname_stickername:` (with optional whitespace) and nothing else.
const STANDALONE_STICKER_RE = /^\s*(:[a-z0-9_-]+_[a-z0-9_-]+:)\s*$/i;
export function detectStandaloneSticker(text: string): { ref: string; url: string } | null {
  const m = text.match(STANDALONE_STICKER_RE);
  if (!m) return null;
  const url = stickerRefMap.get(m[1].toLowerCase());
  return url ? { ref: m[1], url } : null;
}

// Find all `:packname_stickername:` refs and the matching items, for autocomplete.
export function findStickerMatches(query: string, limit = 8): Array<{ ref: string; url: string; name: string; packName: string }> {
  const q = query.trim().toLowerCase().replace(/^:/, '');
  if (!q) return [];
  const out: Array<{ ref: string; url: string; name: string; packName: string }> = [];
  const packNames = new Map(packs.map(p => [p.id, p.name.toLowerCase()]));
  for (const s of stickers) {
    const packName = packNames.get(s.pack_id) || '';
    const fullName = `${packName}_${s.name.toLowerCase()}`;
    const aliases = s.aliases.map(a => `${packName}_${a.toLowerCase()}`);
    if (fullName.includes(q) || aliases.some(a => a.includes(q))) {
      out.push({
        ref: `:${packName}_${s.name}:`,
        url: s.url,
        name: s.name,
        packName,
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}
