// Ported from reference implementation (reference implementation) — adapted for byte-light.
//
// Light-path adaptation: reference implementation's version imported `resolveConfiguredModelRef`
// from agent.ts and `MODEL_MIN_CC` from shared. byte-light has NEITHER, and we
// are NOT touching agent.ts for a Settings card. Instead:
//   - MODEL_MIN_CC is inlined below, keyed by Anthropic model API id and
//     cross-referenced against reference implementation's model-manifest.ts values (only
//     Opus 4.7 declares a minimum today: 2.1.111). byte-light's frontend
//     card does not read this map (it renders the API's `minRequired`
//     field), so there is no cross-package single-source need — inlining
//     is the cleaner light path and avoids any shared-package change.
//   - Configured-models lookup mirrors byte-light's OWN resolution
//     (`getConfiguredModel` in agent.ts): DB config > YAML > env > default,
//     read here via the exported `getConfig` from db.ts and `getBytelightConfig`
//     from config.ts. No new resolver is added to agent.ts.

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getVariant } from '@bytelight/shared';
import { PROJECT_ROOT, getBytelightConfig } from '../config.js';
import { getConfig as getDbConfig } from './db.js';

/**
 * Runtime health: surfaces the Claude Code version that the bundled SDK
 * actually launches, vs the system Claude Code, vs minimum-version
 * requirements declared per model. The bundled runtime is the one that
 * matters for model compatibility — `@anthropic-ai/claude-agent-sdk`
 * ships its own `cli.js` and uses it by default unless the consumer
 * sets `pathToClaudeCodeExecutable` (we don't).
 *
 * The "active vs installed" distinction is load-bearing: after `npm install`
 * rewrites node_modules, the on-disk SDK reports a new version but the
 * running backend Node process still has the old SDK loaded in memory.
 * Active is captured once at module load (frozen until restart); installed
 * is read fresh from disk each call. The panel uses the diff between
 * them to surface "restart required" warnings.
 */

const SDK_PACKAGE_JSON_PATH = join(
  PROJECT_ROOT,
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk',
  'package.json',
);

// ---------------------------------------------------------------------------
// MODEL_MIN_CC — light-path inline map (see file header).
//
// Keyed by Anthropic model API id (the `modelApiId` field of byte-light's
// MODEL_VARIANTS). Values cross-referenced against reference implementation's
// model-manifest.ts, where only Opus 4.7 declares a minimum Claude Code
// version. Both byte-light Opus 4.7 API ids (base + 1M window) share it.
// Adding a future minimum is a one-line edit here.
// ---------------------------------------------------------------------------
export const MODEL_MIN_CC: ReadonlyMap<string, string> = new Map<string, string>([
  ['claude-opus-4-7', '2.1.111'],
  ['claude-opus-4-7[1m]', '2.1.111'],
  // Current generation — the API rejects these below Claude Code 2.1.251
  // ("version 2.1.251 or newer is required", observed live 2026-10-11).
  ['claude-fable-5-1', '2.1.251'],
  ['claude-opus-5-5', '2.1.251'],
  ['claude-sonnet-5-5', '2.1.251'],
  ['claude-haiku-5-5', '2.1.251'],
]);

/**
 * Pure reader — exported for testability. The SDK's package.json exposes
 * `claudeCodeVersion` directly (verified empirically: `0.2.98` SDK ships
 * `2.1.98` claudeCodeVersion); we read the field rather than inferring it
 * from the SDK version.
 */
export function readClaudeCodeVersionFromSdk(
  path: string = SDK_PACKAGE_JSON_PATH,
): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf-8')) as {
      version?: string;
      claudeCodeVersion?: string;
    };
    return pkg.claudeCodeVersion ?? null;
  } catch {
    return null;
  }
}

// Captured once at module load — represents what the running process
// actually has in memory. Will stay frozen until backend restart.
const ACTIVE_RUNTIME = readClaudeCodeVersionFromSdk();

/** Returns the Claude Code version the running backend has loaded. */
export function getActiveRuntimeVersion(): string | null {
  return ACTIVE_RUNTIME;
}

/**
 * Returns the Claude Code version currently on disk (in node_modules).
 * After an `npm install`, this reflects the new on-disk version while
 * the active cache continues to report the version the running process
 * loaded at startup. The two diverging is what triggers the panel's
 * "Restart required" state.
 */
