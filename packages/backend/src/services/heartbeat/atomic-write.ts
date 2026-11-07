// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { renameSync, unlinkSync, writeFileSync } from 'fs';

/**
 * Write a single-value state file so no reader can ever catch it half-written.
 *
 * writeFileSync/open(…,'w') truncate in place, leaving the file at zero bytes
 * for a few microseconds on every write. .last-tick is written every 3s by the
 * hook and read every 2s by the supervisor's watchdog, and the watchdog used to parse
 * an empty read as "never ticked" — dropping through to the outbox mtime, which
 * on a quiet evening is hours old, and killing a perfectly live session.
 * Proven 2026-08-01: two kills whose reported age matched the last activity
 * write to within 2s while the hook's own loop was ticking three seconds apart
 * straight through both windows. rename(2) is atomic — a reader sees the old
 * value or the new one, never neither.
 *
 * The scratch name carries this process's pid. .last-tick has a second writer
 * in another process, the Stop hook, and while both wrote through the same
 * "<file>.tmp" one rename could carry off the other's scratch copy. On
 * 2026-09-26 at 05:43Z the hook lost that race: its rename threw ENOENT, the
 * hook died, a dead Stop hook lets the session end, and the room went with it.
 * A name no other writer uses cannot be taken, and a write that fails cleans
 * up its own scratch copy on the way out.
 */
export function atomicWrite(filepath: string, data: string): void {
  const tmp = `${filepath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, filepath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing left to clean up */ }
    throw err;
  }
}
