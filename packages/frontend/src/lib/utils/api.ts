// Thin fetch wrapper for API calls — always sends session credentials.

type FetchOptions = RequestInit;

export async function apiFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const fetchOptions = { ...options };

  // Always include credentials for session cookies
  fetchOptions.credentials = fetchOptions.credentials ?? 'include';

  return fetch(url, fetchOptions);
}

// Convenience methods
export const api = {
  get: (url: string, options?: FetchOptions) =>
    apiFetch(url, { ...options, method: 'GET' }),

  post: (url: string, body?: unknown, options?: FetchOptions) =>
    apiFetch(url, {
      ...options,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: body ? JSON.stringify(body) : undefined,
    }),

  put: (url: string, body?: unknown, options?: FetchOptions) =>
    apiFetch(url, {
      ...options,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: body ? JSON.stringify(body) : undefined,
    }),

  patch: (url: string, body?: unknown, options?: FetchOptions) =>
    apiFetch(url, {
      ...options,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: body ? JSON.stringify(body) : undefined,
    }),

  delete: (url: string, options?: FetchOptions) =>
    apiFetch(url, { ...options, method: 'DELETE' }),
};
