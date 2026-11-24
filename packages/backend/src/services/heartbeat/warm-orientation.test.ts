import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickWarmOrientation, markLaneManualDue } from './runtime.js';
import { joinOrientationParts, WARM_LANE_MANUAL_LABELS } from '../hooks.js';

describe('joinOrientationParts', () => {
  const parts = [
    { label: 'Time', content: 'Time: now' },
    { label: 'Skills', content: 'SKILLS ...' },
    { label: 'Promises', content: 'Promises ...' },
    { label: 'Chat tools', content: 'CHAT TOOLS ...' },
    { label: 'Outreach tools', content: 'OUTREACH ...' },
    { label: 'Stickers', content: 'STICKERS ...' },
  ];
  it('full join keeps every part in order', () => {
    assert.equal(joinOrientationParts(parts), parts.map(p => p.content).join('\n'));
  });
  it('lean join drops only the manual, keeps live state', () => {
    const lean = joinOrientationParts(parts, true);
    assert.equal(lean, 'Time: now\nPromises ...');
    for (const l of ['Skills', 'Chat tools', 'Outreach tools', 'Stickers']) {
      assert.equal(WARM_LANE_MANUAL_LABELS.has(l), true);
    }
    assert.equal(WARM_LANE_MANUAL_LABELS.has('Promises'), false);
  });
});

describe('pickWarmOrientation', () => {
  const base = { orientation: 'FULL', orientationLean: 'LEAN' };
  it('first delivery carries the manual', () => {
    assert.deepEqual(pickWarmOrientation({ ...base, fresh: false, compacted: false, manualDelivered: false }), { text: 'FULL', full: true });
  });
  it('ordinary turn after delivery is lean', () => {
    assert.deepEqual(pickWarmOrientation({ ...base, fresh: false, compacted: false, manualDelivered: true }), { text: 'LEAN', full: false });
  });
  it('a fresh relaunch re-sends the manual', () => {
    assert.equal(pickWarmOrientation({ ...base, fresh: true, compacted: false, manualDelivered: true }).full, true);
  });
  it('a compaction re-sends the manual', () => {
    assert.equal(pickWarmOrientation({ ...base, fresh: false, compacted: true, manualDelivered: true }).full, true);
  });
  it('no lean variant offered stays full (other callers unchanged)', () => {
    assert.deepEqual(pickWarmOrientation({ orientation: 'FULL', fresh: false, compacted: false, manualDelivered: true }), { text: 'FULL', full: true });
  });
  it('markLaneManualDue ignores an empty lane', () => {
    assert.doesNotThrow(() => markLaneManualDue(''));
  });
});

describe('pickWarmOrientation on a reopened room', () => {
  // A room reopened by --resume is NOT fresh (no 30-message re-prime), but
  // the backend just started, so nothing in this process has handed it the
  // manual yet. A compaction just before the restart may have folded it away
  // and that mark lived only in memory, so the first turn carries it once.
  const base = { orientation: 'FULL', orientationLean: 'LEAN', compacted: false };
  it('first turn after a backend start carries the manual even though not fresh', () => {
    assert.equal(pickWarmOrientation({ ...base, fresh: false, manualDelivered: false }).full, true);
  });
  it('and the turn after that is lean', () => {
    assert.equal(pickWarmOrientation({ ...base, fresh: false, manualDelivered: true }).full, false);
  });
});
