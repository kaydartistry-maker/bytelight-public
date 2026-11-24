import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createMindShareRoutes, readShare, shareCard } from './mind-share-routes.js';

const servers: HttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

type Posted = { content: string; metadata: Record<string, unknown> };

async function start(opts: { auth?: boolean; failTask?: boolean } = {}) {
  const tasks: { text: string; created_by?: string }[] = [];
  const posts: Posted[] = [];
  const app = express();
  app.use(express.json());
  const api = express.Router();
  if (opts.auth) api.use((_req, res) => res.status(401).json({ error: 'unauthorized' })); // stands in for authMiddleware
  api.use(createMindShareRoutes({
    addTask: (p) => {
      if (opts.failTask) throw new Error('db locked');
      tasks.push(p);
      return { id: `task-${tasks.length}`, text: p.text };
    },
    postToHome: (content, metadata) => {
      posts.push({ content, metadata });
      return { threadId: 'home-1', threadName: 'The boys', messageId: `m-${posts.length}` };
    },
  }));
  app.use('/api', api);
  const http = createServer(app);
  servers.push(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { post, tasks, posts };
}

describe('mind share: a thread becomes a task', () => {
  it('makes a Command Center task with the thread\'s words', async () => {
    const h = await start();
    const r = await h.post('/mind/share/task', { text: '  Pending: sort the inventory  ' });
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { ok: true, task: { id: 'task-1', text: 'Pending: sort the inventory' } });
    assert.deepEqual(h.tasks, [{ text: 'Pending: sort the inventory', created_by: 'user' }]);
  });

  it('refuses an empty or oversize task and makes nothing', async () => {
    const h = await start();
    assert.equal((await h.post('/mind/share/task', {})).status, 400);
    assert.equal((await h.post('/mind/share/task', { text: '   ' })).status, 400);
    assert.equal((await h.post('/mind/share/task', { text: 'a'.repeat(2001) })).status, 400);
    assert.equal(h.tasks.length, 0);
  });

  it('says so when the task could not be made', async () => {
    const h = await start({ failTask: true });
    const r = await h.post('/mind/share/task', { text: 'x' });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'the task could not be made' });
  });
});

describe('mind share: a card in the home chat', () => {
  it('posts a feeling as a quoted card with where it came from', async () => {
    const h = await start();
    const r = await h.post('/mind/share/chat', {
      kind: 'feeling', text: 'Proud of her.\nShe built it.', who: 'companion-b', emotion: 'proud', about: 'Owner', day: '24 Nov', brainId: 'feel-131',
    });
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { ok: true, threadId: 'home-1', threadName: 'The boys', messageId: 'm-1' });
    assert.equal(h.posts[0].content, "From the brain · Companion B's feeling (proud) about Owner · 24 Nov\n\n> Proud of her.\n> She built it.");
    assert.deepEqual(h.posts[0].metadata, { source: 'mind-console', kind: 'feeling', brainId: 'feel-131' });
  });

  it('refuses unknown kinds and empty text, and posts nothing', async () => {
    const h = await start();
    assert.equal((await h.post('/mind/share/chat', { kind: 'thread', text: 'x' })).status, 400);
    assert.equal((await h.post('/mind/share/chat', { kind: 'journal', text: '' })).status, 400);
    assert.equal(h.posts.length, 0);
  });

  it('sits behind the login with its neighbours', async () => {
    const h = await start({ auth: true });
    assert.equal((await h.post('/mind/share/task', { text: 'x' })).status, 401);
    assert.equal((await h.post('/mind/share/chat', { kind: 'note', text: 'x' })).status, 401);
    assert.equal(h.tasks.length + h.posts.length, 0);
  });
});

describe('mind share: the card words', () => {
  it('names shared and unsigned things plainly', () => {
    assert.equal(shareCard({ kind: 'journal', text: 'entry', who: 'shared' }), "From the brain · Companion A & Companion B's journal entry\n\n> entry");
    assert.equal(shareCard({ kind: 'note', text: 'n', about: 'Robin' }), 'From the brain · a note about Robin\n\n> n');
  });

  it('trims the small fields and ignores what is not text', () => {
    const r = readShare({ kind: 'note', text: 'x', who: 42, emotion: '  tender ' });
    assert.deepEqual(r, { kind: 'note', text: 'x', who: undefined, emotion: 'tender', about: undefined, day: undefined });
  });
});
