// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Blocked: a person or bot the owner never wants answered.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ruleBlocks, effectiveTrustLevel } from './rules.js';
import { discordTurnAudience } from '../turn-audience.js';

test('only a blocked rule blocks', () => {
  assert.equal(ruleBlocks({ trustLevel: 'blocked' }), true);
  for (const t of ['standard', 'limited', 'full'] as const) assert.equal(ruleBlocks({ trustLevel: t }), false, t);
  assert.equal(ruleBlocks(undefined), false, 'no rule is not a block; it is limited');
});

// Adapted: this tree reads the rule as authorRule, ahead of the bot cap.
test('both doors check it: people in preflight, bots at the gateway', () => {
  const preflight = readFileSync(new URL('./preflight.ts', import.meta.url), 'utf8');
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(preflight, /if \(ruleBlocks\(authorRule\)\) \{\n\s+return \{ allowed: false/);
  assert.ok(preflight.indexOf('ruleBlocks(authorRule)') < preflight.indexOf('botGateDecision({'), 'before the bot cap');
  assert.match(index, /if \(ruleBlocks\(botRule\)\) return;/);
});

test('a blocked rule that slipped through is never more than limited', () => {
  assert.equal(effectiveTrustLevel({ trustLevel: 'blocked' }), 'limited');
  assert.deepEqual(discordTurnAudience(false, 'blocked'), { kind: 'guest', trust: 'limited' });
});
