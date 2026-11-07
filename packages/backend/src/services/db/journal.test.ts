import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'journal-test-'));
process.env.RESONANT_HOME = root;
process.env.MIND_API_URL = 'https://mind.test';
process.env.MIND_API_KEY = 'test-key';
writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');
const { initDb, getDb } = await import('../db.js');
const journal = await import('./journal.js');
initDb(join(root, 'test.db'));

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string; body?: unknown }> = [];
let handler: (url: URL, method: string, body?: unknown) => Response;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.toString(), method, body });
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key');
    return handler(url, method, body);
  }) as typeof fetch;
});

after(() => { globalThis.fetch = realFetch; getDb().close(); rmSync(root, { recursive: true, force: true }); });

const journalRow = (id: number, date = '2026-09-01T00:00:00Z') => ({
  id, entry_date: date, created_at: date, content: `journal ${id}`, tags: null, emotion: null, companion: 'companion-a',
});
const dreamRow = (id: number, date = '2026-09-02T00:00:00Z') => ({
  id, dream_date: date, created_at: date, content: `dream ${id}`, emotional_seed: null, fragments: null,
  recurring_dream_id: null, recurrence_count: 0, companion: 'companion-a', vividness: 80, anchored_at: null,
  last_recalled_at: date, dream_type: 'processing', emerged_question: 'Why?', effective_vividness: 37,
});

test('prefixed ids route to the correct resource and malformed ids are clean misses', async () => {
  handler = (url) => Response.json(url.pathname.includes('journals') ? journalRow(12) : dreamRow(12));
  assert.equal((await journal.getJournalEntry('j:12'))?.entry_type, 'journal');
  const dream = await journal.getJournalEntry('d:12');
  assert.equal(dream?.entry_type, 'dream');
  assert.equal(dream?.emerged_question, 'Why?');
  assert.equal(journal.effectiveVividness(dream!), 37);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/api/journals/12', '/api/dreams/12']);
  assert.equal(await journal.getJournalEntry('12'), null);
  assert.equal(await journal.getJournalEntry('d:nope'), null);
  assert.equal(calls.length, 2);
});

test('lists merge newest first, preserve effective vividness, then paginate locally', async () => {
  handler = (url) => Response.json(url.pathname === '/api/journals'
    ? [journalRow(1, '2026-09-01T00:00:00Z')]
    : [dreamRow(2, '2026-09-03T00:00:00Z'), dreamRow(3, '2026-08-01T00:00:00Z')]);
  const result = await journal.listJournalEntries({ companionId: 'companion-a', limit: 2, offset: 1 });
  assert.equal(result.total, 3);
  assert.deepEqual(result.entries.map(entry => entry.id), ['j:1', 'd:3']);
  assert.equal((await journal.listJournalEntries({ entryType: 'dream' })).entries[0].effective_vividness, 37);
  assert.ok(calls.every(call => call.url.includes('companion=companion-a')) || calls.length > 2);
});

test('journal recall is a remote-write no-op but still records its receipt', async () => {
  handler = () => Response.json(journalRow(7));
  const recalled = await journal.recallJournalEntry('j:7');
  assert.equal(recalled?.id, 'j:7');
  assert.deepEqual(calls.map(call => call.method), ['GET']);
  assert.deepEqual(getDb().prepare('SELECT actor, action, subject_id FROM memory_ledger ORDER BY id DESC LIMIT 1').get(),
    { actor: 'companion-a', action: 'journal.recall', subject_id: 'j:7' });
});

test('create uses remote ids and receipts only follow successful calls', async () => {
  handler = (_url, method) => method === 'POST' ? Response.json(dreamRow(44), { status: 201 }) : Response.json(dreamRow(44));
  const created = await journal.createJournalEntry({ id: 'ignored-local-id', companionId: 'companion-a', entryType: 'dream', content: 'dream 44' });
  assert.equal(created.id, 'd:44');
  assert.equal(calls[0].method, 'POST');
  assert.equal((calls[0].body as { companion: string }).companion, 'companion-a');
  assert.equal((getDb().prepare('SELECT subject_id FROM memory_ledger ORDER BY id DESC LIMIT 1').get() as { subject_id: string }).subject_id, 'd:44');
});

test('network failures become typed errors', async () => {
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  await assert.rejects(() => journal.getJournalEntry('d:1'), (error: unknown) =>
    error instanceof journal.JournalRemoteError && error.message === 'Could not reach the Mind API: offline');
});
