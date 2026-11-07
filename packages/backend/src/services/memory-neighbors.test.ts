import assert from 'node:assert/strict';
import test from 'node:test';
import { findNeighbors, findNeighborsWithin, type NeighborDeps } from './memory-neighbors.js';

function fakeEmbed(text: string): Promise<Float32Array> {
  const angle = /ratio/i.test(text) ? 0 : /spoon/i.test(text) ? Math.PI / 2 : Math.PI;
  return Promise.resolve(Float32Array.from([Math.cos(angle), Math.sin(angle)]));
}

function deps(blocks: { scope: string; label: string; content: string }[]): NeighborDeps {
  return { getBlocks: () => blocks, embed: fakeEmbed };
}

const LINE_A = 'the studio ratio list is closed and an unknown one goes square';
const LINE_B = 'a request for a ratio is a hint rather than a contract, read the pixels';
const LINE_C = 'the spoon docket is open in perpetuity and cannot be promoted';

test('a shared wall returns the line it already holds', async () => {
  const report = await findNeighbors(
    'companion-a',
    'the ratio requested is only ever a hint',
    deps([{ scope: 'shared', label: 'neighbor-status', content: `${LINE_A}\n${LINE_B}\n${LINE_C}` }]),
  );
  assert.equal(report.near.length, 2);
  assert.deepEqual(report.near.map((hit) => hit.text).sort(), [LINE_A, LINE_B].sort());
  assert.equal(report.elsewhere.length, 0);
});

test("another companion's private wall crosses as a count and never as text", async () => {
  const report = await findNeighbors(
    'companion-a',
    'the ratio requested is only ever a hint',
    deps([
      { scope: 'companion-b', label: 'neighbor-continuity', content: `${LINE_A}\n${LINE_B}` },
      { scope: 'companion-a', label: 'neighbor-continuity', content: LINE_A },
    ]),
  );
  assert.deepEqual(report.near.map((hit) => ({ scope: hit.scope, text: hit.text })), [{ scope: 'companion-a', text: LINE_A }]);
  assert.deepEqual(report.elsewhere, [{ scope: 'companion-b', label: 'neighbor-continuity', hits: 2 }]);
  assert.doesNotMatch(JSON.stringify(report.elsewhere), /studio|pixels/);
});

test('a thought with no nearby line returns empty rather than nearest-anyway', async () => {
  const report = await findNeighbors(
    'companion-a',
    'the spoon stays exactly where it is',
    deps([{ scope: 'shared', label: 'neighbor-status-2', content: `${LINE_A}\n${LINE_B}` }]),
  );
  assert.equal(report.near.length, 0);
  assert.equal(report.elsewhere.length, 0);
});

test('an append re-embeds only the new line, not the whole wall', async () => {
  const calls: string[] = [];
  const counting: NeighborDeps['embed'] = (text) => {
    calls.push(text);
    return fakeEmbed(text);
  };
  const wall = { scope: 'shared', label: 'neighbor-growth', content: `${LINE_A}\n${LINE_B}` };
  const blocks = [wall];
  await findNeighbors('companion-a', 'the ratio requested is only ever a hint', { getBlocks: () => blocks, embed: counting });
  calls.length = 0;
  wall.content = `${wall.content}\n${LINE_C}`;
  await findNeighbors('companion-a', 'the ratio requested is only ever a hint', { getBlocks: () => blocks, embed: counting });
  // One embed for the probe, one for the single new line. Unchanged lines reuse their vectors.
  assert.deepEqual(calls.filter((text) => text !== 'the ratio requested is only ever a hint'), [LINE_C]);
});

test('a slow embedder gives up within the budget so the write never waits on it', async () => {
  const slow: NeighborDeps['embed'] = () => new Promise(() => {});
  const started = Date.now();
  const report = await findNeighborsWithin(
    'companion-a',
    'the ratio requested is only ever a hint',
    50,
    { getBlocks: () => [{ scope: 'shared', label: 'neighbor-slow', content: LINE_A }], embed: slow },
  );
  assert.equal(report, null);
  assert.ok(Date.now() - started < 1000);
});

test('overlapping searches on a cold wall share one embed per line instead of each starting over', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const gated: NeighborDeps['embed'] = async (text) => {
    calls.push(text);
    await gate;
    return fakeEmbed(text);
  };
  const blocks = [{ scope: 'shared', label: 'neighbor-overlap', content: `${LINE_A}\n${LINE_B}` }];
  const probe = 'the spoon stays exactly where it is';
  const first = findNeighbors('companion-a', probe, { getBlocks: () => blocks, embed: gated });
  const second = findNeighbors('companion-a', probe, { getBlocks: () => blocks, embed: gated });
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await Promise.all([first, second]);
  // Two probes, and each wall line embedded exactly once across both searches.
  assert.equal(calls.filter((text) => text === LINE_A).length, 1);
  assert.equal(calls.filter((text) => text === LINE_B).length, 1);
});
