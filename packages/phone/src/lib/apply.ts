// Apply = real save (Slice 7, the operator's choice A). While Settings is open her
// changes show live but aren't saved; Apply keeps them, leaving any other way
// asks first, Discard puts back exactly what she had when Settings opened.
// Pure: tested in apply.test.ts.

/** Order-insensitive fingerprint; undefined / null fields don't count. */
export function stableKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined && o[k] !== null)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export interface SettingsSnapshot<T, S> { theme: T; settings: S }

/** Has anything changed since Settings opened? */
export function hasUnapplied<T, S>(snap: SettingsSnapshot<T, S> | null, theme: T, settings: S): boolean {
  if (!snap) return false;
  return stableKey(snap.theme) !== stableKey(theme) || stableKey(snap.settings) !== stableKey(settings);
}
