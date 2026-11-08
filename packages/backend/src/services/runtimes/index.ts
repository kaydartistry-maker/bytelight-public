/**
 * Runtime dispatcher — resolves a tier to the runtime + modelRef +
 * capability descriptor that AgentService should dispatch with.
 *
 * byte-light Phase 2 Step 2: only `claude-sdk` is wired. The other
 * three runtime kinds (`codex`, `openai-compat`, `ollama-native`)
 * throw "not wired up yet" — the type union from
 * `@bytelight/shared/model-manifest` declares them so a future Step 3+
 * can drop in implementations without touching this file's contract.
 *
 * Shape parity: matches reference implementation/main's `resolveConfiguredRuntime(tier)`
 * (see `packages/backend/src/services/agent.ts:328-364`) so
 * Step 3 can fold in the api-router runtime by adding another `case`.
 *
 * Model resolution: byte-light's existing path goes
 * `cfg.agent.model` (interactive) or `cfg.agent.model_autonomous`
 * (autonomous), with env-var override `AGENT_MODEL`. We delegate to
 * that path verbatim via `resolveConfiguredRawModel(tier)` then run
 * the bare id through `normalizeModelRef(...)` to produce a typed
 * `ModelRef`. The `companion-resolver` layer (`./companion-resolver.ts`)
 * is NOT consulted here — it operates one layer up, picking a
 * (companion, tier, thread) tuple; the dispatcher resolves the
 * tier-level fallback that companion-resolver eventually delegates to.
 * Step 3+ will likely fold companion-resolver into this dispatcher
 * once companions can pick non-Claude models.
 */

import { normalizeModelRef, type ModelRef, type ProviderId, type RuntimeId } from '@bytelight/shared';
import { getBytelightConfig } from '../../config.js';
import {
  ClaudeAgentRuntime,
  CLAUDE_CAPABILITIES,
} from './claude-sdk.js';
import { ApiRouterRuntime } from './api-router.js';
import {
  CodexAgentRuntime,
  CODEX_CAPABILITIES,
  isCodexAuthed,
} from './codex.js';
import {
  InteractiveCliRuntime,
  CLAUDE_CLI_CAPABILITIES,
} from '../heartbeat/runtime.js';
import {
  InteractiveCodexRuntime,
  CODEX_CLI_CAPABILITIES,
} from './codex-daemon.js';
import { executeForeignLaneTool, getRouterTools } from '../mcp-bridge.js';  // SLICE-3a ADAPTATION: tag's tools-bridge.ts == main's mcp-bridge.ts (same exports)
import type { AgentRuntime } from './types.js';
import type { AgentModelTier } from './types.js';  // SLICE-3a ADAPTATION: declared in types.ts until agent.ts exports it (Slice 3b)

/**
 * Module-level singleton. Connection / auth / capability state lives
 * on the runtime instance — re-instantiating per dispatch would lose
 * the `activeQuery` reference and break MCP refresh ordering. Mirrors
 * reference implementation `agent.ts:280-281` singleton pattern.
 */
const claudeRuntime = new ClaudeAgentRuntime();

/**
 * Codex runtime singleton WIRED to byte-light's tools-bridge.
 *
 * `codex.ts` is forbidden from importing tools-bridge (Slice 1 out-of-
 * scope guard — keeps the dependency graph clean), so it cannot
 * construct a wired runtime itself. As of Slice 2.6 it does not export
 * any module-level Codex singleton at all; the dispatcher is now the
 * SOLE wiring site, owning both the runtime constructor AND the tools-
 * bridge import, and constructing the singleton here with the bridge
 * callback supplied via constructor option.
 *
 * Same pattern as `getApiRouterRuntime` above (`executeTool: (name, args)
 * => executeForeignLaneTool(name, args)`: the router tools plus the
 * operator's .mcp.json servers). One shared bridge surface serves both
 * runtimes — no parallel registry, no per-runtime tool list.
 */
