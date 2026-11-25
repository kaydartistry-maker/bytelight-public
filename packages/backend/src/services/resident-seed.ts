/**
 * Residents named at setup (the wizard writes `identity.residents` in
 * bytelight.yaml) become companions rows on boot.
 *
 * Phase 1 retired the old fixed seed, so a fresh house starts empty. This is
 * how the companions the owner actually named move in: one row each, on the
 * house's own brain (local-brain.ts), in the order she listed them.
 *
 * INSERT OR IGNORE only. A row that already exists is never renamed, re-brained
 * or deleted from here, so editing the yaml later can add a resident but never
 * rewrites history. Removing someone is a deliberate act elsewhere, not a
 * side effect of a config line going missing.
 */
import type Database from 'better-sqlite3';

export interface ResidentEntry {
  id?: string;
  name: string;
}

/** A display name turned into a stable companion id: "Jace" → "jace". */
export function residentIdFor(name: string): string {
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** Clean the yaml list: names trimmed, ids derived, blanks and repeats dropped. */
export function normalizeResidents(raw: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const name = typeof item === 'string' ? item.trim()
      : item && typeof item === 'object' && typeof (item as ResidentEntry).name === 'string' ? (item as ResidentEntry).name.trim()
      : '';
    if (!name) continue;
    const given = item && typeof item === 'object' && typeof (item as ResidentEntry).id === 'string' ? (item as ResidentEntry).id!.trim() : '';
    const id = given || residentIdFor(name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/** Seat the configured residents as companions rows. Returns how many were new. */
export function seedResidentsFromConfig(db: Database.Database, raw: unknown, brain: string): number {
  const list = normalizeResidents(raw);
  if (!list.length || !brain) return 0;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO companions (id, display_name, avatar, brain, model, sort_order, created_at) VALUES (?, ?, NULL, ?, NULL, ?, datetime('now'))",
  );
  let added = 0;
  db.transaction(() => {
    list.forEach((r, i) => { added += insert.run(r.id, r.name, brain, i).changes; });
  })();
  return added;
}
