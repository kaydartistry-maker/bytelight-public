// How a typed sticker ref (`:pack_sticker:`) is read.
//
// A sticker's own name can carry underscores (`Kay_heart_hands`), so the
// pack/sticker boundary is not knowable from the text alone. Every split is
// offered, first underscore first, and the caller keeps the first one that
// names a real sticker. Splitting only at the last underscore (the old
// greedy pattern) read `Kay_heart_hands` as pack "Kay_heart", which never
// matched, so the picture was silently dropped.

/** A colon-wrapped token with at least one underscore inside. */
export const STICKER_TOKEN = /:([A-Za-z0-9-]+(?:_[A-Za-z0-9-]*)+):/g;

/** Every [pack, sticker] reading of a token body, first underscore first. */
export function stickerRefSplits(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = body.indexOf('_'); i !== -1; i = body.indexOf('_', i + 1)) {
    const pack = body.slice(0, i);
    const name = body.slice(i + 1);
    if (pack && name) out.push([pack, name]);
  }
  return out;
}

/** The first reading the lookup recognises, or null. */
export function resolveStickerRef<T>(body: string, lookup: (pack: string, name: string) => T | null): T | null {
  for (const [pack, name] of stickerRefSplits(body)) {
    let hit: T | null = null;
    try { hit = lookup(pack, name); } catch { hit = null; }
    if (hit) return hit;
  }
  return null;
}
