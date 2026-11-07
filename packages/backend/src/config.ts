import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import type { ThinkingEffort } from '@bytelight/shared';

// Derive project root from this module's location (packages/backend/src/config.ts → ../../..)
// This is stable regardless of process.cwd(), which npm workspaces can change.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

export interface BytelightConfig {
  identity: {
    companion_name: string;
    user_name: string;
    timezone: string;
  };
  server: {
    port: number;
    host: string;
    db_path: string;
  };
  auth: {
    password: string;
  };
  agent: {
    cwd: string;
    claude_md_path: string;
    mcp_json_path: string;
    model: string;
    model_autonomous: string;
    thinking_effort: ThinkingEffort | string;
    /** Optional override for autonomous tier (wakes / watchers / scribe / impulses).
     *  When unset, autonomous tier falls back to the global `thinking_effort` value.
     *  Pulse never uses thinking, so no pulse-tier counterpart exists. */
    thinking_effort_autonomous?: ThinkingEffort | string;
    /**
     * Provider routing mode (Phase 2 Step 3). Controls whether non-Claude
     * runtimes can be reached by the dispatcher.
     *
     * - 'sdk'  → Claude-only via ClaudeAgentRuntime / SDK (DEFAULT — current behavior).
     *            Any non-Claude ModelRef hitting the dispatcher throws — usage falls
     *            back to Claude or surfaces a clear "routing=sdk blocks non-Claude" error.
     * - 'auto' → Claude still routes through ClaudeAgentRuntime; non-Claude models
     *            (ollama-native, openai-compat) route through ApiRouterRuntime.
     * - 'api'  → All providers (INCLUDING Claude) route through ApiRouterRuntime.
     *            Used for testing the api-router code path on Claude; production
     *            should stay on 'sdk' or 'auto'.
     *
     * Default 'sdk' is load-bearing: byte-light's current behavior is identical to
     * post-Step-2 Claude-only routing. Flipping to 'auto' is the explicit opt-in.
     */
    routing: 'sdk' | 'auto' | 'api';
    /**
     * Additive deny patterns for the sensitive-path guard
     * (`services/tools/sensitive-paths.ts`). Each string compiles to a
     * RegExp; invalid patterns are dropped with a warn instead of
     * crashing. The builtin deny list ships EMPTY (operator Phase 0.5
     * directive — single-user sovereign deployment); this field is the
     * operator's hook for deployment-specific denials.
     */
    tool_deny_patterns?: string[];
  };
  /**
   * Provider configuration block for non-Claude runtimes. Each section is
   * optional — unset sections mean "not configured", which the dispatcher
   * + /api/models endpoint use to filter offerings.
   *
   * Only Ollama is wired in Step 3. Other sections are declared so YAML
   * configs and the router.ts loader can populate them, but the dispatcher
   * will throw with `routing=sdk` and the catalog endpoint will hide them
   * unless they're both configured AND `routing != 'sdk'`.
   */
  providers: {
    ollama?: {
      base_url: string;
      api_key?: string;
      /**
       * Two-stage rollback gate (Phase 2 Step 3). When false (DEFAULT),
       * Ollama models are hidden from the catalog and the dispatcher
       * refuses to resolve them — even if `agent.routing != 'sdk'`.
       * Set true to expose Ollama; flip back to false to instantly
       * disable without changing `routing`.
       */
      enabled: boolean;
    };
    openrouter?: { api_key: string };
    anthropic?: { api_key: string; base_url?: string };
    groq?: { api_key: string; base_url?: string };
    xai?: { api_key: string; base_url?: string };
    /**
     * OpenAI direct (BYOK) — Step 6A. `enabled` is the two-stage rollback
     * gate matching Ollama's discipline: even with a valid api_key, the
     * dispatcher refuses to resolve OpenAI models and the catalog hides
     * them unless `enabled === true`.
     */
    openai?: { api_key: string; base_url?: string; enabled?: boolean };
    huggingface?: { api_key: string; base_url?: string };
  };
  orchestrator: {
    enabled: boolean;
    wake_prompts_path: string;
    schedules: Record<string, string>;
    failsafe: {
      enabled: boolean;
      gentle_minutes: number;
      concerned_minutes: number;
      emergency_minutes: number;
    };
  };
  hooks: {
    context_injection: boolean;
    safe_write_prefixes: string[];
  };
  voice: {
    enabled: boolean;
    readAloud: boolean;
    elevenlabs_voice_id: string;
  };
  discord: {
    enabled: boolean;
    owner_user_id: string;
  };
  telegram: {
    enabled: boolean;
    owner_chat_id: string;
    group_chat_id: string;
  };
  integrations: {
    life_api_url: string;
    mind_cloud: {
      enabled: boolean;
      mcp_url: string;
    };
    /**
     * The Spotify app's MCP server, by its id or name in Integrations > MCP
     * (e.g. "Jukebox"). Unset: the first enabled server with "spotify"
     * in its name or address (services/spotify.ts findSpotifyServer).
     */
    spotify_server?: string;
    // PORT ADAPTATION: the ported GIF cutout runtime reads these optional machine-local paths.
    cutout?: {
      python?: string;
      model?: string;
      also_models?: string[];
    };
  };
  command_center: {
    enabled: boolean;
    default_person: string;
    currency_symbol: string;
    care_categories: {
      toggles: string[];
      ratings: string[];
      counters: { name: string; max: number }[];
    };
  };
  cors: {
    origins: string[];
  };
}

