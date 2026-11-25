import { Router } from 'express';
import { getConfig, setConfig } from '../services/db.js';
import { listCompanions } from '../services/db/rooms.js';
import { getBytelightConfig } from '../config.js';

// ============================================================================
// Speaker profiles — name / emoji / image per identity (every registered
// companion, user, fallback). Read by the chat UI to render per-companion bubble avatars and
// names; edited in Settings → Profiles. Stored as JSON in the config table
// under the 'profiles' key. Ported from reference implementation, adapted to byte-light's
// companions. Mounted behind the auth boundary in routes/api.ts like
// its neighbors (preferences, companion settings).
// ============================================================================

type ProfileEntry = { name: string; emoji: string; image: string | null };

/**
 * Phase 1.4: a profile exists for every companion in the registry (residents
 * and visitors), the owner ('user') and the 'fallback' narrator, plus any
 * stored profile for a historical author no longer registered, so old
 * messages keep their face. Nobody absent is invented.
 */
function profileDefaults(): Record<string, ProfileEntry> {
  const out: Record<string, ProfileEntry> = {};
  try {
    for (const c of listCompanions()) {
      out[c.id] = { name: c.display_name || c.id, emoji: c.emoji || '', image: c.avatar || null };
    }
  } catch { /* registry unavailable: owner + fallback only */ }
  let owner = '';
  try { owner = getBytelightConfig().identity.user_name?.trim() ?? ''; } catch { /* config not loaded */ }
  out.user = { name: owner || 'You', emoji: '🖤', image: null };
  out.fallback = { name: 'Bytelight', emoji: '✨', image: null };
  return out;
}

function storedProfiles(): Record<string, Partial<ProfileEntry>> {
  const raw = getConfig('profiles');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, Partial<ProfileEntry>> : {};
  } catch {
    return {};
  }
}

function getProfiles(): Record<string, ProfileEntry> {
  const defaults = profileDefaults();
  const stored = storedProfiles();
  const out: Record<string, ProfileEntry> = {};
  for (const key of new Set([...Object.keys(defaults), ...Object.keys(stored)])) {
    const base = defaults[key] ?? { name: key, emoji: '', image: null };
    const saved = stored[key] && typeof stored[key] === 'object' ? stored[key] : {};
    out[key] = { ...base, ...saved };
  }
  return out;
}

/**
 * Keep a speaker profile in step with an edit made on the companion card.
 * Only identities that have a profile are touched; anyone else is a no-op.
 */
export function syncProfileFromCard(id: string, patch: { emoji?: string; image?: string | null }): void {
  const merged = getProfiles();
  const current = merged[id];
  if (!current) return;
  merged[id] = {
    name: current.name,
    emoji: typeof patch.emoji === 'string' ? patch.emoji : current.emoji,
    image: 'image' in patch ? (patch.image ?? null) : current.image,
  };
  setConfig('profiles', JSON.stringify(merged));
}

export function createProfilesRoutes(): Router {
  const router = Router();

  router.get('/profiles', (_req, res) => {
    res.json(getProfiles());
  });

  router.put('/profiles', (req, res) => {
    const body = (req.body ?? {}) as Record<string, Partial<ProfileEntry>>;
    const merged = getProfiles();
    for (const k of Object.keys(merged)) {
      const p = body[k];
      if (p && typeof p === 'object') {
        merged[k] = {
          name: typeof p.name === 'string' ? p.name : merged[k].name,
          emoji: typeof p.emoji === 'string' ? p.emoji : merged[k].emoji,
          image: p.image === null || typeof p.image === 'string' ? p.image : merged[k].image,
        };
      }
    }
    setConfig('profiles', JSON.stringify(merged));
    res.json(merged);
  });

  return router;
}
