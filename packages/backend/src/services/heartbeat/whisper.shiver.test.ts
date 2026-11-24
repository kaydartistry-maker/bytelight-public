/**
 * The shiver — making ambient recall VISIBLE.
 *
 * Ported mechanic (reference implementation's whisper.ts): a receipt on every surface, a
 * source-veiled déjà-vu on a scored near-miss, and a hard rule that receipt
 * bookkeeping can NEVER block or delay recall.
 *
 * What these tests pin:
 *   - selectDejavuCandidate: only the narrow band just under the surface bar
 *   - a real memory surface writes a `memory.surface` receipt to the ledger
 *   - a scored near-miss writes a `memory.dejavu` receipt with similarity
 *   - a receipt failure is swallowed — recall still returns its block
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

const tmpRoot = mkdtempSync(join(tmpdir(), 'shiver-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

let reply: { status: number; body: unknown } = {
  status: 200,
  body: { result: 'a remembered thing' },
};
let server: Server;

before(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  process.env.MIND_API_URL = `http://127.0.0.1:${addr.port}`;
  process.env.MIND_API_KEY = 'test-key';
});

after(() => {
  server?.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const { initDb, getDb } = await import('../db.js');
const { listMemoryLedger } = await import('../memory-ledger.js');
const { ambientRecall, resetRecallMemory, selectDejavuCandidate } = await import('./whisper.js');

before(() => {
  initDb(dbPath);
});

beforeEach(() => {
  resetRecallMemory();
  reply = { status: 200, body: { result: 'a remembered thing' } };
  // Start each ledger assertion from a clean floor.
  getDb().prepare('DELETE FROM memory_ledger').run();
});

describe('selectDejavuCandidate', () => {
  it('picks the best hit only when it sits just under the surface bar', () => {
    // In-band near-miss: 0.42 - 0.07 <= 0.38 < 0.42.
    assert.deepEqual(
      selectDejavuCandidate([{ id: 'a', similarity: 0.38 }, { id: 'b', similarity: 0.30 }]),
      { id: 'a', similarity: 0.38 },
    );
    // Confident hit — surfaces as a card, not a shiver.
    assert.equal(selectDejavuCandidate([{ id: 'a', similarity: 0.80 }]), null);
    // Too faint — below the band floor, not even a shiver.
    assert.equal(selectDejavuCandidate([{ id: 'a', similarity: 0.10 }]), null);
    // Nothing at all.
    assert.equal(selectDejavuCandidate([]), null);
  });
});

describe('shiver receipts', () => {
  it('writes a memory.surface receipt when a memory surfaces', async () => {
    reply = { status: 200, body: { result: 'a remembered thing', results: [{ id: 'm1', similarity: 0.9, content: 'a remembered thing' }] } };
    await ambientRecall('what did we decide about the delivery cap', 'lane-a', false);
    const rows = listMemoryLedger(10);
    const surface = rows.find((r) => r.action === 'memory.surface');
    assert.ok(surface, 'a surface should be receipted');
    assert.equal(surface!.actor, 'whisper');
    assert.ok(surface!.metadata_json?.includes('m1'), 'the surfaced ids ride the receipt');
  });

  it('writes a memory.dejavu receipt with similarity on a near-miss', async () => {
    reply = { status: 200, body: { result: '', results: [{ id: 'near', similarity: 0.39 }] } };
    const out = await ambientRecall('a faintly familiar thing', 'lane-b', false);
    assert.ok(out.block.includes('Déjà vu'));
    const rows = listMemoryLedger(10);
    const dv = rows.find((r) => r.action === 'memory.dejavu');
    assert.ok(dv, 'a near-miss should be receipted');
    assert.equal(dv!.subject_id, 'near');
    assert.ok(dv!.metadata_json?.includes('similarity'));
  });

  it('never lets a receipt failure break or delay recall', async () => {
    // Fail only receipt INSERTs. Closing the entire DB also prevents credential
    // resolution, so it cannot isolate the promised receipt-failure behavior.
    reply = { status: 200, body: { result: 'still delivered' } };
    getDb().exec(`CREATE TEMP TRIGGER fixture_fail_receipt BEFORE INSERT ON memory_ledger
      BEGIN SELECT RAISE(FAIL, 'synthetic receipt failure'); END`);
    try {
      const out = await ambientRecall('a resilient question', 'lane-c', false);
      assert.ok(out.block.includes('still delivered'), 'recall survives a ledger failure');
    } finally {
      getDb().exec('DROP TRIGGER fixture_fail_receipt');
    }
  });
});
