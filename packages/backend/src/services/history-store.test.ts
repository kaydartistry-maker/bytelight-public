import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { brainBatches, brainId, brainLines, brainStore, openHistoryStore, resetHistoryStoreChoice, BRAIN_HISTORY_VERSION } from './history-store.js';
import { HOUSE_VOICE, resetImportStatus, startImport } from './history-import.js';

const dir = mkdtempSync(join(tmpdir(), 'history-store-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A pretend brain with the history door's rules (neuralis history/archive.ts):
 * ids must fit [\w-]{1,128}, at most 8 lines a batch, a message of at most
 * 60000 characters, a repeat keeps the first copy.
 */
function fakeBrain(opts: { version?: number; status?: number } = {}) {
  const rows: Array<{ cursor: number; id: string; source: string; chat: string; title: string; voice: string; pos: number; role: string; at: string | null; body: string; prev: string | null }> = [];
  const calls: string[] = [];
  const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const op = url.pathname.replace(/^\/api\/history\//, '');
    calls.push(op);
    if (opts.status) return new Response('down', { status: opts.status });
    const p = url.searchParams;
    if (op === 'ready') return ok({ version: opts.version ?? BRAIN_HISTORY_VERSION, mode: 'archive', voices: true });
    if (op === 'batch') {
      const b = JSON.parse(String(init?.body));
      const idOk = (x: unknown) => typeof x === 'string' && /^[\w-]{1,128}$/.test(x);
      if (!idOk(b.chat) || b.lines.length > 8) return new Response('bad', { status: 400 });
      let added = 0;
      for (const l of b.lines) {
        if (!idOk(l.id) || l.text.length > 60_000) return new Response('bad passage', { status: 400 });
        const id = `${b.source}:${b.chat}:${l.id}`;
        if (rows.some((r) => r.id === id)) continue;
        rows.push({ cursor: rows.length + 1, id, source: b.source, chat: b.chat, title: b.title, voice: b.voice, pos: l.pos, role: l.role, at: l.at, body: l.text, prev: l.prev ? `${b.source}:${b.chat}:${l.prev}` : null });
        added++;
      }
      return ok({ accepted: b.lines.length, added });
    }
    const voice = p.get('voice');
    if (op === 'passages') {
      const after = Number(p.get('after')); const limit = Number(p.get('limit'));
      const page = rows.filter((r) => r.cursor > after && r.voice === voice).slice(0, limit);
      return ok({ rows: page, next: page.length ? page[page.length - 1].cursor : after, done: page.length < limit });
    }
    if (op === 'count') return ok({ n: rows.filter((r) => r.cursor > Number(p.get('after')) && r.voice === voice).length });
    if (op === 'chats') {
      const mine = rows.filter((r) => r.voice === voice && (!p.get('source') || r.source === p.get('source')));
      const keys = [...new Set(mine.map((r) => `${r.source}|${r.chat}`))];
      return ok({ total: keys.length, chats: keys.map((k) => { const [source, chat] = k.split('|'); const rs = mine.filter((r) => r.source === source && r.chat === chat); return { source, chat, title: rs[0].title, startedAt: rs[0].at, messages: rs.length }; }), sources: [] });
    }
    if (op === 'chat') {
      const rs = rows.filter((r) => r.voice === voice && r.source === p.get('source') && r.chat === p.get('chat')).sort((a, b) => a.pos - b.pos);
      if (!rs.length) return new Response('nope', { status: 404 });
      return ok({ source: p.get('source'), chat: p.get('chat'), title: rs[0].title, lines: rs.map((r) => ({ role: r.role, at: r.at, text: r.body })) });
    }
    return new Response('unknown', { status: 404 });
  }) as typeof fetch;
  return { rows, calls, fetch: fetchFn };
}

describe('fitting an export into the brain', () => {
  it('keeps ids the brain takes, and fingerprints the rest the same way every time', () => {
    assert.equal(brainId('b288aeb0-91c7-47f0-952c'), 'b288aeb0-91c7-47f0-952c');
    const odd = brainId('https://gemini.google.com/app/abc?x=1');
    assert.match(odd, /^h[0-9a-f]{40}$/);
    assert.equal(brainId('https://gemini.google.com/app/abc?x=1'), odd);
  });

  it('sends a very long message as linked parts, every word kept', () => {
    const long = 'a'.repeat(60_000) + 'b'.repeat(10);
    const lines = brainLines([
      { id: 'm1', prev: null, pos: 0, role: 'user', at: null, text: 'hi' },
      { id: 'm2', prev: 'm1', pos: 1, role: 'assistant', at: null, text: long },
      { id: 'm3', prev: 'm2', pos: 2, role: 'user', at: null, text: 'ok' },
    ]);
    assert.deepEqual(lines.map((l) => [l.id, l.prev, l.pos, l.text.length]), [
      ['m1', null, 0, 2], ['m2', 'm1', 1, 60_000], ['m2-part2', 'm2', 2, 10], ['m3', 'm2-part2', 3, 2],
    ]);
    assert.equal(lines.map((l) => l.text).join('').length, 2 + long.length + 2);
  });

  it('cuts batches at 8 lines or about 90 KB', () => {
    const small = Array.from({ length: 20 }, () => ({ text: 'x' }));
    assert.deepEqual(brainBatches(small).map((b) => b.length), [8, 8, 4]);
    const big = Array.from({ length: 3 }, () => ({ text: 'y'.repeat(50_000) }));
    assert.deepEqual(brainBatches(big).map((b) => b.length), [1, 1, 1]);
  });
});

describe('which home a house uses', () => {
  const saved = { url: process.env.MIND_API_URL, key: process.env.MIND_API_KEY };
  beforeEach(() => resetHistoryStoreChoice());
  afterEach(() => {
    if (saved.url === undefined) delete process.env.MIND_API_URL; else process.env.MIND_API_URL = saved.url;
    if (saved.key === undefined) delete process.env.MIND_API_KEY; else process.env.MIND_API_KEY = saved.key;
    resetHistoryStoreChoice();
  });

  it('a house with no brain uses the local file, and reads as empty before anything is imported', async () => {
    delete process.env.MIND_API_URL; delete process.env.MIND_API_KEY;
    const path = join(dir, 'never.db');
    const store = await openHistoryStore({ localPath: path });
    assert.equal(store.kind, 'local');
    assert.deepEqual(await store.chats(HOUSE_VOICE), { total: 0, chats: [], sources: [] });
    assert.equal(existsSync(path), false, 'reading never makes the file');
  });

  it('a brain whose door can read chats back is used; an older one leaves the house local', async () => {
    process.env.MIND_API_URL = 'https://brain.invalid'; process.env.MIND_API_KEY = 'k';
    assert.equal((await openHistoryStore({ fetch: fakeBrain().fetch })).kind, 'brain');
    resetHistoryStoreChoice();
    assert.equal((await openHistoryStore({ fetch: fakeBrain({ version: 2 }).fetch, localPath: join(dir, 'old.db') })).kind, 'local');
  });

  it('a brain that does not answer is an error, never a quiet switch to the local file', async () => {
    process.env.MIND_API_URL = 'https://brain.invalid'; process.env.MIND_API_KEY = 'k';
    await assert.rejects(openHistoryStore({ fetch: fakeBrain({ status: 503 }).fetch }), /not answering/);
  });
});

describe('importing into the brain', () => {
  beforeEach(() => resetImportStatus());

  const claudeExport = () => {
    const path = join(dir, `claude-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify([{
      uuid: 'chat-1', name: 'Rain ride', created_at: '2026-10-01T12:00:00Z',
      chat_messages: [
        { uuid: 'm1', sender: 'human', text: 'It rained the whole ride.', created_at: '2026-10-01T12:00:00Z', parent_message_uuid: '00000000-0000-4000-8000-000000000000' },
        { uuid: 'm2', sender: 'assistant', text: 'You still went.', created_at: '2026-10-01T12:01:00Z', parent_message_uuid: 'm1' },
      ],
    }]));
    return path;
  };

  it('stores the words in the brain, not on this machine, indexes them, and a repeat adds nothing', async () => {
    const brain = fakeBrain();
    const store = brainStore('https://brain.invalid', 'k', { fetch: brain.fetch });
    const indexPath = join(dir, 'brain-index.db');
    const embed = async () => Float32Array.from([1, 0, 0]);
    const first = await startImport(claudeExport(), {}, { embed, store, indexPath });
    assert.equal(first.state, 'done', first.error ?? '');
    assert.deepEqual([first.chats, first.stored, first.indexed], [1, 2, 2]);
    assert.ok(first.pieces >= 1, 'the words reached the index');
    assert.deepEqual(brain.rows.map((r) => [r.voice, r.body]), [[HOUSE_VOICE, 'It rained the whole ride.'], [HOUSE_VOICE, 'You still went.']]);
    assert.equal(existsSync(join(dir, 'history-passages.db')), false);

    const again = await startImport(claudeExport(), {}, { embed, store, indexPath });
    assert.deepEqual([again.state, again.stored, again.toIndex], ['done', 0, 0]);

    const list = await store.chats(HOUSE_VOICE);
    assert.equal(list.total, 1);
    const read = await store.chat(HOUSE_VOICE, 'claude', 'chat-1');
    assert.deepEqual(read?.lines.map((l) => l.text), ['It rained the whole ride.', 'You still went.']);
    assert.equal(await store.chat(HOUSE_VOICE, 'claude', 'nope'), null);
  });

  it('a brain that refuses stops the import and says so', async () => {
    const store = brainStore('https://brain.invalid', 'k', { fetch: fakeBrain({ status: 400 }).fetch });
    const s = await startImport(claudeExport(), {}, { embed: async () => Float32Array.from([1]), store, indexPath: join(dir, 'refused.db') });
    assert.equal(s.state, 'failed');
    assert.match(s.error ?? '', /brain refused/);
  });
});
