// Who lives in this house, read from the house itself.
//
// Several rooms need the same three facts: which companions exist, who owns the
// place, and which of a list of names are residents rather than guests. Before
// this, each of them carried a typed-out set of the four people in one
// particular house, which is fine right up until somebody else installs it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, useProfiles } from '../bytelight';
import { fetchOwnerFromPreferences, ownerFromCompanionsPayload, type OwnerIdentity } from './owner';
import { normalizeCompanionRows } from './companion-row';

export interface HouseCompanion {
  slug: string;
  display_name: string;
  color: string | null;
  emoji: string | null;
  avatar_url: string | null;
}

export interface CastLabels {
  everyone: string;
  companions: string;
}

export interface HouseRoster {
  companions: HouseCompanion[];
  owner: OwnerIdentity | null;
  /** Companion slugs plus the owner's — everyone who actually lives here. */
  residents: string[];
  companionSlugs: string[];
  castLabels: CastLabels;
  loaded: boolean;
  isResident: (slug: string) => boolean;
  labelOf: (slug: string) => string;
  sigilOf: (slug: string) => string;
}

/** The owner has no companion row to carry an emoji, so the house lends one. */
export const OWNER_SIGIL = '🧡';
const GUEST_SIGIL = '🐾';

/**
 * Her face, from app settings — the same place the messages app reads it.
 *
 * One reader, asked by every surface that draws her. Each rail having its own
 * copy is how the send icon ended up stopping at the edge of one app.
 */
export function getOwnerAvatar(): { url?: string; color?: string } {
  try {
    const saved = localStorage.getItem('bytelight_settings');
    if (!saved) return {};
    const parsed = JSON.parse(saved) as { userAvatar?: string; userAvatarColor?: string };
    return { url: parsed.userAvatar, color: parsed.userAvatarColor };
  } catch {
    return {};
  }
}

export function useHouseRoster(): HouseRoster {
  // The rows as the house sent them. Faces are laid over them from main's
  // profiles, which can land after /api/companions answers (a room opened
  // straight off the lock screen): normalized once, those rows kept the
  // companions table's seeded `avatar`, a copy that can point at a file
  // long gone. So the rows are re-read whenever the profiles change, the
  // same way the chat re-reads its own.
  const [rows, setRows] = useState<unknown[]>([]);
  const profiles = useProfiles();
  const companions = useMemo<HouseCompanion[]>(() => normalizeCompanionRows(rows), [rows, profiles]);
  const [owner, setOwner] = useState<OwnerIdentity | null>(null);
  const [castLabels, setCastLabels] = useState<CastLabels>({ everyone: '', companions: '' });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/companions');
        const data = res.ok ? await res.json().catch(() => null) : null;
        if (cancelled) return;
        if (Array.isArray(data?.companions)) setRows(data.companions);
        if (data?.castLabels && typeof data.castLabels === 'object') {
          setCastLabels({
            everyone: typeof data.castLabels.everyone === 'string' ? data.castLabels.everyone : '',
            companions: typeof data.castLabels.companions === 'string' ? data.castLabels.companions : '',
          });
        }
        // A backend that predates the owner field is still a normal thing to be
        // talking to — the served UI refreshes long before the server restarts.
        const identity = ownerFromCompanionsPayload(data) ?? await fetchOwnerFromPreferences();
        if (!cancelled && identity) setOwner(identity);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const companionSlugs = useMemo(() => companions.map((c) => c.slug), [companions]);
  const residents = useMemo(
    () => (owner?.slug ? [...companionSlugs, owner.slug] : companionSlugs),
    [companionSlugs, owner?.slug],
  );
  const residentSet = useMemo(() => new Set(residents), [residents]);

  const isResident = useCallback((slug: string) => residentSet.has(slug), [residentSet]);

  const labelOf = useCallback((slug: string) => {
    if (owner?.slug && slug === owner.slug) return owner.name;
    return companions.find((c) => c.slug === slug)?.display_name || slug;
  }, [companions, owner?.slug, owner?.name]);

  const sigilOf = useCallback((slug: string) => {
    if (owner?.slug && slug === owner.slug) return OWNER_SIGIL;
    return companions.find((c) => c.slug === slug)?.emoji || GUEST_SIGIL;
  }, [companions, owner?.slug]);

  return { companions, owner, residents, companionSlugs, castLabels, loaded, isResident, labelOf, sigilOf };
}
