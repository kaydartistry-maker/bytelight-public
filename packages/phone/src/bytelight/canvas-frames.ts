// Canvas frames off the socket. Classic keeps canvases in its socket store;
// on the phone only the Canvas app cares, so the socket hands the frames to
// whoever is listening instead of holding a list nobody else reads.

import type { CanvasFrame } from '../lib/canvas-live';

const listeners = new Set<(frame: CanvasFrame) => void>();

export function emitCanvasFrame(frame: CanvasFrame): void {
  for (const l of listeners) l(frame);
}

export function subscribeCanvasFrames(fn: (frame: CanvasFrame) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
