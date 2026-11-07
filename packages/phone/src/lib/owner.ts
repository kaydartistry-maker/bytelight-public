// Who owns this house. The phone shows the owner's name and accent beside the
// companions' in Letters, and none of those
// views should carry a name inside them.
//
// GET /api/companions reports the owner alongside the companions. A backend
// that predates that field is still perfectly normal to be talking to — the
// served UI updates on refresh while the backend only changes when it restarts
// — so fall back to the identity in preferences and derive the slug the same
// way the backend does.

import { apiFetch } from '../bytelight';

export interface OwnerIdentity {
  slug: string;
  name: string;
}

/** Mirror of the backend's owner-slug derivation (services/db/owner-name.ts getOwnerSlug), accents folded. */
export function ownerSlugFromName(name: string): string {
  return name
    .trim()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function ownerFromCompanionsPayload(data: unknown): OwnerIdentity | null {
  const owner = (data as { owner?: { slug?: unknown; name?: unknown } })?.owner;
  const name = typeof owner?.name === 'string' ? owner.name.trim() : '';
  const slug = typeof owner?.slug === 'string' ? owner.slug.trim() : '';
  if (!slug && !name) return null;
  return { slug: slug || ownerSlugFromName(name), name: name || 'You' };
}

/** Ask preferences instead — for backends that don't report the owner yet. */
export async function fetchOwnerFromPreferences(): Promise<OwnerIdentity | null> {
  try {
    const res = await apiFetch('/api/preferences');
    if (!res.ok) return null;
    const prefs = await res.json().catch(() => null);
    const name = typeof prefs?.identity?.user_name === 'string' ? prefs.identity.user_name.trim() : '';
    if (!name) return null;
    return { slug: ownerSlugFromName(name), name };
  } catch {
    return null;
  }
}
