// Slice 4A contract tests — roster dispatch planning (planDispatchOrder).
// Pins: brain dedupe (two seats, one brain → one turn), empty-roster fallback
// (unseated threads stay byte-identical to pre-4A), and the shuffle rule
// (no standing order — every brain gets to speak first sometimes).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planDispatchOrder } from './ws.js';

const seat = (brain: string) => ({ brain });

describe('planDispatchOrder (Slice 4A roster dispatch)', () => {
  it('empty roster plans nothing — no seat, no model call (Phase 1.2)', () => {
    assert.deepEqual(planDispatchOrder([]), []);
  });

  it('companion-a + companion-b seats dedupe to ONE local turn (shared brain)', () => {
    const plan = planDispatchOrder([seat('companion-a-b'), seat('companion-a-b')]);
    assert.deepEqual(plan, ['companion-a-b']);
  });

  it('full Living Room roster yields exactly the two distinct brains', () => {
    const plan = planDispatchOrder([seat('companion-a-b'), seat('companion-a-b'), seat('companion-c')]);
    assert.equal(plan.length, 2);
    assert.ok(plan.includes('companion-a-b'));
    assert.ok(plan.includes('companion-c'));
  });

  it('order is shuffled — no standing hierarchy across turns', () => {
    // 100 draws of a 2-brain room: P(one order never appears) = 2^-100.
    // If this ever fails, the shuffle is broken, not unlucky.
    const roster = [seat('companion-a-b'), seat('companion-c')];
    const firsts = new Set<string>();
    for (let i = 0; i < 100; i++) {
      firsts.add(planDispatchOrder(roster)[0]);
    }
    assert.equal(firsts.size, 2, 'both brains must lead at least once in 100 turns');
  });

  it('never invents brains and never drops one', () => {
    const roster = [seat('companion-a-b'), seat('companion-c'), seat('companion-c')];
    for (let i = 0; i < 20; i++) {
      const plan = planDispatchOrder(roster);
      assert.deepEqual([...plan].sort(), ['companion-a-b', 'companion-c']);
    }
  });
});
