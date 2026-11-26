/**
 * BYOK secrets store — a single DB-first read path for every managed
 * API key / token in byte-light.
 *
 * Storage: keys live in the existing `config` KV table under a
 * `secret:<name>` prefix, so they never collide with the agent/discord/
 * telegram config rows already in that table. No new table, no migration.
 *
 * Resolution order for `getSecret(name)`:
 *   1. DB   — `config['secret:<name>']` (the BYOK override you save here)
 *   2. env  — `process.env[def.envVar]` (faithful to the pre-BYOK .env deploy)
 *   3. base — `def.fallback()` (e.g. a bytelight.yaml provider block)
 *
 * The env + base fallbacks make this a ZERO-REGRESSION drop-in: with the
 * DB empty, every key resolves byte-for-byte the way it did before this
 * store existed. Saving a value in the DB simply wins over the fallback
 * on the NEXT read — no restart needed for call-time read seams.
 *
 * Values are sealed at rest (services/secret-box.ts): a stored row is
 * AES-256-GCM ciphertext under a key file outside the repo, and only
 * getSecret opens it. An older plain row still reads and is sealed at the
 * next start (sealPlainSecrets). Values are NEVER logged.
 *
 * Pattern ported from a sibling fork's shipped secrets store; registry
 * and read seams are byte-light-native. Lineage credit in the commit body.
 */

import { getConfig, setConfig, deleteConfig, getAllConfig } from './db.js';
import { getBytelightConfig } from '../config.js';
import { isSealedValue, loadSecretsKey, openValue, sealValue, secretsKeyPath } from './secret-box.js';

const PREFIX = 'secret:';

export type SecretCategory = 'providers' | 'search' | 'voice' | 'platforms' | 'other';

export interface SecretDef {
  /** Canonical slot name — the DB key is `secret:<name>`. */
  name: string;
  /** Human label for the future Keys UI. */
  label: string;
  /** Grouping bucket for the UI. */
  category: SecretCategory;
  /** Environment variable consulted when the DB slot is empty. */
  envVar?: string;
  /** One-liner shown under the input in the UI. */
  hint?: string;
  /**
   * Non-env fallback (e.g. a bytelight.yaml provider block). Consulted
   * after `envVar`. Guarded by the caller — may throw if config isn't
   * loaded yet.
   */
  fallback?: () => string | undefined;
  /**
   * Info-only slot: readable status, but writes/reveals are refused.
   * Used for the Claude SDK ambient-auth key, which must NOT be routed
   * through this store.
   */
  readonly?: boolean;
}

