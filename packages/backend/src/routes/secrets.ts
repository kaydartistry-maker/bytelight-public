/**
 * BYOK secrets API — list (masked), reveal, set, clear.
 *
 * Mounted INSIDE the auth boundary in routes/api.ts, so every handler
 * here is already behind the session cookie — same guard every other
 * authenticated route rides on.
 *
 * Read seams resolve through services/secrets.ts::getSecret at call time,
 * so a value saved here wins on the NEXT use for the live-at-call slots
 * (providers, Tavily, voice, Giphy, Mind). Gateway tokens (Discord/
 * Telegram/VAPID) are read at connect/boot time and take effect on the
 * next restart — hinted per-slot in the registry.
 *
 * The list endpoint returns hasValue booleans ONLY — never a value.
 * Values are only returned by GET /secrets/:name, and never for readonly
 * info slots (the Claude SDK ambient-auth key).
 *
 * Pattern ported from a sibling fork; byte-light-native implementation.
 * Lineage credit in the commit body.
 */

import { Router, type Request } from 'express';
import {
  deleteSecret,
  getSecret,
  getSecretDef,
  listSecrets,
  setSecret,
} from '../services/secrets.js';
import { getPushService } from '../services/push.js';

const router = Router();

// Masked status of every managed key — hasValue booleans, no values.
router.get('/secrets', (_req, res) => {
  res.json({ secrets: listSecrets() });
});

// Reveal a single secret's value to the authenticated operator. Refused
// for readonly info slots so the Claude SDK ambient-auth key is never
// surfaced through this API.
router.get('/secrets/:name', (req: Request, res) => {
  const name = String(req.params.name);
  const def = getSecretDef(name);
  if (!def) return res.status(404).json({ error: 'unknown secret' });
  if (def.readonly) return res.status(403).json({ error: 'this key is read-only' });
  const value = getSecret(name);
  if (!value) return res.status(404).json({ error: 'not set' });
  res.json({ name, value });
});

// Save a BYOK override. DELETE clears it (empty value is rejected).
router.put('/secrets/:name', (req: Request, res) => {
  const name = String(req.params.name);
  const def = getSecretDef(name);
  if (!def) return res.status(404).json({ error: 'unknown secret' });
  if (def.readonly) return res.status(403).json({ error: 'this key is read-only' });
  const value = typeof req.body?.value === 'string' ? req.body.value.trim() : '';
  if (!value) {
    return res.status(400).json({ error: 'value is required — use DELETE to clear' });
  }
  setSecret(name, value);
  // The Android app's push credentials apply at once, no restart.
  if (name === 'fcm_service_account') getPushService()?.refreshFcm();
  res.json({ ok: true, name, hasValue: true });
});

// Clear a BYOK override — resolution falls back to env/base config again.
router.delete('/secrets/:name', (req: Request, res) => {
  const name = String(req.params.name);
  const def = getSecretDef(name);
  if (!def) return res.status(404).json({ error: 'unknown secret' });
  if (def.readonly) return res.status(403).json({ error: 'this key is read-only' });
  deleteSecret(name);
  if (name === 'fcm_service_account') getPushService()?.refreshFcm();
  res.json({ ok: true, name, hasValue: !!getSecret(name) });
});

export default router;
