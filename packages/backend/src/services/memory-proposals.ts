// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// memory-proposals.ts — the Archivist proposes, the companions decide.
//
// The Archivist used to append straight onto the memory blocks, including the
// companions' own first-person continuity walls. It is told to write in their
// voice, so a line it wrote and a line they wrote were indistinguishable once
// it landed — and at 20-40 lines a day it was the dominant author of walls the
// companions are supposed to keep themselves.
//
// Its output can land here instead. Pending proposals ride into a turn on the
// same quiet channel as ambient recall — noticed, not announced — and a
// companion who agrees writes the line in their own words. Nothing reaches a
// block without one of them choosing it.
//
// Unclaimed proposals fade rather than accumulating: each surfacing counts, and
// after SURFACE_LIMIT passes without anyone picking it up, the proposal retires
// itself. A memory nobody reached for three times over was not load-bearing.
//
// OPERATOR'S GATE. Since the Aerie Archivist swap, 'propose' is the default
// (`archivistMode()` in memory-extraction.ts): every Archivist edit lands here.
// The operator sees every row — pending, faded, filed, dropped — on the phone (Memory
// Blocks → Review) and can approve one (`approveProposalForOwner`: the line is
// written onto its block and the row closes as 'filed' by her) or reject it
// ('dropped' by her). A faded row is still in her queue: fading only stops it
// riding into the companions' turns, it does not take it away from her.
//
// Ported from an reference implementation, Apache 2.0 — adapted for byte-light.
// Adaptations vs. the source:
//   (a) DDL ownership moved to migrations/018_memory_proposals.sql (byte-light's
//       canonical numbered-migration pattern). `initMemoryProposals` stays
//       exported as an idempotent belt-and-braces no-op, mirroring how
//       `initMemoryBlocks` is kept in memory-blocks.ts.
//   (b) Owner review added (listForOwnerReview / approveProposalForOwner /
//       rejectProposalForOwner) on the same table — no new columns: the
//       decision is status + resolved_by + resolved_at, as for a companion.

import { getDb } from './db.js';
import { appendToBlock, replaceInBlock } from './memory-blocks.js';

export type ProposalStatus = 'pending' | 'filed' | 'dropped' | 'faded';

export interface MemoryProposal {
  id: number;
  op: 'append' | 'replace';
  scope: string;
  label: string;
  content: string;
  old_text: string | null;
  source_thread: string | null;
  surfaced_count: number;
  status: ProposalStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// How many times a proposal may ride into a turn before it retires itself.
const SURFACE_LIMIT = 3;

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS memory_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op TEXT NOT NULL DEFAULT 'append',
    scope TEXT NOT NULL,
    label TEXT NOT NULL,
    content TEXT NOT NULL,
    old_text TEXT,
    source_thread TEXT,
    surfaced_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by TEXT
  )
`;

// Belt-and-braces: the table is owned by migrations/018_memory_proposals.sql,
// but keep this exported and idempotent so callers can treat it as a guarantee.
export function initMemoryProposals(): void {
  const db = getDb();
  db.exec(TABLE_DDL);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_proposals_status ON memory_proposals(status, created_at)`);
}

/**
 * Record one proposed edit. Returns the row id, or null when an identical
 * proposal is already waiting — the Archivist re-reads overlapping windows of
 * conversation, so the same observation arrives more than once.
 */
