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
 * Values are only returned by GET /secrets/:name, and only for the few
 * keys a page actually shows or hands to a third party (isRevealableSecret);
 * every other key is write-only from a client.
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

// Which secrets the browser may read the RAW VALUE of. The phone talks to a few
// third parties directly (ElevenLabs for voice, Giphy) and shows a couple of its
// own service values (the Cortex URL and token, with a reveal-and-copy). Every
// other secret — the Discord and Telegram bot tokens, the FCM service account,
// the VAPID private key, the Mind and model provider keys — is write-only from
// a client: it can be set or cleared but never read back. This caps the damage a
// stolen or valid session cookie can do from "vacuum every key" to these few.
// (The masked LIST at GET /secrets shows all names without values, and PUT/DELETE
// on any name still work — this gate is only on reading a raw value.)
const REVEALABLE_SECRETS = new Set([
  'elevenlabs_api_key',
  'giphy_api_key',
  'cortex_mcp_url',
  'cortex_auth_token',
  // The phone's toy bridge hands this to Lovense's SDK on the device.
  'lovense_developer_token',
]);
export function isRevealableSecret(name: string): boolean {
  return REVEALABLE_SECRETS.has(name) || name.startsWith('elevenlabs_voice_id:');
}

// Masked status of every managed key — hasValue booleans, no values. Each row
// also says whether its value can be read back, so a page offers a reveal
// button only where one works.
router.get('/secrets', (_req, res) => {
  res.json({ secrets: listSecrets().map((s) => ({ ...s, revealable: isRevealableSecret(s.name) })) });
});

// Reveal a single secret's value to the authenticated operator, for the
// revealable few only. Refused for readonly info slots so the Claude SDK
// ambient-auth key is never surfaced through this API.
router.get('/secrets/:name', (req: Request, res) => {
  const name = String(req.params.name);
  const def = getSecretDef(name);
  if (!def) return res.status(404).json({ error: 'unknown secret' });
  if (def.readonly) return res.status(403).json({ error: 'this key is read-only' });
  if (!isRevealableSecret(name)) {
    // Write-only from a client. Do not leak whether it is set, either.
    return res.status(403).json({ error: 'not revealable' });
  }
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
