// Persisting an `agent.*` setting so the running house actually picks it up.
//
// There are three places one of these values lives and all three have to move
// together: the DB config row (what slash commands read back), bytelight.yaml
// (what survives a restart), and the in-memory config (what the current
// process dispatches from — refreshed here via reloadConfig()).
//
// The settings screen already wrote yaml + reload inline. The /model slash
// command did only the DB row, which is the one nothing dispatches from — so
// it wrote a row nobody reads, left the live model untouched, and reported
// success. Worse, reading it back preferred the DB row, so it then quoted the
// value it had failed to set. One function, used by every writer, is the fix.
// (Aerie agent-settings.ts, adapted: her updateConfigValue is our
// reloadConfig after the yaml write.)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { setConfig } from './db.js';
import { reloadConfig, PROJECT_ROOT } from '../config.js';

/** bytelight.yaml, found the same way config.ts loads it — from PROJECT_ROOT
 *  rather than cwd, which is not the same directory under pm2. */
export function findAgentConfigPath(): string | null {
  for (const name of ['bytelight.yaml', 'bytelight.yml']) {
    const p = join(PROJECT_ROOT, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// Only these reach the YAML. A key that is not here still lands in the DB row;
// it simply does not survive a restart, which is correct for anything the
// config file has no home for.
const YAML_KEYS = new Set([
  'agent.model',
  'agent.model_autonomous',
  'agent.routing',
  'agent.thinking_effort',
  'agent.thinking_effort_autonomous',
]);

export function persistAgentSetting(key: string, value: string, configPathOverride?: string): void {
  setConfig(key, value);
  if (!key.startsWith('agent.')) return;
  if (!YAML_KEYS.has(key)) return;

  const configPath = configPathOverride ?? findAgentConfigPath();
  if (!configPath) return;

  const parsed = (yaml.load(readFileSync(configPath, 'utf-8')) as Record<string, any>) || {};
  if (!parsed.agent) parsed.agent = {};
  parsed.agent[key.slice('agent.'.length)] = value;
  writeFileSync(
    configPath,
    yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true }),
    'utf-8',
  );

  // The live config re-reads the yaml just written — the leg /model always
  // skipped, and the reason a "switched" model never actually dispatched.
  // Skipped under an override path: a test writing a scratch yaml must not
  // reload the process onto the real one's contents mid-suite.
  if (!configPathOverride) reloadConfig();
}
