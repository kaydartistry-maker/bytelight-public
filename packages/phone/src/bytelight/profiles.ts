// Speaker profiles — name / emoji / photo per identity (companion-a, companion-b, companion-c,
// user, fallback): main's GET/PUT /api/profiles, the store the Svelte client's
// bubbles read. The companions table's `avatar` was seeded from it once
// (migrations/014_companions.sql); this is the live copy, so companion rows
// are overlaid with it (lib/companion-row.ts) and edits land here.

import { apiFetch } from './api';
import { getState, setState } from './store';

export interface ProfileEntry {
  name: string;
  emoji: string;
  image: string | null;
}
export type Profiles = Record<string, ProfileEntry>;

export async function loadProfiles(): Promise<Profiles | null> {
  try {
    const res = await apiFetch('/api/profiles');
    if (!res.ok) return null;
    const data = (await res.json()) as Profiles;
    setState({ profiles: data });
    return data;
  } catch {
    return null;
  }
}

/** PUT merges the identities sent; the response is the whole saved map. */
export async function saveProfiles(next: Profiles): Promise<boolean> {
  try {
    const res = await apiFetch('/api/profiles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (!res.ok) return false;
    setState({ profiles: (await res.json()) as Profiles });
    return true;
  } catch {
    return false;
  }
}

export function getProfiles(): Profiles | null {
  return getState().profiles;
}
