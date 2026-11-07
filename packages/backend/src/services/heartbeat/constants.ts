// Clocks shared by the heartbeat reply window (runtime.ts) and the
// supervisor's watchdog (supervisor.ts). Both must read the same values, or
// one clock waits patiently while the other kills the session anyway.

/** How long one `touch io/.busy` counts as declared background work. */
export const BUSY_FRESH_MS = (parseInt(process.env.BYTELIGHT_HEARTBEAT_BUSY_FRESH || '600', 10)) * 1000;

/**
 * Which lane wrote a companion row: `<runtimeId>:<laneKey>` (laneKey is the
 * companion slug for "A Lane Each", else 'primary'). Stamped on every
 * companion row as metadata.lane so a warm lane can tell its own words from
 * words another lane wrote into the same thread.
 */
export function laneTagFor(runtimeId: string, laneKey: string | null | undefined): string {
  return `${runtimeId}:${laneKey || 'primary'}`;
}
