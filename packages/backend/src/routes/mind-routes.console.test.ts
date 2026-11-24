import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createMindRoutes } from './mind-routes.js';
import { consoleAllows, consoleSegments } from '../services/mind-console.js';

const servers: HttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

type Seen = { method: string; url: string; auth: string | undefined; body: string };

async function listen(server: HttpServer): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
}

// A pretend brain that records what reached it and answers like Neuralis.
async function fakeBrain(seen: Seen[]): Promise<string> {
  return listen(createServer(async (req, res) => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: await readBody(req) });
    res.writeHead(req.url!.startsWith('/api/missing') ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, from: 'brain' }));
  }));
}

async function house(brain: string, opts: { auth?: boolean; key?: string } = {}): Promise<string> {
  const app = express();
  app.use(express.json());
  const api = express.Router();
  if (opts.auth) api.use((_req, res) => res.status(401).json({ error: 'unauthorized' })); // stands in for authMiddleware
  api.use(createMindRoutes({ url: () => brain, key: () => opts.key ?? 'k-123' }));
  app.use('/api', api);
  return `${await listen(createServer(app))}/api`;
}

describe('mind console rules', () => {
  it('lets every known room be read and refuses unknown rooms', () => {
    assert.equal(consoleAllows('GET', ['threads']), true);
    assert.equal(consoleAllows('GET', ['cortex', 'thoughts']), true);
    assert.equal(consoleAllows('GET', ['secrets']), false);
  });

  it('lets named writes through and nothing else', () => {
    assert.equal(consoleAllows('POST', ['threads', 'abc', 'resolve']), true);
    assert.equal(consoleAllows('POST', ['observations', '12', 'sit']), true);
    assert.equal(consoleAllows('POST', ['entities', 'merge']), true);
    assert.equal(consoleAllows('PUT', ['identity', 'core']), true);
    assert.equal(consoleAllows('DELETE', ['identity', 'core']), false);
    assert.equal(consoleAllows('POST', ['crons', 'x', 'fire']), false);
    assert.equal(consoleAllows('PATCH', ['crons', 'x']), false);
    assert.equal(consoleAllows('DELETE', ['threads']), false);
    assert.equal(consoleAllows('POST', ['isolated', 'connect']), true);
    assert.equal(consoleAllows('POST', ['isolated', 'ignore']), true);
    assert.equal(consoleAllows('POST', ['isolated', 'Owner', 'connect']), false);
  });

  it('refuses unsafe paths', () => {
    assert.equal(consoleSegments('threads/..'), null);
    assert.equal(consoleSegments('threads/%2e%2e'), null);
    assert.equal(consoleSegments('a/b/c/d/e/f'), null);
    assert.equal(consoleSegments(''), null);
    assert.deepEqual(consoleSegments('entities/Owner'), ['entities', 'Owner']);
  });
});

describe('mind console hallway', () => {
  it('passes a read through with the key and the query', async () => {
    const seen: Seen[] = [];
    const base = await house(await fakeBrain(seen));
    const r = await fetch(`${base}/mind/brain/search?q=mint%20chip`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, from: 'brain' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, '/api/search?q=mint%20chip');
    assert.equal(seen[0].auth, 'Bearer k-123');
  });

  it('passes a named write through with its body', async () => {
    const seen: Seen[] = [];
    const base = await house(await fakeBrain(seen));
    const r = await fetch(`${base}/mind/brain/threads/t1/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution: 'done' }),
    });
    assert.equal(r.status, 200);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/api/threads/t1/resolve');
    assert.deepEqual(JSON.parse(seen[0].body), { resolution: 'done' });
  });

  it('never lets an unnamed write reach the brain', async () => {
    const seen: Seen[] = [];
    const base = await house(await fakeBrain(seen));
    for (const [method, path] of [['POST', 'crons/nightly/fire'], ['POST', 'process'], ['DELETE', 'identity/core'], ['GET', 'secrets']]) {
      const r = await fetch(`${base}/mind/brain/${path}`, { method });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    assert.equal(seen.length, 0);
  });

  it('hands the brain\'s own status back', async () => {
    const seen: Seen[] = [];
    const base = await house(await fakeBrain(seen));
    // 'missing' is not a room, so it never leaves; a real 404 comes from a known room
    assert.equal((await fetch(`${base}/mind/brain/missing`)).status, 403);
    const brain = await listen(createServer((_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Thread not found"}'); }));
    const base2 = await house(brain);
    const r = await fetch(`${base2}/mind/brain/threads/nope`);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'Thread not found' });
  });

  it('says so plainly when the brain is not set up or not reachable', async () => {
    const base = await house('', {});
    assert.equal((await fetch(`${base}/mind/brain/health`)).status, 503);
    const dead = await house('http://127.0.0.1:1');
    const r = await fetch(`${dead}/mind/brain/health`);
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'could not reach the brain' });
  });

  it('is behind the login: nothing answers without it', async () => {
    const seen: Seen[] = [];
    const base = await house(await fakeBrain(seen), { auth: true });
    assert.equal((await fetch(`${base}/mind/brain/threads`)).status, 401);
    assert.equal(seen.length, 0);
  });
});
