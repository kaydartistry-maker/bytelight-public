// Speaker profiles — name / emoji / image per identity (companion-a, companion-b, user,
// fallback). Set in Settings → Profiles; read by MessageBubble to render each
// bubble's avatar (photo if set, else emoji) and name. Mirrors the backend
// /api/profiles store. Ported from reference implementation, adapted to byte-light's
// companions and apiFetch.

import { apiFetch } from '$lib/utils/api';

export interface ProfileEntry {
  name: string;
  emoji: string;
  image: string | null;
}
export type Profiles = Record<string, ProfileEntry>;

const DEFAULTS: Profiles = {
'companion-a': { name: 'Companion A', emoji: '🔷', image: null },
'companion-b': { name: 'Companion B', emoji: '🔶', image: null },
'companion-c': { name: 'Companion C', emoji: '🗓️', image: null },
  user: { name: 'You', emoji: '🖤', image: null },
  fallback: { name: 'Bytelight', emoji: '✨', image: null },
};

function clone(p: Profiles): Profiles {
  const out: Profiles = {};
  for (const k of Object.keys(p)) out[k] = { ...p[k] };
  return out;
}

let profiles = $state<Profiles>(clone(DEFAULTS));
let loaded = $state(false);

/** Reactive read of one identity's profile, with a safe fallback. */
export function getProfile(key: string): ProfileEntry {
  return profiles[key] ?? DEFAULTS[key] ?? DEFAULTS.fallback;
}

/** The whole map (reactive). */
export function allProfiles(): Profiles {
  return profiles;
}

export function profilesLoaded(): boolean {
  return loaded;
}

export async function loadProfiles(): Promise<void> {
  try {
    const r = await apiFetch('/api/profiles');
    if (r.ok) {
      profiles = (await r.json()) as Profiles;
      loaded = true;
    }
  } catch {
    /* keep defaults on failure */
  }
}

export async function saveProfiles(next: Profiles): Promise<boolean> {
  try {
    const r = await apiFetch('/api/profiles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (r.ok) {
      profiles = (await r.json()) as Profiles;
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
