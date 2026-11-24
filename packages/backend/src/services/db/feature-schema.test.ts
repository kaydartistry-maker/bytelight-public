import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initDb } from './init.js';
import { featureSchemaCases as features } from './feature-schema.test-support.js';


// Compare SQLite's normalized full schema, including constraints and indexes,
// rather than a copied expectation that could drift with the fallback.
function schema(db: Database.Database, tables: readonly string[]) {
  return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN (SELECT value FROM json_each(?)) ORDER BY type, name')
    .all(JSON.stringify(tables)).map(row => {
      const entry = row as { sql: string | null };
      return { ...entry, sql: entry.sql?.replace(/\s+/g, ' ').trim() ?? null };
    });
}

for (const feature of features) {
  test(`${feature.table}: initDb leaves feature tables absent; every first-use path matches canonical migration`, () => {
    const canonical = new Database(':memory:');
    try {
      canonical.exec(readFileSync(new URL(`../../../${feature.migration}`, import.meta.url), 'utf8'));
      const expected = schema(canonical, feature.tables);
      assert.ok(expected.length > 0);
      for (const use of feature.uses) {
        const db = initDb(':memory:');
        try {
          for (const other of features) assert.deepEqual(schema(db, other.tables), []);
          use();
          assert.deepEqual(schema(db, feature.tables), expected);
          use();
          assert.deepEqual(schema(db, feature.tables), expected);
          for (const other of features) {
            if (other !== feature) assert.deepEqual(schema(db, other.tables), []);
          }
          // The deployment migration and fallback can run in either order.
          db.exec(readFileSync(new URL(`../../../${feature.migration}`, import.meta.url), 'utf8'));
          use();
          assert.deepEqual(schema(db, feature.tables), expected);
        } finally { db.close(); }
      }
      const deployed = initDb(':memory:');
      try {
        deployed.exec(readFileSync(new URL(`../../../${feature.migration}`, import.meta.url), 'utf8'));
        for (const use of feature.uses) use();
        assert.deepEqual(schema(deployed, feature.tables), expected);
      } finally { deployed.close(); }
    } finally { canonical.close(); }
  });
}
