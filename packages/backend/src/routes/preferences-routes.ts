import { Router } from 'express';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { getBytelightConfig, reloadConfig, findBytelightConfigPath } from '../config.js';
import { getAllConfig, setConfig, getConfig, getConfigBool } from '../services/db.js';
import { roomBiosReady } from '../services/heartbeat/lane-identity.js';
import { getArchivistSettings } from '../services/memory-extraction.js';

// The Archivist knobs the phone's ArchivistSettings saves. Kept in the settings
// table (read live by every sweep, no restart), never YAML — the same place
// Aerie keeps them. Before this the PUT dropped them silently.
const ARCHIVIST_EFFORTS = new Set(['adaptive', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const ARCHIVIST_THINKING = new Set(['adaptive', 'enabled', 'disabled']);

export function createPreferencesRoutes(): Router {
  const router = Router();

  // --- Preferences (bytelight.yaml) ---

  router.get('/preferences', (req, res) => {
    try {
      // The same file the loader read, found from the project root. Looking
      // in the working directory missed it under `npm start`, which runs the
      // backend from packages/backend.
      const configPath = findBytelightConfigPath();
      if (!configPath) {
        res.status(404).json({ error: 'No config file found' });
        return;
      }
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = yaml.load(raw) as Record<string, unknown> || {};
      // Only expose safe, editable fields — not server internals
      const config = getBytelightConfig();
      res.json({
        identity: {
          companion_name: config.identity.companion_name,
          user_name: config.identity.user_name,
          timezone: config.identity.timezone,
        },
        agent: {
          model: (parsed as any)?.agent?.model ?? config.agent.model,
          model_autonomous: (parsed as any)?.agent?.model_autonomous ?? config.agent.model_autonomous,
          thinking_effort: (parsed as any)?.agent?.thinking_effort ?? config.agent.thinking_effort ?? 'max',
          // Optional autonomous-tier override. Returned as undefined when
          // unset so the frontend distinguishes "match chat" from explicit
          // value. Falls through to thinking_effort at resolution time.
          thinking_effort_autonomous: (parsed as any)?.agent?.thinking_effort_autonomous,
          // The Room ("A Lane Each"). Kept in the settings table and read live
          // on every turn, so flipping it needs no restart. It stays off until
          // every resident companion has a bio — his lane reads it.
          multi_lane: getConfig('agent.multi_lane') === 'true',
          multi_lane_ready: roomBiosReady().ready,
          multi_lane_waiting_on: roomBiosReady().missing,
          // The Archivist. Provider/effort/thinking as each sweep will run
          // them (defaults filled in); the model only as saved, so an unset
          // model shows the provider's placeholder instead of a stale id.
          ...(() => {
            const a = getArchivistSettings();
            return {
              archivist_provider: a.provider,
              archivist_model: getConfig('agent.archivist_model') || '',
              archivist_effort: a.effort,
              archivist_thinking: a.thinking,
            };
          })(),
        },
        orchestrator: {
          enabled: (parsed as any)?.orchestrator?.enabled ?? config.orchestrator.enabled,
        },
        voice: {
          enabled: (parsed as any)?.voice?.enabled ?? config.voice.enabled,
        },
        discord: {
          enabled: getConfigBool('discord.enabled', (parsed as any)?.discord?.enabled ?? config.discord.enabled),
        },
        telegram: {
          enabled: getConfigBool('telegram.enabled', (parsed as any)?.telegram?.enabled ?? config.telegram.enabled),
        },
        auth: {
          has_password: !!config.auth.password,
        },
        // Phase 2 Step 3 — surface providers block so the ProvidersPanel
        // can render configured state on mount. API keys are redacted to
        // `'***'` placeholders so the frontend can show "configured" without
        // leaking secrets back over the wire. Empty/undefined fields are
        // returned as-is so the panel can distinguish "unset" from "set".
        // (Slice 3c port from the tag's preferences-routes; the tag's
        // companion-settings hydration legs are intentionally NOT ported —
        // companion-resolver wiring is out of this arc's scope.)
        providers: (() => {
          const rawProviders = (parsed as any)?.providers ?? {};
          const redact = (v: unknown) => (typeof v === 'string' && v.length > 0 ? '***' : v);
          return {
            anthropic: rawProviders.anthropic ? { enabled: rawProviders.anthropic.enabled } : undefined,
            // Step 6A: surface base_url alongside enabled + redacted api_key so
            // the ProvidersPanel can render the OpenAI card from a fresh mount
            // without a second roundtrip.
            openai: rawProviders.openai ? {
              base_url: rawProviders.openai.base_url,
              api_key: redact(rawProviders.openai.api_key),
              enabled: !!rawProviders.openai.enabled,
            } : undefined,
            openrouter: rawProviders.openrouter ? { enabled: rawProviders.openrouter.enabled, api_key: redact(rawProviders.openrouter.api_key) } : undefined,
            ollama: rawProviders.ollama ? {
              base_url: rawProviders.ollama.base_url,
              api_key: redact(rawProviders.ollama.api_key),
              enabled: !!rawProviders.ollama.enabled,
            } : undefined,
            huggingface: rawProviders.huggingface ? { enabled: rawProviders.huggingface.enabled, api_key: redact(rawProviders.huggingface.api_key) } : undefined,
            custom: rawProviders.custom ? { base_url: rawProviders.custom.base_url, enabled: rawProviders.custom.enabled, api_key: redact(rawProviders.custom.api_key) } : undefined,
          };
        })(),
        agent_full: {
          routing: config.agent.routing,
        },
      });
    } catch (err) {
      console.error('Failed to read preferences:', err);
      res.status(500).json({ error: 'Failed to read preferences' });
    }
  });

  router.put('/preferences', (req, res) => {
    try {
      const configPath = findBytelightConfigPath();
      if (!configPath) {
        res.status(404).json({ error: 'No config file found' });
        return;
      }
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = (yaml.load(raw) as Record<string, any>) || {};
      const updates = req.body as Record<string, any>;

      // Merge only allowed fields
      if (updates.identity) {
        if (!parsed.identity) parsed.identity = {};
        if (updates.identity.companion_name !== undefined) parsed.identity.companion_name = updates.identity.companion_name;
        if (updates.identity.user_name !== undefined) parsed.identity.user_name = updates.identity.user_name;
        if (updates.identity.timezone !== undefined) parsed.identity.timezone = updates.identity.timezone;
      }
      if (updates.agent) {
        if (!parsed.agent) parsed.agent = {};
        if (updates.agent.model !== undefined) parsed.agent.model = updates.agent.model;
        if (updates.agent.model_autonomous !== undefined) parsed.agent.model_autonomous = updates.agent.model_autonomous;
        if (updates.agent.thinking_effort !== undefined) parsed.agent.thinking_effort = updates.agent.thinking_effort;
        // Optional autonomous-tier override. null/empty clears (returns
        // to "match chat" fallback); any truthy value sets the override.
        if (updates.agent.thinking_effort_autonomous !== undefined) {
          const v = updates.agent.thinking_effort_autonomous;
          if (v === null || v === '') {
            delete parsed.agent.thinking_effort_autonomous;
          } else {
            parsed.agent.thinking_effort_autonomous = v;
          }
        }
      }
      // The Room: written to the settings table (live, no restart), never YAML.
      if (updates.agent?.multi_lane !== undefined) {
        const on = updates.agent.multi_lane === true || String(updates.agent.multi_lane) === 'true';
        const bios = roomBiosReady();
        if (on && !bios.ready) {
          res.status(400).json({ error: `A Lane Each waits on a bio for ${bios.missing.join(' and ') || 'each companion'} — his lane reads it.` });
          return;
        }
        setConfig('agent.multi_lane', on ? 'true' : 'false');
      }
      // The Archivist: settings table (live, no restart), never YAML.
      if (updates.agent && typeof updates.agent === 'object') {
        const a = updates.agent as Record<string, unknown>;
        for (const key of ['archivist_provider', 'archivist_model'] as const) {
          if (a[key] !== undefined && typeof a[key] !== 'string') {
            res.status(400).json({ error: `agent.${key} must be a string` });
            return;
          }
        }
        if (a.archivist_effort !== undefined && !ARCHIVIST_EFFORTS.has(String(a.archivist_effort))) {
          res.status(400).json({ error: `agent.archivist_effort must be one of ${[...ARCHIVIST_EFFORTS].join(', ')}` });
          return;
        }
        if (a.archivist_thinking !== undefined && !ARCHIVIST_THINKING.has(String(a.archivist_thinking))) {
          res.status(400).json({ error: `agent.archivist_thinking must be one of ${[...ARCHIVIST_THINKING].join(', ')}` });
          return;
        }
        // An empty model clears back to the provider's default.
        if (a.archivist_provider !== undefined) setConfig('agent.archivist_provider', String(a.archivist_provider).trim());
        if (a.archivist_model !== undefined) setConfig('agent.archivist_model', String(a.archivist_model).trim());
        if (a.archivist_effort !== undefined) setConfig('agent.archivist_effort', String(a.archivist_effort));
        if (a.archivist_thinking !== undefined) setConfig('agent.archivist_thinking', String(a.archivist_thinking));
      }
      if (updates.orchestrator) {
        if (!parsed.orchestrator) parsed.orchestrator = {};
        if (updates.orchestrator.enabled !== undefined) parsed.orchestrator.enabled = updates.orchestrator.enabled;
      }
      if (updates.voice) {
        if (!parsed.voice) parsed.voice = {};
        if (updates.voice.enabled !== undefined) parsed.voice.enabled = updates.voice.enabled;
      }
      if (updates.discord) {
        if (!parsed.discord) parsed.discord = {};
        if (updates.discord.enabled !== undefined) parsed.discord.enabled = updates.discord.enabled;
      }
      if (updates.telegram) {
        if (!parsed.telegram) parsed.telegram = {};
        if (updates.telegram.enabled !== undefined) parsed.telegram.enabled = updates.telegram.enabled;
      }
      if (updates.auth) {
        if (!parsed.auth) parsed.auth = {};
        if (updates.auth.password !== undefined) parsed.auth.password = updates.auth.password;
      }

      // ---------------------------------------------------------------------
      // providers.* — Phase 2 Step 3 augmentation (Slice 3c port, verbatim
      // from the tag's preferences-routes.ts).
      //
      // The ProvidersPanel six-card layout POSTs partial updates here. Only
      // `providers.ollama.*` is FUNCTIONAL in Step 3 (the dispatcher /
      // catalog actually read it); the other provider keys are accepted
      // and persisted so Step 4 doesn't have to re-extend the validator.
      //
      // Shape (raw shape-check to match this file's existing style):
      //   providers.anthropic?.enabled?: boolean
      //   providers.openai?.enabled?: boolean
      //   providers.openrouter?.{api_key?, enabled?}
      //   providers.ollama?.{base_url, api_key?, enabled}   ← validated, required when present
      //   providers.huggingface?.{api_key?, enabled?}
      //   providers.custom?.{base_url?, api_key?, enabled?}
      //
      // Validation policy: light. We reject only obviously-broken Ollama
      // payloads (missing base_url when the block is present) — everything
      // else passes through as-is so Step 4 can layer richer validation
      // without churning this file again.
      if (updates.providers && typeof updates.providers === 'object') {
        if (!parsed.providers) parsed.providers = {};
        const p = updates.providers as Record<string, any>;

        // Ollama — fully wired in Step 3. base_url is required when the
        // block is present; api_key is optional; enabled is a boolean.
        if (p.ollama && typeof p.ollama === 'object') {
          const o = p.ollama;
          if (o.base_url !== undefined && typeof o.base_url !== 'string') {
            res.status(400).json({ error: 'providers.ollama.base_url must be a string' });
            return;
          }
          if (o.base_url !== undefined && !/^https?:\/\//i.test(o.base_url)) {
            res.status(400).json({ error: 'providers.ollama.base_url must be a valid http(s) URL' });
            return;
          }
          if (o.api_key !== undefined && typeof o.api_key !== 'string') {
            res.status(400).json({ error: 'providers.ollama.api_key must be a string' });
            return;
          }
          if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
            res.status(400).json({ error: 'providers.ollama.enabled must be a boolean' });
            return;
          }
          if (!parsed.providers.ollama) parsed.providers.ollama = {};
          if (o.base_url !== undefined) parsed.providers.ollama.base_url = o.base_url;
          if (o.api_key !== undefined) parsed.providers.ollama.api_key = o.api_key;
          if (o.enabled !== undefined) parsed.providers.ollama.enabled = o.enabled;
        }

        // OpenAI direct (BYOK) — Step 6A. Strict validation mirroring Ollama:
        // base_url must be http(s) when present, api_key is a string, enabled
        // is a boolean. The api_key is persisted verbatim and never logged.
        if (p.openai && typeof p.openai === 'object') {
          const o = p.openai;
          if (o.base_url !== undefined && typeof o.base_url !== 'string') {
            res.status(400).json({ error: 'providers.openai.base_url must be a string' });
            return;
          }
          if (o.base_url !== undefined && !/^https?:\/\//i.test(o.base_url)) {
            res.status(400).json({ error: 'providers.openai.base_url must be a valid http(s) URL' });
            return;
          }
          if (o.api_key !== undefined && typeof o.api_key !== 'string') {
            res.status(400).json({ error: 'providers.openai.api_key must be a string' });
            return;
          }
          if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
            res.status(400).json({ error: 'providers.openai.enabled must be a boolean' });
            return;
          }
          if (!parsed.providers.openai) parsed.providers.openai = {};
          if (o.base_url !== undefined) parsed.providers.openai.base_url = o.base_url;
          if (o.api_key !== undefined) parsed.providers.openai.api_key = o.api_key;
          if (o.enabled !== undefined) parsed.providers.openai.enabled = o.enabled;
        }

        // Accept-and-store the other provider blocks. Step 4 will validate
        // and actually wire each. (OpenAI now handled above explicitly.)
        // H3b-1: groq + xai added — their openai-compat lanes are now live in
        // the picker, so their BYOK keys must persist through this same flow.
        for (const key of ['anthropic', 'openrouter', 'groq', 'xai', 'huggingface', 'custom']) {
          if (p[key] && typeof p[key] === 'object') {
            const block = p[key];
            if (!parsed.providers[key]) parsed.providers[key] = {};
            if (block.api_key !== undefined) {
              if (typeof block.api_key !== 'string') {
                res.status(400).json({ error: `providers.${key}.api_key must be a string` });
                return;
              }
              parsed.providers[key].api_key = block.api_key;
            }
            if (block.base_url !== undefined) {
              if (typeof block.base_url !== 'string') {
                res.status(400).json({ error: `providers.${key}.base_url must be a string` });
                return;
              }
              parsed.providers[key].base_url = block.base_url;
            }
            if (block.enabled !== undefined) {
              if (typeof block.enabled !== 'boolean') {
                res.status(400).json({ error: `providers.${key}.enabled must be a boolean` });
                return;
              }
              parsed.providers[key].enabled = block.enabled;
            }
          }
        }
      }

      // Write back
      const newYaml = yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true });
      writeFileSync(configPath, newYaml, 'utf-8');

      // Refresh the in-memory _config so subsequent reads (including
      // agent.ts model selection) see the new value without PM2 reload.
      reloadConfig();

      res.json({ success: true, message: 'Preferences saved.' });
    } catch (err) {
      console.error('Failed to save preferences:', err);
      res.status(500).json({ error: 'Failed to save preferences' });
    }
  });

  // --- Settings & Config endpoints ---

  // Get all config
  router.get('/settings', (req, res) => {
    try {
      const config = getAllConfig();
      res.json({ config });
    } catch (error) {
      console.error('Error fetching settings:', error);
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  // Update a config value
  router.put('/settings', (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key || typeof key !== 'string' || typeof value !== 'string') {
        res.status(400).json({ error: 'key and value (strings) required' });
        return;
      }
      setConfig(key, value);
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating setting:', error);
      res.status(500).json({ error: 'Failed to update setting' });
    }
  });

  // Get config endpoint — returns companion/user names plus all DB config
  router.get('/config', (req, res) => {
    try {
      const resonantConfig = getBytelightConfig();
      const dbConfig = getAllConfig();
      res.json({
        companion_name: resonantConfig.identity.companion_name,
        user_name: resonantConfig.identity.user_name,
        timezone: resonantConfig.identity.timezone,
        config: dbConfig,
      });
    } catch (error) {
      console.error('Error fetching config:', error);
      res.status(500).json({ error: 'Failed to fetch config' });
    }
  });

  // Get skills from agent CWD
  router.get('/skills', (req, res) => {
    try {
      const config = getBytelightConfig();
      const agentCwd = config.agent.cwd;
      const skillsDir = join(agentCwd, '.claude', 'skills');

      if (!existsSync(skillsDir)) {
        res.json({ skills: [] });
        return;
      }

      const skills: Array<{ name: string; description: string }> = [];
      const dirs = readdirSync(skillsDir, { withFileTypes: true });

      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const skillFile = join(skillsDir, dir.name, 'SKILL.md');
        if (!existsSync(skillFile)) continue;

        const content = readFileSync(skillFile, 'utf-8');

        // Parse YAML frontmatter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const fm = fmMatch[1];
        const nameMatch = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m);
        const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);

        skills.push({
          name: nameMatch?.[1] || dir.name,
          description: descMatch?.[1] || '',
        });
      }

      res.json({ skills });
    } catch (error) {
      console.error('Error reading skills:', error);
      res.status(500).json({ error: 'Failed to read skills' });
    }
  });

  return router;
}