const codexRuntime = new CodexAgentRuntime({
  executeTool: (name, args) => executeForeignLaneTool(name, args),
});

/**
 * Claude-CLI (heartbeat) runtime singleton — the subscription-billed lane.
 * Wraps a warm interactive `claude` CLI session kept alive by the heartbeat
 * supervisor. Module-level singleton so connection / session / lane state
 * survives across dispatches (re-instantiating would drop the warm session
 * ledger), mirroring the claude/codex singletons above.
 *
 * Self-gates on `CLAUDE_CLI_HEARTBEAT_ENABLED` (default FALSE) inside
 * `runTurn` — with the flag off it emits one non-recoverable `error` event
 * and never touches the supervisor or spawns a subprocess. Constructed with
 * its options-default `sessionKey: 'primary'`; a per-companion factory map
 * (mirroring `apiRouterRuntimes`) can replace this once a route threads a
 * companion id through.
 */
const claudeCliRuntime = new InteractiveCliRuntime();

/**
 * A companion's own Claude CLI lane — one warm session per companion slug,
 * used when The Room runs "A Lane Each". Same runtime class as the shared
 * lane, keyed by the companion instead of 'primary'; identity is layered in
 * that session's own CLAUDE.md (heartbeat/lane-identity.ts).
 */
const claudeCliLaneRuntimes = new Map<string, InteractiveCliRuntime>();
export function getClaudeCliLaneRuntime(companionSlug: string): InteractiveCliRuntime {
  let runtime = claudeCliLaneRuntimes.get(companionSlug);
  if (!runtime) {
    runtime = new InteractiveCliRuntime({ sessionKey: companionSlug });
    claudeCliLaneRuntimes.set(companionSlug, runtime);
  }
  return runtime;
}

/**
 * Codex-CLI (warm daemon) runtime singleton — the ChatGPT/Codex subscription
 * lane (H2). Wraps a warm Codex app-server daemon kept alive by
 * `codexSupervisor`, holding a daemon-resident thread as its session. Module-
 * level singleton so the daemon connection / thread id survive across
 * dispatches (re-instantiating would drop the warm thread), mirroring the
 * claude/claude-cli/codex singletons above.
 *
 * Constructed with no options — model comes off the resolved `ModelRef` per
 * turn (the picked codex-cli model), so one singleton serves every codex-cli
 * pick. If a future route threads a companion id through, a per-companion
 * factory map (mirroring `apiRouterRuntimes`) can replace this.
 */
const codexCliRuntime = new InteractiveCodexRuntime();

/**
 * A companion's own Codex CLI lane — one runtime (its own daemon connection
 * and app-server thread binding) per companion slug, used when The Room runs
 * "A Lane Each". Session cards for it are filed under his lane.
 */
const codexCliLaneRuntimes = new Map<string, InteractiveCodexRuntime>();
export function getCodexCliLaneRuntime(companionSlug: string): InteractiveCodexRuntime {
  let runtime = codexCliLaneRuntimes.get(companionSlug);
  if (!runtime) {
    runtime = new InteractiveCodexRuntime({ laneKey: companionSlug });
    codexCliLaneRuntimes.set(companionSlug, runtime);
  }
  return runtime;
}

/**
 * ApiRouter runtime singletons — one per (runtimeId, providerId) pair.
 * Step 3 wires Ollama + OpenRouter; future providers (xAI, Groq, OpenAI
 * direct) follow the same pattern once they get their own ProviderId
 * entries in `model-manifest.ts`.
 *
 * Stateless construction is safe — ApiRouter holds no per-instance state
 * beyond a transient AbortController during an active turn. We still
 * cache to avoid recreating on every dispatch (premature optimization,
 * but it preserves reference implementation pattern from `agent.ts:281`).
 *
 * Capability descriptor: ApiRouter has narrower capabilities than Claude.
 * No MCP (tools come from byte-light's tools-bridge, not from SDK
 * cloud-MCP), no file checkpointing, no session resume. Vision is true
 * because the OpenAI-compat path supports it natively. Reasoning is best-
 * effort (<think> tag injection for non-Anthropic models per reference implementation
 * router.ts:244-249 prompt manipulation).
 */
