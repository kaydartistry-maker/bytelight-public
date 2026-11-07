// Pure decision logic for /api/auth/check. A server restart (connection
// refused, a proxy's 502/503/504, an HTML error page) must never read as
// logged out: only a real answer from the backend can do that.

export type AuthCheckOutcome =
  | { kind: 'answered'; authenticated: boolean; required: boolean }
  | { kind: 'unreachable' };

export type AuthCheckResponse =
  | { error: unknown }
  | { status: number; body: unknown };

// Same backoff as the classic client's auth store.
export const AUTH_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

/** Delay before retry number `attempt` (1-based, counted like the classic store). */
export function authRetryDelay(attempt: number): number {
  return AUTH_RETRY_DELAYS[Math.min(Math.max(attempt, 0), AUTH_RETRY_DELAYS.length - 1)];
}

/** Statuses that mean "the server can't answer right now", not "you're out". */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export function classifyAuthCheck(res: AuthCheckResponse): AuthCheckOutcome {
  if ('error' in res) return { kind: 'unreachable' };
  if (isTransientStatus(res.status)) return { kind: 'unreachable' };
  if (res.status >= 200 && res.status < 300) {
    // A 2xx without the backend's JSON shape is a proxy or fallback page
    // standing in while the server is down, not an answer.
    const body = res.body;
    if (!body || typeof body !== 'object' || !('authenticated' in body)) {
      return { kind: 'unreachable' };
    }
    const data = body as { authenticated?: unknown; auth_required?: unknown };
    return {
      kind: 'answered',
      authenticated: data.authenticated === true,
      required: data.auth_required !== false,
    };
  }
  // Any other non-ok status (401, 403, ...) is the server saying no.
  return { kind: 'answered', authenticated: false, required: true };
}
