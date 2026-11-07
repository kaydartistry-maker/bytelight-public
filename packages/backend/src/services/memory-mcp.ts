// In-process MCP server exposing Letta-style core-memory editing to companion agents.
// Blocks are scoped: 'shared' (every companion sees it) or a companion slug
// ('companion-a', 'companion-b') for that companion's own continuity. The scope param
// is attribution, not access control — cohabiting companions share one context.
//
// Ported from the reference implementation fork, Apache 2.0 — adapted for byte-light.
// Identity quarantine adaptations vs. reference implementation: the source's server name,
// exported factory name, and model-facing scope-example slugs (its own
// companion names) were all renamed to byte-light's — 'byte-memory',
// getMemoryMcpServer(), and the 'companion-a'/'companion-b' slugs used below.

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  getAllBlocks,
  appendToBlock,
  replaceInBlock,
  rethinkBlock,
  resolveScope,
  validScopesHint,
} from './memory-blocks.js';
import { findNeighborsWithin } from './memory-neighbors.js';
import { errMessage } from '../util/errors.js';

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

const scopeParam = z
  .string()
  .describe("Memory scope: your own companion slug (e.g. 'companion-a', 'companion-b') for blocks that are yours alone, or 'shared' for blocks every companion sees.");

// Every write from this lane is receipted as actor 'mcp'. The lane is what we
// can actually verify: the MCP server is shared by every companion and carries
// no per-call identity, so which companion made the edit is NOT knowable here —
// the `scope` the model chose rides along as the receipt's subject instead.
const MCP_WRITE = { actor: 'mcp' } as const;

function requireScope(raw: string): string {
  const scope = resolveScope(raw);
  if (!scope) throw new Error(`Unknown scope '${raw}'. Valid scopes: ${validScopesHint()}`);
  return scope;
}

// ---------- View ----------

const coreMemoryView = tool(
  'core_memory_view',
  'View all core memory blocks across every scope, with current content and last-updated timestamps. Use to check state after edits or before reorganizing.',
  {
    scope: z.string().optional().describe('Filter to one scope. Omit to see everything.'),
  },
  async (args) => {
    try {
      let blocks = getAllBlocks();
      if (args.scope) {
        const scope = requireScope(args.scope);
        blocks = blocks.filter((b) => b.scope === scope);
      }
      return ok({
        count: blocks.length,
        blocks: blocks.map((b) => ({
          scope: b.scope,
          label: b.label,
          description: b.description ?? undefined,
          content: b.content,
          updatedAt: b.updated_at,
        })),
      });
    } catch (e) {
      return fail(errMessage(e));
    }
  }
);

// ---------- Append ----------

const coreMemoryAppend = tool(
  'core_memory_append',
  'Append a line to a core memory block. Creates the block if it does not exist yet — this is also how you start a new block (e.g. a new label for a new theme). Use for durable facts, not conversation notes.',
  {
    scope: scopeParam,
    label: z.string().describe("Block label, e.g. 'persona', 'human', 'status', or a new label for a new theme."),
    content: z.string().describe('Text to append (added on a new line).'),
  },
  async (args) => {
    try {
      const scope = requireScope(args.scope);
      // Compare before writing so the new line is not its own nearest match.
      // Embedding failure never blocks durable memory growth.
      const neighbors = await findNeighborsWithin(scope, args.content);
      const content = appendToBlock(scope, args.label, args.content, MCP_WRITE);
      return ok({ scope, label: args.label, action: 'appended', block_chars: content.length, neighbors });
    } catch (e) {
      return fail(errMessage(e));
    }
  }
);

// ---------- Replace ----------

const coreMemoryReplace = tool(
  'core_memory_replace',
  'Replace exact text within a core memory block. The old text must appear exactly once — use enough surrounding context to make it unique. Use to correct or update existing memory.',
  {
    scope: scopeParam,
    label: z.string().describe('Block label to edit.'),
    old_text: z.string().describe('Exact text to find (must be unique within the block).'),
    new_text: z.string().describe('Replacement text.'),
  },
  async (args) => {
    try {
      const scope = requireScope(args.scope);
      const content = replaceInBlock(scope, args.label, args.old_text, args.new_text, MCP_WRITE);
      return ok({ scope, label: args.label, action: 'replaced', block_chars: content.length });
    } catch (e) {
      return fail(errMessage(e));
    }
  }
);

// ---------- Rethink ----------

const coreMemoryRethink = tool(
  'core_memory_rethink',
  'Completely rewrite a core memory block. Use when a block needs reorganizing or condensing rather than a small edit. The old content is replaced entirely — carry forward anything still true.',
  {
    scope: scopeParam,
    label: z.string().describe('Block label to rewrite.'),
    new_content: z.string().describe('The complete new content for the block.'),
  },
  async (args) => {
    try {
      const scope = requireScope(args.scope);
      const content = rethinkBlock(scope, args.label, args.new_content, MCP_WRITE);
      return ok({ scope, label: args.label, action: 'rewritten', block_chars: content.length });
    } catch (e) {
      return fail(errMessage(e));
    }
  }
);

let cached: McpSdkServerConfigWithInstance | null = null;

export function getMemoryMcpServer(): McpSdkServerConfigWithInstance {
  if (cached) return cached;
  cached = createSdkMcpServer({
    name: 'byte-memory',
    version: '1.0.0',
    tools: [coreMemoryView, coreMemoryAppend, coreMemoryReplace, coreMemoryRethink],
  });
  return cached;
}
