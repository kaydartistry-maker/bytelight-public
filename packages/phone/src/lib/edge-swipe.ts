/**
 * Is this pointer gesture a swipe-back from the left edge?
 *
 * The phone's navigation is state rather than history — an app opens by
 * swapping the OS screen and closes back to wherever it was launched from — so
 * there is no browser history for a swipe to walk. This decides whether a
 * gesture MEANT back; the caller does whatever its own back button does.
 *
 * Deliberately narrow, because the alternative is stealing gestures from the
 * apps. It has to start at the very edge, travel a real distance, stay
 * roughly horizontal, and finish quickly enough to be a flick rather than a
 * drag somebody paused halfway through. Nothing here calls preventDefault, so
 * a gesture this misreads still does whatever it was going to do anyway.
 */
export interface SwipeSample {
  startX: number;
  dx: number;
  dy: number;
  elapsedMs: number;
}

/** Left-edge strip that can start one, in CSS pixels. */
export const EDGE_WIDTH = 28;
/** How far right it has to get to count. */
export const MIN_DISTANCE = 72;
/** Vertical slop allowed over the whole gesture. */
export const MAX_DRIFT = 48;
/** Longer than this and it is a drag, not a swipe. */
export const MAX_DURATION_MS = 700;

export function isBackSwipe(sample: SwipeSample): boolean {
  if (sample.startX > EDGE_WIDTH) return false;
  if (sample.dx < MIN_DISTANCE) return false;
  if (Math.abs(sample.dy) > MAX_DRIFT) return false;
  if (sample.elapsedMs > MAX_DURATION_MS) return false;
  // Decisively horizontal, not merely more horizontal than not. Written first
  // as dx > |dy| and the test caught it: eighty across and forty-six down
  // passed, which is a diagonal drag by any honest reading. Twice as far
  // across as up or down.
  return sample.dx >= Math.abs(sample.dy) * 2;
}
