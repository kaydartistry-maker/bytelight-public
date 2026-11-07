// Pending canvas references — the BL <<canvas:id:title>> chip system.
// Canvas app and composer live on different screens on the phone, so the
// pending set lives here (module state + change event) instead of component
// state. The sentinel format and send behaviour are BL main's MessageInput
// (pendingCanvasRefs) verbatim: refs prepend to the outgoing message as
// `<<canvas:id:title>>` and the backend injects the canvas content ahead of
// the model turn.

export interface CanvasRef {
  canvasId: string;
  title: string;
}

const EVENT = 'bytelight:canvas-refs-changed';
let pending: CanvasRef[] = [];

export function getCanvasRefs(): CanvasRef[] {
  return [...pending];
}

export function addCanvasRef(canvasId: string, title: string): void {
  if (pending.some((r) => r.canvasId === canvasId)) return;
  pending = [...pending, { canvasId, title }];
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function removeCanvasRef(index: number): void {
  pending = pending.filter((_, i) => i !== index);
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function clearCanvasRefs(): void {
  pending = [];
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function subscribeCanvasRefs(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

/** Serialize refs to the wire sentinels, BL's exact shape. */
export function canvasRefSentinels(refs: CanvasRef[]): string {
  return refs.map((r) => `<<canvas:${r.canvasId}:${r.title}>>`).join(' ');
}

/** Match sentinels in message text for chip rendering. */
export const CANVAS_REF_RE = /<<canvas:([a-zA-Z0-9-]+):(.+?)>>/g;