const DEFAULTS: BytelightConfig = {
  identity: {
    companion_name: 'Echo',
    user_name: 'User',
    timezone: 'UTC',
  },
  server: {
    port: 3002,
    host: '127.0.0.1',
    db_path: './data/bytelight.db',
  },
  auth: {
    password: '',
  },
  agent: {
    cwd: '.',
    claude_md_path: './CLAUDE.md',
    mcp_json_path: './.mcp.json',
    model: 'claude-sonnet-4-6',
    model_autonomous: 'claude-sonnet-4-6',
    // Default 'auto' picks per-model: high on Opus/Sonnet, medium on Haiku.
    // Existing user configs with explicit values are respected verbatim.
    thinking_effort: 'auto' satisfies ThinkingEffort,
    // Default 'sdk' = Claude-only. Phase 2 Step 3 ships the Ollama path
    // flag-gated OFF; flipping to 'auto' is the explicit opt-in.
    routing: 'sdk',
  },
  // Provider configs default to empty — each provider stays "not
  // configured" until YAML populates it. Ollama specifically also
  // requires `providers.ollama.enabled=true` (DEFAULT false) per the
  // two-stage rollback gate above.
  providers: {},
  orchestrator: {
    enabled: true,
    wake_prompts_path: './prompts/wake.md',
    schedules: {},
    failsafe: {
      enabled: false,
      gentle_minutes: 120,
      concerned_minutes: 720,
      emergency_minutes: 1440,
    },
  },
  hooks: {
    context_injection: true,
    safe_write_prefixes: [],
  },
  voice: {
    enabled: false,
    readAloud: false,
    elevenlabs_voice_id: '',
  },
  discord: {
    enabled: false,
    owner_user_id: '',
  },
  telegram: {
    enabled: false,
    owner_chat_id: '',
    group_chat_id: '',
  },
  integrations: {
    life_api_url: '',
    mind_cloud: {
      enabled: false,
      mcp_url: '',
    },
  },
  command_center: {
    enabled: false,
    default_person: 'user',
    currency_symbol: '$',
    care_categories: {
      toggles: ['breakfast', 'lunch', 'dinner', 'snacks', 'medication', 'movement', 'shower'],
      ratings: ['sleep', 'energy', 'wellbeing', 'mood'],
      counters: [{ name: 'water', max: 10 }],
    },
  },
  cors: {
    origins: [],
  },
};

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

