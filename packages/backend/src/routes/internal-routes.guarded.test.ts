import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The internal surface mounts ABOVE the auth boundary in api.ts (it has to —
// the agent calls it without a session), so the only thing between every
// internal route and the internet-facing front is the requireLocalhost guard
// each route carries by hand. One new route added without it would work
// perfectly in every test and answer anybody through the tunnel.
//
// The 2026-09-02 audit read all 17 declarations and found every one guarded.
// This assertion is so that stays true by something other than habit.
// (Aerie's a3c346ae is the same idea for her internal router.)

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));

test('every route in internal-routes.ts is declared under /internal and carries requireLocalhost', () => {
  const internal = readFileSync(join(ROUTES_DIR, 'internal-routes.ts'), 'utf8');

  // Path may be a plain string or a template literal (the Discord verb loop).
  const declaration = /router\.(get|post|put|patch|delete|all|use)\(\s*(['"`])([^'"`]*?)\2\s*,\s*([A-Za-z0-9_]+)/g;

  const badPath: string[] = [];
  const unguarded: string[] = [];
  let found = 0;

  for (const match of internal.matchAll(declaration)) {
    found += 1;
    const [, verb, , path, firstMiddleware] = match;
    if (!path.startsWith('/internal')) badPath.push(`${verb.toUpperCase()} ${path}`);
    if (firstMiddleware !== 'requireLocalhost') unguarded.push(`${verb.toUpperCase()} ${path}`);
  }

  // A regex that silently matches nothing would pass this test forever.
  assert.ok(found >= 15, `only ${found} route declarations found in internal-routes.ts — the matcher has stopped seeing them.`);

  assert.deepEqual(
    badPath,
    [],
    `Route(s) in internal-routes.ts declared outside /internal: ${badPath.join(', ')}. `
      + 'The internal surface is recognizable (and greppable) by its prefix; a bare path here '
      + 'lands in the general /api namespace where nobody expects an unauthenticated route.',
  );

  assert.deepEqual(
    unguarded,
    [],
    `Route(s) in internal-routes.ts missing requireLocalhost as their first middleware: ${unguarded.join(', ')}. `
      + 'These mount above the auth boundary — without the guard they answer anybody the tunnel forwards.',
  );
});
