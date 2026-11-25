// Companions registry + per-thread roster (Arc C, Slice 3).
//
// Reads GET /api/companions (the pickable identities) and the per-thread
// roster endpoints from Slice 2 (rooms-routes.ts). Faces/emojis for each
// companion are NOT stored here — they render from the profiles store
// (getProfile(companion.id)), the same visual language the Arc B bubbles use.
// So a companion row carries identity/order; the profiles store carries the
// face. All fetches ride apiFetch like profiles.svelte.ts.

import { apiFetch } from '$lib/utils/api';

/** A pickable companion, mirrors the backend companions registry row. */
export interface Companion {
  id: string;
  display_name: string;
  avatar: string | null;
  brain: string;
  model: string | null;
  sort_order: number;
  created_at: string;
}

let companions = $state<Companion[]>([]);
/** The house's own brain (GET /api/companions localBrainId, Phase 1.4). Until
 *  the first load answers it holds the backend's default, so settings writes
 *  keyed by brain land exactly where they always have. */
let houseBrain = $state('companion-a-b');
let loaded = $state(false);
let loading = $state(false);

/** The full pickable registry (reactive), in picker order. */
export function allCompanions(): Companion[] {
  return companions;
}

/** The brain this house runs turns for. */
export function localBrainId(): string {
  return houseBrain;
}

/** The companions who live in this house (their brain is the house's own). */
export function residentCompanions(): Companion[] {
  return companions.filter((c) => c.brain === houseBrain);
}

export function companionsLoaded(): boolean {
  return loaded;
}

/** Load the registry once. Safe to call repeatedly (no-op after first load
 *  unless force is set). */
export async function loadCompanions(force = false): Promise<void> {
  if ((loaded || loading) && !force) return;
  loading = true;
  try {
    const r = await apiFetch('/api/companions');
    if (r.ok) {
      const data = (await r.json()) as { companions?: Companion[]; localBrainId?: string };
      companions = data.companions ?? [];
      if (typeof data.localBrainId === 'string' && data.localBrainId) houseBrain = data.localBrainId;
      loaded = true;
    }
  } catch {
    /* keep whatever we had */
  } finally {
    loading = false;
  }
}

/** Read a thread's seated roster (companion ids, picker order). Returns [] on
 *  any failure so callers can render a safe empty state. */
export async function getThreadRoster(threadId: string): Promise<Companion[]> {
  try {
    const r = await apiFetch(`/api/threads/${threadId}/roster`);
    if (r.ok) {
      const data = (await r.json()) as { roster?: Companion[] };
      return data.roster ?? [];
    }
  } catch {
    /* fall through */
  }
  return [];
}

/** Replace a thread's roster with exactly companionIds. Returns the resulting
 *  roster on success, or null on failure (the caller keeps its prior state). */
export async function setThreadRoster(
  threadId: string,
  companionIds: string[],
): Promise<Companion[] | null> {
  try {
    const r = await apiFetch(`/api/threads/${threadId}/roster`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companionIds }),
    });
    if (r.ok) {
      const data = (await r.json()) as { roster?: Companion[] };
      return data.roster ?? [];
    }
  } catch {
    /* fall through */
  }
  return null;
}
