// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Memory integrity rounds — a daily, idempotent check-up of the memory stores,
// run every six hours (the first run of a UTC day does the work; later runs
// that day skip). Each completed round files a receipt in the memory ledger.
//
// Ported from Aerie. byte-light adaptations:
//   (a) memory_round_runs is owned by migrations/039_memory_round_runs.sql
//       (Aerie creates it inline in init.ts).
//   (b) Only the checks whose tables byte-light has are ported:
//         - selfKnowledgeIndex (missing / orphaned / hash drift against
//           self_knowledge_embeddings, then refreshSelfKnowledgeIndex) — the
//           hash input matches byte-light's self-knowledge-index.ts exactly.
//         - staleProposals (self_knowledge rows still 'proposed' after 30 days;
//           a count only, nothing is changed).
//       Left out, because byte-light has no such columns/tables:
//         - invalidLifecycle (self_knowledge.heat / .confidence / 'contradicted')
//         - brokenJournalSources, journalAnomalies (journal_entries was dropped
//           in migrations/024_drop_journal.sql)
//         - cortexUnindexed (no cortex_memory_embeddings table)
//   (c) startMemoryRounds returns nothing as before, and stopMemoryRounds is
//       added so the server can clear the timer on shutdown.
import { createHash } from 'crypto';
import { getDb } from './db.js';
import { memoryReceipt } from './memory-ledger.js';
import { refreshSelfKnowledgeIndex } from './self-knowledge-index.js';

let running: Promise<Record<string, unknown>> | null = null;

export async function runMemoryRounds(force = false): Promise<Record<string, unknown>> {
  if (running) return running;
  running = (async () => {
    const db = getDb();
    const day = new Date().toISOString().slice(0, 10);
    if (!force && db.prepare('SELECT 1 FROM memory_round_runs WHERE day=?').get(day)) return { day, skipped: true };
    db.prepare(`INSERT INTO memory_round_runs (day, started_at, status) VALUES (?, ?, 'running')
      ON CONFLICT(day) DO UPDATE SET started_at=excluded.started_at, status='running'`)
      .run(day, new Date().toISOString());
    const summary: Record<string, unknown> = {};
    try {
      const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      const missing = count(`SELECT count(*) n FROM self_knowledge sk LEFT JOIN self_knowledge_embeddings e
        ON e.self_knowledge_id=sk.id WHERE e.self_knowledge_id IS NULL`);
      const orphaned = count(`SELECT count(*) n FROM self_knowledge_embeddings e LEFT JOIN self_knowledge sk
        ON sk.id=e.self_knowledge_id WHERE sk.id IS NULL`);
      let hashDrift = 0;
      for (const row of db.prepare(`SELECT sk.category,sk.content,e.content_hash FROM self_knowledge sk
        JOIN self_knowledge_embeddings e ON e.self_knowledge_id=sk.id`).all() as Array<{category:string;content:string;content_hash:string}>) {
        const input = `${row.category.replaceAll('_', ' ')}: ${row.content}`;
        if (createHash('sha256').update(input).digest('hex') !== row.content_hash) hashDrift++;
      }
      summary.selfKnowledgeIndex = { missing, orphaned, hashDrift };
      if (missing || orphaned || hashDrift) await refreshSelfKnowledgeIndex();
      summary.staleProposals = count(`SELECT count(*) n FROM self_knowledge WHERE status='proposed'
        AND julianday(created_at) < julianday('now','-30 days')`);
      db.prepare(`UPDATE memory_round_runs SET finished_at=?,status='complete',summary_json=? WHERE day=?`)
        .run(new Date().toISOString(), JSON.stringify(summary), day);
      memoryReceipt({ actor: 'daemon', action: 'rounds.complete', detail: 'Memory integrity rounds completed.', metadata: summary });
      return { day, ...summary };
    } catch (error) {
      db.prepare(`UPDATE memory_round_runs SET finished_at=?,status='error',summary_json=? WHERE day=?`)
        .run(new Date().toISOString(), JSON.stringify({ error: String(error) }), day);
      memoryReceipt({ actor: 'daemon', action: 'rounds.error', detail: `Memory integrity rounds failed: ${String(error).slice(0, 300)}` });
      throw error;
    }
  })().finally(() => { running = null; });
  return running;
}

let roundsTimer: ReturnType<typeof setInterval> | null = null;

export function startMemoryRounds(): void {
  if (roundsTimer) return;
  void runMemoryRounds().catch(() => {});
  roundsTimer = setInterval(() => void runMemoryRounds().catch(() => {}), 6 * 60 * 60 * 1000);
  roundsTimer.unref?.();
}

export function stopMemoryRounds(): void {
  if (roundsTimer) {
    clearInterval(roundsTimer);
    roundsTimer = null;
  }
}
