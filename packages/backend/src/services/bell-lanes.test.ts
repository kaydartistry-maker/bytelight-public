// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { laneSwitchBefore, laneSwitchAfter, LANES_HOLD_MS } from './bell-lanes.js';

const now = new Date('2026-09-24T22:00:00Z');
const inMinutes = (m: number) => new Date(now.getTime() + m * 60_000);

test('a bell only turns the switch on when the owner asked for it and it is off', () => {
  assert.equal(laneSwitchBefore({ splitLanes: true, multiLane: false }), 'turn_on');
  assert.equal(laneSwitchBefore({ splitLanes: true, multiLane: true }), 'leave');
  assert.equal(laneSwitchBefore({ splitLanes: false, multiLane: false }), 'leave');
});

test('a switch the owner turned on by hand is never turned off by a bell', () => {
  assert.equal(laneSwitchAfter({ turnedOnByBell: false, multiLane: true, nextSplitBellAt: null, now }), 'leave');
});

test('the switch stays on while another split bell is coming', () => {
  assert.equal(laneSwitchAfter({ turnedOnByBell: true, multiLane: true, nextSplitBellAt: inMinutes(30), now }), 'leave');
});

test('after the last bell of the night the switch goes back off', () => {
  assert.equal(laneSwitchAfter({ turnedOnByBell: true, multiLane: true, nextSplitBellAt: null, now }), 'turn_off');
  const tomorrow = new Date(now.getTime() + LANES_HOLD_MS + 60_000);
  assert.equal(laneSwitchAfter({ turnedOnByBell: true, multiLane: true, nextSplitBellAt: tomorrow, now }), 'turn_off');
});

test('if the owner already turned it off by hand, there is nothing to do', () => {
  assert.equal(laneSwitchAfter({ turnedOnByBell: true, multiLane: false, nextSplitBellAt: null, now }), 'leave');
});
