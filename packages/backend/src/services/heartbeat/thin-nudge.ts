// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * Think-and-thin nudge: core-memory blocks are re-injected whole every session,
 * so an oversized block is a permanent per-session tax. The ones over budget
 * are surfaced at recycle time, on an owner's turn, so the fresh session can
 * bring it up.
 *
 * It only ever asks. Nothing here edits a block, nothing is edited without the
 * owner's yes, and thinning is the companion's own work: by hand, in their own
 * voice, nothing lost.
 */

import { getConfigNumber } from '../db/config.js';
import { getAllBlocks, SHARED_SCOPE } from '../memory-blocks.js';
import { SHARED_LANE_KEY } from './lane-dir.js';

/** Config key for the budget, in characters. */
export const THIN_THRESHOLD_KEY = 'memory.thin.threshold_chars';

/** The operator's number. Change it with the config key, not here. */
export const DEFAULT_THIN_THRESHOLD_CHARS = 8_000;

type BlockSize = { scope: string; label: string; content: string };

/** A companion's own lane hears shared blocks and its own; the shared room is both of them. */
function laneSees(scope: string, laneKey: string): boolean {
  return laneKey === SHARED_LANE_KEY || scope === SHARED_SCOPE || scope === laneKey;
}

/** The upkeep note for these blocks, or '' when none of this lane's are over budget. */
export function thinNudge(blocks: BlockSize[], thresholdChars: number, laneKey: string = SHARED_LANE_KEY): string {
  const overBudget = blocks
    .filter((b) => laneSees(b.scope, laneKey) && b.content.length > thresholdChars)
    .sort((a, b) => b.content.length - a.content.length);
  if (overBudget.length === 0) return '';
  const list = overBudget
    .map((b) => `${b.scope}/${b.label} (${(b.content.length / 1000).toFixed(1)}k)`)
    .join(', ');
  return `\n[Memory upkeep] Core-memory blocks over the ${thresholdChars / 1000}k budget: ${list}. `
    + 'This is a nudge, not a job. When the moment is right, raise it with the owner, in passing; it can wait. '
    + 'Do not edit a block until the owner says yes. After a yes, thin by hand, in your own voice: archive dated '
    + 'entries older than about three weeks to Cortex first, then rewrite the block tighter, keeping every fact '
    + 'and lesson. Never flatten it into clinical shorthand.\n';
}

/** The note for the live blocks. Never throws: a turn does not depend on it. */
export function buildThinNudge(laneKey: string = SHARED_LANE_KEY): string {
  try {
    const configured = getConfigNumber(THIN_THRESHOLD_KEY, DEFAULT_THIN_THRESHOLD_CHARS);
    const threshold = configured > 0 ? configured : DEFAULT_THIN_THRESHOLD_CHARS;
    return thinNudge(getAllBlocks(), threshold, laneKey);
  } catch {
    return ''; // blocks table unavailable — skip the nudge
  }
}

/**
 * The note for one turn: only a fresh session, and only when the owner is the
 * one there to hear it. A guest would be reading a room that discusses the
 * walls, and a wake has nobody to raise it with.
 */
export function thinNudgeForTurn(turn: { fresh: boolean; guest: boolean; autonomous: boolean; laneKey: string }): string {
  if (!turn.fresh || turn.guest || turn.autonomous) return '';
  return buildThinNudge(turn.laneKey);
}