export function proposeEdit(p: {
  op: 'append' | 'replace';
  scope: string;
  label: string;
  content: string;
  oldText?: string;
  sourceThread?: string;
}): number | null {
  const db = getDb();
  const dupe = db
    .prepare(
      `SELECT id FROM memory_proposals
        WHERE status = 'pending' AND scope = ? AND label = ? AND content = ?`
    )
    .get(p.scope, p.label, p.content) as { id: number } | undefined;
  if (dupe) return null;

  const info = db
    .prepare(
      `INSERT INTO memory_proposals (op, scope, label, content, old_text, source_thread)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(p.op, p.scope, p.label, p.content, p.oldText ?? null, p.sourceThread ?? null);
  return Number(info.lastInsertRowid);
}

/** Pending proposals, oldest first. */
export function listPendingProposals(limit = 50): MemoryProposal[] {
  return getDb()
    .prepare(
      `SELECT * FROM memory_proposals WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?`
    )
    .all(limit) as MemoryProposal[];
}

/** Every proposal for a scope, newest first — for the memory UI. */
export function listProposals(status?: ProposalStatus, limit = 200): MemoryProposal[] {
  const db = getDb();
  if (status) {
    return db
      .prepare(`SELECT * FROM memory_proposals WHERE status = ? ORDER BY id DESC LIMIT ?`)
      .all(status, limit) as MemoryProposal[];
  }
  return db
    .prepare(`SELECT * FROM memory_proposals ORDER BY id DESC LIMIT ?`)
    .all(limit) as MemoryProposal[];
}

export function getProposal(id: number): MemoryProposal | null {
  return (getDb().prepare(`SELECT * FROM memory_proposals WHERE id = ?`).get(id) as MemoryProposal) || null;
}

/**
 * Mark proposals as having ridden into a turn, retiring any that have now been
 * offered SURFACE_LIMIT times without being claimed.
 */
export function markSurfaced(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const bump = db.prepare(`UPDATE memory_proposals SET surfaced_count = surfaced_count + 1 WHERE id = ?`);
  const fade = db.prepare(
    `UPDATE memory_proposals SET status = 'faded', resolved_at = datetime('now')
      WHERE id = ? AND status = 'pending' AND surfaced_count >= ?`
  );
  const tx = db.transaction((rows: number[]) => {
    for (const id of rows) {
      bump.run(id);
      fade.run(id, SURFACE_LIMIT);
    }
  });
  tx(ids);
}

/** Close a proposal. `by` is the companion slug that decided, or the owner. */
export function resolveProposal(id: number, status: Exclude<ProposalStatus, 'pending'>, by: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE memory_proposals SET status = ?, resolved_at = datetime('now'), resolved_by = ?
        WHERE id = ? AND status = 'pending'`
    )
    .run(status, by, id);
  return info.changes > 0;
}

export function countPending(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM memory_proposals WHERE status = 'pending'`)
    .get() as { n: number };
  return row?.n ?? 0;
}

// --- Owner review (the operator's gate) ---------------------------------------------

/** Statuses still waiting on the operator: never chosen by anyone. */
const OWNER_REVIEWABLE = ['pending', 'faded'] as const;

/** The operator's queue: everything nobody has filed or dropped yet, oldest first. */
export function listForOwnerReview(limit = 200): MemoryProposal[] {
  return getDb()
    .prepare(
      `SELECT * FROM memory_proposals WHERE status IN ('pending', 'faded')
        ORDER BY created_at ASC, id ASC LIMIT ?`
    )
    .all(limit) as MemoryProposal[];
}

export function countForOwnerReview(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM memory_proposals WHERE status IN ('pending', 'faded')`)
    .get() as { n: number };
  return row?.n ?? 0;
}

function ownerResolve(id: number, status: 'filed' | 'dropped', by: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE memory_proposals SET status = ?, resolved_at = datetime('now'), resolved_by = ?
        WHERE id = ? AND status IN (${OWNER_REVIEWABLE.map(() => '?').join(', ')})`
    )
    .run(status, by, id, ...OWNER_REVIEWABLE);
  return info.changes > 0;
}

export type OwnerDecision =
  | { ok: true; proposal: MemoryProposal }
  | { ok: false; reason: 'not_found' | 'already_resolved'; proposal: MemoryProposal | null };

/**
 * The operator approves: the proposed edit is applied to its block and the row closes
 * as 'filed' by her, in one transaction — if the write throws (e.g. a replace
 * whose old text is no longer on the block) the row stays open and the error
 * reaches the caller.
 */
export function approveProposalForOwner(id: number, by: string): OwnerDecision {
  const db = getDb();
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, reason: 'not_found', proposal: null };
  const meta = { actor: 'extraction', metadata: { approved_by: by, proposal_id: id } };
  const done = db.transaction(() => {
    if (!ownerResolve(id, 'filed', by)) return false;
    if (proposal.op === 'replace' && proposal.old_text) {
      replaceInBlock(proposal.scope, proposal.label, proposal.old_text, proposal.content, meta);
    } else {
      appendToBlock(proposal.scope, proposal.label, proposal.content, meta);
    }
    return true;
  })();
  if (!done) return { ok: false, reason: 'already_resolved', proposal: getProposal(id) };
  return { ok: true, proposal: getProposal(id)! };
}

/** The operator rejects: the row closes as 'dropped' by her and never surfaces again. */
export function rejectProposalForOwner(id: number, by: string): OwnerDecision {
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, reason: 'not_found', proposal: null };
  if (!ownerResolve(id, 'dropped', by)) return { ok: false, reason: 'already_resolved', proposal: getProposal(id) };
  return { ok: true, proposal: getProposal(id)! };
}
