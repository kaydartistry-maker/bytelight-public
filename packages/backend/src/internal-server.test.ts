import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { initDb } from './services/db/init.js';
import { createInternalApp } from './internal-server.js';

// The point of the separate port is that a TEST can hold it.
//
// The old rule — loopback socket and no proxy headers — could not be tested,
// because its correctness lived in a reverse-proxy config that is not in this
// repo. Every assertion you could write about it passed on a box whose proxy
// was fine and would have gone on passing on a box whose proxy was not.
//
// Reachability is different. The internal routes are either on the public app
// or they are not, and that is a fact about this source tree.

const SRC = dirname(fileURLToPath(import.meta.url));

// This house mounts the public routes through routes/api.ts, and the internal
// router used to be mounted there (router.use(createInternalRoutes())), so
// both files are held.
test('the public app does not carry the internal routes', () => {
  const server = readFileSync(join(SRC, 'server.ts'), 'utf-8');
  const api = readFileSync(join(SRC, 'routes', 'api.ts'), 'utf-8');

  for (const [name, source] of [['server.ts', server], ['routes/api.ts', api]] as const) {
    assert.doesNotMatch(
      source, /createInternalRoutes\s*\(/,
      `${name} must not mount the internal router on the public app — that is the whole change`,
    );
    assert.doesNotMatch(
      source, /^\s*import\s+[^;]*\binternal-routes\.js/m,
      `${name} should not import the internal router at all`,
    );
    assert.doesNotMatch(
      source, /^\s*import\s+[^;]*\bcc-mcp\.js/m,
      `${name} should not import the Command Center MCP router; it lives on the internal port`,
    );
  }
  assert.match(
    server, /startInternalServer\(/,
    'the public server must start the internal one, or nothing serves /api/internal',
  );
});

test('the old address answers a local caller with somewhere to go, not with HTML', () => {
  const server = readFileSync(join(SRC, 'server.ts'), 'utf-8');

  // Without a handler the address falls through to the SPA fallback and
  // answers 200 with index.html, which reads to a script as success.
  assert.match(server, /app\.use\(\s*['"`]\/api\/internal['"`]/, 'the old address needs a handler');
  assert.match(server, /410/, 'a direct-local caller on the old port should be told it moved');
});

// The journal reads a remote brain in this house, so the routes below ask the
// field notes instead: a local table, so a 200 means the router is mounted and
// working, not that a remote answered.
test('a request that reached the internal port is served', async () => {
  initDb(':memory:');
  const app = createInternalApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/field-notes?limit=1`);
    // This used to assert only "not a 404" and "is JSON", which a 500 with a
    // JSON error body satisfies — the router could be mounted and broken and
    // this still passed. Ask for the actual answer instead.
    assert.equal(res.status, 200, 'the internal router must be mounted AND working on this app');
    assert.match(res.headers.get('content-type') || '', /json/, 'and it must answer JSON, not a page');
    const body = await res.json() as { notes?: unknown };
    assert.ok(Array.isArray(body.notes), 'and the answer must have the shape a caller reads');
  } finally {
    server.close();
  }
});

test('a relayed request is still refused even on the internal port', async () => {
  initDb(':memory:');
  const app = createInternalApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    // Belt as well as braces. Reachability is the guarantee; this is what
    // catches a front accidentally pointed at this port.
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/field-notes`, {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    assert.equal(res.status, 404, 'a proxy hop must still be refused here');
  } finally {
    server.close();
  }
});

test('the internal port is configurable and defaults away from the public one', async () => {
  const { loadConfig } = await import('./config.js');
  const cfg = loadConfig();
  assert.equal(typeof cfg.server.internal_port, 'number');
  assert.notEqual(
    cfg.server.internal_port, cfg.server.port,
    'the internal surface must not share the port the proxy fronts',
  );
});

// The 404 that told nobody anything.
//
// The public app answers 410 with a hint when an internal route is sent to it.
// The reverse had no answer at all: a caller on this box asking this port for a
// PUBLIC route — /api/cortex/remember, /api/memory/blocks, /api/studio — got a
// bare "Not found", which is exactly what a route that does not exist returns.
// A whole batch of writes was thrown away against that silence before anybody
// tried the other door.
test('a public route asked of the internal port is told where the door is', async () => {
  initDb(':memory:');
  const app = createInternalApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/cortex/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x', domain: 'canon' }),
    });
    assert.equal(res.status, 404, 'it is still not here');
    const body = await res.json() as { error?: string; publicPort?: number; hint?: string };
    assert.match(body.error || '', /public route/i, 'but the reason must say so');
    assert.equal(typeof body.publicPort, 'number', 'and it must name the port that has it');
    assert.match(body.hint || '', /\/api\/cortex\/remember$/, 'and hand back the same path');
  } finally {
    server.close();
  }
});

// The hint must not fire for the routes this port really owns — an unknown
// /api/internal/* address is a genuine miss and pointing it at the public app
// would send the next window somewhere it definitely is not.
test('an unknown internal route is a plain miss, not a redirect to the public app', async () => {
  initDb(':memory:');
  const app = createInternalApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/not-a-real-route`);
    assert.equal(res.status, 404);
    const body = await res.json() as { error?: string; publicPort?: number };
    assert.equal(body.publicPort, undefined, 'an internal miss must not advertise the public port');
    assert.doesNotMatch(body.error || '', /public route/i);
  } finally {
    server.close();
  }
});

// fetch silently drops a Host header, so these go through node:http, which
// sends what it is given, the way a rebinding browser's request arrives.
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('a doubled slash does not get past the guard', async () => {
  initDb(':memory:');
  const app = createInternalApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const path = '/internal/field-notes?limit=1';
    assert.equal(await rawGet(port, `/api${path}`, { host: '127.0.0.1' }), 200, 'our own call is served');
    assert.equal(await rawGet(port, `/api${path}`, { host: 'rebind.example' }), 404, 'the guard refuses a foreign Host');
    assert.equal(await rawGet(port, `/api/${path}`, { host: 'rebind.example' }), 404, 'and still refuses it with the slash doubled');
    assert.equal(await rawGet(port, `/api${path}`, { host: '127.0.0.1', origin: 'https://evil.test' }), 404, 'a request a page sent is refused');
  } finally {
    server.close();
  }
});

test('a service switched on later on the public app reaches the internal app too', async () => {
  const { createInternalApp, shareWithInternal } = await import('./internal-server.js');
  const app = createInternalApp({ discordService: null });
  assert.equal(app.locals.discordService, null);
  const svc = { sayInChannel: async () => ({ ok: true }) };
  shareWithInternal('discordService', svc);
  assert.equal(app.locals.discordService, svc);
  shareWithInternal('discordService', null);
  assert.equal(app.locals.discordService, null);
});
