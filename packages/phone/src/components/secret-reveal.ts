// Reveal-on-request for a stored key: GET /api/secrets/:name returns
// { name, value } for one of the few revealable slots that has a value; 404
// means nothing is stored; read-only slots and every write-only key are
// refused (403) by the backend, and the list marks them revealable: false so
// the button is not offered.

export type RevealResult = { kind: 'value'; value: string } | { kind: 'error'; message: string };

export function revealResult(status: number, body: unknown): RevealResult {
  if (status >= 200 && status < 300) {
    const value = body && typeof body === 'object' ? (body as { value?: unknown }).value : undefined;
    return { kind: 'value', value: typeof value === 'string' ? value : '' };
  }
  if (status === 404) return { kind: 'error', message: 'not set' };
  if (status === 403 && body && typeof body === 'object' && (body as { error?: unknown }).error === 'not revealable') {
    return { kind: 'error', message: 'write-only' };
  }
  return { kind: 'error', message: `Reveal failed (${status})` };
}

/** The button only works on a slot that has something stored. */
export function canReveal(slot: { hasValue: boolean; readonly?: boolean; revealable?: boolean }): boolean {
  return slot.hasValue && !slot.readonly && slot.revealable !== false;
}
