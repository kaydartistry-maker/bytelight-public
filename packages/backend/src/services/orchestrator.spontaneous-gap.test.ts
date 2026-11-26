import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same bootstrap as orchestrator.default-tasks.test.ts: the orchestrator's
// import chain reads config paths, so point RESONANT_HOME at a stub first.
const tmpRoot = mkdtempSync(join(tmpdir(), 'orchestrator-gap-test-'));
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { pickSpontaneousMinutes } = await import('./orchestrator.js');

/** Deterministic rand from a fixed list, cycling. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('spontaneous wakes keep their distance', () => {
  it('never puts two wakes closer than the gap', () => {
    for (let trial = 0; trial < 200; trial++) {
      const mins = pickSpontaneousMinutes(10, 9 * 60, 24 * 60, 60);
      for (let i = 1; i < mins.length; i++) {
        assert.ok(mins[i] - mins[i - 1] >= 60, `gap ${mins[i] - mins[i - 1]} in ${mins.join(',')}`);
      }
    }
  });

  it('re-draws a pick that lands too close instead of clumping', () => {
    // Second draw lands 8 minutes after the first; the third is far enough.
    const span = 900;
    const mins = pickSpontaneousMinutes(2, 0, span, 60, seq([0.5, 0.5 + 8 / span, 0.9]));
    assert.equal(mins.length, 2);
    assert.ok(mins[1] - mins[0] >= 60);
  });

  it('drops a wake rather than squeezing it in when the window is full', () => {
    const mins = pickSpontaneousMinutes(5, 0, 90, 60);
    assert.ok(mins.length <= 2, `got ${mins.length}`);
  });

  it('a zero gap behaves like the old roll', () => {
    const mins = pickSpontaneousMinutes(3, 0, 100, 0, seq([0.1, 0.1, 0.1]));
    assert.deepEqual(mins, [10, 10, 10]);
  });

  it('returns nothing for an empty window or zero count', () => {
    assert.deepEqual(pickSpontaneousMinutes(0, 0, 100, 60), []);
    assert.deepEqual(pickSpontaneousMinutes(3, 100, 100, 60), []);
  });
});
