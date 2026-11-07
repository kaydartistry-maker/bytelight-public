// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0.
// Ported from Reverie (Tris's fork of Aerie). On Eastern time an evening is
// already the next day by the world clock, and sometimes the next month.
process.env.TZ = 'America/New_York';

import test from 'node:test';
import assert from 'node:assert/strict';
import { monthKey, monthsOf } from './picture-months.js';

test('an evening at the end of July on Eastern time is still July', () => {
  // 23:00 on Jul 31 on Eastern time is 03:00 on Aug 1 by UTC.
  assert.equal(monthKey('2026-08-01T03:00:00.000Z'), '2026-07');
});

test('months come newest first, each with how many pictures it holds', () => {
  const months = monthsOf([
    { createdAt: '2026-07-28T01:35:41.773Z' },
    { createdAt: '2026-09-26T07:16:42.958Z' },
    { createdAt: '2026-07-25T12:00:00.000Z' },
  ]);
  assert.deepEqual(months.map((m) => [m.key, m.count]), [['2026-09', 1], ['2026-07', 2]]);
  assert.match(months[1].label, /Jul/);
});

test('a picture with no readable date is left out of the months rather than filed under a made-up one', () => {
  assert.deepEqual(monthsOf([{ createdAt: 'not a date' }]), []);
});