export const API_ROUTER_CAPABILITIES = {
  tools: true,
  vision: true,
  reasoning: true,
  mcp: false,        // tools-bridge handles MCP at a higher layer
  sessionResume: false,
  fileCheckpointing: false,
  streaming: true,
} as const;

const apiRouterRuntimes = new Map<string, ApiRouterRuntime>();

function getApiRouterRuntime(runtimeId: RuntimeId, providerId: ProviderId): ApiRouterRuntime {
  const key = `${runtimeId}|${providerId}`;
  let rt = apiRouterRuntimes.get(key);
  if (!rt) {
    rt = new ApiRouterRuntime({
      runtimeId,
      providerId,
      executeTool: (name, args) => executeForeignLaneTool(name, args),
      // Tools are lazy-loaded per-turn via input.tools rather than passed
      // statically — getRouterTools() requires async + the executeRouterTool
      // callback already covers in-process + MCP routing. Step 4+ may
      // populate `tools` here if a static tool set proves cheaper.
    });
    apiRouterRuntimes.set(key, rt);
  }
  return rt;
}

/**
 * Two-stage Ollama rollback gate. Even when `agent.routing != 'sdk'`,
 * Ollama remains hidden unless `providers.ollama.enabled === true`. This
 * lets the operator flip `PROVIDER_OLLAMA_ENABLED=false` to instantly disable
 * Ollama without changing the routing mode.
 */
function isOllamaEnabled(): boolean {
  const cfg = getBytelightConfig();
  return !!cfg.providers.ollama?.enabled && !!cfg.providers.ollama?.base_url;
}

/**
 * Force-load the router tools registry so `getRouterTools()` populated
 * before any turn fires. Called by AgentService init in Step 4+; today
 * the bridge is lazy so this is unused but exported for future use.
 */
export async function warmRouterTools(): Promise<void> {
  await getRouterTools();
}

/**
 * What `resolveConfiguredRuntime` hands back to a dispatching caller.
 * The capability descriptor rides alongside so consumers can ask the
 * runtime "do you do MCP / vision / reasoning?" without poking
 * runtime-specific methods.
 */
export interface RuntimeDispatchPacket {
  runtime: AgentRuntime;
  modelRef: ModelRef;
  /**
   * Capability descriptor for the resolved runtime. Union of all
   * possible capability shapes; consumers should check runtime kind
   * before relying on Claude-only fields. The shape is identical across
   * runtimes today (same key set, different booleans), so a simple
   * boolean lookup works on both unions interchangeably.
   */
  capabilities:
    | typeof CLAUDE_CAPABILITIES
    | typeof API_ROUTER_CAPABILITIES
    | typeof CODEX_CAPABILITIES
    | typeof CLAUDE_CLI_CAPABILITIES
    | typeof CODEX_CLI_CAPABILITIES;
}

/**
 * Resolve byte-light's per-tier model config to a typed `ModelRef`.
 * This is the same cascade today's `_processQuery` does inline at
 * agent.ts:597-599 — just lifted out and run through
 * `normalizeModelRef` to get a typed value. The cascade order
 * (cfg.agent.model > env var > hardcoded default) is preserved verbatim;
 * the autonomous path takes its own field (`cfg.agent.model_autonomous`)
 * exactly as the inline resolver did.
 *
 * Pulse and memory tiers fall through to the interactive path today
 * (byte-light doesn't differentiate them at the config layer yet).
 * companion-resolver's `systemFallback` agrees with this mapping —
 * see `services/companion-resolver.ts:56-67`.
 */
