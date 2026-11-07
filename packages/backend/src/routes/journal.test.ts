import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';

const root = mkdtempSync(join(tmpdir(), 'journal-routes-'));
process.env.RESONANT_HOME = root;
process.env.MIND_API_URL = 'https://mind.test';
process.env.MIND_API_KEY = 'route-key';
writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');
const { initDb, getDb } = await import('../services/db.js');
const { loadConfig } = await import('../config.js');
const { default: journalRouter } = await import('./journal.js');

const realFetch = globalThis.fetch;
let failRemote = false;
const dream = {
  id: 7, dream_date: '2026-09-08T00:00:00Z', created_at: '2026-09-08T00:00:00Z', content: 'A blue door',
  emotional_seed: null, fragments: null, recurring_dream_id: null, recurrence_count: 0, companion: 'companion-a',
  vividness: 80, anchored_at: null, last_recalled_at: '2026-09-07T00:00:00Z', dream_type: 'processing',
  emerged_question: 'What waits?', effective_vividness: 41,
};

before(() => {
  initDb(join(root, 'test.db'));
  loadConfig(join(root, 'config.yaml'));
  globalThis.fetch = (async (input, init) => {
    if (failRemote) throw new Error('remote unavailable');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer route-key');
    const path = new URL(String(input)).pathname;
    if (path === '/api/journals') return Response.json([]);
    if (path === '/api/dreams') return Response.json([dream]);
    if (path === '/api/dreams/7') return Response.json(dream);
    if (path === '/api/dreams/7/recall') return Response.json({ ...dream, effective_vividness: 56 });
    return Response.json({ error: 'not found' }, { status: 404 });
  }) as typeof fetch;
});

after(() => { globalThis.fetch = realFetch; getDb().close(); rmSync(root, { recursive: true, force: true }); });

interface FakeRes { statusCode: number; jsonBody: unknown }
function callRoute(method: 'GET' | 'POST' | 'DELETE', url: string, query: Record<string, string> = {}): Promise<FakeRes> {
  return new Promise((resolve, reject) => {
    const out: FakeRes = { statusCode: 200, jsonBody: undefined };
    const req = { method, url, path: url, headers: {}, query, params: {} } as unknown as Request;
    const res = {
      status(code: number) { out.statusCode = code; return this; },
      json(payload: unknown) { out.jsonBody = payload; resolve(out); return this; },
    } as unknown as Response;
    (journalRouter as unknown as (req: Request, res: Response, next: (error?: unknown) => void) => void)(
      req, res, error => reject(error ?? new Error(`no route matched ${method} ${url}`)),
    );
  });
}

test('public list and detail preserve prefixed ids and remote effective vividness', async () => {
  const list = await callRoute('GET', '/?type=dream', { type: 'dream' });
  assert.equal(list.statusCode, 200);
  const listBody = list.jsonBody as { total: number; entries: Array<{ id: string; effective_vividness: number }> };
  assert.equal(listBody.total, 1);
  assert.equal(listBody.entries[0].id, 'd:7');
  assert.equal(listBody.entries[0].effective_vividness, 41);
  const detail = await callRoute('GET', '/d:7');
  assert.equal((detail.jsonBody as { id: string }).id, 'd:7');
  assert.equal((detail.jsonBody as { effective_vividness: number }).effective_vividness, 41);
});

test('malformed ids return 404 without fetching', async () => {
  const result = await callRoute('GET', '/not-an-id');
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.jsonBody, { error: 'Entry not found' });
});

test('network failures become a plain-English 502', async () => {
  failRemote = true;
  try {
    const result = await callRoute('GET', '/d:7');
    assert.equal(result.statusCode, 502);
    assert.match((result.jsonBody as { error: string }).error, /Could not reach the Mind API/);
  } finally { failRemote = false; }
});
