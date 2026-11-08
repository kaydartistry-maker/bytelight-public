import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { errMessage } from '../../util/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database | null = null;

// Migration files live in packages/backend/migrations; callers name them
// relative to the package root, e.g. 'migrations/013_memory.sql'.
function migrationSql(relPath: string): string | null {
  const path = join(__dirname, '../../..', relPath);
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

/** Exec one migration file. Optional files are skipped when absent; required ones throw. */
function runMigration(database: Database.Database, relPath: string, { required = false } = {}): void {
  const sql = required ? readFileSync(join(__dirname, '../../..', relPath), 'utf-8') : migrationSql(relPath);
  if (sql !== null) database.exec(sql);
}

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  // Busy timeout prevents SQLITE_BUSY errors under concurrent async access
  db.pragma('busy_timeout = 5000');

  // Run migrations
  runMigration(db, 'migrations/001_init.sql', { required: true });

  runMigration(db, 'migrations/002_command_center.sql');

  // Stickers migration
  runMigration(db, 'migrations/003_stickers.sql');

  // Usage events migration
  runMigration(db, 'migrations/004_usage_events.sql');

  // Per-(thread, runtime, provider, model_ref) session sidecar migration
  runMigration(db, 'migrations/005_thread_provider_sessions.sql');

  // Per-message TTS cache (read-aloud audio sidecar)
  runMigration(db, 'migrations/006_message_tts.sql');

  // Starred messages (favorites) — generic multi-actor stars.
  // Apache 2.0 — adapted for byte-light (attribution in NOTICE).
  runMigration(db, 'migrations/007_starred_messages.sql');

  // DB-managed MCP server registry.
  // Ported from the upstream fork, Apache 2.0 — adapted for byte-light.
  runMigration(db, 'migrations/008_mcp_servers.sql');

  // ── Slice 3a resurrection: June runtime organs (tag stable-pre-rollback-
  // 2026-06-20). Tag migrations 007/008/009/011 renumbered onto main's
  // ledger as 009/010/011/012 (main's 007/008 slots were taken by
  // starred_messages / mcp_servers post-rollback). Loader blocks copied
  // from the tag's db.ts verbatim, paths + warn labels renumbered. ──

  // Companion settings — per (companion, tier, scope[, thread]) overrides
  // for (provider, model, thinking_effort). See migrations/009 for design.
  runMigration(db, 'migrations/009_companion_settings.sql');

  // Usage events companion attribution — additive ALTER TABLE. SQLite
  // lacks `ADD COLUMN IF NOT EXISTS`, so wrap in try/catch to keep the
  // migration idempotent across restarts (matches the inline-ALTER
  // pattern used for messages.platform / threads.pinned_at / canvases.tags
  // further down).
  const usageCompanionMigrationSQL = migrationSql('migrations/010_usage_events_companion_id.sql');
  if (usageCompanionMigrationSQL !== null) {
    try {
      db.exec(usageCompanionMigrationSQL);
    } catch (err: unknown) {
      const msg = errMessage(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        console.warn('Migration warning (010):', msg);
      }
      // Index creation uses IF NOT EXISTS so it's safe to re-run on its own.
      // If only the ALTER threw, try the index separately so the column-add
      // failure doesn't leave the index unbuilt on a fresh DB recovery.
      try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_companion_id ON usage_events(companion_id);');
      } catch {
        // Best effort — the column might not exist yet on first-run failure.
      }
    }
  }

  // Seed system-scope defaults for pulse + memory tiers. Idempotent across
  // boots: the uq_companion_settings_scope_key unique index from 009 makes
  // a second INSERT fail with UNIQUE constraint, which we swallow here.
  const seedDefaultsSQL = migrationSql('migrations/011_seed_companion_defaults.sql');
  if (seedDefaultsSQL !== null) {
    try {
      db.exec(seedDefaultsSQL);
    } catch (err: unknown) {
      const msg = errMessage(err);
      if (!msg.includes('UNIQUE constraint failed')) {
        console.warn('Migration warning (011):', msg);
      }
    }
  }

  // Phase 2 Step 3 — multi-provider usage attribution. Three additive
  // ALTER TABLE columns + two indexes. The bundled .sql executes all five
  // statements; SQLite stops at the first ALTER if a column already
  // exists (duplicate column error), which leaves the later ALTERs +
  // indexes unrun. We catch + retry column-by-column with idempotent
  // ALTERs so partial state on a re-run heals fully. Mirrors the 010
  // multi-column-safe pattern.
  const usageProviderMigrationSQL = migrationSql('migrations/012_usage_events_provider.sql');
  if (usageProviderMigrationSQL !== null) {
    try {
      db.exec(usageProviderMigrationSQL);
    } catch (err: unknown) {
      const msg = errMessage(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        console.warn('Migration warning (012):', msg);
      }
      // Heal partial application: each column is its own try/catch so a
      // duplicate on one doesn't block the others.
      for (const col of ['provider', 'runtime', 'model_ref']) {
        try {
          db.exec(`ALTER TABLE usage_events ADD COLUMN ${col} TEXT`);
        } catch { /* duplicate column — fine */ }
      }
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);'); } catch { /* best effort */ }
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_runtime ON usage_events(runtime);'); } catch { /* best effort */ }
    }
  }

  // Memory blocks — Letta-style in-place memory editing (Slice 1).
  // Apache 2.0 — adapted for byte-light (attribution in NOTICE).
  // Plain CREATE TABLE IF NOT EXISTS migration; safe to re-run on every boot.
  runMigration(db, 'migrations/013_memory.sql');

  // Companions + per-thread roster (Arc C rooms, Slice 1 — schema only).
  // Schema shape ported from NESTstack rooms-worker (cindiekinzz-coder, MIT);
  // see migrations/014 for the full attribution + id convention. The .sql
  // mixes idempotent CREATE TABLE IF NOT EXISTS with two bare ALTER TABLE ADD
  // COLUMN (threads.default_companion_id, messages.companion_id). SQLite lacks
  // `ADD COLUMN IF NOT EXISTS`, so on a re-boot the whole-file exec throws
  // "duplicate column" and stops before the seed. Catch + heal column-by-column
  // and re-run the idempotent tail, mirroring the 010/012 multi-statement
  // pattern.
  const companionsMigrationSQL = migrationSql('migrations/014_companions.sql');
  if (companionsMigrationSQL !== null) {
    try {
      db.exec(companionsMigrationSQL);
    } catch (err: unknown) {
      const msg = errMessage(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        console.warn('Migration warning (014):', msg);
      }
      // Heal partial application: each ALTER is its own try/catch so a duplicate
      // on one doesn't block the others or the seed below.
      try { db.exec('ALTER TABLE threads ADD COLUMN default_companion_id TEXT'); } catch { /* duplicate column — fine */ }
      try { db.exec('ALTER TABLE messages ADD COLUMN companion_id TEXT'); } catch { /* duplicate column — fine */ }
      // Seed is INSERT OR IGNORE (idempotent); re-run so a mid-file throw on the
      // first boot still lands the roster rows.
      try {
        db.exec(
          "INSERT OR IGNORE INTO companions (id, display_name, avatar, brain, model, sort_order, created_at) VALUES " +
          "('companion-a', 'Companion A', '/api/files/d03d4e7c-6c4c-4ae1-8134-848c8507939e', 'companion-a-b', NULL, 0, datetime('now')), " +
          "('companion-b', 'Companion B', '/api/files/a7421965-61e9-4f53-8ce0-0d2cf47a7d17', 'companion-a-b', NULL, 1, datetime('now')), " +
          "('companion-c',  'Companion C',  NULL, 'companion-c', NULL, 2, datetime('now'));"
        );
      } catch { /* best effort — table may not exist on a first-run failure */ }
    }
  }

  // Rooms seed + roster backfill (Arc C rooms, Slice 2 — data only, still no
  // dispatch read). Depends on 014 above. The .sql is pure INSERT OR IGNORE
  // (backfill every existing thread to the resident pair; create the two
  // fixed-id dormant rooms "Living Room" + "Companion C" with their rosters), so —
  // unlike 014 — there is no ALTER to trip the "duplicate column" path; a
  // straight re-exec is idempotent. Guard for a first-run race where 014 did
  // not create the tables (best-effort warn, don't crash boot).
  const roomsSeedMigrationSQL = migrationSql('migrations/015_rooms_seed.sql');
  if (roomsSeedMigrationSQL !== null) {
    try {
      db.exec(roomsSeedMigrationSQL);
    } catch (err: unknown) {
      const msg = errMessage(err);
      console.warn('Migration warning (015):', msg);
    }

    // Home roster seed: the Arc A pinned routing thread ('app.routingThreadId')
    // gets the resident pair. Its id lives in the config table, not known at
    // migration-authoring time, so it is seeded here rather than in the .sql.
    // If the key is unset (fresh DB, no Home pinned yet) skip gracefully — the
    // backfill above already seated every EXISTING thread, and the resolver
    // seats a new Home the moment one is pinned via the picker (Slice 3).
    // INSERT OR IGNORE against the composite PK keeps this idempotent.
    try {
      const homeId = db.prepare("SELECT value FROM config WHERE key = 'app.routingThreadId'").get() as { value?: string } | undefined;
      const rid = homeId?.value;
      if (rid) {
        // Only seed if the routing thread actually exists (a stale config
        // pointer must not create orphan roster rows — the FK would reject it
        // anyway, but skip cleanly rather than throw).
        const exists = db.prepare('SELECT 1 FROM threads WHERE id = ?').get(rid);
        if (exists) {
          const seatHome = db.prepare('INSERT OR IGNORE INTO thread_companions (thread_id, companion_id) VALUES (?, ?)');
          seatHome.run(rid, 'companion-a');
          seatHome.run(rid, 'companion-b');
        }
      }
    } catch (err: unknown) {
      const msg = errMessage(err);
      console.warn('Migration warning (015 Home roster seed):', msg);
    }
  }

  // PORT ADAPTATION (Reverie usage meters): Reverie reads Codex transcripts
  // on demand. byte-light already receives the same signal live, so persist
  // the latest standing per lane/window in a bounded, idempotent table.
  runMigration(db, 'migrations/016_subscription_usage_windows.sql');

  // Memory ledger — a receipt row per core-memory write (see memory-ledger.ts).
  // Ported from an upstream fork, Apache 2.0. Pure CREATE TABLE / CREATE INDEX
  // IF NOT EXISTS, so a straight re-exec on every boot is idempotent — no
  // duplicate-column healing needed, unlike 014.
  runMigration(db, 'migrations/017_memory_ledger.sql');

  // Memory proposals — the Archivist's holding area (see memory-proposals.ts).
  // Ported from an upstream fork, Apache 2.0. Same idempotent shape as 017.
  // Since the Aerie Archivist swap, 'propose' is the default: every Archivist
  // edit lands here for the operator's review (Memory Blocks → Review on the phone).
  runMigration(db, 'migrations/018_memory_proposals.sql');

  // Canonical ids + open aliases for core-memory blocks. The migration is
  // non-destructive: historical ghost rows stay untouched, but their welded
  // labels resolve to the real block on every future write.
  runMigration(db, 'migrations/019_memory_block_aliases.sql');

  // Lossless cold home for text removed by the gentle core-memory diet loop.
  runMigration(db, 'migrations/020_memory_blocks_archive.sql');

  // Durable sender receipts. Older databases need the additive column first;
  // fresh installs already receive it from 001_init.sql.
  try {
    db.exec('ALTER TABLE messages ADD COLUMN client_id TEXT');
  } catch (err: unknown) {
    const message = errMessage(err);
    if (!message.includes('duplicate column name')) throw err;
  }
  runMigration(db, 'migrations/021_message_delivery.sql');

  // Self-knowledge — the living identity layer (Wave 2, Slice 3). New tables
  // only (self_knowledge + self_knowledge_embeddings); nothing existing is
  // altered. Adapted for byte-light (attribution in NOTICE). Heat/confidence
  // lifecycle deliberately NOT included per the operator's ruling. Idempotent via CREATE TABLE IF NOT EXISTS.
  runMigration(db, 'migrations/022_self_knowledge.sql');

  // Preserve the journal migration sequence for databases crossing this
  // boundary: 023 created the interim local table, then 024 retired it when
  // the feature moved to the remote Mind API.
  runMigration(db, 'migrations/023_journal.sql', { required: true });
  runMigration(db, 'migrations/024_drop_journal.sql', { required: true });

  // Permanent Letters — isolated local vault, deliberately outside every
  // journal, memory, sweep, decay, and compaction path.
  runMigration(db, 'migrations/025_letters.sql', { required: true });

  // 026: companion card columns (bio / status / phone). Bare ALTERs, so each
  // statement runs on its own and a "duplicate column" means already there —
  // this house's DB gained them by hand before the migration existed.
  const companionCardSQL = migrationSql('migrations/026_companion_card.sql');
  if (companionCardSQL !== null) {
    const statements = companionCardSQL
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((stmt) => stmt.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        db.exec(stmt);
      } catch (err: unknown) {
        const msg = errMessage(err);
        if (!msg.includes('duplicate column')) console.warn('Migration warning (026):', msg);
      }
    }
  }
  // 027: a lane on every session card (thread_provider_sessions), so a thread
  // can hold one provider conversation per companion. A table rebuild — run
  // once, in a transaction, only while the `lane` column is missing. Every
  // existing row lands in lane '' (the shared lane), unchanged.
  const providerLaneSQL = migrationSql('migrations/027_provider_sessions_lane.sql');
  if (providerLaneSQL !== null) {
    const cols = db.prepare('PRAGMA table_info(thread_provider_sessions)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === 'lane')) {
      const before = (db.prepare('SELECT COUNT(*) AS n FROM thread_provider_sessions').get() as { n: number }).n;
      const conn = db;
      conn.transaction(() => {
        conn.exec(providerLaneSQL);
        const after = (conn.prepare('SELECT COUNT(*) AS n FROM thread_provider_sessions').get() as { n: number }).n;
        if (after !== before) throw new Error(`027: ${before} session rows before the rebuild, ${after} after — rolled back`);
      })();
      console.log(`Migration 027: session cards gained a lane (${before} rows kept, all in the shared lane)`);
    }
  }

  // 029: sticky notes for the phone's Notes app (ported from Aerie). 028 is
  // held by the Scribe branch. CREATE IF NOT EXISTS, safe on every boot.
  runMigration(db, 'migrations/029_notes.sql', { required: true });

  // 032: Artifacts — interactive React components for the phone's Artifacts
  // app (ported from Aerie's inline CREATE). CREATE IF NOT EXISTS, safe on
  // every boot.
  runMigration(db, 'migrations/032_artifacts.sql', { required: true });
  // 035: Field Notes — a sentence or two a day from the companions, for the
  // phone's Field Notes page (Aerie's 016). CREATE IF NOT EXISTS, safe on boot.
  runMigration(db, 'migrations/035_field_notes.sql', { required: true });
  // 036: the Fleet Room (ported from Aerie's 009_battleship.sql) — Battleship
  // matches and their log. CREATE IF NOT EXISTS, safe on every boot.
  runMigration(db, 'migrations/036_battleship.sql', { required: true });

  // 037: the Card Room (ported from Aerie's 010_card_room.sql) — the table,
  // a game-agnostic state blob and the table log. CREATE IF NOT EXISTS.
  runMigration(db, 'migrations/037_card_room.sql', { required: true });
  // 039: memory integrity rounds, one row per day (ported from Aerie; see
  // services/memory-rounds.ts). CREATE IF NOT EXISTS, safe on every boot.
  runMigration(db, 'migrations/039_memory_round_runs.sql', { required: true });
  // 038: threads.type gains 'treehouse' — the companions' own room (ported
  // from Aerie's init.ts widen). 001 created the CHECK as ('daily', 'named'),
  // and SQLite cannot alter a CHECK in place, so the table is rebuilt: run
  // once, in a transaction, only while the stored schema lacks 'treehouse'.
  // Rows are copied by the LIVE column list (column order varies by install
  // age); a live column the new table does not know aborts the rebuild rather
  // than dropping data, and the row count must match before and after (the
  // 027 safety pattern) or the whole thing rolls back.
  const treehouseTypeSQL = migrationSql('migrations/038_threads_treehouse_type.sql');
  if (treehouseTypeSQL !== null) {
    const threadsSchema = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get() as
        | { sql?: string }
        | undefined
    )?.sql;
    if (threadsSchema && !threadsSchema.includes("'treehouse'")) {
      const conn = db;
      const liveCols = (conn.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name);
      const before = (conn.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n;
      // Foreign keys must be off while the parent table is swapped (a pragma
      // cannot change inside a transaction). This house never turns them on;
      // whatever the setting was, it is put back afterwards.
      const fkWas = conn.pragma('foreign_keys', { simple: true });
      conn.pragma('foreign_keys = OFF');
      try {
        conn.transaction(() => {
          conn.exec('DROP TABLE IF EXISTS threads_039');
          conn.exec(treehouseTypeSQL);
          const newCols = new Set(
            (conn.prepare('PRAGMA table_info(threads_039)').all() as Array<{ name: string }>).map((c) => c.name),
          );
          const unknown = liveCols.filter((c) => !newCols.has(c));
          if (unknown.length > 0) throw new Error(`038: threads has column(s) the rebuild does not know (${unknown.join(', ')}) — rolled back`);
          const cols = liveCols.map((c) => `"${c}"`).join(', ');
          conn.exec(`INSERT INTO threads_039 (${cols}) SELECT ${cols} FROM threads`);
          conn.exec('DROP TABLE threads');
          conn.exec('ALTER TABLE threads_039 RENAME TO threads');
          const after = (conn.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n;
          if (after !== before) throw new Error(`038: ${before} thread rows before the rebuild, ${after} after — rolled back`);
        })();
        console.log(`Migration 038: threads.type now allows 'treehouse' (${before} rows kept)`);
      } catch (err: unknown) {
        console.warn('Migration warning (038): threads.type could not be widened; the Treehouse cannot open —', errMessage(err));
      } finally {
        conn.pragma(`foreign_keys = ${fkWas ? 'ON' : 'OFF'}`);
      }
    }
  }

  // 042: custom emojis and emoji packs (ported from full-sweep's 004/005).
  // CREATE IF NOT EXISTS with pack_id inline, so a house that already has
  // the tables (the operator's, from the full-sweep era) is left exactly as it is.
  runMigration(db, 'migrations/042_emojis.sql', { required: true });

  // 043: statuses — the owner's status and each companion's line and mood,
  // for the phone's Status widget. CREATE IF NOT EXISTS, safe on every boot.
  runMigration(db, 'migrations/043_statuses.sql', { required: true });
  // Her status tags ("at work", "with Sam"), beside her own words. Added
  // after 043 may already have run, so a column, not a new CREATE.
  try { db.exec('ALTER TABLE statuses ADD COLUMN tags TEXT'); } catch { /* duplicate column — fine */ }

  // 044: turn leases — phone turns cut off by a restart are picked back up
  // on boot (services/db/turn-leases.ts). CREATE IF NOT EXISTS.
  runMigration(db, 'migrations/044_turn_leases.sql', { required: true });

  // 045: intentions — promises riding impulses, kept until said and answered
  // (services/db/intentions.ts). CREATE IF NOT EXISTS.
  runMigration(db, 'migrations/045_intentions.sql', { required: true });
  // Who filed a promise: a companion live, or the Archivist catching one he
  // forgot ('archivist'). A column, since 045 may already have run.
  try { db.exec("ALTER TABLE intentions ADD COLUMN source TEXT NOT NULL DEFAULT 'companion'"); } catch { /* duplicate column — fine */ }

  // 046: the compactions shelf — every squash the lanes have had, kept here
  // because Claude Code deletes old transcripts (services/compaction-shelf.ts).
  // CREATE IF NOT EXISTS.
  runMigration(db, 'migrations/046_compactions.sql', { required: true });

  // 001 wrote push_subscriptions with a type list of web_push and apns, which
  // predates Android push, so an FCM device token from the app would be
  // refused by the CHECK constraint. SQLite cannot alter a constraint in
  // place, so rebuild the table when the old list is still on it, carrying
  // every existing row across. (Ported from Aerie.)
  const pushTableSql = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'")
      .get() as { sql?: string } | undefined
  )?.sql;
  if (pushTableSql && !pushTableSql.includes("'fcm'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE push_subscriptions_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('web_push', 'apns', 'fcm')),
        endpoint TEXT,
        keys_p256dh TEXT,
        keys_auth TEXT,
        device_token TEXT,
        device_name TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      INSERT INTO push_subscriptions_new
        (id, type, endpoint, keys_p256dh, keys_auth, device_token, device_name, created_at, last_used_at)
        SELECT id, type, endpoint, keys_p256dh, keys_auth, device_token, device_name, created_at, last_used_at
        FROM push_subscriptions;
      DROP TABLE push_subscriptions;
      ALTER TABLE push_subscriptions_new RENAME TO push_subscriptions;
      COMMIT;
    `);
    console.log('[DB] Widened push_subscriptions to accept Android (FCM) device tokens');
  }


  // Insert default config if not exists
  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  stmt.run('dnd_start', '23:00');
  stmt.run('dnd_end', '07:00');

  // Timers table (created inline, no migration needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      context TEXT,
      fire_at TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);

  // Triggers table (impulse queue + event watchers)
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      conditions TEXT NOT NULL,
      prompt TEXT,
      thread_id TEXT,
      cooldown_minutes INTEGER DEFAULT 120,
      status TEXT NOT NULL DEFAULT 'pending',
      last_fired_at TEXT,
      fire_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);

  // Discord integration migration — platform column + pairing table
  // Safe to run multiple times (uses IF NOT EXISTS / catches already-exists)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN platform TEXT DEFAULT 'web'`);
  } catch {
    // Column already exists — fine
  }

  // Thread pinning migration
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN pinned_at TEXT DEFAULT NULL`);
  } catch {
    // Column already exists — fine
  }

  // Canvas tags migration
  try {
    db.exec(`ALTER TABLE canvases ADD COLUMN tags TEXT DEFAULT '[]'`);
  } catch (err: unknown) {
    const msg = errMessage(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_pairings (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      approved_by TEXT
    )
  `);

  // Semantic embeddings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id TEXT PRIMARY KEY,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    )
  `);

  // Session history migration — add UNIQUE on session_id + 'resumed' end_reason
  // Inspect the table schema directly instead of probing with a test INSERT/DELETE,
  // which previously dirtied the table and could surface false-positive warnings.
  const shCount = (db.prepare('SELECT COUNT(*) as c FROM session_history').get() as { c: number }).c;
  if (shCount === 0) {
    const sessionHistorySchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_history'"
    ).get() as { sql?: string } | undefined;
    const sessionHistorySql = sessionHistorySchema?.sql ?? '';
    const needsRecreate =
      !sessionHistorySql.includes('session_id TEXT NOT NULL UNIQUE') ||
      !sessionHistorySql.includes("'resumed'");

    if (needsRecreate) {
      db.exec('DROP TABLE session_history');
      db.exec(`
        CREATE TABLE session_history (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          session_type TEXT NOT NULL CHECK(session_type IN ('v1', 'v2')),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          end_reason TEXT CHECK(end_reason IN ('compaction', 'reaper', 'daily_rotation', 'error', 'manual', 'resumed')),
          tokens_used INTEGER,
          cost_usd REAL,
          peak_memory_mb INTEGER,
          FOREIGN KEY (thread_id) REFERENCES threads(id)
        )
      `);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_history_thread_id ON session_history(thread_id)');

  clearStalePendingTurns(db);

  return db;
}

/**
 * A turn that was in flight when the process went away is not in flight now.
 *
 * Ported from Aerie. Reported Sep 17 2026: restart the backend while a rail turn
 * is running and `companion_pending` stays 1 forever, because the code that
 * clears it lives after the await that never returned. Every later move is then
 * refused with "They are already talking" — a 409 about a conversation that
 * stopped existing when the process did, and no way out except editing the
 * database.
 *
 * Both rooms carry the same flag and the same fault, and so does the Story
 * Shelf, whose books are "being written" while a page turn is queued or
 * running. This runs on every boot because the truth it asserts is only ever
 * true at boot: nothing is mid-turn in a process that has not started yet.
 */
export function clearStalePendingTurns(db: Database.Database): number {
  let cleared = 0;
  for (const table of ['card_tables', 'battleship_games', 'story_books']) {
    try {
      const res = db.prepare(`UPDATE ${table} SET companion_pending = 0 WHERE companion_pending = 1`).run();
      cleared += res.changes;
    } catch { /* the table may not exist yet in an older database */ }
  }
  if (cleared > 0) console.log(`[db] cleared ${cleared} turn(s) left pending by a restart`);
  return cleared;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}
