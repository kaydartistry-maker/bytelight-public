// Custom emoji CRUD against the backend's /api/emojis endpoint, plus a boot
// sync that merges backend + local state and migrates any leftover base64
// data-URL emojis stored from before the phone learned to sync.

import { apiFetch } from './api';
import type { CustomEmoji } from '../types';

export interface BackendEmoji {
  id: string;
  name: string;
  filename: string;
  aliases: string[];
  url: string;
  pack_id: string | null;
  created_at: string;
}

export async function listEmojis(): Promise<BackendEmoji[]> {
  try {
    const res = await apiFetch('/api/emojis');
    if (!res.ok) return [];
    return (await res.json()) as BackendEmoji[];
  } catch {
    return [];
  }
}

// Upload a data-URL or Blob as a new emoji. Caller picks the shortcode which
// becomes the backend's unique `name`. Returns the persisted record or null
// on failure (most commonly a duplicate name).
export async function uploadEmoji(
  name: string,
  source: string | Blob,
): Promise<BackendEmoji | null> {
  try {
    const blob =
      typeof source === 'string' ? await (await fetch(source)).blob() : source;
    const mime = blob.type || 'image/png';
    const ext =
      mime === 'image/gif'
        ? 'gif'
        : mime === 'image/webp'
          ? 'webp'
          : mime === 'image/png'
            ? 'png'
            : 'png';
    const form = new FormData();
    form.append(
      'file',
      new File([blob], `${name}.${ext}`, { type: mime }),
    );
    form.append('name', name);
    const res = await apiFetch('/api/emojis', { method: 'POST', body: form });
    if (!res.ok) return null;
    return (await res.json()) as BackendEmoji;
  } catch {
    return null;
  }
}

export async function renameEmoji(
  id: string,
  name: string,
): Promise<BackendEmoji | null> {
  try {
    const res = await apiFetch(`/api/emojis/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return null;
    return (await res.json()) as BackendEmoji;
  } catch {
    return null;
  }
}

export async function deleteEmojiApi(id: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/emojis/${id}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

// Convert a backend emoji record to the phone's local CustomEmoji shape.
// pack_id rides along so the picker can group emojis into per-pack tabs.
export function toCustomEmoji(be: BackendEmoji): CustomEmoji {
  return { id: be.id, shortcode: be.name, url: be.url, pack_id: be.pack_id ?? null };
}

// Fetch the user's emoji packs. Used by the chat input's emoji picker
// so it can render one tab per pack instead of dumping everything into
// a single Custom view.
export async function listEmojiPacks(): Promise<Array<{ id: string; name: string }>> {
  try {
    const res = await apiFetch('/api/emojis/packs');
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ id: string; name: string }>;
    return rows.map((r) => ({ id: r.id, name: r.name }));
  } catch {
    return [];
  }
}

// Boot-time reconciliation. Pulls the backend list, uploads any local-only
// base64 entries, and returns the merged set of emojis to write back to
// appSettings. Idempotent — safe to call on every connect.
export async function syncEmojis(local: CustomEmoji[]): Promise<CustomEmoji[]> {
  const backend = await listEmojis();
  const byName = new Map(backend.map((e) => [e.name, e]));
  const merged: CustomEmoji[] = backend.map(toCustomEmoji);

  for (const entry of local) {
    if (!entry.url) continue;
    // Backend URL but no backend twin = the user (or another device)
    // deleted this emoji on the server. Don't resurrect it as a ghost
    // — the URL points to a now-404 file and the missing pack_id would
    // dump it into the Unpacked tab. The backend is canonical.
    if (!entry.url.startsWith('data:')) continue;
    // Local base64 with a backend twin of the same shortcode — drop the local
    // copy; the backend record is canonical.
    if (byName.has(entry.shortcode)) continue;
    // Migrate.
    const uploaded = await uploadEmoji(entry.shortcode, entry.url);
    if (uploaded) {
      merged.push(toCustomEmoji(uploaded));
      byName.set(uploaded.name, uploaded);
    } else {
      // Upload failed — keep the local entry so the user doesn't lose it.
      merged.push(entry);
    }
  }

  return merged;
}
