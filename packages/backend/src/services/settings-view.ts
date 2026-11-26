import { isSecretConfigKey } from './secrets.js';
/**
 * What GET /api/settings may hand the phone.
 *
 * The config table also holds every stored secret under a `secret:` key (bot
 * tokens, provider keys, the push service account), and the settings route
 * used to return the whole table, so any logged-in page could read every one
 * of them in plain text (found by an outside audit). The phone never read
 * them from here: it asks /api/secrets, which reveals only an allowlist. So
 * they are simply left out.
 */

export function settingsForClient(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretConfigKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Settings that name a program the house will later run. Whoever can write one
 * chooses what runs on the machine, so they are set in bytelight.yaml or by hand on
 * the box, never through the settings door (third outside audit, Nov 17 2026).
 * A new setting of this kind ends in _bin or _path and runs something; add it
 * here by name if it doesn't.
 */
const PROGRAM_SETTING_KEYS = new Set(['image_gen.codex_bin', 'image_gen.antigravity_bin', 'videos.ytdlp_path']);

/** Keys the generic settings door (PUT /api/settings) must never write. */
export function isGuardedSettingKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return k.startsWith('secret:') || k.startsWith('security.') || k.startsWith('auth.') || k === 'app_settings'
    || PROGRAM_SETTING_KEYS.has(k) || k.endsWith('_bin');
}