let _config: BytelightConfig | null = null;

export function loadConfig(configPath?: string): BytelightConfig {
  if (_config) return _config;

  const searchPaths = configPath
    ? [configPath]
    : [
        join(PROJECT_ROOT, 'bytelight.yaml'),
        join(PROJECT_ROOT, 'bytelight.yml'),
        join(PROJECT_ROOT, 'config', 'bytelight.yaml'),
      ];

  // Exorcism tombstone: if only a legacy config exists, fail loudly rather
  // than silently booting on defaults (no auth token, wrong paths).
  if (!configPath && !searchPaths.some((p) => existsSync(p))) {
    for (const legacy of ['resonant.yaml', 'resonant.yml', join('config', 'resonant.yaml')]) {
      const lp = join(PROJECT_ROOT, legacy);
      if (existsSync(lp)) {
        throw new Error(
          `Legacy config found at ${lp} — rename it to bytelight.yaml and restart.`
        );
      }
    }
  }

  let fileConfig: Record<string, unknown> = {};

  for (const p of searchPaths) {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf-8');
      fileConfig = yaml.load(raw) as Record<string, unknown> || {};
      console.log(`Loaded config from: ${p}`);
      break;
    }
  }

  // Merge: defaults <- yaml <- env overrides
  const merged = deepMerge(DEFAULTS as unknown as Record<string, unknown>, fileConfig) as unknown as BytelightConfig;

  // Environment variable overrides
  if (process.env.PORT) merged.server.port = parseInt(process.env.PORT, 10);
  if (process.env.HOST) merged.server.host = process.env.HOST;
  if (process.env.DB_PATH) merged.server.db_path = process.env.DB_PATH;
  if (process.env.APP_PASSWORD) merged.auth.password = process.env.APP_PASSWORD;
  if (process.env.AGENT_CWD) merged.agent.cwd = process.env.AGENT_CWD;
  if (process.env.AGENT_MODEL) merged.agent.model = process.env.AGENT_MODEL;
  if (process.env.COMPANION_NAME) merged.identity.companion_name = process.env.COMPANION_NAME;
  if (process.env.USER_NAME) merged.identity.user_name = process.env.USER_NAME;
  if (process.env.TZ) merged.identity.timezone = process.env.TZ;
  if (process.env.DISCORD_ENABLED === 'true') merged.discord.enabled = true;
  if (process.env.TELEGRAM_ENABLED === 'true') merged.telegram.enabled = true;

  // Phase 2 Step 3 — provider routing flag. PROVIDER_ROUTING preferred;
  // AGENT_ROUTING accepted as fallback per the brief. Only the three
  // documented values are valid; anything else falls back to the default
  // ('sdk' from DEFAULTS) so a typo can't accidentally enable non-Claude routing.
  const rawRouting = process.env.PROVIDER_ROUTING ?? process.env.AGENT_ROUTING;
  if (rawRouting === 'sdk' || rawRouting === 'auto' || rawRouting === 'api') {
    merged.agent.routing = rawRouting;
  }

  // Phase 2 Step 3 — Ollama provider config from env (URL/key/enabled).
  // YAML can also populate `providers.ollama`; env-vars override field-by-field
  // when the YAML key is set, and provision a minimal section when it isn't.
  if (process.env.OLLAMA_BASE_URL) {
    merged.providers.ollama = {
      base_url: process.env.OLLAMA_BASE_URL,
      api_key: process.env.OLLAMA_API_KEY ?? merged.providers.ollama?.api_key,
      enabled: merged.providers.ollama?.enabled ?? false,
    };
  }
  // PROVIDER_OLLAMA_ENABLED is the two-stage rollback switch. Honors the
  // existing ollama config block if present; otherwise no-ops (no base_url
  // means no Ollama regardless of the flag).
  if (process.env.PROVIDER_OLLAMA_ENABLED === 'true' && merged.providers.ollama) {
    merged.providers.ollama.enabled = true;
  } else if (process.env.PROVIDER_OLLAMA_ENABLED === 'false' && merged.providers.ollama) {
    merged.providers.ollama.enabled = false;
  }

  // Resolve relative paths against the project root (not cwd)
  const resolveFromRoot = (p: string) => resolve(PROJECT_ROOT, p);
  merged.server.db_path = resolveFromRoot(merged.server.db_path);
  merged.agent.cwd = resolveFromRoot(merged.agent.cwd);
  merged.agent.claude_md_path = resolveFromRoot(merged.agent.claude_md_path);
  merged.agent.mcp_json_path = resolveFromRoot(merged.agent.mcp_json_path);
  merged.orchestrator.wake_prompts_path = resolveFromRoot(merged.orchestrator.wake_prompts_path);

  _config = merged;
  return merged;
}

