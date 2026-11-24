import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ThemeAssetStore } from '../services/theme-assets.js';
import type { ThemeAssetKind } from '../services/theme-assets.js';
import { createThemeAssetsRoutes } from './theme-assets-routes.js';
import { createWebRestOwner } from '../middleware/owner.js';
import { getBytelightConfig } from '../config.js';
import { createFilesRoutes } from './files-routes.js';

const admittedOwner = () => ({ audience: 'owner' as const, thread: 'isolated-test', session: 'isolated-test' });

const directory = mkdtempSync(join(tmpdir(), 'theme-assets-routes-'));
let server: Server, base: string, setup: unknown = {}, unreadable = false;
before(async () => {
  const app = express();
  app.use('/api', createThemeAssetsRoutes({ ownerForRequest: admittedOwner, store: new ThemeAssetStore(directory, { maxBytes: 1024 }), readSetup: () => { if (unreadable) throw new Error('unreadable'); return setup; } }));
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); rmSync(directory, { recursive: true, force: true }); });
async function upload(data: Uint8Array, name: string, kind = 'image'): Promise<Response> {
  const body = new FormData(); body.append('kind', kind); body.append('file', new Blob([data as BlobPart], { type: 'application/octet-stream' }), name);
  return fetch(`${base}/theme-assets`, { method: 'POST', body });
}
describe('theme asset API (mounted under parent authentication)', () => {
  it('constructs the default router before configuration loads and denies unowned requests before storage or multipart parsing', async () => {
    assert.throws(() => getBytelightConfig(), /Config not loaded/);
    assert.doesNotThrow(() => createFilesRoutes(), 'the real API concern router composes before loadConfig too');
    const app = express();
    assert.doesNotThrow(() => app.use('/api', createThemeAssetsRoutes()));
    const local = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/api/theme-assets`;
    try {
      for (const [method, suffix] of [['GET', ''], ['GET', '/not-an-id/file'], ['POST', ''], ['DELETE', '/not-an-id']] as const) {
        const response = await fetch(url + suffix, { method, ...(method === 'POST' ? { body: 'malformed multipart', headers: { 'content-type': 'multipart/form-data' } } : {}) });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: 'owner_session_required' });
      }
      assert.throws(() => getBytelightConfig(), /Config not loaded/, 'denials never initialize storage/configuration');
    } finally { await new Promise<void>((resolve, reject) => local.close(error => error ? reject(error) : resolve())); }
  });
  it('enforces real owner-session and HTTPS same-origin semantics before accepting theme mutations', async () => {
    const ownerForRequest = createWebRestOwner({ session: token => token === 'valid-test-session' ? {
      id: 'test-session', token, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    } : null });
    const store = new ThemeAssetStore(join(directory, 'origin-tests'), { maxBytes: 1024 });
    const app = express();
    app.use('/api', createThemeAssetsRoutes({ store, ownerForRequest, readSetup: () => ({}) }));
    const local = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const host = `127.0.0.1:${(local.address() as { port: number }).port}`;
    const url = `http://${host}/api/theme-assets`;
    const session = { cookie: 'bytelight_session=valid-test-session' };
    const secure = { ...session, origin: `https://${host}`, 'x-forwarded-proto': 'https' };
    try {
      assert.equal((await fetch(url, { headers: session })).status, 200, 'owner GET does not require a mutation Origin');
      for (const headers of [session, { ...secure, origin: 'https://attacker.invalid' }, { ...secure, 'x-forwarded-proto': 'http' }, { ...secure, cookie: 'bytelight_session=unknown' }]) {
        assert.equal((await fetch(url, { method: 'POST', headers })).status, 403);
        assert.equal((await fetch(url + '/not-an-id', { method: 'DELETE', headers })).status, 403);
      }
      const data = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff00ff44' } }).png().toBuffer();
      const body = new FormData(); body.append('kind', 'image'); body.append('file', new Blob([new Uint8Array(data)]), 'private.png');
      const saved = await fetch(url, { method: 'POST', headers: secure, body });
      assert.equal(saved.status, 201);
      const { asset } = await saved.json() as any;
      assert.equal((await fetch(url + `/${asset.id}/file`)).status, 403);
      assert.equal((await fetch(url + `/${asset.id}`, { method: 'DELETE', headers: secure })).status, 200);
    } finally { await new Promise<void>((resolve, reject) => local.close(error => error ? reject(error) : resolve())); }
  });
  it('mounts the preserved theme assets exactly once behind native API authentication', () => {
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
    const files = readFileSync(new URL('./files-routes.ts', import.meta.url), 'utf8');
    assert.ok(api.indexOf('router.use(authMiddleware)') < api.indexOf('router.use(createFilesRoutes())'));
    const mount = 'router.use(createThemeAssetsRoutes())';
    const inFiles = files.includes(mount);
    const inApi = api.includes(mount);
    assert.notEqual(inFiles, inApi, 'one extension point owns the theme route');
    if (inApi) assert.ok(api.indexOf('router.use(authMiddleware)') < api.indexOf(mount));
  });
  it('uploads/lists/serves originals with typed private nosniff headers, protects references, then deletes unused assets', async () => {
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff00ff44' } }).png().toBuffer();
    const response = await upload(bytes, 'overlay.png'); assert.equal(response.status, 201);
    const { asset } = await response.json() as any;
    const list = await fetch(`${base}/theme-assets`); assert.match(list.headers.get('cache-control')!, /private/);
    assert.deepEqual((await list.json() as any).assets, [asset]);
    const image = await fetch(base.replace(/\/api$/, '') + asset.url);
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff'); assert.match(image.headers.get('cache-control')!, /private/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    setup = { theme: { overlayAssetId: asset.id } };
    assert.equal((await fetch(`${base}/theme-assets/${asset.id}`, { method: 'DELETE' })).status, 409);
    setup = {}; unreadable = true;
    assert.equal((await fetch(`${base}/theme-assets/${asset.id}`, { method: 'DELETE' })).status, 409);
    unreadable = false;
    assert.equal((await fetch(`${base}/theme-assets/${asset.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(base.replace(/\/api$/, '') + asset.url)).status, 404);
  });
  it('rejects bad content, missing fields, oversized input and invalid IDs without leaking internals', async () => {
    assert.equal((await upload(new TextEncoder().encode('<svg/>'), 'bad.png')).status, 400);
    assert.equal((await upload(new Uint8Array(2048), 'big.png')).status, 413);
    assert.equal((await upload(new Uint8Array(5), 'bad.png', 'code')).status, 400);
    const absent = await fetch(`${base}/theme-assets/not-a-uuid/file`); assert.equal(absent.status, 404);
    assert.deepEqual(await absent.json(), { error: 'Theme asset not found' });
  });
  it('admits at least sixteen sequential assets within one bounded portable import', async () => {
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#33445566' } }).png().toBuffer();
    for (let i = 0; i < 16; i++) {
      const response = await upload(bytes, `import-${i}.png`);
      assert.equal(response.status, 201, `sequential asset ${i + 1}`);
      const { asset } = await response.json() as any;
      assert.equal(asset.name, `import-${i}.png`);
    }
  });
  it('bounds accepted uploads before multipart parsing and retains decode slots after client abort', async () => {
    let release!: () => void, bothStarted!: () => void, started = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { bothStarted = resolve; });
    class HeldStore extends ThemeAssetStore {
      override async save(data: Buffer, name: string, kind: ThemeAssetKind) {
        if (++started === 2) bothStarted();
        await gate;
        return super.save(data, name, kind);
      }
    }
    const app = express();
    app.use('/api', createThemeAssetsRoutes({ ownerForRequest: admittedOwner, store: new HeldStore(join(directory, 'concurrent'), { maxBytes: 1024 }), readSetup: () => ({}) }));
    const local = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/api/theme-assets`;
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#00000000' } }).png().toBuffer();
    const request = (signal?: AbortSignal) => {
      const body = new FormData(); body.append('kind', 'image'); body.append('file', new Blob([new Uint8Array(bytes).buffer]), 'tiny.png');
      return fetch(url, { method: 'POST', body, signal });
    };
    const controller = new AbortController();
    const first = request(controller.signal).catch(error => error);
    const second = request();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise<void>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Accepted uploads did not enter validation')), 5000); })]);
      clearTimeout(timeout);
      controller.abort(); await first;
      const rejected = await request();
      assert.equal(rejected.status, 429); assert.equal(rejected.headers.get('retry-after'), '1');
      assert.equal(started, 2, 'rejected request never enters store/decode');
      release(); assert.equal((await second).status, 201);
      const retry = await request(); assert.equal(retry.status, 201);
      assert.equal(started, 3, 'slot released only after validation finishes');
    } finally {
      clearTimeout(timeout);
      release();
      await Promise.allSettled([first, second]);
      await new Promise<void>((resolve, reject) => local.close(error => error ? reject(error) : resolve()));
    }
  });
});
