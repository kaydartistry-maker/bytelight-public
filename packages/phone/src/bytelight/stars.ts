// Stars — main's starred_messages (routes/starred.ts), shared with the Svelte
// client. The bubble's star is the human viewer's own star; companions star
// with their own actor slugs and show up in the Starred sheet, not the bubble.

import { apiFetch } from './api';
import { getState, setState } from './store';

// Main's human actor. The backend defaults to it and the Svelte client uses the
// same constant (frontend/src/lib/stores/stars.svelte.ts HUMAN_ACTOR).
export const HUMAN_STAR_ACTOR = 'user';

export interface StarredItem {
  id: string;
  message_id: string;
  starred_by: string;
  starred_at: string;
  note: string | null;
  thread_id: string;
  thread_title: string | null;
  message_role: 'user' | 'companion' | 'system';
  message_content: string;
  message_content_type: string;
  message_created_at: string;
  message_deleted_at: string | null;
}

function withActor(map: Record<string, string[]>, messageId: string, actor: string): Record<string, string[]> {
  const who = map[messageId] || [];
  return who.includes(actor) ? map : { ...map, [messageId]: [...who, actor] };
}

function withoutActor(map: Record<string, string[]>, messageId: string, actor: string): Record<string, string[]> {
  const who = (map[messageId] || []).filter((w) => w !== actor);
  const { [messageId]: _drop, ...rest } = map;
  return who.length > 0 ? { ...rest, [messageId]: who } : rest;
}

export function applyStarFrame(type: 'message_starred' | 'message_unstarred', messageId: string, actor: string): void {
  setState((st) => ({
    starredBy: type === 'message_starred'
      ? withActor(st.starredBy, messageId, actor)
      : withoutActor(st.starredBy, messageId, actor),
  }));
}

/**
 * Seed the viewer's own stars so bubbles render their state without a fetch
 * each. The server's list REPLACES the viewer's entries rather than merging
 * into them: a star removed on another device while this one was offline
 * would otherwise stay lit until a reload. Other actors' entries are kept.
 */
export async function loadMyStars(): Promise<void> {
  try {
    const res = await apiFetch(`/api/starred?starred_by=${HUMAN_STAR_ACTOR}&limit=500`);
    if (!res.ok) throw new Error(`Failed to load stars (${res.status})`);
    const data = (await res.json()) as { items?: StarredItem[] };
    setState((st) => {
      let map: Record<string, string[]> = {};
      for (const [id, who] of Object.entries(st.starredBy)) {
        const others = who.filter((w) => w !== HUMAN_STAR_ACTOR);
        if (others.length > 0) map[id] = others;
      }
      for (const item of data.items ?? []) map = withActor(map, item.message_id, HUMAN_STAR_ACTOR);
      return { starredBy: map };
    });
  } catch (err) {
    console.warn('[Bytelight] Stars fetch failed:', err);
  }
}

export function isStarredByMe(starredBy: Record<string, string[]>, messageId: string): boolean {
  return (starredBy[messageId] || []).includes(HUMAN_STAR_ACTOR);
}

/**
 * Remove one actor's star, always as a DELETE. The Starred sheet uses this
 * rather than toggleStar: the local map is only seeded with the viewer's own
 * stars, so a toggle on a companion's star would read "not starred" and POST.
 */
export async function unstar(messageId: string, actor: string): Promise<void> {
  const was = (getState().starredBy[messageId] || []).includes(actor);
  applyStarFrame('message_unstarred', messageId, actor);
  try {
    const res = await apiFetch(`/api/messages/${messageId}/star`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred_by: actor }),
    });
    if (!res.ok) throw new Error(`Unstar failed (${res.status})`);
  } catch (err) {
    if (was) applyStarFrame('message_starred', messageId, actor);
    throw err;
  }
}

/** Optimistic toggle; the server's broadcast confirms it on every other device. */
export async function toggleStar(messageId: string, actor = HUMAN_STAR_ACTOR): Promise<void> {
  const was = (getState().starredBy[messageId] || []).includes(actor);
  applyStarFrame(was ? 'message_unstarred' : 'message_starred', messageId, actor);
  try {
    const res = await apiFetch(`/api/messages/${messageId}/star`, {
      method: was ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred_by: actor }),
    });
    if (!res.ok) throw new Error(`Star failed (${res.status})`);
  } catch (err) {
    applyStarFrame(was ? 'message_starred' : 'message_unstarred', messageId, actor);
    throw err;
  }
}

export async function listStarred(actor: string): Promise<{ items: StarredItem[]; counts: Record<string, number> }> {
  const res = await apiFetch(`/api/starred?starred_by=${encodeURIComponent(actor)}&limit=300`);
  if (!res.ok) throw new Error(`Failed (${res.status})`);
  const data = await res.json();
  return { items: data.items ?? [], counts: data.counts ?? {} };
}
