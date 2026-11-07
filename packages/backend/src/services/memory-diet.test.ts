import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, initDb, setConfig } from './db.js';
import { setBlock, getBlock } from './memory-blocks.js';
import {
  charsToMove, DEFAULT_BUDGET_CHARS, DEFAULT_PACE_CHARS,
  runMemoryDiet, selectOldestDatedEntries,
} from './memory-diet.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'memory-diet-test-'));
const now = new Date('2026-08-10T12:00:00Z');

before(() => initDb(join(tempRoot, 'diet.db')));
after(() => rmSync(tempRoot, { recursive: true, force: true }));
beforeEach(() => {
  getDb().exec(`
    DELETE FROM memory_blocks_archive;
    DELETE FROM memory_proposals;
    DELETE FROM memory_block_aliases;
    DELETE FROM memory_block_identities;
    DELETE FROM memory_blocks;
    DELETE FROM memory_ledger;
    DELETE FROM config WHERE key LIKE 'memory.diet.%';
  `);
});

describe('memory diet selection math', () => {
  it('targets only the amount above the soft budget', () => {
    assert.equal(charsToMove(DEFAULT_BUDGET_CHARS - 1, DEFAULT_BUDGET_CHARS), 0);
    assert.equal(charsToMove(DEFAULT_BUDGET_CHARS + 321, DEFAULT_BUDGET_CHARS), 321);
  });

  it('caps each pass at the gentle pace', () => {
    assert.equal(charsToMove(72_000, 8_000), DEFAULT_PACE_CHARS);
  });

  it('leaves every post-smoosh hot-core block within the default soft budget', () => {
    // Post-smoosh live sizes (2026-08-12): shared/human 64,174; companion-a/persona
    // 23,994; companion-b/persona 23,407; shared/rules 11,691 — all below the shipped
    // default, so nothing is over budget until blocks grow past ~80k.
    for (const size of [64_174, 23_994, 23_407, 11_691]) {
      assert.equal(charsToMove(size, DEFAULT_BUDGET_CHARS), 0);
    }
  });

  it('selects whole oldest entries on dated structured content', () => {
    const content = '2026-06-01 old one\n2026-06-02 old two\n2026-08-01 recent';
    const selected = selectOldestDatedEntries(content, 25, now);
    assert.equal(selected?.archived, '2026-06-01 old one\n');
    assert.equal(selected?.remaining, '2026-06-02 old two\n2026-08-01 recent');
  });

  it('never selects an entry inside the 14-day guard', () => {
    const content = '2026-07-27 edge is protected\n2026-08-01 recent';
    assert.equal(selectOldestDatedEntries(content, 2_000, now), null);
  });

  it('rejects freeform content without dated seams', () => {
    assert.equal(selectOldestDatedEntries('I am a continuous freeform persona.', 2_000, now), null);
  });

  it('rejects malformed dates before and after a valid seam', () => {
    assert.equal(selectOldestDatedEntries('2026-02-30 bad\n2026-06-01 good', 2_000, now), null);
    assert.equal(selectOldestDatedEntries('2026-06-01 good\n2026-02-30 bad', 2_000, now), null);
  });

  it('rejects non-chronological dated entries', () => {
    assert.equal(selectOldestDatedEntries('2026-06-02 second\n2026-06-01 first', 2_000, now), null);
  });
});

