// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The Archivist's Claude lane.
 *
 * Built for one job only and deliberately NOT in the model picker: the
 * Archivist had been running on Codex Terra at xhigh, and Codex re-sends its
 * whole identity slab every turn by design — 24 Terra turns cost 4.35M input
 * tokens against 62.5k across 3,738 warm Opus 5 turns. When the Codex weekly
 * allowance is the scarce one, that is the wrong meter to be sweeping on.
 *
 * ONE HONEST DISAGREEMENT IS RECORDED HERE RATHER THAN RESOLVED. The comment
 * in memory-extraction.ts and the one in silence-check.ts both say a Claude
 * path outside the warm CLI lane bills metered API credits. Newer information
 * says the Agent SDK rides the subscription, at least for now, so this exists —
 * but it reports what the SDK says each run cost, and runMemoryExtraction reads
 * the owner's Claude usage before and after the first sweep. The question is answered
 * by a measurement, not by whoever wrote the older comment.
 *
 * No tools, no MCP servers, one turn, a neutral working directory. This lane
 * reads a conversation and returns JSON; it has no business touching the disk.

 * Ported from Aerie. byte-light adaptation: `tools: []` added (see below).
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { tmpdir } from 'node:os';

export interface SdkExtraction {
  text: string;
  /** What the SDK reported this turn cost, when it reported anything. */
  costUsd: number | null;
  /** Raw usage block from the SDK's result message, for the log. */
  usage: Record<string, unknown> | null;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The lane's options, apart so a test can read them.
 *
 * DISABLE_AUTO_COMPACT: the SDK runs its own bundled CLI, which can be older
 * than the model it is asked to run, and a CLI that does not know a model
 * judges its window too small. The memory blocks plus the conversation can sit
 * right at that edge, and a run that compacts squashes its whole reading pile
 * to a short summary before reading a word, then proposes memories from the
 * summary. A one-turn reading job must never compact what it was handed: if
 * the pile is ever truly too long, the API refuses and the run fails where it
 * can be seen.
 */
export function archivistSdkOptions(model: string, systemPrompt: string, abortController: AbortController): Options {
  return {
    model,
    systemPrompt,
    cwd: tmpdir(),
    permissionMode: 'bypassPermissions',
    maxTurns: 1,
    // A text job. Handing it tools is how a memory sweep ends up editing files.
    // byte-light adaptation: `tools: []` removes the built-in tools outright.
    // `allowedTools` is only an auto-approve list, and with bypassPermissions
    // an empty one would not stop a tool call; byte-light's previous Archivist
    // passed `tools: []` and this keeps that guarantee.
    tools: [],
    allowedTools: [],
    mcpServers: {},
    thinking: { type: 'disabled' },
    env: { ...process.env, DISABLE_AUTO_COMPACT: '1' },
    abortController,
  };
}

export async function extractViaClaudeSdk(
  systemPrompt: string,
  prompt: string,
  model: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SdkExtraction> {
  const started = Date.now();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  const options = archivistSdkOptions(model, systemPrompt, abortController);

  let text = '';
  let costUsd: number | null = null;
  let usage: Record<string, unknown> | null = null;

  try {
    for await (const message of query({ prompt, options })) {
      if (!message || typeof message !== 'object' || !('type' in message)) continue;
      const type = (message as { type: string }).type;

      if (type === 'assistant') {
        const content = (message as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
              text += (block as { text?: string }).text ?? '';
            }
          }
        }
      }

      // The final result message is the only place the SDK says what it spent.
      if (type === 'result') {
        const result = message as { total_cost_usd?: number; usage?: Record<string, unknown> };
        costUsd = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
        usage = result.usage ?? null;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (!text.trim()) {
    throw new Error('Claude SDK lane returned no text');
  }

  return { text, costUsd, usage, durationMs: Date.now() - started };
}
