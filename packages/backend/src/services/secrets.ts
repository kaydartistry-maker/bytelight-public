/** Native encrypted DB overrides; environment and config fallbacks remain unchanged. */
import { getConfig, deleteConfig, getDb } from './db.js';
import { getBytelightConfig } from '../config.js';

import { decryptCredential, encryptCredential, isVaultEnvelope, readVaultKey } from './credential-vault.js';

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
  { name: 'provider_openai_api_key', label: 'OpenAI provider key', category: 'providers', envVar: 'OPENAI_API_KEY' },
  { name: 'provider_openrouter_api_key', label: 'OpenRouter provider key', category: 'providers', envVar: 'OPENROUTER_API_KEY' },
  { name: 'provider_groq_api_key', label: 'Groq provider key', category: 'providers', envVar: 'GROQ_API_KEY' },
  { name: 'provider_xai_api_key', label: 'xAI provider key', category: 'providers', envVar: 'XAI_API_KEY' },
  { name: 'provider_huggingface_api_key', label: 'Hugging Face provider key', category: 'providers', envVar: 'HUGGINGFACE_API_KEY' },
  { name: 'provider_ollama_api_key', label: 'Ollama provider key', category: 'providers', envVar: 'OLLAMA_API_KEY' },
  { name: 'provider_custom_api_key', label: 'Custom provider key', category: 'providers' },
  { name: 'provider_anthropic_api_key', label: 'Anthropic API-router key', category: 'providers' },
  {
    name: 'provider_zai_coding_plan_api_key',
    label: 'Z.ai GLM Coding Plan key',
    category: 'providers',
    envVar: 'ZAI_CODING_PLAN_API_KEY',
    hint: 'Personal Coding Plan → Plan Overview. Uses plan quota, including Start trial quota.',
  },
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

  { name: 'studio_openai_api_key', label: 'Studio OpenAI image key', category: 'providers', envVar: 'OPENAI_API_KEY' },
  { name: 'studio_cloudflare_token', label: 'Studio Cloudflare image token', category: 'providers', envVar: 'IMAGEGEN_MCP_TOKEN' },
  { name: 'auth_password', label: 'Application password', category: 'other', envVar: 'APP_PASSWORD', readonly: true },

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
  {
    name: 'google_drive_client_id',
    label: 'Google Drive OAuth client ID',
    category: 'platforms',
    envVar: 'GOOGLE_DRIVE_CLIENT_ID',
    hint: 'Google Cloud OAuth 2.0 Web client. Used only to connect the house to Drive and Docs.',
  },
  {
    name: 'google_drive_client_secret',
    label: 'Google Drive OAuth client secret',
    category: 'platforms',
    envVar: 'GOOGLE_DRIVE_CLIENT_SECRET',
    hint: 'Google Cloud OAuth client secret. Stored encrypted in the local credential vault.',
  },
  {
    name: 'google_drive_refresh_token',
    label: 'Google Drive refresh token',
    category: 'platforms',
    envVar: 'GOOGLE_DRIVE_REFRESH_TOKEN',
    hint: 'Created by Connect Google Drive. Disconnecting removes this local token without changing any Docs.',
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

/** Read the loaded config, swallowing the pre-load throw. */
function safeConfig(pick: (c: ReturnType<typeof getBytelightConfig>) => string | undefined): string | undefined {
  try {
    return pick(getBytelightConfig());
  } catch {
    return undefined;
  }
}

/**
 * Resolve a secret. DB-first, then env var, then a non-env fallback.
 * Returns undefined when nothing is set. Every step is guarded so this
 * is safe to call at boot before the DB or config are ready (it simply
 * skips the unavailable source).
 */
export function getSecret(name: string): string | undefined {
  const def = BY_NAME.get(name);

  // Only DB readiness is swallowed; vault errors must never select a fallback.
  let ready = false;
  try { getDb(); ready = true; } catch { /* pre-init compatibility */ }
  const stored = ready ? getConfig(PREFIX + name) : null;
  if (stored) {
    if (!isVaultEnvelope(stored)) migrateSecrets();
    const key = readVaultKey();
    try {
      const value = decryptCredential(name, getConfig(PREFIX + name)!, key);
      if (value) return value;
    } finally { key.fill(0); }
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

/** FULL synchronous commit replaces plaintext atomically, including unknown slots.
 * A crash leaves the original row or the authenticated envelope, never a gap.
 */
export function migrateSecrets(): void {
  const db = getDb();
  const rowsExist = db.prepare("SELECT 1 FROM config WHERE key LIKE 'secret:%' LIMIT 1").get();
  if (!rowsExist) return;
  const key = readVaultKey();
  const prior = db.pragma('synchronous', { simple: true }) as number;
  db.pragma('synchronous = FULL');
  try {
    db.transaction(() => {
      const rows = db.prepare("SELECT key, value FROM config WHERE key LIKE 'secret:%'").all() as { key: string; value: string }[];
      for (const row of rows) {
        const name = row.key.slice(PREFIX.length);
        if (isVaultEnvelope(row.value)) decryptCredential(name, row.value, key);
        else db.prepare('UPDATE config SET value = ? WHERE key = ?').run(encryptCredential(name, row.value, key), row.key);
      }
    }).immediate();
  } finally { db.pragma(`synchronous = ${prior}`); key.fill(0); }
}

/** Persist an authenticated encrypted override. Key provisioning is explicit. */
export function setSecret(name: string, value: string): void {
  migrateSecrets();
  const key = readVaultKey();
  const db = getDb();
  const prior = db.pragma('synchronous', { simple: true }) as number;
  db.pragma('synchronous = FULL');
  try {
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(PREFIX + name, encryptCredential(name, value, key));
  } finally { db.pragma(`synchronous = ${prior}`); key.fill(0); }
}

/** Save related encrypted values as one durable transaction (e.g. a keypair).
 * Key provisioning remains explicit; this never creates a vault key. */
export function setSecretsAtomically(values: Record<string, string>): void {
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) throw new Error('A non-empty secret map is required');
  for (const [name, value] of Object.entries(values)) {
    const def = BY_NAME.get(name);
    if (!def || def.readonly || typeof value !== 'string' || !value.trim()) throw new Error('Invalid secret entry');
  }
  migrateSecrets();
  const key = readVaultKey();
  const db = getDb();
  const prior = db.pragma('synchronous', { simple: true }) as number;
  try {
    db.pragma('synchronous = FULL');
    const encrypted = Object.entries(values).map(([name, value]) => [PREFIX + name, encryptCredential(name, value, key)]);
    db.transaction(() => {
      const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
      for (const [name, value] of encrypted) stmt.run(name, value);
    }).immediate();
  } finally { try { db.pragma(`synchronous = ${prior}`); } finally { key.fill(0); } }
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
