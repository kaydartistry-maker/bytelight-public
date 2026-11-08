/**
 * buildAgentTurnInput — Slice 2 extraction of the AgentTurnInput
 * construction seam from agent.ts (formerly inline at lines 1065-1083,
 * non-Claude branch only).
 *
 * Takes pre-resolved per-turn inputs and returns the typed AgentTurnInput
 * the runtime's `runTurn` consumes. Pure function: no I/O, no module-level
 * state, no imports from agent.ts (avoids cycles when the call site
 * imports from here).
 *
 * Behavior preservation (extraction, not correction):
 *   - platform: nullish → 'internal'; valid union members and unknown
 *     strings both pass through. Matches the current
 *     `(platform as 'web' | 'discord' | 'telegram' | 'api') ?? 'internal'`
 *     cast-at-runtime semantic — TS cast is a no-op at runtime, so
 *     unknown strings flow through.
 *   - orientation: nullish → ''.
 *   - systemPromptText: nullish → ''; wrapped as { kind: 'text', value }.
 *   - thread: only id, name, type, current_session_id are pulled from the
 *     input ThreadHandle (matches the inline literal that picks these
 *     four fields by hand).
 *   - handoff, cwd, abortSignal, thinkingEffort: keys ALWAYS present in
 *     the output object, values pass through verbatim (including
 *     undefined). Matches the current object-literal shape — dropping
 *     undefined keys would be a behavior change.
 *   - modelRef: held opaque. The documented `[1m]` Claude Code
 *     1M-context variant suffix flows through verbatim — no strip, no
 *     normalize, no reinterpret.
 *
 * Tools (H1 "hands"): the `tools` field is now an OPTIONAL passthrough.
 * When the foreign-lane call site resolves the MCP tool surface
 * (getRouterTools → ToolDefinition[]) it passes it here and we emit it
 * verbatim; when omitted the field stays undefined and the model is
 * offered no tools, exactly as before. Populating it is the caller's
 * job (foreign path only) — this helper just forwards.
 *
 * Not in scope:
 *   - getMessages DB read + role mapping (stays at agent.ts call site).
 *   - Handoff attach-log (console.log side effect — stays at call site).
 *   - Claude SDK branch (Step 4+ unification territory).
 *   - sessionId field (still set at the call site post-build from the
 *     resume sidecar — not populated by this helper).
 */

import type {
  AgentTurnInput,
} from '../runtimes/types.js';

export interface BuildAgentTurnInputParams {
  thread: AgentTurnInput['thread'];
  tier: AgentTurnInput['tier'];
  modelRef: AgentTurnInput['modelRef'];
  platform?: AgentTurnInput['platform'] | string | null;
  isAutonomous: boolean;
  orientation?: string | null;
  systemPromptText?: string | null;
  messages: AgentTurnInput['messages'];
  cwd?: string;
  abortSignal?: AbortSignal;
  thinkingEffort?: AgentTurnInput['thinkingEffort'];
  /** Optional tool surface offered to the runtime. Foreign lanes pass
   *  the resolved MCP tools here (H1); omitted → tool-less turn. */
  tools?: AgentTurnInput['tools'];
}

export function buildAgentTurnInput(
  params: BuildAgentTurnInputParams,
): AgentTurnInput {
  return {
    thread: {
      id: params.thread.id,
      name: params.thread.name,
      type: params.thread.type,
      current_session_id: params.thread.current_session_id,
    },
    tier: params.tier,
    modelRef: params.modelRef,
    platform: (params.platform as AgentTurnInput['platform']) ?? 'internal',
    isAutonomous: params.isAutonomous,
    orientation: params.orientation ?? '',
    systemPrompt: { kind: 'text', value: params.systemPromptText ?? '' },
    messages: params.messages,
    cwd: params.cwd,
    abortSignal: params.abortSignal,
    thinkingEffort: params.thinkingEffort,
    tools: params.tools,
  };
}
