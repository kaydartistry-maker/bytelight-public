// Reveal-on-request for a stored key, same rules as the classic Keys panel:
// GET /api/secrets/:name returns { name, value } for a writable slot that
// has a value; 404 means nothing is stored; read-only slots are refused by
// the backend and never rendered on this screen anyway.

export type RevealResult = { kind: 'value'; value: string } | { kind: 'error'; message: string };

export function revealResult(status: number, body: unknown): RevealResult {
  if (status >= 200 && status < 300) {
    const value = body && typeof body === 'object' ? (body as { value?: unknown }).value : undefined;
    return { kind: 'value', value: typeof value === 'string' ? value : '' };
  }
  if (status === 404) return { kind: 'error', message: 'not set' };
  return { kind: 'error', message: `Reveal failed (${status})` };
}

/** The button only works on a slot that has something stored. */
export function canReveal(slot: { hasValue: boolean; readonly?: boolean }): boolean {
  return slot.hasValue && !slot.readonly;
}
