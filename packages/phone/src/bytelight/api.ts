// CSRF-aware fetch + auth. Every authenticated call goes through apiFetch or
// the api helpers below: they attach the session cookie and the x-csrf-token
// header, which a raw fetch silently omits.

import { getState, setState } from './store';
import { authRetryDelay, classifyAuthCheck, type AuthCheckResponse } from './auth-check';

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)bytelight_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

type FetchOptions = RequestInit & {
  /** Skip the CSRF header (for auth endpoints that set the cookie). */
  skipCsrf?: boolean;
};

export async function apiFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { skipCsrf, ...fetchOptions } = options;
  const method = (fetchOptions.method || 'GET').toUpperCase();

  if (!skipCsrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const token = getCsrfToken();
    if (token) {
      fetchOptions.headers = { ...fetchOptions.headers, 'x-csrf-token': token };
    }
  }

  fetchOptions.credentials = fetchOptions.credentials ?? 'include';
  return fetch(url, fetchOptions);
}

export const api = {
  get: (url: string, options?: FetchOptions) => apiFetch(url, { ...options, method: 'GET' }),

  post: (url: string, body?: unknown, options?: FetchOptions) =>
    apiFetch(url, {
      ...options,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  put: (url: string, body?: unknown, options?: FetchOptions) =>
    apiFetch(url, {
      ...options,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  patch: (url: string, body?: unknown, options?: FetchOptions) =>
    apiFetch(url, {
      ...options,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  delete: (url: string, options?: FetchOptions) => apiFetch(url, { ...options, method: 'DELETE' }),
};

// --- Auth ---

// Retry state while the server is unreachable (classic auth store's rule:
// a failed check schedules another with backoff; any answer resets it).
let authRetryTimer: ReturnType<typeof setTimeout> | null = null;
let authRetryAttempt = 0;

function clearAuthRetry(): void {
  if (authRetryTimer) {
    clearTimeout(authRetryTimer);
    authRetryTimer = null;
  }
}

/** Stop any pending auth re-check (app teardown). */
export function stopAuthPolling(): void {
  clearAuthRetry();
  authRetryAttempt = 0;
}

async function fetchAuthCheck(): Promise<AuthCheckResponse> {
  try {
    const res = await fetch('/api/auth/check', { credentials: 'include' });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, body };
  } catch (error) {
    return { error };
  }
}

export async function checkAuth(): Promise<boolean> {
  clearAuthRetry();
  // Retries leave `checking` alone so a live session isn't torn down and
  // rebuilt on every attempt.
  if (authRetryAttempt === 0) setState((s) => ({ auth: { ...s.auth, checking: true } }));
  const outcome = classifyAuthCheck(await fetchAuthCheck());

  if (outcome.kind === 'answered') {
    authRetryAttempt = 0;
    setState({
      auth: { checking: false, authenticated: outcome.authenticated, required: outcome.required, unreachable: false },
    });
    return outcome.authenticated;
  }

  // Server down or restarting: keep whatever we last knew, flag it, and try
  // again with backoff. Never fall through to the password screen here.
  authRetryAttempt++;
  setState((s) => ({ auth: { ...s.auth, checking: false, unreachable: true } }));
  authRetryTimer = setTimeout(() => { void checkAuth(); }, authRetryDelay(authRetryAttempt));
  return getState().auth.authenticated;
}

export async function login(password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      stopAuthPolling();
      setState((s) => ({ auth: { ...s.auth, authenticated: true, unreachable: false } }));
      return { success: true };
    }
    const data = await res.json().catch(() => ({}));
    return { success: false, error: data.error || 'Login failed' };
  } catch (err) {
    console.error('Login error:', err);
    return { success: false, error: 'Network error' };
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch (err) {
    console.error('Logout error:', err);
  } finally {
    setState((s) => ({ auth: { ...s.auth, authenticated: false } }));
  }
}