export function resolveConfiguredModelRef(tier: AgentModelTier): ModelRef {
  const cfg = getBytelightConfig();
  let raw: string;
  switch (tier) {
    case 'autonomous':
      raw = cfg.agent.model_autonomous;
      break;
    case 'interactive':
    case 'pulse':
    case 'memory':
    default:
      raw = cfg.agent.model || process.env.AGENT_MODEL || 'claude-sonnet-4-6';
      break;
  }
  return normalizeModelRef(raw);
}

/**
 * Pick the runtime to dispatch for an explicit `ModelRef`. Same switch
 * as `resolveConfiguredRuntime`, but takes the ref as input instead of
 * computing it from per-tier cfg. This is what callers should use when
 * the ref comes from `companion-resolver` (thread/companion-scope
 * overrides via `companion_settings`) — i.e. when the dispatched model
 * may differ from `cfg.agent.model`.
 *
 * `resolveConfiguredRuntime(tier)` is now a thin wrapper around this
 * function for the cfg-only path; keeping it preserves the original
 * signature for any callers that still resolve by tier.
 *
 * Step 3 adds `case 'openai-compat'` for the reference implementation-style api-router
 * runtime. Step 4+ adds Codex / Ollama.
 */
export function resolveRuntimeForRef(modelRef: ModelRef): RuntimeDispatchPacket {
  const cfg = getBytelightConfig();
  switch (modelRef.runtime) {
    case 'claude-sdk':
      // Routing='api' diverts Claude through ApiRouter for testing the
      // generic HTTP path. Production stays on routing='sdk' or 'auto'.
      if (cfg.agent.routing === 'api') {
        return {
          runtime: getApiRouterRuntime('openai-compat', 'claude'),
          modelRef,
          capabilities: API_ROUTER_CAPABILITIES,
        };
      }
      return { runtime: claudeRuntime, modelRef, capabilities: CLAUDE_CAPABILITIES };
    case 'ollama-native':
      // Two-stage gate: routing must be non-'sdk' AND Ollama provider
      // must be explicitly enabled. Either failure surfaces a clear
      // error rather than mis-routing or silently falling back.
      if (cfg.agent.routing === 'sdk') {
        throw new Error(
          `ollama-native runtime unavailable with routing=sdk (modelRef=${modelRef.canonical}). ` +
          `Set PROVIDER_ROUTING=auto (or YAML agent.routing: auto) to enable.`,
        );
      }
      if (!isOllamaEnabled()) {
        throw new Error(
          `Ollama runtime is disabled (modelRef=${modelRef.canonical}). ` +
          `Set PROVIDER_OLLAMA_ENABLED=true and configure providers.ollama.base_url.`,
        );
      }
      return {
        runtime: getApiRouterRuntime('ollama-native', 'ollama'),
        modelRef,
        capabilities: API_ROUTER_CAPABILITIES,
      };
    case 'openai-compat':
      if (cfg.agent.routing === 'sdk') {
        throw new Error(
          `openai-compat runtime unavailable with routing=sdk (modelRef=${modelRef.canonical}). ` +
          `Set PROVIDER_ROUTING=auto to enable.`,
        );
      }
      return {
        runtime: getApiRouterRuntime('openai-compat', modelRef.provider),
        modelRef,
        capabilities: API_ROUTER_CAPABILITIES,
      };
    case 'codex':
      // 6B-B Slice 1: runtime shell wired. Auth gate is enforced
      // INSIDE codexRuntime.runTurn (the runtime emits `auth_required`
      // when `isCodexLoggedIn()` is false) so a dispatched turn from
      // an unauthed user yields a clean event sequence instead of a
      // throw. The dispatcher only short-circuits on a config-level
      // disablement, which Codex doesn't have today — auth IS the
      // gate. `isCodexAuthed` is re-exported in case a future caller
      // wants to check before dispatch (e.g. to avoid spinning up
      // orientation context for an unauthed Codex turn).
      void isCodexAuthed; // keep the import live for downstream slices
      return {
        runtime: codexRuntime,
        modelRef,
        capabilities: CODEX_CAPABILITIES,
      };
    case 'claude-cli':
      // H1b — the pickable subscription lane. Provider 'claude-cli' maps
      // here via providerToRuntime; a thread that picks "Claude (CLI ·
      // subscription)" resolves to this singleton. The runtime self-gates
      // on CLAUDE_CLI_HEARTBEAT_ENABLED (default FALSE) inside runTurn, so
      // dispatching with the flag off yields a clean non-recoverable error
      // event in-thread rather than a spawn. No routing-mode gate: like
      // Codex, this lane dispatches independently of the api-router, so
      // routing='sdk' permits it.
      return {
        runtime: claudeCliRuntime,
        modelRef,
        capabilities: CLAUDE_CLI_CAPABILITIES,
      };
    case 'codex-cli':
      // H2 — the pickable ChatGPT/Codex subscription lane. Provider 'codex-cli'
      // maps here via providerToRuntime; a thread that picks a "… (Codex CLI)"
      // model resolves to this singleton. Dispatches through the warm Codex
      // app-server daemon (InteractiveCodexRuntime) on the operator's ChatGPT
      // CLI-login (~/.codex/auth.json), independently of the api-router — so
      // routing='sdk' permits it, exactly like the claude-cli and codex lanes.
      // Daemon-start / connect failures surface as clean in-thread error events
      // (the runtime never throws out of runTurn).
      return {
        runtime: codexCliRuntime,
        modelRef,
        capabilities: CODEX_CLI_CAPABILITIES,
      };
    default: {
      const _exhaustive: never = modelRef.runtime;
      throw new Error(`Unhandled runtime: ${_exhaustive as string}`);
    }
  }
}

