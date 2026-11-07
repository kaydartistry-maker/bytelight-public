// Semantic retrieval for the living self-knowledge layer.
//
// Ported from the tris/Aerie fork — commit 67339ed6. byte-light already has an
// embeddings worker (services/embeddings.ts) with the exact API this needs
// (embed / cosineSimilarity / vectorToBuffer / bufferToVector), so the port
// reuses it directly.
//
// ADAPTED FOR OPERATOR'S RULINGS: the source ranked results by
// similarity * 0.65 + effectiveHeat * 0.25 + confidence * 0.10 and filtered
// through isSurfaceable() — all of which belong to the NESTknow heat/confidence
// lifecycle (7ab2b980) that the operator ruled OFF. That scoring and filtering is
// removed. Ranking here is similarity plus an optional keyword boost, over
// accepted entries only.
//
// AUTO-RETRIEVAL STAYS OFF: this index is EXPOSED via a manual API search
// endpoint. Nothing here auto-injects into a companion's prompt. The future
// wiring point (Mind Bridge / Cortex integration) is called out in the slice
// report; do not wire it without that mapping.

import { createHash } from 'crypto';
import { getDb } from './db.js';
import { bufferToVector, cosineSimilarity, embed, vectorToBuffer } from './embeddings.js';
import type { SelfKnowledgeEntry } from './db/self-knowledge.js';

export interface SemanticSelfKnowledgeResult extends SelfKnowledgeEntry {
  similarity: number;
  score: number;
  source: 'semantic' | 'hybrid';
}

const CANDIDATE_THRESHOLD = 0.32;
const ABSTAIN_THRESHOLD = 0.40;
let refreshPromise: Promise<void> | null = null;
let scheduledRefresh: ReturnType<typeof setTimeout> | null = null;

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Rebuild the embedding sidecar: embed any new/changed entry, prune rows whose
 *  entry no longer exists. Non-fatal on failure (search just returns nothing).
 *  Embeds ALL entries regardless of status so an entry is ready the moment it
 *  is accepted; search itself filters to accepted. */
export async function refreshSelfKnowledgeIndex(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const db = getDb();
    const entries = db.prepare('SELECT * FROM self_knowledge').all() as SelfKnowledgeEntry[];
    const existing = new Map((db.prepare(
      'SELECT self_knowledge_id, content_hash FROM self_knowledge_embeddings'
    ).all() as Array<{ self_knowledge_id: string; content_hash: string }>)
      .map(row => [row.self_knowledge_id, row.content_hash]));
    const upsert = db.prepare(`
      INSERT INTO self_knowledge_embeddings (self_knowledge_id, content_hash, vector, indexed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(self_knowledge_id) DO UPDATE SET
        content_hash = excluded.content_hash, vector = excluded.vector, indexed_at = excluded.indexed_at
    `);
    for (const entry of entries) {
      const input = `${entry.category.replaceAll('_', ' ')}: ${entry.content}`;
      const contentHash = hash(input);
      if (existing.get(entry.id) === contentHash) continue;
      upsert.run(entry.id, contentHash, vectorToBuffer(await embed(input)), new Date().toISOString());
    }
    const live = new Set(entries.map(entry => entry.id));
    const remove = db.prepare('DELETE FROM self_knowledge_embeddings WHERE self_knowledge_id = ?');
    for (const id of existing.keys()) if (!live.has(id)) remove.run(id);
  })().catch(error => console.warn('[self-knowledge-index] Refresh failed (non-fatal):', error))
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

/** Debounced refresh — called from the DB layer on any write. */
export function scheduleSelfKnowledgeIndexRefresh(delayMs = 250): void {
  if (scheduledRefresh) clearTimeout(scheduledRefresh);
  scheduledRefresh = setTimeout(() => {
    scheduledRefresh = null;
    void refreshSelfKnowledgeIndex();
  }, delayMs);
  scheduledRefresh.unref?.();
}

/** Rank accepted entries against a query vector. Ranking is similarity plus an
 *  optional keyword boost (the lifecycle heat/confidence terms are removed per
 *  the operator's ruling). Each companion gets one identity slot before any companion
 *  takes two, so a single voice can't crowd the surface. */
export function searchSemanticSelfKnowledge(
  queryVector: Float32Array,
  keywordIds: Set<string> = new Set(),
  limit = 6,
): SemanticSelfKnowledgeResult[] {
  const rows = getDb().prepare(`
    SELECT sk.*, e.vector FROM self_knowledge sk
    JOIN self_knowledge_embeddings e ON e.self_knowledge_id = sk.id
    WHERE sk.status = 'accepted'
  `).all() as Array<SelfKnowledgeEntry & { vector: Buffer }>;
  const ranked = rows.map(row => {
    const { vector, ...entry } = row;
    const similarity = cosineSimilarity(queryVector, bufferToVector(vector));
    const keywordBoost = keywordIds.has(row.id) ? 0.10 : 0;
    return {
      ...entry,
      similarity,
      // Similarity + keyword boost only — no heat/confidence terms (lifecycle
      // ruled off). Keeps the shape (score) so callers can sort/display.
      score: similarity + keywordBoost,
      source: keywordBoost ? 'hybrid' as const : 'semantic' as const,
    };
  }).filter(row => row.similarity >= CANDIDATE_THRESHOLD).sort((a, b) => b.score - a.score);
  if (!ranked.some(row => row.similarity >= ABSTAIN_THRESHOLD)) return [];

  // Give each companion's identity one slot before any companion takes two.
  const selected: SemanticSelfKnowledgeResult[] = [];
  const seenCompanions = new Set<string>();
  for (const row of ranked) {
    if (seenCompanions.has(row.companion_id)) continue;
    selected.push(row);
    seenCompanions.add(row.companion_id);
    if (selected.length >= limit) return selected;
  }
  for (const row of ranked) {
    if (!selected.some(selectedRow => selectedRow.id === row.id)) selected.push(row);
    if (selected.length >= limit) break;
  }
  return selected;
}

/** Convenience for the manual search API: embed the query text, then rank. */
export async function semanticSearchSelfKnowledge(
  queryText: string,
  limit = 6,
): Promise<SemanticSelfKnowledgeResult[]> {
  const q = queryText.trim();
  if (q.length < 2) return [];
  const queryVector = await embed(q);
  return searchSemanticSelfKnowledge(queryVector, new Set(), limit);
}
