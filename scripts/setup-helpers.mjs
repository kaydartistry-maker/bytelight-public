// Pure helpers for the setup wizard (scripts/setup.mjs), kept apart so they
// can be tested without a terminal.

/** True when `tz` is a time zone this machine's Intl knows (e.g. "America/New_York"). */
export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * The machine's own zone, or null when it can't be trusted as the person's.
 * Cloud VMs almost always report UTC, which is nobody's real clock, so UTC
 * counts as "unknown" and the wizard asks instead of guessing.
 */
export function trustedDetectedTimezone(detected) {
  if (!isValidTimezone(detected)) return null;
  const tz = detected.trim();
  if (tz === 'UTC' || tz === 'Etc/UTC' || tz === 'Etc/Universal' || tz === 'Universal' || tz === 'Zulu') return null;
  return tz;
}

/**
 * A house name turned into a pm2 process name: lowercase letters, digits and
 * single dashes. Two houses on one machine need different names, or pm2 treats
 * them as the same app.
 */
export function processNameFor(houseName) {
  const slug = String(houseName ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'bytelight';
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The engines a house can run on, as the wizard offers them. Each entry says
 * what the house's default model becomes and what to do to sign in. Picking
 * one is only the starting default: every thread and the whole house can be
 * switched to another engine later in the app.
 */
export const ENGINES = [
  {
    key: 'claude',
    label: 'Claude Code (your Claude plan login)',
    model: 'sonnet', // "latest Sonnet": never goes stale on a new install
    signIn: [
      'Install Claude Code:  npm install -g @anthropic-ai/claude-code',
      'Sign in:              claude auth login',
    ],
  },
  {
    key: 'codex',
    label: 'Codex (your ChatGPT login)',
    model: 'codex-cli/gpt-6.1-sol',
    signIn: [
      'Install Codex:  npm install -g @openai/codex',
      'Sign in:        codex login   (on a server with no browser: codex login --device-auth)',
    ],
  },
  {
    key: 'api',
    label: 'An API key (OpenRouter, Grok, Groq, OpenAI, Ollama)',
    model: null, // the person picks one from their provider's own list
    signIn: [],
  },
];

/** API providers the wizard can set up, and where their model lists live. */
export const API_PROVIDERS = [
  { key: 'openrouter', label: 'OpenRouter (many models, one key)', models: 'https://openrouter.ai/models' },
  { key: 'xai', label: 'Grok (xAI)', models: 'https://docs.x.ai/docs/models' },
  { key: 'groq', label: 'Groq', models: 'https://console.groq.com/docs/models' },
  { key: 'openai', label: 'OpenAI', models: 'https://platform.openai.com/docs/models' },
  { key: 'ollama', label: 'Ollama (local, or Ollama Cloud)', models: 'https://ollama.com/library' },
];

/** Double quotes and backslashes escaped for a YAML double-quoted string. */
export function yamlQuote(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The yaml lines an engine choice produces: the default model, and for an API
 * key the one provider block it needs. Returns { model, providersYaml }.
 */
export function engineSettings(engineKey, api = {}) {
  const engine = ENGINES.find((e) => e.key === engineKey);
  if (!engine) throw new Error(`unknown engine: ${engineKey}`);
  if (engine.key !== 'api') return { model: engine.model, providersYaml: 'providers: {}\n' };
  const provider = API_PROVIDERS.find((p) => p.key === api.provider);
  if (!provider) throw new Error(`unknown API provider: ${api.provider}`);
  const modelId = String(api.model ?? '').trim();
  if (!modelId) throw new Error('an API engine needs a model id');
  const lines = ['providers:', `  ${provider.key}:`];
  if (provider.key === 'ollama') lines.push(`    base_url: ${yamlQuote(api.baseUrl || 'http://localhost:11434')}`);
  if (api.key) lines.push(`    api_key: ${yamlQuote(api.key)}`);
  if (provider.key === 'ollama' || provider.key === 'openai') lines.push('    enabled: true');
  return { model: `${provider.key}/${modelId}`, providersYaml: lines.join('\n') + '\n' };
}
