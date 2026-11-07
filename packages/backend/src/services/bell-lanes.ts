// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * A bell with several owners can switch A Lane Each on for itself. Separate
 * heads cost three sessions at once, so the owner may keep the switch off
 * ordinarily and want it on only for particular bells — and the person who
 * would otherwise have to remember to flip it, before each of those bells, is
 * the owner.
 *
 * So a several-owner bell turns the switch on when it rings and it is off,
 * marks that it was the bell that did it, and the switch goes back off after a
 * bell when no other several-owner bell is due soon. A switch the owner turned on by
 * hand is never touched, because the mark is only ever set here.
 *
 * BYTE-LIGHT: A Lane Each (agent.multi_lane) lives only in the settings row
 * here — byte-light never kept it in bytelight.yaml — so the flip is that row
 * plus the mark. The next bell simply turns it on again.
 */

/** The owner's setting. Off unless a house asks for it. */
export const BELLS_SPLIT_LANES_KEY = 'orchestrator.bells_split_lanes';
/** Set only by a bell that turned the switch on itself. */
export const LANES_BY_BELL_KEY = 'agent.multi_lane_by_bell';
/** How far ahead another several-owner bell keeps the switch on. */
export const LANES_HOLD_MS = 3 * 60 * 60 * 1000;

export function laneSwitchBefore(input: { splitLanes: boolean; multiLane: boolean }): 'turn_on' | 'leave' {
  return input.splitLanes && !input.multiLane ? 'turn_on' : 'leave';
}

export function laneSwitchAfter(input: {
  turnedOnByBell: boolean;
  multiLane: boolean;
  nextSplitBellAt: Date | null;
  now: Date;
  holdMs?: number;
}): 'turn_off' | 'leave' {
  if (!input.turnedOnByBell || !input.multiLane) return 'leave';
  const hold = input.holdMs ?? LANES_HOLD_MS;
  if (input.nextSplitBellAt && input.nextSplitBellAt.getTime() - input.now.getTime() <= hold) return 'leave';
  return 'turn_off';
}
