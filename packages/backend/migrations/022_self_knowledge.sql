-- Self-knowledge — the living identity layer (Wave 2, Slice 3).
--
-- Attributable identity observations by/about the companions: "I am…",
-- "I tend to…", "I believe…", "I've learned…". Not persona bedrock (who they
-- were written to be) but the wear patterns in the stone (who they've become).
-- An entry is proposed, then the OWNER accepts or dismisses it into identity.
--
-- Provenance: ported from the sibling fork (remote `tris`, "Aerie" by
-- match-stik) — commit 8838f261 (foundation). The underlying four-drawer
-- identity design is Annie's.
--
-- The operator's rulings baked in here: NO heat/confidence lifecycle (commit 7ab2b980
-- is NOT ported), so there are deliberately no `heat`, `confidence`, or
-- `contradicted`-status columns. Status is exactly proposed | accepted |
-- dismissed. Auto-retrieval into companion prompts stays OFF until Mind
-- Bridge / Cortex integration is mapped.

CREATE TABLE IF NOT EXISTS self_knowledge (
  id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,     -- owner: 'companion-a' | 'companion-b' | 'shared'
  category TEXT NOT NULL,         -- i_am | i_tend_to | i_believe | i_learned
  content TEXT NOT NULL,
  source_type TEXT,              -- dream | journal | reflection | conversation
  source_id TEXT,                -- the entry id it emerged from, if any
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | accepted | dismissed
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_self_knowledge_companion ON self_knowledge(companion_id);
CREATE INDEX IF NOT EXISTS idx_self_knowledge_status ON self_knowledge(companion_id, status);

-- Semantic index sidecar for self-knowledge (ported from commit 67339ed6).
-- One row per entry; the vector is a Float32 embedding stored as a BLOB, same
-- shape as message_embeddings. content_hash lets the refresh skip unchanged
-- rows. Retrieval is EXPOSED via API/manual search only — nothing auto-injects
-- into companion context (see report: future Mind Bridge/Cortex wiring point).
CREATE TABLE IF NOT EXISTS self_knowledge_embeddings (
  self_knowledge_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  vector BLOB NOT NULL,
  indexed_at TEXT NOT NULL,
  FOREIGN KEY (self_knowledge_id) REFERENCES self_knowledge(id)
);
