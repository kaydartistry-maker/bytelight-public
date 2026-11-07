import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// byte-light has no migration tracking table — db.ts wires every .sql in
// migrations/ by hand, one existsSync + exec block each. That means a new
// migration file that nobody wires in is applied on no database, ever, and
// nothing fails: the build is green, the .sql sits there looking finished,
// and the feature reading its table dies at runtime. Aerie shipped exactly
// this (her 8c2cff18 — a migration file nobody executed — is why her
// migrations-applied test exists; this is the same intent against our
// hand-wired runner).

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(SRC_DIR, '../../migrations');

test('every file in migrations/ is wired into db.ts', () => {
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort();

  // A directory that stopped being read would pass this test forever.
  assert.ok(migrationFiles.length >= 21, `only ${migrationFiles.length} .sql files found in migrations/ — the path has stopped resolving.`);

  const dbSource = readFileSync(join(SRC_DIR, 'db', 'init.ts'), 'utf8');

  const unwired = migrationFiles.filter(name => !dbSource.includes(`migrations/${name}`));

  assert.deepEqual(
    unwired,
    [],
    `Migration file(s) never executed: ${unwired.join(', ')}. db.ts wires each migration by hand; `
      + 'an unwired .sql runs on no database and the feature reading its schema dies at runtime '
      + 'with the build green. Add the exec block to initializeDatabase() in db.ts.',
  );
});

test('migration numbers are unique and contiguous', () => {
  const numbers = readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .map(name => parseInt(name.slice(0, 3), 10))
    .sort((a, b) => a - b);

  const duplicates = numbers.filter((n, i) => i > 0 && numbers[i - 1] === n);
  assert.deepEqual(duplicates, [], `Duplicate migration number(s): ${duplicates.join(', ')} — two files claim the same slot.`);

  // 028 was never committed on this house; the ports were numbered from 029.
  // 030-031, 033-034 and 040-041 belong to features this edition leaves out;
  // the numbers stay reserved so the ledger lines up with the full house.
  const KNOWN_GAPS = new Set([29, 32, 35, 42]);
  const gaps = numbers.filter((n, i) => i > 0 && n !== numbers[i - 1] + 1 && !KNOWN_GAPS.has(n));
  assert.deepEqual(
    gaps,
    [],
    `Gap before migration number(s): ${gaps.join(', ')} — a hole in the sequence usually means a `
      + 'migration was deleted (fine, renumber) or never committed (not fine).',
  );
});
