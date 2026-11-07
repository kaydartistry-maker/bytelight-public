import { Router } from 'express';
import { getConfig, setConfig } from '../services/db.js';

// ============================================================================
// Speaker profiles — name / emoji / image per identity (companion-a, companion-b, user,
// fallback). Read by the chat UI to render per-companion bubble avatars and
// names; edited in Settings → Profiles. Stored as JSON in the config table
// under the 'profiles' key. Ported from reference implementation, adapted to byte-light's
// companions. Mounted behind the auth boundary in routes/api.ts like
// its neighbors (preferences, companion settings).
// ============================================================================

const PROFILE_KEYS = ['companion-a', 'companion-b', 'companion-c', 'user', 'fallback'] as const;
type ProfileEntry = { name: string; emoji: string; image: string | null };
const PROFILE_DEFAULTS: Record<string, ProfileEntry> = {
'companion-a':    { name: 'Companion A',     emoji: '🔷', image: null },
'companion-b':    { name: 'Companion B',     emoji: '🔶', image: null },
'companion-c':     { name: 'Companion C',      emoji: '🗓️', image: null },
  user:     { name: 'You',                emoji: '🖤', image: null },
  fallback: { name: 'Bytelight', emoji: '✨', image: null },
};

function getProfiles(): Record<string, ProfileEntry> {
  let stored: Record<string, Partial<ProfileEntry>> = {};
  const raw = getConfig('profiles');
  if (raw) { try { stored = JSON.parse(raw); } catch { stored = {}; } }
  const out: Record<string, ProfileEntry> = {};
  for (const k of PROFILE_KEYS) out[k] = { ...PROFILE_DEFAULTS[k], ...(stored[k] || {}) };
  return out;
}

export function createProfilesRoutes(): Router {
  const router = Router();

  router.get('/profiles', (_req, res) => {
    res.json(getProfiles());
  });

  router.put('/profiles', (req, res) => {
    const body = (req.body ?? {}) as Record<string, Partial<ProfileEntry>>;
    const merged = getProfiles();
    for (const k of PROFILE_KEYS) {
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
