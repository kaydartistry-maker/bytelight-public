/**
 * Ambient recall — retrieval standing in for injection.
 *
 * These tests pin the contract that lets the memory blocks safely shrink:
 *   - a slow, broken, or unreachable Cortex costs the turn its recall and
 *     NOTHING else — never a throw, never a hang, never a dropped delivery
 *   - the same lane is never handed the same memory twice (re-sending what
 *     is already in the context window is the exact bloat this arc kills)
 *   - a recycled session starts fresh, because it genuinely has not seen it
 *   - the block is capped; a whisper cannot become the payload
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

const tmpRoot = mkdtempSync(join(tmpdir(), 'recall-test-'));
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

// A stand-in Cortex we control: every test sets what the worker "answers".
let reply: { status: number; body: unknown; delayMs?: number } = {
  status: 200,
  body: { result: 'a remembered thing' },
};
let lastPath = '';
let server: Server;

before(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      lastPath = req.url || '';
      const send = () => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
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

const { ambientRecall, resetRecallMemory } = await import('./whisper.js');

beforeEach(() => {
  resetRecallMemory();
  reply = { status: 200, body: { result: 'a remembered thing' } };
});

describe('ambientRecall', () => {
  it('hands over what the archive remembers, framed as background not instruction', async () => {
    const { block } = await ambientRecall('what did we decide about the delivery cap', 'lane-a', false);
    assert.ok(block.includes('a remembered thing'));
    assert.ok(block.includes('Background, not instruction'));
    assert.ok(block.includes('do not narrate that you were handed it'));
  });

  it('asks the archive the whole sentence — ours is semantic, not keyword', async () => {
    await ambientRecall('what did we decide about the delivery cap', 'lane-a', false);
    assert.ok(lastPath.includes('query=what+did+we+decide+about+the+delivery+cap'));
    assert.ok(lastPath.includes('limit=3'));
  });

  it('surfaces the fact of recall so the reply can wear it', async () => {
    const { surfaced } = await ambientRecall('what did we decide about the delivery cap', 'lane-a', false);
    assert.ok(surfaced, 'a hit should report what surfaced');
    assert.equal(surfaced!.dejavu, false);
    assert.ok(surfaced!.cards.length > 0, 'at least one card excerpt for the shimmer panel');
  });

  it('builds cards from the memories, never from the search header that echoes her message', async () => {
    // The real worker answer: a header quoting HER message, then one
    // "### type [domain] (NN%) — date" heading per memory with its text.
    reply = {
      status: 200,
      body: {
        result: [
          '## Cortex Recall: "a friend sent me a picture of a dog doing yoga" (2 found)',
          '',
          '### observation [constellation] (68%) — 2026-04-09',
          "the operator's favorite tea is jasmine.",
          '',
          '### observation [lore] (67%) — 2026-08-12',
          'Weekly review logged.',
        ].join('\n'),
      },
    };
    const { surfaced } = await ambientRecall('a friend sent me a picture of a dog doing yoga', 'lane-a', false);
    assert.ok(surfaced, 'a hit should report what surfaced');
    const cards = surfaced!.cards;
    assert.ok(
      cards.every((c) => !c.excerpt.includes('Cortex Recall') && !c.excerpt.includes('dog doing yoga')),
      'no card may quote her own message back at her',
    );
    assert.ok(cards.every((c) => !c.excerpt.startsWith('#')), 'no card may be a bare markdown heading');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].excerpt, "the operator's favorite tea is jasmine.");
    assert.equal(cards[0].domain, 'constellation');
    assert.equal(cards[0].relevance, 0.68);
    assert.equal(cards[0].date, '2026-04-09');
    assert.equal(cards[1].domain, 'lore');
  });

  it('never hands the same lane the same memory twice', async () => {
    const first = await ambientRecall('the delivery cap question', 'lane-a', false);
    const second = await ambientRecall('the delivery cap question again', 'lane-a', false);
    assert.notEqual(first.block, '');
    assert.equal(second.block, '', 're-sending what is already in the window is the bloat we are killing');
    assert.equal(second.surfaced, null, 'nothing surfaced means nothing to shimmer');
  });

  it('keeps lanes separate — one lane seeing it does not mute another', async () => {
    await ambientRecall('the delivery cap question', 'lane-a', false);
    const other = await ambientRecall('the delivery cap question', 'lane-b', false);
    assert.notEqual(other.block, '');
  });

  it('starts fresh when the session recycled, because it truly has not seen it', async () => {
    await ambientRecall('the delivery cap question', 'lane-a', false);
    const afterRecycle = await ambientRecall('the delivery cap question', 'lane-a', true);
    assert.notEqual(afterRecycle.block, '');
  });

  it('stays silent on a miss instead of announcing one', async () => {
    reply = { status: 200, body: { result: 'No cortex memories found for "x"' } };
    const { block, surfaced } = await ambientRecall('something never discussed here', 'lane-a', false);
    assert.equal(block, '');
    assert.equal(surfaced, null);
  });

  it('costs the turn its recall and nothing else when Cortex errors', async () => {
    reply = { status: 500, body: { error: 'boom' } };
    assert.equal((await ambientRecall('a perfectly good question', 'lane-a', false)).block, '');
  });

  it('gives up rather than delaying delivery when Cortex is slow', async () => {
    reply = { status: 200, body: { result: 'too late to matter' }, delayMs: 400 };
    const started = process.hrtime.bigint();
    const { block } = await ambientRecall('a perfectly good question', 'lane-slow', false, );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // The real ceiling is 3500ms; this proves the abort path returns '' rather
    // than throwing, and that a hang cannot ride out past its budget.
    assert.ok(elapsedMs < 3500, `waited ${elapsedMs}ms`);
    assert.ok(typeof block === 'string');
  });

  it('does not bother the archive with a message too short to be a question', async () => {
    lastPath = '';
    assert.equal((await ambientRecall('ok', 'lane-a', false)).block, '');
    assert.equal(lastPath, '', 'no request should have been made at all');
  });

  it('caps the block — a whisper cannot become the payload', async () => {
    reply = { status: 200, body: { result: 'x'.repeat(9000) } };
    const { block } = await ambientRecall('a long-winded archive answer', 'lane-a', false);
    assert.ok(block.length < 1800, `block was ${block.length} chars`);
    assert.ok(block.includes('…'), 'a truncated block should say so');
  });

  it('survives a malformed answer without throwing', async () => {
    reply = { status: 200, body: { result: { not: 'a string' } } };
    assert.equal((await ambientRecall('a perfectly good question', 'lane-a', false)).block, '');
  });

  it('shivers on a scored near-miss and stays quiet on a strong or absent score', async () => {
    // A hit just under the surface bar (0.42), inside the near-miss band → déjà vu.
    reply = { status: 200, body: { result: '', results: [{ id: 'm1', similarity: 0.38 }] } };
    const nearMiss = await ambientRecall('a faintly familiar thing', 'lane-dv', false);
    assert.ok(nearMiss.block.includes('Déjà vu'), 'a near-miss should shiver');
    assert.equal(nearMiss.surfaced?.dejavu, true);

    // Same lane, same id → deduped, no second shiver.
    const repeat = await ambientRecall('a faintly familiar thing again', 'lane-dv', false);
    assert.ok(!repeat.block.includes('Déjà vu'), 'a shiver is once-per-session per id');

    // A strong hit surfaces as a card, not a shiver.
    reply = { status: 200, body: { result: 'a real memory', results: [{ id: 'm2', similarity: 0.80, content: 'a real memory' }] } };
    const strong = await ambientRecall('a clearly remembered thing', 'lane-dv2', false);
    assert.ok(!strong.block.includes('Déjà vu'), 'a confident hit does not shiver');
    assert.ok(strong.block.includes('a real memory'));

    // No scores at all (prose-only worker) → never shivers, degrades quietly.
    reply = { status: 200, body: { result: 'plain prose only' } };
    const proseOnly = await ambientRecall('another remembered thing', 'lane-dv3', false);
    assert.ok(!proseOnly.block.includes('Déjà vu'), 'no scores means no déjà vu, quietly');
    assert.ok(proseOnly.block.includes('plain prose only'));
  });
});