// Every managed key in one place, grouped so the future Keys UI can
// render sections. `envVar` is the pre-BYOK source; `fallback` covers
// keys that currently live in bytelight.yaml rather than the environment.
export const SECRETS: SecretDef[] = [
  // ── Model providers ────────────────────────────────────────────────
  // Model-router provider keys (OpenAI / xAI / Groq-router / OpenRouter /
  // HuggingFace / Ollama) are intentionally NOT managed here — they live
  // in bytelight.yaml `providers.*` and are edited on the Providers tab.
  // The engine dispatch + catalog paths read them directly (byte-identical
  // to upstream), so no getSecret seam reroutes provider resolution.
  //
  // The only provider-category entry is the read-only Anthropic info slot:
  {
    // Info-only: the Claude SDK authenticates via ambient ANTHROPIC_API_KEY.
    // This store DOES NOT route it — listed so the Keys UI can show its
    // status, but writes/reveals are refused to keep the Claude lane's
    // ambient auth byte-identical.
    name: 'anthropic_api_key',
    label: 'Anthropic API key (Claude SDK — read-only)',
    category: 'providers',
    envVar: 'ANTHROPIC_API_KEY',
    readonly: true,
    hint: 'Claude SDK ambient auth. Managed via environment only — not editable here.',
  },

  // ── Search ─────────────────────────────────────────────────────────
  {
    name: 'tavily_api_key',
    label: 'Tavily API key (web search)',
    category: 'search',
    envVar: 'TAVILY_API_KEY',
    hint: 'tavily.com — powers the search_web tool for foreign engines',
  },
  {
    name: 'opensubtitles_api_key',
    label: 'OpenSubtitles API key',
    category: 'search',
    envVar: 'OPENSUBTITLES_API_KEY',
    hint: 'opensubtitles.com/consumers — the Theater finds subtitles for a night on its own',
  },

  // ── Voice ──────────────────────────────────────────────────────────
  {
    name: 'groq_api_key',
    label: 'Groq API key (voice transcription)',
    category: 'voice',
    envVar: 'GROQ_API_KEY',
    hint: 'console.groq.com — Whisper transcription for voice notes. Distinct read path from the router Groq key.',
  },
  {
    name: 'elevenlabs_api_key',
    label: 'ElevenLabs API key',
    category: 'voice',
    envVar: 'ELEVENLABS_API_KEY',
    hint: 'elevenlabs.io/app/settings/api-keys — TTS voice',
  },
  {
    name: 'elevenlabs_voice_id',
    label: 'Default ElevenLabs voice ID',
    category: 'voice',
    envVar: 'ELEVENLABS_VOICE_ID',
    fallback: () => safeConfig((c) => c.voice.elevenlabs_voice_id || undefined),
    hint: 'Used when no per-companion voice is set',
  },
  {
    name: 'hume_api_key',
    label: 'Hume API key (voice prosody)',
    category: 'voice',
    envVar: 'HUME_API_KEY',
    hint: 'hume.ai — optional tone reading alongside the transcript',
  },

  // ── Platforms ──────────────────────────────────────────────────────
  // Read at gateway connect time — a saved value takes effect on the
  // NEXT restart/reconnect, not live (see routes/secrets.ts + server.ts).
  {
    name: 'discord_bot_token',
    label: 'Discord bot token',
    category: 'platforms',
    envVar: 'DISCORD_BOT_TOKEN',
    hint: 'discord.com/developers/applications — takes effect on restart',
  },
  {
    name: 'fcm_service_account',
    label: 'Firebase service account',
    category: 'platforms',
    envVar: 'FCM_SERVICE_ACCOUNT',
    hint: 'Firebase → Project settings → Service accounts → Generate new private key. Paste the whole JSON. Only needed for push to the Android app.',
  },
  {
    name: 'telegram_bot_token',
    label: 'Telegram bot token',
    category: 'platforms',
    envVar: 'TELEGRAM_BOT_TOKEN',
    hint: 'Talk to @BotFather — takes effect on restart',
  },

  // ── Other ──────────────────────────────────────────────────────────
  {
    name: 'giphy_api_key',
    label: 'Giphy API key',
    category: 'other',
    envVar: 'GIPHY_API_KEY',
    hint: 'developers.giphy.com — GIF search in the Telegram gateway',
  },
  {
    name: 'mind_api_key',
    label: 'Mind Bridge API key',
    category: 'other',
    envVar: 'MIND_API_KEY',
    hint: 'Bearer for the Mind Bridge proxy',
  },
  {
    name: 'mind_api_url',
    label: 'Mind Bridge API URL',
    category: 'other',
    envVar: 'MIND_API_URL',
    hint: 'Base URL for the Mind Bridge proxy',
  },
  {
    name: 'vapid_public_key',
    label: 'VAPID public key (web push)',
    category: 'other',
    envVar: 'VAPID_PUBLIC_KEY',
    hint: 'Web-push keypair — takes effect on restart',
  },
  {
    name: 'vapid_private_key',
    label: 'VAPID private key (web push)',
    category: 'other',
    envVar: 'VAPID_PRIVATE_KEY',
    hint: 'Web-push keypair — takes effect on restart',
  },
  {
    name: 'vapid_contact',
    label: 'VAPID contact (mailto:)',
    category: 'other',
    envVar: 'VAPID_CONTACT',
    hint: 'Contact URI for web-push, e.g. mailto:you@example.com — takes effect on restart',
  },
];

const BY_NAME = new Map(SECRETS.map((s) => [s.name, s]));

// The config table holds the secrets store too, under PREFIX. Anything that
// hands the table to a client goes through this first: a signed-in page should
// never be one request away from every key the house holds.
export function withoutSecrets(config: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !isSecretConfigKey(key)));
}

/** A config key that holds a key or token even though it is not under the
 *  secrets prefix (Studio's OpenAI key lives at image_gen.openai_api_key). */
