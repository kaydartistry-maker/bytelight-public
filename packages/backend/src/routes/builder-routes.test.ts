import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createBuilderRoutes, builderRestOwner } from './builder-routes.js';

test('REST refuses missing owner before dispatch and strips spoofed identity/configuration', async () => {
  const app = express(); app.use(express.json()); let calls = 0;
  app.use('/api', createBuilderRoutes(req => {
    if (req.get('x-fixture-owner') !== 'yes') throw new Error('not owner');
    return { audience: 'owner', thread: 'trusted-thread', session: 'trusted-session' };
  }, async (action, args, owner) => {
    calls++; assert.equal(owner.thread, 'trusted-thread');
    assert.equal(args.workspace, undefined); assert.equal(args.command, undefined); assert.equal(args.path, undefined); assert.equal(args.audience, undefined); assert.equal(args.ownerSession, undefined);
    return { action, args, id: 'job' };
  }));
  const server = createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/builder/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audience: 'owner', task: 'spoof' }) });
    assert.equal(denied.status, 403); assert.equal(calls, 0);
    for (const [method, path] of [['GET', '/jobs'], ['POST', '/jobs'], ['GET', '/jobs/id'], ['GET', '/jobs/id/logs?cursor=3'], ['POST', '/jobs/id/stop'], ['POST', '/jobs/id/prepare-deploy'], ['POST', '/jobs/id/deploy'], ['GET', '/jobs/id/deploy'], ['GET', '/jobs/id/deploy/logs?cursor=3'], ['POST', '/jobs/id/rollback']]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/builder${path}`, { method, headers: { 'x-fixture-owner': 'yes', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ task: 'fix', command: 'rm data', path: '/etc', workspace: '/production', audience: 'owner', ownerSession: 'spoof' }) } : {}) });
      assert.equal(response.status, path === '/jobs' && method === 'POST' ? 202 : 200);
    }
    assert.equal(calls, 10);
    assert.throws(() => builderRestOwner({ headers: {}, method: 'GET' } as never));
  } finally { await new Promise<void>(r => server.close(() => r())); }
});


test("configured owner REST rejects absent session token before database lookup", async () => {
  const { loadConfig } = await import("../config.js");
  const config = loadConfig("/dev/null");
  const previous = config.auth.password; config.auth.password = "fixture-password";
  try {
    for (const cookie of [undefined, "unrelated=value"]) {
      assert.throws(() => builderRestOwner({ headers: { cookie }, method: "GET" } as never), /Owner session required/);
    }
  } finally { config.auth.password = previous; }
});
