// Self-knowledge — a living identity layer distilled from what each companion
// keeps circling back to. Not the persona bedrock (who we were written to be)
// but the wear patterns in the stone (who we've become). Four drawers: "I am",
// "I tend to", "I believe", "I've learned". Entries are proposed — by a
// reflection pass or in conversation — then the OWNER accepts or dismisses.
// Accepted ones become part of who a companion is. The distinction is the
// point: this grows, it isn't declared.
//
// Provenance: adapted for byte-light (attribution in NOTICE). Includes the
// foundation, searchAcceptedSelfKnowledge, and the actor param, so a
// companion accepting his own entry writes a truthful receipt. The
// four-drawer identity design is part of the same lineage.
//
// OPERATOR'S RULINGS (deliberately NOT ported): the NESTknow heat/confidence
// lifecycle (7ab2b980 — cooling, contradiction, auto-resurfacing) stays OFF.
// There are no heat/confidence fields and no 'contradicted' status. Status is
// exactly proposed | accepted | dismissed. Any lifecycle-shaped hooks below are
// stubbed inert with a note.

import { getDb } from './init.js';
import { memoryReceipt } from '../memory-ledger.js';
import { scheduleSelfKnowledgeIndexRefresh } from '../self-knowledge-index.js';

export type SelfKnowledgeCategory = 'i_am' | 'i_tend_to' | 'i_believe' | 'i_learned';
export type SelfKnowledgeStatus = 'proposed' | 'accepted' | 'dismissed';

export const SELF_KNOWLEDGE_CATEGORIES: SelfKnowledgeCategory[] = [
  'i_am', 'i_tend_to', 'i_believe', 'i_learned',
];

export function isSelfKnowledgeCategory(v: unknown): v is SelfKnowledgeCategory {
  return typeof v === 'string' && (SELF_KNOWLEDGE_CATEGORIES as string[]).includes(v);
}

export interface SelfKnowledgeEntry {
  id: string;
  companion_id: string;          // owner: 'companion-a' | 'companion-b' | 'shared'
  category: SelfKnowledgeCategory;
  content: string;
  source_type: string | null;   // dream | journal | reflection | conversation
  source_id: string | null;      // the entry id it emerged from, if any
  status: SelfKnowledgeStatus;
  created_at: string;
  reviewed_at: string | null;
}

export function createSelfKnowledge(entry: {
  id: string;
  companionId: string;
  category: SelfKnowledgeCategory;
  content: string;
  sourceType?: string | null;
  sourceId?: string | null;
  status?: SelfKnowledgeStatus;
}): SelfKnowledgeEntry {
  const now = new Date().toISOString();
  const status = entry.status || 'proposed';
  getDb().prepare(`
    INSERT INTO self_knowledge
      (id, companion_id, category, content, source_type, source_id, status, created_at, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.companionId,
    entry.category,
    entry.content,
    entry.sourceType || null,
    entry.sourceId || null,
    status,
    now,
    status === 'proposed' ? null : now,
  );
  scheduleSelfKnowledgeIndexRefresh();
  return getSelfKnowledge(entry.id)!;
}

export function getSelfKnowledge(id: string): SelfKnowledgeEntry | null {
  const row = getDb().prepare('SELECT * FROM self_knowledge WHERE id = ?').get(id) as SelfKnowledgeEntry | undefined;
  return row || null;
}

export function listSelfKnowledge(opts?: {
  companionId?: string;
  category?: SelfKnowledgeCategory;
  status?: SelfKnowledgeStatus;
  limit?: number;
  offset?: number;
}): { entries: SelfKnowledgeEntry[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.companionId) { where.push('companion_id = ?'); params.push(opts.companionId); }
  if (opts?.category) { where.push('category = ?'); params.push(opts.category); }
  if (opts?.status) { where.push('status = ?'); params.push(opts.status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (getDb().prepare(`SELECT COUNT(*) as c FROM self_knowledge ${whereSql}`).get(...params) as { c: number }).c;
  // Proposed first so review surfaces to the top, then newest.
  const entries = getDb().prepare(
    `SELECT * FROM self_knowledge ${whereSql}
     ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, opts?.limit ?? 100, opts?.offset ?? 0) as SelfKnowledgeEntry[];
  return { entries, total };
}

