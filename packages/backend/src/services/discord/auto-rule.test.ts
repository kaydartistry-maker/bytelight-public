// People appear on the Users list on their own (Kay, 2026-11-27), without
// changing who is answered: a person lands at Limited, a bot at Blocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { autoRuleFor, effectiveTrustLevel, ruleBlocks } from './rules.js';

const now = '2026-11-27T22:00:00.000Z';

test('a new person lands at Limited, which is what no rule already meant', () => {
  const rule = autoRuleFor({ id: '1', name: 'Mira', bot: false }, { ownerUserId: '9', existing: undefined, now });
  assert.ok(rule);
  assert.equal(rule.trustLevel, 'limited');
  assert.equal(effectiveTrustLevel(rule), effectiveTrustLevel(undefined));
  assert.equal(rule.auto, true);
  assert.equal(rule.seenAt, now);
  assert.equal(rule.name, 'Mira');
});

test('a new bot lands at Blocked, so it is still turned away', () => {
  const rule = autoRuleFor({ id: '2', name: 'Ren', bot: true }, { ownerUserId: '9', existing: undefined, now });
  assert.ok(rule);
  assert.equal(rule.trustLevel, 'blocked');
  assert.equal(ruleBlocks(rule), true);
});

test("someone Kay already set is never touched, and Kay herself is never listed", () => {
  const existing = { id: '3', name: 'Jac', trustLevel: 'full' as const };
  assert.equal(autoRuleFor({ id: '3', name: 'Jac', bot: false }, { ownerUserId: '9', existing, now }), null);
  assert.equal(autoRuleFor({ id: '9', name: 'Kay', bot: false }, { ownerUserId: '9', existing: undefined, now }), null);
});

test('a missing display name falls back to the id', () => {
  const rule = autoRuleFor({ id: '4', name: '', bot: false }, { ownerUserId: '9', existing: undefined, now });
  assert.equal(rule?.name, '4');
});
