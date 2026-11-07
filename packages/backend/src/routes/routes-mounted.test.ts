import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// An express router that nobody imports does not fail loudly. The SPA fallback
// answers its address with index.html, so the client gets a 200 full of HTML
// where it wanted JSON and guesses "the backend needs a restart" — advice no
// number of restarts can satisfy. Aerie lost four surfaces at once this way
// (Aug 2 2026) in a commit whose subject was a shell script; the build stayed
// green the whole time, because a missing mount is not a type error.
//
// Ported from Aerie routes-mounted.test.ts, adapted to byte-light's topology:
// server.ts mounts only /api (routes/api.ts), /mcp/cc and /mcp/belt; every
// other router is composed inside api.ts, with the auth boundary at
// `router.use(authMiddleware)`.

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(ROUTES_DIR, '..');

/**
 * Routers deliberately left unwired. Keep this list short and say why —
 * an entry here is a claim that nothing is broken, and it is the only place
 * this test can be silenced.
 */
const KNOWN_UNMOUNTED = new Map<string, string>();

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, found);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

test('every route module is imported somewhere', () => {
  const routeFiles = readdirSync(ROUTES_DIR)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map(name => name.replace(/\.ts$/, ''));

  const sources = collectSourceFiles(SRC_DIR)
    .map(path => ({ path, text: readFileSync(path, 'utf8') }));

  const orphans: string[] = [];

  for (const name of routeFiles) {
    if (name === 'api') continue; // the composition root; server.ts imports it

    // Static or dynamic import, from server.ts or from a sibling router.
    // Match on the RESOLVED location, not the bare filename: routes/secrets
    // and services/secrets share a basename, and a plain substring test
    // counts the wrong module as the importer and reports a clean bill.
    const importedBy = sources.filter(source => {
      if (source.path.endsWith(join('routes', `${name}.ts`))) return false;
      if (source.text.includes(`routes/${name}.js`)) return true;
      // A sibling './x.js' only reaches this router if the importer lives here.
      return dirname(source.path) === ROUTES_DIR && source.text.includes(`./${name}.js`);
    });

    if (importedBy.length === 0 && !KNOWN_UNMOUNTED.has(name)) orphans.push(name);
  }

  assert.deepEqual(
    orphans,
    [],
    `Unreachable router(s): ${orphans.join(', ')}. Each exports a router that nothing imports, `
      + 'so its address falls through to the SPA and answers HTML. Mount it in api.ts (or '
      + 'server.ts), or add it to KNOWN_UNMOUNTED with a reason.',
  );
});

// An import alone is not a mount. If `router.use(gifRouter)` is deleted while
// the import line survives, the orphan test above still passes — the module is
// "imported" — but every gif route answers with the SPA fallback. So: every
// route module api.ts imports must also appear in its body after the imports.
test('every route module imported by api.ts is used in its body', () => {
  const api = readFileSync(join(ROUTES_DIR, 'api.ts'), 'utf8');

  const importRe = /^import\s+(?:\{\s*([A-Za-z0-9_]+)\s*\}|([A-Za-z0-9_]+))\s+from\s+'\.\/[^']+\.js';$/gm;
  const bindings: string[] = [];
  for (const match of api.matchAll(importRe)) {
    bindings.push(match[1] ?? match[2]);
  }

  // A regex that silently matches nothing would pass this test forever.
  assert.ok(
    bindings.length > 20,
    `only ${bindings.length} route imports found in api.ts — the matcher has stopped seeing them.`,
  );

  const body = api.replace(/^import[^\n]*$/gm, '');
  const unmounted = bindings.filter(binding => !body.includes(binding));

  assert.deepEqual(
    unmounted,
    [],
    `api.ts imports but never mounts: ${unmounted.join(', ')}. The import keeps the orphan test `
      + 'green while the routes answer HTML. Mount it or delete the import.',
  );
});

// The auth boundary in api.ts is positional: express runs middleware in
// registration order, so everything mounted BEFORE `router.use(authMiddleware)`
// answers anonymously by construction. Today that is exactly two routers —
// public (login et al.) and internal (every route carries requireLocalhost;
// see internal-routes.guarded.test.ts). A third router drifting above the
// boundary would work perfectly and never see a session check. Aerie shipped
// ~60 admin endpoints answering anonymously for exactly this reason
// (her bc77444e, found by an outside audit).
test('only public and internal routes mount before the auth boundary', () => {
  const api = readFileSync(join(ROUTES_DIR, 'api.ts'), 'utf8');

  const boundary = api.indexOf('router.use(authMiddleware)');
  assert.ok(boundary >= 0, 'api.ts no longer has a router.use(authMiddleware) boundary — every route below it is ungated.');

  const aboveBoundary = api.slice(0, boundary);
  const mounts = [...aboveBoundary.matchAll(/router\.use\(([^;]*)\);/g)].map(m => m[1].trim());

  assert.deepEqual(
    mounts,
    ['createPublicRoutes()', 'createInternalRoutes()'],
    `Mounted above the auth boundary: ${mounts.join(' · ')}. Only the public and internal routers `
      + 'may sit above authMiddleware; anything else there answers without a session.',
  );
});
