// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The owner's name, for the sentences a companion reads in a game room.
//
// Taken from identity.user_name rather than written into the prompts, so each
// house's companions are told about their own person. Falls back to "the
// owner" when config has not loaded (tests, early boot) or the name is blank.
import { getBytelightConfig } from '../../config.js';

export function ownerDisplayName(atSentenceStart = false): string {
  let name = 'the owner';
  try {
    name = getBytelightConfig().identity.user_name?.trim() || name;
  } catch {
    // config not loaded yet; the neutral name stands
  }
  return atSentenceStart ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/**
 * The owner's seat slug, derived from identity.user_name. Aerie keeps this as
 * getOwnerSlug() in config.ts; byte-light's config has no such helper, so the
 * same derivation lives here beside the owner's name. The phone mirrors it in
 * lib/owner.ts (ownerSlugFromName), so the two agree on which chair is hers.
 */
export function getOwnerSlug(): string {
  let name = '';
  try {
    name = getBytelightConfig().identity.user_name ?? '';
  } catch {
    // config not loaded yet; fall through to the neutral slug
  }
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'owner';
}
