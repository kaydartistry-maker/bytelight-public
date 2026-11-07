export const MAX_ONE_OFF_REFS = 4;

export type OneOffRefToken = string & { readonly __brand: 'OneOffRefToken' };
export interface OneOffRef { token: OneOffRefToken; name: string }

export function parseOneOffRef(name: string, value: unknown): OneOffRef | null {
  if (!value || typeof value !== 'object') return null;
  const token = (value as Record<string, unknown>).token;
  return typeof token === 'string' && token.trim() ? { name, token: token as OneOffRefToken } : null;
}

/** The server's own reason for a refused upload, or the desktop Studio's fallback. */
export function oneOffUploadError(data: unknown): string {
  const error = data && typeof data === 'object' ? (data as Record<string, unknown>).error : undefined;
  return typeof error === 'string' && error.trim() ? error : 'Reference upload failed.';
}