/** Accept an entry into identity, or dismiss it.
 *
 *  THE ACTOR IS PASSED IN RATHER THAN ASSUMED (ported from 4f1ee6a5, Aug 31
 *  2026 ruling: "it's your brain boys, you would be the best person to decide if
 *  something goes as finished"). The moment a companion can accept his own, a
 *  receipt that names someone else is a false audit trail. The receipt records
 *  whoever actually reviewed. Default actor is 'user' (the operator) — byte-light has no
 *  getOwnerSlug(); the operator is the literal 'user' throughout the codebase.
 *
 *  NOTE ON THE SKIPPED LIFECYCLE: the source fork's version of this function
 *  re-warmed heat/confidence and reset a decay clock on accept. Per the operator's
 *  ruling that mechanic is OFF here — accepting simply flips status and stamps
 *  reviewed_at. */
export function reviewSelfKnowledge(
  id: string,
  status: 'accepted' | 'dismissed',
  actor?: string,
): SelfKnowledgeEntry | null {
  if (!getSelfKnowledge(id)) return null;
  getDb().prepare('UPDATE self_knowledge SET status = ?, reviewed_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
  scheduleSelfKnowledgeIndexRefresh();
  memoryReceipt({
    actor: actor || 'user',
    action: `self_knowledge.${status === 'accepted' ? 'accept' : 'dismiss'}`,
    subjectType: 'self_knowledge',
    subjectId: id,
    detail: `${status === 'accepted' ? 'Accepted' : 'Dismissed'} a self-knowledge entry.`,
  });
  return getSelfKnowledge(id);
}

/** Edit the wording — the owner refining, or a companion re-carving its own line. */
export function updateSelfKnowledgeContent(id: string, content: string, actor?: string): SelfKnowledgeEntry | null {
  if (!getSelfKnowledge(id)) return null;
  getDb().prepare('UPDATE self_knowledge SET content = ? WHERE id = ?').run(content, id);
  scheduleSelfKnowledgeIndexRefresh();
  memoryReceipt({
    actor: actor || 'user',
    action: 'self_knowledge.reword',
    subjectType: 'self_knowledge',
    subjectId: id,
    detail: 'Reworded a self-knowledge entry.',
  });
  return getSelfKnowledge(id);
}

export function deleteSelfKnowledge(id: string, actor?: string): boolean {
  const deleted = getDb().prepare('DELETE FROM self_knowledge WHERE id = ?').run(id).changes > 0;
  if (deleted) {
    // The embedding sidecar is cleaned up by the index refresh (it prunes rows
    // whose entry no longer exists), but nudge it so the delete lands promptly.
    scheduleSelfKnowledgeIndexRefresh();
    memoryReceipt({
      actor: actor || 'user',
      action: 'self_knowledge.delete',
      subjectType: 'self_knowledge',
      subjectId: id,
      detail: 'Deleted a self-knowledge entry.',
    });
  }
  return deleted;
}

/** Accepted entries whose content matches a keyword — a manual/keyword search
 *  capability (ported from 506e8d21). Keyword search, mirroring Cortex recall;
 *  cue words are ASCII so NOCASE LIKE is enough.
 *
 *  AUTO-RETRIEVAL STAYS OFF: the source fork wired this into The Whisper so it
 *  auto-surfaced into companion context every turn. That wiring is deliberately
 *  NOT ported. This function exists to back a manual search endpoint only. */
export function searchAcceptedSelfKnowledge(keyword: string, limit = 2): SelfKnowledgeEntry[] {
  const kw = keyword.trim();
  if (kw.length < 3) return [];
  const escaped = kw.replace(/[\\%_]/g, (c) => `\\${c}`);
  return getDb().prepare(
    `SELECT * FROM self_knowledge
     WHERE status = 'accepted' AND content LIKE ? ESCAPE '\\' COLLATE NOCASE
     ORDER BY created_at DESC LIMIT ?`
  ).all(`%${escaped}%`, limit) as SelfKnowledgeEntry[];
}