/**
 * Pick the runtime to dispatch a given tier through. Returns a packet
 * with runtime + modelRef + capabilities so the caller can avoid a
 * second lookup. Throws for non-Claude runtimes — byte-light Step 2
 * only wires Claude.
 *
 * Thin wrapper over `resolveRuntimeForRef` — kept for the cfg-only
 * path where the caller doesn't have a resolved ref in hand.
 *
 * Step 3 adds `case 'openai-compat'` for the reference implementation-style api-router
 * runtime. Step 4+ adds Codex / Ollama.
 */
export function resolveConfiguredRuntime(tier: AgentModelTier): RuntimeDispatchPacket {
  return resolveRuntimeForRef(resolveConfiguredModelRef(tier));
}

export { claudeRuntime };
// The dispatcher-wired Codex singleton (constructed above with
// `executeTool` bound to tools-bridge) is the SOLE production Codex
// runtime instance. `codex.ts` no longer exports a module-level
// singleton (Slice 2.6); any direct construction is via the
// `createCodexRuntime` factory (tests) or `new CodexAgentRuntime(opts)`.
export { codexRuntime };
// H2 codex-cli warm-daemon singleton — the sole production InteractiveCodexRuntime
// instance (constructed above). Exported for parity with the claude/codex/claude-cli
// singletons and for the server.ts graceful-shutdown hook.
export { codexCliRuntime };
export { InteractiveCodexRuntime, CODEX_CLI_CAPABILITIES } from './codex-daemon.js';
export { codexSupervisor } from './codex-supervisor.js';
export { ClaudeAgentRuntime, CLAUDE_CAPABILITIES } from './claude-sdk.js';
export { ApiRouterRuntime } from './api-router.js';
export {
  CodexAgentRuntime,
  CODEX_CAPABILITIES,
  createCodexRuntime,
  isCodexAuthed,
} from './codex.js';
export { isOllamaEnabled };
export type { ClaudeRuntimeDispatchInput } from './claude-sdk.js';
export type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentTurnInput,
  NormalizedMessage,
  NormalizedImage,
  ToolDefinition,
  ThreadHandle,
  CapabilityKey,
  RuntimeSystemPrompt,
} from './types.js';
