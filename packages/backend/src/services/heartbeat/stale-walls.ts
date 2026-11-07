// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * What the walls say now, for a lane whose injected copy is about to be
 * replayed at it. A compaction hands the room the SAME CLAUDE.md attachment it
 * opened with rather than re-reading it, so a block edited mid-room never
 * reaches that room (see block-drift.ts).
 *
 * Fails soft in every direction. A compaction that cannot be repaired is the
 * behaviour we already had; a compaction that throws is worse than useless.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../config.js';
import { isHeartbeatLane } from '../compaction-log.js';
import { getAllBlocks } from '../memory-blocks.js';
import {
  BASELINE_FILE, LIVE_WALLS_FILE, driftAgainstBaseline, driftFitsInline, liveWallsText, renderDrift,
} from './block-drift.js';

export function staleBlockText(lane: unknown, projectRoot: string = PROJECT_ROOT): string {
  try {
    if (!isHeartbeatLane(lane, projectRoot)) return '';
    // NOT the lane's CLAUDE.md: the backend regenerates that, so it follows
    // the live blocks and can never disagree with them. The baseline is the
    // hash file the supervisor writes at launch.
    const io = join(projectRoot, 'data', 'heartbeat', lane, 'io');
    const path = join(io, BASELINE_FILE);
    if (!existsSync(path)) return '';
    const baseline = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    const { changed, removed } = driftAgainstBaseline(baseline, getAllBlocks());
    const liveFile = join(io, LIVE_WALLS_FILE);
    if (driftFitsInline(changed, removed)) {
      rmSync(liveFile, { force: true });
      return renderDrift(changed, removed);
    }
    // Too big for the hook to hand back, so it goes where the room can page
    // through it. A file that will not write still leaves the list of names.
    try {
      writeFileSync(liveFile, liveWallsText(changed), 'utf8');
      return renderDrift(changed, removed, liveFile);
    } catch {
      return renderDrift(changed, removed);
    }
  } catch {
    return '';
  }
}