export function getBytelightConfig(): BytelightConfig {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

/**
 * Force a fresh reload of the YAML config and replace the in-memory
 * cache. Called after PUT /api/preferences so subsequent reads
 * (including agent.ts model selection) see the new value without a
 * PM2 reload.
 */
export function reloadConfig(): BytelightConfig {
  _config = null;
  return loadConfig();
}

/**
 * Locate the active bytelight.yaml so callers outside the preferences
 * route can persist edits to the same file the loader reads from.
 * Returns null if no config file is on disk.
 */
export function findBytelightConfigPath(): string | null {
  for (const name of ['bytelight.yaml', 'bytelight.yml']) {
    const p = join(PROJECT_ROOT, name);
    if (existsSync(p)) return p;
  }
  const configDir = join(PROJECT_ROOT, 'config', 'bytelight.yaml');
  if (existsSync(configDir)) return configDir;
  return null;
}

/**
 * Persist `voice.enabled` to bytelight.yaml and refresh the in-memory
 * cache. Used by the WS voice-mode handler so the per-connection
 * toggle survives reconnects (mobile backgrounding, PM2 reload).
 * No-op if the config file cannot be found.
 */
export function persistVoiceEnabled(enabled: boolean): void {
  const configPath = findBytelightConfigPath();
  if (!configPath) return;
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = (yaml.load(raw) as Record<string, any>) || {};
  if (!parsed.voice) parsed.voice = {};
  parsed.voice.enabled = enabled;
  const newYaml = yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true });
  writeFileSync(configPath, newYaml, 'utf-8');
  reloadConfig();
}

/**
 * Persist `orchestrator.enabled` to bytelight.yaml and refresh the in-memory
 * cache. Used by the Integrations switch so a stop survives a restart; boot
 * reads this flag before starting the orchestrator.
 * No-op if the config file cannot be found.
 */
export function persistOrchestratorEnabled(enabled: boolean): void {
  const configPath = findBytelightConfigPath();
  if (!configPath) return;
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = (yaml.load(raw) as Record<string, any>) || {};
  if (!parsed.orchestrator) parsed.orchestrator = {};
  parsed.orchestrator.enabled = enabled;
  const newYaml = yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true });
  writeFileSync(configPath, newYaml, 'utf-8');
  reloadConfig();
}

/**
 * Persist `voice.readAloud` to bytelight.yaml and refresh the in-memory
 * cache. Owned exclusively by the composer speaker button — decoupled
 * from `voice.enabled` (the capability master).
 */
export function persistVoiceReadAloud(readAloud: boolean): void {
  const configPath = findBytelightConfigPath();
  if (!configPath) return;
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = (yaml.load(raw) as Record<string, any>) || {};
  if (!parsed.voice) parsed.voice = {};
  parsed.voice.readAloud = readAloud;
  const newYaml = yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true });
  writeFileSync(configPath, newYaml, 'utf-8');
  reloadConfig();
}