export function isSecretConfigKey(key: string): boolean {
  return key.startsWith(PREFIX) || /(?:^|[._])(?:api_key|apikey|token|secret|password)$/i.test(key);
}

/** Read the loaded config, swallowing the pre-load throw. */
function safeConfig(pick: (c: ReturnType<typeof getBytelightConfig>) => string | undefined): string | undefined {
  try {
    return pick(getBytelightConfig());
  } catch {
    return undefined;
  }
}

// Stored values are sealed at rest (services/secret-box.ts); getSecret,
// setSecret and sealPlainSecrets are the only doors to them, so nothing else
// in the house sees ciphertext.
let warnedUnopenable = false;
function openStored(row: string, stored: string): string | null {
  const plain = openValue(stored, loadSecretsKey(), row);
  if (plain === null && !warnedUnopenable) {
    warnedUnopenable = true;
    console.error(`[secrets] ${row} is sealed and the key file cannot open it (${secretsKeyPath()}); treating it as unset`);
  }
  return plain;
}

/** Whether new values get sealed: on unless config secrets.at_rest is 'off'. */
function sealingOn(): boolean {
  return getConfig('secrets.at_rest') !== 'off';
}

/**
 * Resolve a secret. DB-first, then env var, then a non-env fallback.
 * Returns undefined when nothing is set. Every step is guarded so this
 * is safe to call at boot before the DB or config are ready (it simply
 * skips the unavailable source).
 */
export function getSecret(name: string): string | undefined {
  const def = BY_NAME.get(name);

  // 1. DB override
  try {
    const stored = getConfig(PREFIX + name);
    if (stored) {
      const plain = openStored(PREFIX + name, stored);
      if (plain) return plain;
    }
  } catch {
    /* DB not initialized yet — fall through to env/base */
  }

  // 2. Environment variable
  if (def?.envVar) {
    const fromEnv = process.env[def.envVar];
    if (fromEnv) return fromEnv;
  }

  // 3. Non-env base (e.g. bytelight.yaml provider block)
  if (def?.fallback) {
    try {
      const v = def.fallback();
      if (v) return v;
    } catch {
      /* fallback source unavailable */
    }
  }

  return undefined;
}

/** Persist a BYOK override, sealed unless secrets.at_rest is 'off'. */
export function setSecret(name: string, value: string): void {
  const key = value && sealingOn() ? loadSecretsKey({ create: true }) : null;
  setConfig(PREFIX + name, key ? sealValue(value, key, PREFIX + name) : value);
}

/**
 * Seal every stored secret still held as plain text (run at start, so values
 * written before this existed, or by a restore, are covered). Returns how many
 * rows it sealed; nothing when sealing is off or no key file can be made.
 * Idempotent: a sealed row is never touched again.
 */
export function sealPlainSecrets(): number {
  if (!sealingOn()) return 0;
  const plain = Object.entries(getAllConfig()).filter(([k, v]) => k.startsWith(PREFIX) && v && !isSealedValue(v));
  if (!plain.length) return 0;
  const key = loadSecretsKey({ create: true });
  if (!key) return 0;
  for (const [k, v] of plain) setConfig(k, sealValue(v, key, k));
  return plain.length;
}

/** Clear a BYOK override — resolution falls back to env/base again. */
export function deleteSecret(name: string): void {
  deleteConfig(PREFIX + name);
}

export interface SecretStatus {
  name: string;
  label: string;
  category: SecretCategory;
  hint?: string;
  hasValue: boolean;
  readonly: boolean;
}

/**
 * List every registered secret with a hasValue boolean ONLY — never the
 * value itself. `hasValue` reflects the full resolution chain (DB, env,
 * or base fallback), so a provider configured via bytelight.yaml reads as
 * present even with no BYOK override saved.
 */
export function listSecrets(): SecretStatus[] {
  return SECRETS.map((def) => ({
    name: def.name,
    label: def.label,
    category: def.category,
    hint: def.hint,
    hasValue: !!getSecret(def.name),
    readonly: !!def.readonly,
  }));
}

/** Lookup a definition (used by routes to enforce readonly slots). */
export function getSecretDef(name: string): SecretDef | undefined {
  return BY_NAME.get(name);
}
