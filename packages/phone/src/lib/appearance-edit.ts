/** Immutable edits for internal, dotted field descriptors. Never mutate the
 * saved theme or a sibling override while editing one slider. */
export function appearanceField(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) =>
    value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, source);
}

export function editAppearanceField<T extends object>(source: T, path: string, value: unknown): T {
  const keys = path.split('.');
  if (!keys.length || keys.some((key) => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || ['constructor', 'prototype'].includes(key))) {
    throw new Error('Invalid appearance field');
  }
  const next = structuredClone(source) as Record<string, unknown>;
  let cursor = next;
  for (const key of keys.slice(0, -1)) {
    const current = cursor[key];
    if (!current || typeof current !== 'object' || Array.isArray(current)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  if (value === undefined) delete cursor[keys[keys.length - 1]];
  else cursor[keys[keys.length - 1]] = value;
  return next as T;
}