export function getInstalledRuntimeVersion(): string | null {
  return readClaudeCodeVersionFromSdk();
}

/**
 * Shell out to `claude --version` (or `claude.cmd --version` on Windows).
 * Strictly informational — byte-light does NOT use the system Claude Code;
 * the backend launches the SDK's bundled cli.js. Returns null when the
 * command is unavailable or the output can't be parsed.
 */
export function getSystemClaudeCodeVersion(): string | null {
  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  try {
    const out = execFileSync(cmd, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Compare two MAJOR.MINOR.PATCH version strings numerically per component.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Critical: string comparison gets this wrong for multi-digit components.
 * "2.1.98" lexically compares GREATER than "2.1.111" because '9' > '1'
 * at position 4. This helper splits on '.' and compares numerically so
 * "2.1.98" correctly comes before "2.1.111".
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * byte-light's model tiers. Unlike reference implementation (interactive/autonomous/pulse/
 * memory), byte-light configures exactly two: the interactive chat model
 * (`agent.model`) and the autonomous/wake model (`agent.model_autonomous`).
 */
type AgentModelTier = 'interactive' | 'autonomous';

/**
 * Resolve the configured model string for a tier WITHOUT importing
 * agent.ts. Mirrors `getConfiguredModel` there exactly: DB config wins,
 * then YAML (`bytelight.yaml`), then the `AGENT_MODEL` env override, then
 * the byte-light default. Keeping this in lockstep means the card reports
 * the same model the agent will actually launch.
 */
function getConfiguredModelForTier(tier: AgentModelTier): string {
  const isAutonomous = tier === 'autonomous';
  const dbKey = isAutonomous ? 'agent.model_autonomous' : 'agent.model';
  const dbValue = getDbConfig(dbKey);
  if (dbValue) return dbValue;

  const cfg = getBytelightConfig();
  const yamlValue = isAutonomous ? cfg.agent.model_autonomous : cfg.agent.model;
  if (yamlValue) return yamlValue;

  if (process.env.AGENT_MODEL) return process.env.AGENT_MODEL;

  return 'claude-sonnet-4-6';
}

export interface MinRequirement {
  version: string;
  /** "<modelApiId> (<tier>)" — e.g. "claude-opus-4-7 (autonomous)". */
  reason: string;
}

/**
 * Compute the maximum Claude Code version requirement across byte-light's
 * two configured model tiers. Returns the highest requirement and which
 * tier+model is the bottleneck, or null if no configured model has a
 * declared minimum.
 *
 * Multi-tier matters because if `agent.model_autonomous` is set to Opus
 * 4.7 but `agent.model` is on Sonnet, the chat surface looks fine while
 * scheduled wakes need the newer runtime. The panel surfaces the highest
 * requirement so the user sees the actual blocker.
 */
export function computeMinRequirement(): MinRequirement | null {
  const tiers: AgentModelTier[] = ['interactive', 'autonomous'];
  let highest: MinRequirement | null = null;

  for (const tier of tiers) {
    const configured = getConfiguredModelForTier(tier);
    // Normalize whatever is stored (variant slug OR raw API id) to the
    // canonical model API id, then look up its minimum. getVariant is
    // liberal and falls back to the default variant for unknown values.
    const apiId = getVariant(configured).modelApiId;
    const min = MODEL_MIN_CC.get(apiId);
    if (!min) continue;
    if (!highest || compareVersions(min, highest.version) > 0) {
      highest = { version: min, reason: `${apiId} (${tier})` };
    }
  }

  return highest;
}

export interface RuntimeHealth {
  activeRuntimeVersion: string | null;
  installedRuntimeVersion: string | null;
  systemCcVersion: string | null;
  minRequired: MinRequirement | null;
  restartRequired: boolean;
}

/**
 * One-shot snapshot of runtime state for the health endpoint. Computes
 * `restartRequired` from the active-vs-installed diff (panel surfaces
 * this as "restart to load the new runtime").
 */
export function getRuntimeHealth(): RuntimeHealth {
  const active = getActiveRuntimeVersion();
  const installed = getInstalledRuntimeVersion();
  const system = getSystemClaudeCodeVersion();
  const minRequired = computeMinRequirement();
  const restartRequired = !!(
    active && installed && compareVersions(installed, active) > 0
  );
  return {
    activeRuntimeVersion: active,
    installedRuntimeVersion: installed,
    systemCcVersion: system,
    minRequired,
    restartRequired,
  };
}
