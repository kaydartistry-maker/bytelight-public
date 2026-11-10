/**
 * Rooms — companion registry + per-thread roster endpoints (Arc C, Slice 2).
 *
 * The picker's future data source. NOTHING reads the roster for prompt
 * assembly or dispatch in this slice; these routes just let the Slice 3 Svelte
 * store read the registry and read/write a thread's roster. Load-path parity:
 * the PUT write is immediately readable back through the GET (both legs prove
 * out here; the frontend hydrate leg lands in Slice 3).
 *
 *   GET /api/companions                 — list all pickable companions
 *   GET /api/threads/:id/roster         — the companions seated in a thread
 *   PUT /api/threads/:id/roster         — replace a thread's roster
 *   PATCH /api/companions/:id           — edit a companion's card (name, bio,
 *                                         status, phone)
 *
 * Schema shape ported from NESTstack's rooms-worker (cindiekinzz-coder, MIT);
 * see migrations/014_companions.sql for the full attribution.
 *
 * Auth is inherited from the parent router at routes/api.ts (the
 * router.use(authMiddleware) boundary). This module mounts AFTER that
 * boundary — like profiles-routes / companion-settings-routes — so every
 * handler below is already authed.
 */

import { Router } from 'express';
import { getThread } from '../services/db.js';
import { getOwnerSlug, ownerDisplayName } from '../services/db/owner-name.js';
import {
  listCompanions,
  getThreadRoster,
  setThreadRoster,
  allCompanionsExist,
  updateCompanionCard,
  type CompanionCardUpdate,
} from '../services/db/rooms.js';
import { syncProfileFromCard } from './profiles-routes.js';

// Card fields and how long each may be. The bio is read by a companion's own
// head, so it is allowed room to say something; the rest are one-liners.
const CARD_FIELDS: Record<keyof CompanionCardUpdate, number> = {
  display_name: 80,
  bio: 8000,
  status: 200,
  phone: 40,
  // A cropped photo arrives as a data URL (400px webp, well under a few
  // hundred KB); a gallery or https URL is far shorter. 8 MB keeps us under
  // the 10 MB JSON body limit in server.ts.
  avatar: 8_000_000,
  emoji: 16,
  color: 32,
};

export function createRoomsRoutes(): Router {
  const router = Router();

  // GET /api/companions — the full pickable registry, picker order.
  router.get('/companions', (_req, res) => {
    try {
      // The owner rides along so the phone seats her by the house's own slug
      // (accents folded) instead of re-deriving it from preferences.
      const name = ownerDisplayName();
      res.json({ companions: listCompanions(), owner: { slug: getOwnerSlug(), name: name === 'the owner' ? 'You' : name } });
    } catch (err) {
      console.error('Failed to list companions:', err);
      res.status(500).json({ error: 'Failed to list companions' });
    }
  });

  // PATCH /api/companions/:id — edit the card. Only the fields sent are
  // written; null (or an empty string) clears one. display_name can't be
  // cleared — a companion always has a name.
  router.patch('/companions/:id', (req, res) => {
    try {
      const body = { ...((req.body ?? {}) as Record<string, unknown>) };
      // The phone's card calls his photo avatar_url; the registry column is
      // avatar. Take either name.
      if ('avatar_url' in body && !('avatar' in body)) body.avatar = body.avatar_url;
      const updates: CompanionCardUpdate = {};
      for (const [key, max] of Object.entries(CARD_FIELDS) as Array<[keyof CompanionCardUpdate, number]>) {
        if (!(key in body)) continue;
        const value = body[key];
        if (value !== null && typeof value !== 'string') {
          res.status(400).json({ error: `${key} must be a string or null` });
          return;
        }
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (trimmed.length > max) {
          res.status(400).json({ error: `${key} is longer than ${max} characters` });
          return;
        }
        if (key === 'display_name' && !trimmed) {
          res.status(400).json({ error: 'display_name cannot be empty' });
          return;
        }
        (updates as Record<string, string | null>)[key] = trimmed || null;
      }
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'nothing to update (display_name, bio, status, phone, avatar, emoji, color)' });
        return;
      }
      const companion = updateCompanionCard(req.params.id, updates);
      if (!companion) {
        res.status(404).json({ error: 'Companion not found' });
        return;
      }
      // For the voices that also have a speaker profile (the chat bubbles'
      // name/emoji/photo), keep that copy in step, or the phone's overlay
      // would paint the old emoji/photo back over the one just saved.
      if ('emoji' in updates || 'avatar' in updates) {
        syncProfileFromCard(companion.id, {
          ...('emoji' in updates && updates.emoji ? { emoji: updates.emoji } : {}),
          ...('avatar' in updates ? { image: updates.avatar ?? null } : {}),
        });
      }
      res.json({ companion });
    } catch (err) {
      console.error('Failed to update companion card:', err);
      res.status(500).json({ error: 'Failed to update companion card' });
    }
  });

  // GET /api/threads/:id/roster — companions seated in a thread.
  router.get('/threads/:id/roster', (req, res) => {
    try {
      const thread = getThread(req.params.id);
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      res.json({ threadId: thread.id, roster: getThreadRoster(thread.id) });
    } catch (err) {
      console.error('Failed to get thread roster:', err);
      res.status(500).json({ error: 'Failed to get thread roster' });
    }
  });

  // PUT /api/threads/:id/roster — replace a thread's roster.
  // Body: { companionIds: string[] }. Must be non-empty; every id must exist.
  router.put('/threads/:id/roster', (req, res) => {
    try {
      const thread = getThread(req.params.id);
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = body.companionIds;
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string' && x.trim().length > 0)) {
        res.status(400).json({ error: 'companionIds must be a non-empty array of companion id strings' });
        return;
      }
      // Dedup while preserving intent; an empty roster is not allowed.
      const ids = Array.from(new Set((raw as string[]).map((s) => s.trim())));
      if (ids.length === 0) {
        res.status(400).json({ error: 'roster may not be empty' });
        return;
      }
      if (!allCompanionsExist(ids)) {
        res.status(400).json({ error: 'one or more companionIds do not exist in the companions registry' });
        return;
      }

      const roster = setThreadRoster(thread.id, ids);
      res.json({ threadId: thread.id, roster });
    } catch (err) {
      console.error('Failed to set thread roster:', err);
      res.status(500).json({ error: 'Failed to set thread roster' });
    }
  });

  return router;
}