describe('memory diet side effects', () => {
  const oldEntry = `2026-01-01 ${'x'.repeat(600)}\n`;
  const recentEntry = `2026-08-01 ${'y'.repeat(300)}`;

  beforeEach(() => {
    setConfig('memory.diet.default_budget_chars', '200');
    setBlock('shared', 'status', oldEntry + recentEntry);
    getDb().prepare('DELETE FROM memory_ledger').run();
  });

  it('leaves the block, archive, and ledger untouched when remote write fails', async () => {
    const before = getBlock('shared', 'status')!.content;
    const result = await runMemoryDiet(async () => false, now);
    assert.equal(result.failed, 1);
    assert.equal(getBlock('shared', 'status')!.content, before);
    assert.equal((getDb().prepare('SELECT count(*) n FROM memory_blocks_archive').get() as { n: number }).n, 0);
    assert.equal((getDb().prepare('SELECT count(*) n FROM memory_ledger').get() as { n: number }).n, 0);
  });

  it('archives locally and writes a linked memory.archive receipt after remote success', async () => {
    const result = await runMemoryDiet(async () => true, now);
    assert.equal(result.archived, 1);
    assert.equal(getBlock('shared', 'status')!.content, recentEntry);
    const archive = getDb().prepare('SELECT * FROM memory_blocks_archive').get() as {
      content: string; ledger_receipt_id: number;
    };
    assert.equal(archive.content, oldEntry);
    const receipt = getDb().prepare('SELECT * FROM memory_ledger WHERE id = ?').get(archive.ledger_receipt_id) as {
      action: string; detail: string;
    };
    assert.equal(receipt.action, 'memory.archive');
    assert.match(receipt.detail, /shared\/status/);
    assert.match(receipt.detail, new RegExp(String(oldEntry.length)));
  });

  it('routes mixed dated and undated persona structure to proposal, never trim', async () => {
    setBlock('shared', 'status', `${oldEntry}## Who I am\nOperator values continuity.`);
    const result = await runMemoryDiet(async () => true, now);
    assert.equal(result.proposed, 1);
    assert.equal(result.archived, 0);
    assert.equal((getDb().prepare('SELECT count(*) n FROM memory_proposals').get() as { n: number }).n, 1);
    assert.equal((getDb().prepare('SELECT count(*) n FROM memory_blocks_archive').get() as { n: number }).n, 0);
  });

  it('routes malformed dates on either side of a valid seam to proposal', async () => {
    for (const content of [
      `2026-02-30 impossible\n${oldEntry}`,
      `${oldEntry}2026-02-30 impossible`,
    ]) {
      setBlock('shared', 'status', content);
      const result = await runMemoryDiet(async () => true, now);
      assert.equal(result.proposed, 1);
      assert.equal(result.archived, 0);
      getDb().prepare('DELETE FROM memory_proposals').run();
    }
  });

  it('routes unsorted dates to proposal', async () => {
    setBlock('shared', 'status', `2026-06-02 ${'z'.repeat(300)}\n2026-06-01 ${'z'.repeat(300)}`);
    const result = await runMemoryDiet(async () => true, now);
    assert.equal(result.proposed, 1);
    assert.equal(result.archived, 0);
  });

  it('skips an empty block quietly', async () => {
    getDb().prepare("UPDATE memory_blocks SET content = '' WHERE scope = 'shared' AND label = 'status'").run();
    const result = await runMemoryDiet(async () => true, now);
    assert.equal(result.skipped, 1);
    assert.equal(result.proposed, 0);
  });

  it('skips a single old entry larger than the pace cap quietly', async () => {
    setConfig('memory.diet.pace_chars', '100');
    setBlock('shared', 'status', `2026-01-01 ${'x'.repeat(700)}`);
    const result = await runMemoryDiet(async () => true, now);
    assert.equal(result.skipped, 1);
    assert.equal(result.proposed, 0);
  });

  it('skips an over-budget block whose entries are all within 14 days quietly', async () => {
    setBlock('shared', 'status', `2026-08-01 ${'x'.repeat(700)}`);
    const result = await runMemoryDiet(async () => true, now);
    assert.equal(result.skipped, 1);
    assert.equal(result.proposed, 0);
  });

  it('aborts if block content changes between selection and transaction', async () => {
    const replacement = '2026-08-02 changed concurrently';
    const result = await runMemoryDiet(async () => {
      setBlock('shared', 'status', replacement);
      return true;
    }, now);
    assert.equal(result.failed, 1);
    assert.equal(getBlock('shared', 'status')!.content, replacement);
    assert.equal((getDb().prepare('SELECT count(*) n FROM memory_blocks_archive').get() as { n: number }).n, 0);
  });

  it('leaves no trim after remote success followed by transaction abort', async () => {
    const original = getBlock('shared', 'status')!.content;
    const replacement = `${original}\n2026-08-02 concurrent extension`;
    const result = await runMemoryDiet(async () => {
      getDb().prepare("UPDATE memory_blocks SET content = ? WHERE scope = 'shared' AND label = 'status'").run(replacement);
      return true;
    }, now);
    assert.equal(result.failed, 1);
    assert.equal(getBlock('shared', 'status')!.content, replacement);
    assert.equal((getDb().prepare('SELECT count(*) n FROM memory_blocks_archive').get() as { n: number }).n, 0);
  });

  // Post-smoosh reality: hot blocks are mostly UNDATED rule/signal/relationship
  // lines (many carrying an old date as inline provenance, e.g.
  // "LESSON (2026-07-12): …"), plus a few fresh dated appends from the daily
  // Archivist. The date is not at the line START, so these are not trimmable
  // "dated entries" — the fail-closed parser must protect them.
  const postSmooshHotCore = [
    '## Rules',
    'Prefers short replies.',
    'LESSON (2026-07-12): check the calendar first.',
    "the operator's :user_side_eye: reaction named 2026-07-10.",
    'Prefers mornings for planning.',
  ].join('\n');
  const freshDatedAppends = '\n2026-08-11 archivist noticing one\n2026-08-12 archivist noticing two';

  it('never auto-trims undated hot-core even when forced over a tiny budget', async () => {
    getDb().prepare("DELETE FROM memory_blocks").run(); // isolate from beforeEach seed
    setConfig('memory.diet.default_budget_chars', '50');
    setBlock('shared', 'rules', postSmooshHotCore + freshDatedAppends);
    const before = getBlock('shared', 'rules')!.content;
    const result = await runMemoryDiet(async () => true, now);
    // Undated provenance lines make the whole block ambiguous → proposal-only.
    assert.equal(result.archived, 0);
    assert.equal(result.proposed, 1);
    assert.equal(getBlock('shared', 'rules')!.content, before);
    assert.equal((getDb().prepare('SELECT count(*) n FROM memory_blocks_archive').get() as { n: number }).n, 0);
  });

  it('finds no eligible trim on post-smoosh hot-core under the default budget', async () => {
    // No memory.diet.* budget override → the shipped 80k default applies. The
    // whole hot-core block (well under 80k) is within budget, so the diet skips.
    getDb().prepare("DELETE FROM config WHERE key LIKE 'memory.diet.%'").run();
    getDb().prepare("DELETE FROM memory_blocks").run(); // isolate from beforeEach seed
    setBlock('shared', 'rules', postSmooshHotCore + freshDatedAppends);
    const before = getBlock('shared', 'rules')!.content;
    const result = await runMemoryDiet(async () => true, now);
    assert.equal(result.archived, 0);
    assert.equal(result.proposed, 0);
    assert.equal(result.skipped, 1);
    const rulesDecision = result.decisions.find(d => d.scope === 'shared' && d.label === 'rules');
    assert.equal(rulesDecision?.reason, 'within soft budget');
    assert.equal(getBlock('shared', 'rules')!.content, before);
  });

  it('dry-run reports per-block decisions without mirror or local mutations', async () => {
    let mirrorCalls = 0;
    const before = getBlock('shared', 'status')!.content;
    const result = await runMemoryDiet(async () => { mirrorCalls++; return true; }, now, { dryRun: true });
    assert.equal(result.archived, 1);
    assert.equal(result.decisions[0]?.action, 'archive');
    assert.equal(mirrorCalls, 0);
    assert.equal(getBlock('shared', 'status')!.content, before);
    assert.equal((getDb().prepare('SELECT count(*) n FROM memory_blocks_archive').get() as { n: number }).n, 0);
  });
});
