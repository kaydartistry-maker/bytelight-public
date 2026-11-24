import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { createAppSettingsRoutes } from './app-settings-routes.js';

const servers: HttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function start(withAuth = false) {
  let saved: string | null = null;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const api = express.Router();
  if (withAuth) api.use((_req, res) => res.status(401).json({ error: 'unauthorized' })); // stands in for authMiddleware
  api.use(createAppSettingsRoutes({
    store: { get: () => saved, set: (v) => { saved = v; } },
    assetsDir: mkdtempSync(join(tmpdir(), 'bl-assets-')),
    now: () => 1234,
  }));
  app.use('/api', api);
  const http = createServer(app);
  servers.push(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/api`;
}

describe('app-settings sync', () => {
  it('starts empty, then saves and returns the setup with its time', async () => {
    const base = await start();
    assert.deepEqual(await (await fetch(`${base}/app-settings`)).json(), { settings: null, updatedAt: 0 });
    const put = await fetch(`${base}/app-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { v: 2, look: { mode: 'dark' } } }) });
    assert.deepEqual(await put.json(), { ok: true, updatedAt: 1234 });
    assert.deepEqual(await (await fetch(`${base}/app-settings`)).json(), { settings: { v: 2, look: { mode: 'dark' } }, updatedAt: 1234 });
  });

  it('refuses junk and oversize setups', async () => {
    const base = await start();
    for (const body of [{}, { settings: 'x' }, { settings: [1] }]) {
      const r = await fetch(`${base}/app-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(r.status, 400);
    }
    const big = await fetch(`${base}/app-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { s: 'a'.repeat(5 * 1024 * 1024) } }) });
    assert.equal(big.status, 413);
  });

  it('stores an asset once by its contents and serves it back with its type', async () => {
    const base = await start();
    const bytes = Buffer.from('pretend this is a font file');
    const sha = createHash('sha256').update(bytes).digest('hex');
    assert.equal((await fetch(`${base}/app-assets/${sha}`, { method: 'HEAD' })).status, 404);
    const up = await fetch(`${base}/app-assets`, { method: 'PUT', headers: { 'Content-Type': 'font/ttf' }, body: bytes });
    assert.deepEqual(await up.json(), { id: sha });
    assert.equal((await fetch(`${base}/app-assets/${sha}`, { method: 'HEAD' })).status, 200);
    const got = await fetch(`${base}/app-assets/${sha}`);
    assert.equal(got.headers.get('content-type'), 'font/ttf');
    assert.equal(Buffer.from(await got.arrayBuffer()).toString(), 'pretend this is a font file');
    assert.match(got.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(got.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    const part = await fetch(`${base}/app-assets/${sha}`, { headers: { Range: 'bytes=0-6' } });
    assert.equal(part.status, 206);
    assert.equal(Buffer.from(await part.arrayBuffer()).toString(), 'pretend');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    // Same bytes again: same id, nothing new.
    assert.deepEqual(await (await fetch(`${base}/app-assets`, { method: 'PUT', headers: { 'Content-Type': 'font/ttf' }, body: bytes })).json(), { id: sha });
  });

  it('refuses path tricks, empty files and bad types', async () => {
    const base = await start();
    assert.equal((await fetch(`${base}/app-assets/..%2F..%2Fetc%2Fpasswd`)).status, 404);
    assert.equal((await fetch(`${base}/app-assets/not-a-sha`)).status, 404);
    assert.equal((await fetch(`${base}/app-assets`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(0) })).status, 400);
    assert.equal((await fetch(`${base}/app-assets`, { method: 'PUT', headers: { 'Content-Type': 'text/html"><script>' }, body: Buffer.from('x') })).status, 400);
  });

  it('refuses pages and scripts, but keeps pictures, fonts, videos and unlabeled files', async () => {
    const base = await start();
    for (const type of ['text/html', 'application/xhtml+xml', 'text/javascript', 'application/javascript', 'text/xml']) {
      const r = await fetch(`${base}/app-assets`, { method: 'PUT', headers: { 'Content-Type': type }, body: Buffer.from('<p>' + type) });
      assert.equal(r.status, 415, type);
    }
    for (const type of ['image/png', 'image/webp', 'image/svg+xml', 'video/mp4', 'font/woff2', 'application/octet-stream']) {
      const r = await fetch(`${base}/app-assets`, { method: 'PUT', headers: { 'Content-Type': type }, body: Buffer.from('bytes ' + type) });
      assert.equal(r.status, 200, type);
    }
  });

  it('allows files up to 25 MB and refuses bigger', async () => {
    const base = await start();
    const ok = await fetch(`${base}/app-assets`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.alloc(21 * 1024 * 1024, 1) });
    assert.equal(ok.status, 200);
    const big = await fetch(`${base}/app-assets`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.alloc(26 * 1024 * 1024, 1) });
    assert.equal(big.status, 413);
  });

  it('is behind the login: nothing answers without it', async () => {
    const base = await start(true);
    assert.equal((await fetch(`${base}/app-settings`)).status, 401);
    assert.equal((await fetch(`${base}/app-assets`, { method: 'PUT', body: 'x' })).status, 401);
  });
});
