// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Spotify worker's lock (1.2.0). Before it, with
// no key, anyone who had the address could drive the owner's Spotify, and
// anyone who opened /auth could sign their own Spotify in over the owner's. These
// tests load the worker file itself and call its fetch handler directly, so
// they read the same code a Cloudflare deploy runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Kv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};
type Env = Record<string, unknown> & { SPOTIFY_KV: Kv };
type Worker = { fetch(request: Request, env: Env): Promise<Response> };

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, '../../../../workers/spotify-mcp/index.js');

async function loadWorker(): Promise<Worker> {
  const mod = await import(pathToFileURL(workerPath).href);
  return mod.default as Worker;
}

function memoryKv(): Kv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key)! : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

const SECRET = 'open-sesame';

function env(secret: string | null, kv = memoryKv()): Env {
  return {
    SPOTIFY_CLIENT_ID: 'client',
    SPOTIFY_CLIENT_SECRET: 'shh',
    SPOTIFY_REDIRECT_URI: 'https://worker.example/callback',
    SPOTIFY_KV: kv,
    ...(secret ? { MCP_SECRET: secret } : {}),
  };
}

function initialize(path = '/mcp', headers: Record<string, string> = {}): Request {
  return new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
}

test('with no secret set, the worker answers the way it always has', async () => {
  const worker = await loadWorker();
  assert.equal((await worker.fetch(initialize(), env(null))).status, 200);
  const auth = await worker.fetch(new Request('https://worker.example/auth'), env(null));
  assert.equal(auth.status, 302);
});

test('with a secret set, /mcp and /auth turn away a call with no key or a wrong one', async () => {
  const worker = await loadWorker();
  const locked = env(SECRET);
  assert.equal((await worker.fetch(initialize(), locked)).status, 401);
  assert.equal((await worker.fetch(new Request('https://worker.example/auth'), locked)).status, 401);
  for (const wrong of ['nope', 'open-sesamE', `${SECRET}x`]) {
    assert.equal((await worker.fetch(initialize('/mcp', { Authorization: `Bearer ${wrong}` }), locked)).status, 401, wrong);
    assert.equal((await worker.fetch(initialize(`/mcp?key=${wrong}`), locked)).status, 401, wrong);
    assert.equal((await worker.fetch(new Request(`https://worker.example/auth?key=${wrong}`), locked)).status, 401, wrong);
  }
});

test('the right key opens /mcp by header or by address', async () => {
  const worker = await loadWorker();
  const locked = env(SECRET);
  const byHeader = await worker.fetch(initialize('/mcp', { Authorization: `Bearer ${SECRET}` }), locked);
  assert.equal(byHeader.status, 200);
  const body = await byHeader.json() as { result: { serverInfo: { version: string } } };
  assert.equal(body.result.serverInfo.version, '1.2.0');
  assert.equal((await worker.fetch(initialize(`/mcp?key=${SECRET}`), locked)).status, 200);
});

test('/auth leaves a one-time state, and /callback refuses a sign-in without it', async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const locked = env(SECRET, kv);
  const auth = await worker.fetch(new Request(`https://worker.example/auth?key=${SECRET}`), locked);
  assert.equal(auth.status, 302);
  const sent = new URL(auth.headers.get('Location')!);
  const state = sent.searchParams.get('state');
  assert.ok(state, 'the redirect to Spotify carries a state');
  assert.ok(kv.store.has(`auth_state:${state}`), 'the state is kept to be checked on the way back');

  // No state, a made-up state: refused before any token is asked for.
  assert.equal((await worker.fetch(new Request('https://worker.example/callback?code=abc'), locked)).status, 400);
  assert.equal((await worker.fetch(new Request('https://worker.example/callback?code=abc&state=made-up'), locked)).status, 400);
  assert.ok(kv.store.has(`auth_state:${state}`), 'a refused callback does not spend the real state');
});

test('the real state is spent the first time it comes back', async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const locked = env(SECRET, kv);
  const auth = await worker.fetch(new Request(`https://worker.example/auth?key=${SECRET}`), locked);
  const state = new URL(auth.headers.get('Location')!).searchParams.get('state')!;
  // No code on purpose, so nothing reaches Spotify; the state is checked first.
  assert.equal((await worker.fetch(new Request(`https://worker.example/callback?state=${state}`), locked)).status, 400);
  assert.equal(kv.store.has(`auth_state:${state}`), false);
});
