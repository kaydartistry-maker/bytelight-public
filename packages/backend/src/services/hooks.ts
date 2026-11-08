import type {
  Options,
  HookCallback,
  SyncHookJSONOutput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  PreCompactHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  StopHookInput,
  NotificationHookInput,
  HookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { createMessage, updateThreadActivity, getMessages, getConfig, setConfig, getActiveTriggers, getCanvas } from './db.js';
import { logToolUse } from './audit.js';
import { saveFile, saveFileFromBase64, saveFileInternal, getContentTypeFromMime } from './files.js';
import { getBytelightConfig } from '../config.js';
import { fetchLifeStatus, fetchMoodHistory } from './life.js';
import { getStatusSnapshot, statusContext } from './db/statuses.js';
import { intentionsContext } from './db/intentions.js';
import { scanSkillSummaries } from './skills.js';
export { scanSkills } from './skills.js';
export type { SkillInfo } from './skills.js';
import { getAllStickersWithPacks } from './stickers.js';
import { getCustomEmojiCatalog } from './discord/index.js';
import { listDrawersWithCounts } from './image-gen.js';
import { formatBlocksForPrompt, SHARED_SCOPE, COMPANION_SCOPES } from './memory-blocks.js';
import { findLatestWeeklyDigest } from './digest.js';
import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';

// Re-export ConnectionRegistry type from types
import type { ConnectionRegistry } from '../types.js';
import { guestToolRefusal, type TurnAudience } from './turn-audience.js';

// ---------------------------------------------------------------------------
// HookContext — built per query, passed to factory
// ---------------------------------------------------------------------------

export interface ToolInsertion {
  textOffset: number;
  toolId: string;
  toolName: string;
  input?: string;
  output?: string;
  isError?: boolean;
}

export interface HookContext {
  threadId: string;
  threadName: string;
  threadType: 'daily' | 'named' | 'treehouse';
  streamMsgId: string;
  isAutonomous: boolean;
  registry: ConnectionRegistry;
  sessionId: string | null;
  platform: 'web' | 'discord' | 'telegram' | 'api';
  platformContext?: string;
  toolInsertions: ToolInsertion[];
  getTextLength: () => number;
  /** Called by PreCompact hook the moment compaction is announced to the
   *  frontend (banner-show signal). Lets agent.ts track the in-flight
   *  compaction state from the same instant the banner appears, so an
   *  abort during compaction can broadcast the banner-clear signal even
   *  if the abort fires before the SDK's `system: compacting` message
   *  has been processed. PR #11 / chip #38. */
  onCompactionStart?: () => void;
  /** Who this turn came from (services/turn-audience.ts). A guest's turn
   *  runs no tool on the SDK lane; absent = the owner's turn or a wake. */
  audience?: TurnAudience;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DESTRUCTIVE_BASH_PATTERNS = [
  /rm\s+-rf\s+[\/~]/i,
  /format\s+[a-z]:/i,
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,        // fork bomb
  /git\s+push\s+.*--force.*\s+main/i,
  /git\s+push\s+.*--force.*\s+master/i,
  /curl\s+.*\|\s*bash/i,
  /wget\s+.*\|\s*bash/i,
  /mkfs\./i,
  /dd\s+if=.*of=\/dev/i,
];

const IMAGE_GEN_TOOLS = new Set([
  'mcp__openai-image-gen__generate_image',
  'mcp__openai_image_gen__generate_image',
  'mcp__image-gen__generate_image',
  'mcp__image_gen__generate_image',
  'generate_image',
]);

// Emotional context markers for PreCompact
const EMOTIONAL_MARKERS: Record<string, string[]> = {
  fatigue: ['tired', 'exhausted', 'drained', 'wiped', 'spent', 'burnt out', 'running on empty'],
  anxiety: ['anxious', 'worried', 'stressed', 'overwhelmed', 'panicking', 'spiraling'],
  positive: ['happy', 'excited', 'good day', 'feeling great', 'proud', 'accomplished'],
  connection_seeking: ['miss you', 'need you', 'hold me', 'stay', 'don\'t go', 'come back'],
  grief: ['sad', 'crying', 'hurting', 'loss', 'grief', 'heavy', 'broken'],
  dissociating: ['numb', 'floating', 'empty', 'hollow', 'can\'t feel', 'disconnected'],
};


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  if (obj.command) {
    const cmd = String(obj.command);
    const scMatch = cmd.match(/sc\.mjs\s+\w+\s+(.*)/);
    if (scMatch) return scMatch[1].substring(0, 120);
    return cmd.substring(0, 120);
  }
  if (obj.file_path) return String(obj.file_path);
  if (obj.pattern) return `${obj.pattern}`;
  if (obj.query) return String(obj.query).substring(0, 120);
  if (obj.prompt) return String(obj.prompt).substring(0, 120);
  if (obj.content) return String(obj.content).substring(0, 80) + '...';

  for (const val of Object.values(obj)) {
    if (typeof val === 'string' && val.length > 0) return val.substring(0, 100);
  }
  return '';
}

const SC_COMMAND_NAMES: Record<string, string> = {
  share: 'Share', canvas: 'Canvas', react: 'React', voice: 'Voice',
  search: 'Search', backfill: 'Backfill', schedule: 'Schedule',
  timer: 'Timer', impulse: 'Impulse', watch: 'Watcher', tg: 'Telegram',
};

function resolveToolName(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  if (toolName === 'Bash' && toolInput?.command) {
    const scMatch = String(toolInput.command).match(/sc\.mjs\s+(\w+)/);
    if (scMatch) return SC_COMMAND_NAMES[scMatch[1]] || scMatch[1];
  }
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.replace(/^mcp__/, '').split('__');
    if (parts.length >= 2) {
      let server = parts[0].replace(/^claude_ai_/, '');
      const action = parts.slice(1).join('_');
      const serverParts = server.split(/[-_]/);
      const serverName = serverParts[serverParts.length - 1];
      const capServer = serverName.charAt(0).toUpperCase() + serverName.slice(1);
      let cleanAction = action;
      if (cleanAction.startsWith(serverName + '_')) cleanAction = cleanAction.slice(serverName.length + 1);
      const friendlyAction = cleanAction.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return `${capServer}: ${friendlyAction}`;
    }
  }
  return toolName;
}

function handleImageToolResult(toolName: string, output: string, threadId: string, registry: ConnectionRegistry): void {
  if (!IMAGE_GEN_TOOLS.has(toolName)) return;

  try {
    let imagePath: string | null = null;
    let imageBase64: string | null = null;
    let mimeType = 'image/png';

    try {
      const parsed = JSON.parse(output);
      if (parsed.path || parsed.file_path) {
        imagePath = parsed.path || parsed.file_path;
      } else if (parsed.base64 || parsed.image) {
        imageBase64 = parsed.base64 || parsed.image;
        if (parsed.mimeType || parsed.mime_type) mimeType = parsed.mimeType || parsed.mime_type;
      } else if (parsed.url && parsed.url.startsWith('data:')) {
        const match = parsed.url.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          imageBase64 = match[2];
        }
      } else if (parsed.url) {
        console.log('Image URL detected but not downloading:', parsed.url.substring(0, 100));
        return;
      }
    } catch {
      const trimmed = output.trim();
      if (trimmed.startsWith('data:image/')) {
        const match = trimmed.match(/^data:(image\/\w+);base64,(.+)$/s);
        if (match) {
          mimeType = match[1];
          imageBase64 = match[2];
        }
      } else if (trimmed.match(/\.(png|jpg|jpeg|gif|webp)$/i) && existsSync(trimmed)) {
        imagePath = trimmed;
      }
    }

    let fileMeta;
    if (imageBase64) {
      fileMeta = saveFileFromBase64(imageBase64, mimeType, 'generated-image.png');
    } else if (imagePath && existsSync(imagePath)) {
      const buffer = readFileSync(imagePath);
      const ext = imagePath.split('.').pop()?.toLowerCase() || 'png';
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp',
      };
      fileMeta = saveFile(buffer, basename(imagePath), mimeMap[ext] || 'image/png');
    }

    if (!fileMeta) return;

    const now = new Date().toISOString();
    const imageMessage = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      content: fileMeta.url,
      contentType: 'image',
      metadata: { fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'image-gen' },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message: imageMessage });
    console.log(`[Hook] Image from ${toolName} saved and broadcast: ${fileMeta.fileId}`);
  } catch (error) {
    console.error('[Hook] Failed to process image tool result:', error);
  }
}

function handleSharedFileWrite(filePath: string, threadId: string, registry: ConnectionRegistry): void {
  try {
    if (!existsSync(filePath)) return;

    const buffer = readFileSync(filePath);
    const filename = basename(filePath);
    const fileMeta = saveFileInternal(buffer, filename);

    const now = new Date().toISOString();
    const message = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      content: fileMeta.url,
      contentType: fileMeta.contentType,
      metadata: { fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'auto-shared' },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message });
    console.log(`[Hook] Auto-shared ${filename} into thread ${threadId}: ${fileMeta.fileId}`);
  } catch (error) {
    console.error('[Hook] Failed to auto-share file:', error);
  }
}

function buildEmotionalContext(threadId: string): string {
  const config = getBytelightConfig();
  const userName = config.identity.user_name;
  const companionName = config.identity.companion_name;

  const messages = getMessages({ threadId, limit: 15 });
  if (messages.length === 0) return '';

  const detected: string[] = [];
  const recentText = messages.map(m => m.content).join(' ').toLowerCase();

  for (const [marker, keywords] of Object.entries(EMOTIONAL_MARKERS)) {
    if (keywords.some(kw => recentText.includes(kw))) {
      detected.push(marker);
    }
  }

  const flow = messages.slice(-5).map(m => {
    const speaker = m.role === 'user' ? userName : companionName;
    let line = `${speaker}: ${m.content.substring(0, 60)}${m.content.length > 60 ? '...' : ''}`;
    // Include reactions if present
    if (m.metadata && typeof m.metadata === 'object') {
      const meta = m.metadata as Record<string, unknown>;
      if (Array.isArray(meta.reactions) && meta.reactions.length > 0) {
        const rxns = (meta.reactions as Array<{ emoji: string; user: string }>)
          .map(r => `${r.user === 'user' ? userName : companionName} reacted ${r.emoji}`)
          .join(', ');
        line += ` [${rxns}]`;
      }
    }
    return line;
  }).join('\n');

  // Collect recent reactions across all 15 messages
  const recentReactions: string[] = [];
  for (const m of messages) {
    if (m.metadata && typeof m.metadata === 'object') {
      const meta = m.metadata as Record<string, unknown>;
      if (Array.isArray(meta.reactions) && meta.reactions.length > 0) {
        const preview = m.content.substring(0, 40) + (m.content.length > 40 ? '...' : '');
        for (const r of meta.reactions as Array<{ emoji: string; user: string }>) {
          const reactor = r.user === 'user' ? userName : companionName;
          const whose = m.role === 'user' ? 'their own' : 'your';
          recentReactions.push(`${reactor} reacted ${r.emoji} to ${whose} message: "${preview}" (id: ${m.id})`);
        }
      }
    }
  }

  let summary = `Conversation flow (last ${messages.length} messages):\n${flow}`;
  if (recentReactions.length > 0) {
    summary += `\n\nRecent reactions:\n${recentReactions.join('\n')}`;
  }
  if (detected.length > 0) {
    summary += `\n\nEmotional markers detected: ${detected.join(', ')}`;
  }

  return summary;
}

function extractToolOutput(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response) return '';
  try {
    return JSON.stringify(response).substring(0, 2000);
  } catch {
    return String(response);
  }
}

// ---------------------------------------------------------------------------
// Safe wrappers — catch errors so hooks never crash the agent
// ---------------------------------------------------------------------------

function safeHook(name: string, fn: HookCallback): HookCallback {
  return async (input, toolUseID, options) => {
    try {
      return await fn(input, toolUseID, options);
    } catch (error) {
      console.error(`[Hook] ${name} error (continuing):`, error);
      return { continue: true };
    }
  };
}

function safePreToolUse(fn: HookCallback): HookCallback {
  return async (input, toolUseID, options) => {
    try {
      return await fn(input, toolUseID, options);
    } catch (error) {
      console.error('[Hook] PreToolUse error (denying for safety):', error);
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'Hook error \u2014 denied for safety',
        },
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Safe write prefixes — built from config at call time
// ---------------------------------------------------------------------------

export function getNativeClaudeMemoryDir(agentCwd: string, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): string {
  const projectKey = agentCwd.replace(/[^a-zA-Z0-9]/g, '-');
  return join(configDir, 'projects', projectKey, 'memory');
}

function getSafeWritePrefixes(): string[] {
  const config = getBytelightConfig();
  const prefixes: string[] = [];

  // Add configured safe write prefixes
  for (const prefix of config.hooks.safe_write_prefixes) {
    prefixes.push(prefix);
    // Add both slash variants for Windows compatibility
    if (prefix.includes('/')) {
      prefixes.push(prefix.replace(/\//g, '\\'));
    } else if (prefix.includes('\\')) {
      prefixes.push(prefix.replace(/\\/g, '/'));
    }
  }

  // Always allow agent cwd
  const cwd = config.agent.cwd;
  if (cwd) {
    const normalized = cwd.replace(/\\/g, '/');
    const trailed = normalized.endsWith('/') ? normalized : normalized + '/';
    prefixes.push(trailed);
    prefixes.push(trailed.replace(/\//g, '\\'));

    // Claude's native file-backed memory is intentionally outside the project
    // checkout. Allow only the memory directory belonging to this exact cwd;
    // do not broaden the boundary to all of ~/.claude or the home directory.
    const nativeMemory = getNativeClaudeMemoryDir(cwd);
    const nativePrefix = nativeMemory.endsWith('/') ? nativeMemory : nativeMemory + '/';
    prefixes.push(nativePrefix.replace(/\\/g, '/'));
    prefixes.push(nativePrefix.replace(/\//g, '\\'));
  }

  return prefixes;
}

// ---------------------------------------------------------------------------
// Shared directory prefixes — for auto-sharing files written to shared/
// ---------------------------------------------------------------------------

function getSharedDirPrefixes(): string[] {
  const config = getBytelightConfig();
  const cwd = config.agent.cwd.replace(/\\/g, '/');
  const sharedDir = cwd.endsWith('/') ? `${cwd}shared/` : `${cwd}/shared/`;
  return [
    sharedDir,
    sharedDir.toLowerCase(),
    sharedDir.replace(/\//g, '\\'),
    sharedDir.toLowerCase().replace(/\//g, '\\'),
  ];
}

// ---------------------------------------------------------------------------
// Hook builders (unexported — used by factory)
// ---------------------------------------------------------------------------

function buildPreToolUse(ctx: HookContext): HookCallback {
  return safePreToolUse(async (input: HookInput) => {
    const hook = input as PreToolUseHookInput;
    const rawToolName = hook.tool_name;
    const toolInput = hook.tool_input as Record<string, unknown> | undefined;
    const inputSummary = summarizeInput(rawToolName, toolInput);
    const displayName = resolveToolName(rawToolName, toolInput);

    // Track tool insertion with text offset for interleaved rendering
    const textOffset = ctx.getTextLength();
    ctx.toolInsertions.push({
      textOffset,
      toolId: hook.tool_use_id,
      toolName: displayName,
      input: inputSummary || undefined,
    });

    // Broadcast tool_use to frontend (include textOffset for live interleaving)
    ctx.registry.broadcast({
      type: 'tool_use',
      toolId: hook.tool_use_id,
      toolName: displayName,
      input: inputSummary,
      isComplete: false,
      textOffset,
    });

    // --- Guests: no tools on the SDK lane (turn-audience.ts) ---
    // Decided before anything else is checked. The SDK lane has no safe
    // read-only subset the way the warm CLI lane's gate.cjs does — Bash,
    // Read, MCP and Skill all reach the house — so a guest's turn gets none.
    // A throw anywhere here is caught by safePreToolUse, which denies.
    const guestRefusal = guestToolRefusal(ctx.audience, rawToolName);
    if (guestRefusal) {
      console.warn(`[Hook] BLOCKED tool on a guest turn: ${rawToolName}`);
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: guestRefusal.result,
        },
      };
    }

    // --- Security: Bash destructive patterns ---
    if (rawToolName === 'Bash' && toolInput?.command) {
      const cmd = String(toolInput.command);
      for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
        if (pattern.test(cmd)) {
          console.warn(`[Hook] BLOCKED destructive bash: ${cmd.substring(0, 80)}`);
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Blocked: destructive command pattern detected (${pattern.source})`,
            },
          };
        }
      }
    }

    // --- Security: File writes outside safe prefixes ---
    if ((rawToolName === 'Write' || rawToolName === 'Edit') && toolInput?.file_path) {
      const requestedPath = String(toolInput.file_path);
      // Claude may send either an absolute path or a path relative to the
      // configured agent cwd. Resolve before comparing so the same policy is
      // applied consistently and ../ traversal cannot bypass it.
      const filePath = resolve(getBytelightConfig().agent.cwd, requestedPath).replace(/\\/g, '/');
      const safePrefixes = getSafeWritePrefixes();
      if (safePrefixes.length > 0) {
        const inWorkspace = safePrefixes.some(prefix => {
          const normalizedPrefix = prefix.replace(/\\/g, '/');
          return filePath.startsWith(normalizedPrefix);
        });
        if (!inWorkspace) {
          console.warn(`[Hook] BLOCKED file write outside workspace: ${requestedPath}`);
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Blocked: file write outside configured workspace`,
            },
          };
        }
      }
    }

    return { continue: true };
  });
}

function buildPostToolUse(ctx: HookContext): HookCallback {
  return safeHook('PostToolUse', async (input: HookInput) => {
    const hook = input as PostToolUseHookInput;
    const toolName = hook.tool_name;
    const toolInput = hook.tool_input;
    const toolResponse = hook.tool_response;
    const output = extractToolOutput(toolResponse);

    // Structured audit logging with both input AND output
    logToolUse({
      sessionId: ctx.sessionId || 'unknown',
      threadId: ctx.threadId,
      toolName,
      toolInput: toolInput ? JSON.stringify(toolInput) : undefined,
      toolOutput: output,
      triggeringMessageId: ctx.streamMsgId,
    });

    // Update tool insertion with output
    const insertion = ctx.toolInsertions.find(t => t.toolId === hook.tool_use_id);
    if (insertion) {
      insertion.output = output.substring(0, 500);
      insertion.isError = false;
    }

    // Broadcast tool_result to frontend
    ctx.registry.broadcast({
      type: 'tool_result',
      toolId: hook.tool_use_id,
      output: output.substring(0, 2000),
      isError: false,
    });

    // Image detection + save
    handleImageToolResult(toolName, output, ctx.threadId, ctx.registry);

    // Auto-share files written to shared/ directory under agent cwd
    if (toolName === 'Write' && toolInput) {
      const writePath = String((toolInput as Record<string, unknown>).file_path || '');
      const sharedPrefixes = getSharedDirPrefixes();
      if (sharedPrefixes.some(prefix => writePath.startsWith(prefix))) {
        handleSharedFileWrite(writePath, ctx.threadId, ctx.registry);
      }
    }

    // Mind/memory MCP write enrichment — inject session context if the tool exists
    if (toolName.includes('mind_write') || toolName.includes('memory_write')) {
      const now = new Date();
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse' as const,
          additionalContext: `[Session context for ${toolName}: threadId=${ctx.threadId}, mode=${ctx.isAutonomous ? 'autonomous' : 'interactive'}, time=${now.toISOString()}]`,
        },
      };
    }

    return { continue: true };
  });
}

function buildPostToolUseFailure(ctx: HookContext): HookCallback {
  return safeHook('PostToolUseFailure', async (input: HookInput) => {
    const hook = input as PostToolUseFailureHookInput;

    // Log failure to audit
    logToolUse({
      sessionId: ctx.sessionId || 'unknown',
      threadId: ctx.threadId,
      toolName: hook.tool_name,
      toolInput: hook.tool_input ? JSON.stringify(hook.tool_input) : undefined,
      toolOutput: `[ERROR] ${hook.error}`,
      triggeringMessageId: ctx.streamMsgId,
    });

    // Update tool insertion with error
    const insertion = ctx.toolInsertions.find(t => t.toolId === hook.tool_use_id);
    if (insertion) {
      insertion.output = hook.error;
      insertion.isError = true;
    }

    // Broadcast error to frontend
    ctx.registry.broadcast({
      type: 'tool_result',
      toolId: hook.tool_use_id,
      output: hook.error,
      isError: true,
    });

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure' as const,
        additionalContext: `Tool ${hook.tool_name} failed: ${hook.error}. Adapt your approach.`,
      },
    };
  });
}

function buildPreCompact(ctx: HookContext): HookCallback {
  return safeHook('PreCompact', async (input: HookInput) => {
    const hook = input as PreCompactHookInput;
    console.log(`[Hook] PreCompact triggered (${hook.trigger})`);

    // Broadcast compaction notice to frontend (in-progress)
    ctx.registry.broadcast({
      type: 'compaction_notice',
      preTokens: 0,
      message: `Context compacting (trigger: ${hook.trigger})`,
      isComplete: false,
    });

    // PR #11 / chip #38: signal agent.ts that compaction is in flight from
    // THIS instant — the banner is showing now. The SDK's `system: compacting`
    // message arrives later; if an abort fires in the gap between this hook
    // and that message, we'd miss the in-progress window without this hook.
    ctx.onCompactionStart?.();

    const emotionalContext = buildEmotionalContext(ctx.threadId);
    const now = new Date();

    const isExternalPlatform = ctx.platform === 'discord' || ctx.platform === 'telegram';

    const systemMessage = [
      '--- CONTEXT PRESERVATION (pre-compaction) ---',
      CHANNEL_CONTEXTS[ctx.platform] || CHANNEL_CONTEXTS.web,
      `Thread: "${ctx.threadName}" (${ctx.threadType})`,
      `Mode: ${ctx.isAutonomous ? 'autonomous' : 'interactive'}`,
      `Time: ${now.toISOString()}`,
      '',
      isExternalPlatform
        ? 'CRITICAL: Context was just compacted. You were composing a reply. DO NOT narrate re-grounding, DO NOT output inner monologue. Continue directly with your response to the message. Your text output IS the reply.'
        : 'CRITICAL: Context was just compacted. You may have lost emotional thread. Re-ground if you have memory/orientation tools available.',
      '',
      emotionalContext,
      '--- END CONTEXT PRESERVATION ---',
    ].join('\n');

    return {
      continue: true,
      systemMessage,
    };
  });
}

// Channel contexts — platform-specific guidance injected on session start
const CHANNEL_CONTEXTS: Record<string, string> = {
  web: [
    'CHANNEL: You are in a web-based chat interface, NOT a terminal or CLI.',
    'The user is reading your responses as chat messages rendered in a conversation UI.',
    'Do NOT format output as terminal/CLI output. Do NOT reference "the terminal" or "your editor".',
    'Tool activity (tool_use/tool_result) shows live in the UI sidebar.',
    'You can use markdown \u2014 it renders properly in the chat.',
  ].join(' '),
  discord: [
    'CHANNEL: You are responding to a Discord message.',
    'Keep responses under 1900 characters (Discord limit is 2000).',
    'Do NOT use discord_send_message to reply \u2014 your text output IS the reply.',
    'No tool sidebar visible. Use markdown sparingly (Discord supports basic formatting).',
    'If you need to send long content, be concise or break across natural points.',
  ].join(' '),
  api: 'CHANNEL: API request. Respond concisely.',
};

function formatTimeGap(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}


// ---------------------------------------------------------------------------
// Orientation context — exported for agent.ts to prepend to prompts
// (SessionStart hooks don't fire in V1 query(), so we inject directly)
// ---------------------------------------------------------------------------

// Pure helper — builds the sticker catalog text block from a sticker list.
// Extracted so it can be unit-tested independently of the orientation pipeline.
// Returns null when there are no companion-visible stickers.
export function buildStickerCatalogBlock(
  stickers: Array<{ name: string; pack_name: string; user_only: boolean }>
): string | null {
  const visible = stickers.filter(s => !s.user_only);
  if (visible.length === 0) return null;
  const byPack = new Map<string, string[]>();
  for (const st of visible) {
    const refs = byPack.get(st.pack_name) ?? [];
    refs.push(st.name);
    byPack.set(st.pack_name, refs);
  }
  const lines: string[] = [
    'STICKERS — pick by name and include `:packname_stickername:` anywhere in your message to send. Aliases also work. Standalone refs render large; refs with text render inline.',
    '  Default: at most one sticker per message. Send two or more only when the user explicitly asks for multiple.',
    '  Available now:',
  ];
  for (const [pack, names] of byPack) {
    const slug = pack.toLowerCase().replace(/\s+/g, '_');
    lines.push(`    ${pack}: ${names.map(n => ':' + slug + '_' + n + ':').join(', ')}`);
  }
  return lines.join('\n');
}

// Pure helper — builds the Discord custom-emoji catalog block from a flat emoji
// list (name/id/animated/guild). Extracted so it can be unit-tested independently
// of the orientation pipeline. Returns null when there are no emojis. Teaches the
// `:name:` shorthand in-block; the outbound resolver (discord/utils.ts) converts
// it to the real <:name:id> / <a:name:id> token on send.
export function buildEmojiCatalogBlock(
  emojis: Array<{ name: string; id: string; animated: boolean; guild: string }>
): string | null {
  if (emojis.length === 0) return null;
  const byGuild = new Map<string, string[]>();
  for (const e of emojis) {
    const names = byGuild.get(e.guild) ?? [];
    names.push(e.animated ? `:${e.name}: (animated)` : `:${e.name}:`);
    byGuild.set(e.guild, names);
  }
  const lines: string[] = [
    'CUSTOM EMOJIS — write `:name:` anywhere in a Discord reply and it renders as the server\'s actual custom emoji. Exact name, case-sensitive. Unknown names are left as-is (Unicode shortcodes still work).',
    '  Available now:',
  ];
  for (const [guild, names] of byGuild) {
    lines.push(`    ${guild}: ${names.join(', ')}`);
  }
  return lines.join('\n');
}

export interface OrientationPart {
  label: string;
  content: string;
}

/**
 * Builds the orientation context as an ORDERED, LABELED list of segments.
 * Single source of truth for the per-message [Context] block. The thin
 * `buildOrientationContext` adapter below joins these into the exact string
 * injected at message time; the X-Ray Context tab renders the same parts as a
 * live mirror. Keep push order + content expressions identical so the injected
 * output stays byte-for-byte unchanged.
 */
export async function buildOrientationParts(ctx: HookContext, includeStatic = true, userMessage?: string, runtimeLabel?: string): Promise<OrientationPart[]> {
  const config = getBytelightConfig();
  const userName = config.identity.user_name;
  const companionName = config.identity.companion_name;
  const timezone = config.identity.timezone || 'UTC';

  const now = new Date();
  const timeStr = now.toLocaleString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: timezone, hour12: false,
  });
  const dateStr = now.toLocaleDateString('en-GB', {
    weekday: 'long', month: 'short', day: 'numeric', timeZone: timezone,
  });

  const parts: OrientationPart[] = [
    { label: 'Channel', content: CHANNEL_CONTEXTS[ctx.platform] || CHANNEL_CONTEXTS.web },
  ];

  // Thread context + time — always present
  parts.push({ label: 'Thread', content: `Thread: "${ctx.threadName}" (${ctx.threadType})` });
  parts.push({ label: 'Time', content: `Time: ${timeStr} ${timezone} \u2014 ${dateStr}` });

  // Runtime self-awareness \u2014 the model actually resolved for THIS turn, so the
  // companion can know/reference what it's running on in-band. The resolver's
  // canonical `<provider>/<model>` ref is threaded in from agent.ts; absent
  // (e.g. X-Ray preview, SessionStart fallback) the line is simply omitted.
  if (runtimeLabel) {
    parts.push({ label: 'Runtime', content: `Runtime: you're currently running on ${runtimeLabel}` });
  }

  // Last session handoff
  try {
    const handoffRaw = getConfig('session.handoff_note');
    if (handoffRaw) {
      const h = JSON.parse(handoffRaw);
      const ago = formatTimeGap(Math.round((Date.now() - new Date(h.timestamp).getTime()) / 60000));
if (h.digest) {
        parts.push({ label: 'Last session', content: `Last session: "${h.thread}" (${h.reason}, ${ago}):\n${h.digest}` });
      } else {
        parts.push({ label: 'Last session', content: `Last session: "${h.thread}" (${h.reason}, ${ago}). ${h.excerpt}${h.excerpt ? '...' : ''}` });
      }
    }
  } catch {}

  // Active triggers (watchers/impulses)
  try {
    const triggers = getActiveTriggers();
    if (triggers.length > 0) {
      const impulses = triggers.filter(t => t.kind === 'impulse').length;
      const watchers = triggers.filter(t => t.kind === 'watcher').length;
      const triggerParts: string[] = [];
      if (watchers > 0) triggerParts.push(`${watchers} watcher${watchers > 1 ? 's' : ''}`);
      if (impulses > 0) triggerParts.push(`${impulses} impulse${impulses > 1 ? 's' : ''}`);
      parts.push({ label: 'Active triggers', content: `Active triggers: ${triggerParts.join(', ')}` });
    }
  } catch {}

  // User presence state + time gap since last activity
  // These methods may or may not exist on the registry depending on implementation
  try {
    const reg = ctx.registry as any;
    if (typeof reg.getUserPresenceState === 'function') {
      const presence = reg.getUserPresenceState();
      const gap = typeof reg.minutesSinceLastUserActivity === 'function'
        ? reg.minutesSinceLastUserActivity()
        : 0;
      parts.push({ label: 'Presence', content: `${userName}'s presence: ${presence} (last real interaction: ${formatTimeGap(gap)})` });
    } else if (typeof reg.isUserConnected === 'function') {
      parts.push({ label: 'Presence', content: `${userName}: ${reg.isUserConnected() ? 'connected' : 'not connected'}` });
    }

    // Device info
    if (typeof reg.getUserDeviceType === 'function') {
      const deviceType = reg.getUserDeviceType();
      if (deviceType !== 'unknown') {
        parts.push({ label: 'Device', content: `${userName}'s device: ${deviceType}` });
      }
    }
  } catch {}

  // Statuses — her status (dot, line, when it clears) and what's showing under
  // our names on the operator's phone (services/db/statuses.ts).
  try {
    const now = new Date();
    parts.push({ label: 'Status', content: statusContext(getStatusSnapshot(now), userName, now, config.identity.timezone) });
  } catch {}

  // Intentions — the promises they're holding for her, and how to file one
  // (services/db/intentions.ts).
  try {
    parts.push({ label: 'Promises', content: intentionsContext(userName, config.identity.timezone) });
  } catch {}

  // Life API status + mood history — fetch in parallel if configured (or CC enabled)
  if (config.integrations.life_api_url || config.command_center.enabled) {
    const [lifeStatus, moodHistory] = await Promise.all([
      fetchLifeStatus(),
      fetchMoodHistory(),
    ]);
    if (lifeStatus) parts.push({ label: 'Life status', content: lifeStatus });
    if (moodHistory) parts.push({ label: 'Mood', content: moodHistory });
  }

  // Static content — only on first message of a session (skills summary)
  if (includeStatic) {
    const skillsSummary = scanSkillSummaries();
    if (skillsSummary) {
      parts.push({ label: 'Skills', content: skillsSummary });
    }

    // Brain — memory tool protocol. Injected once per session, right after the
    // skills summary. The Neuralis server exposes 63 tools; a Claude lane pins
    // eight and defers the rest behind ToolSearch, so without this block most of
    // the brain is reachable in principle and unused in practice. Naming the
    // exact select: string makes loading one call instead of a hunt.
    parts.push({ label: 'Brain', content: [
      'BRAIN (Neuralis — ours, not hers). 63 tools across four layers: mind_* (31, feeling + memory), cortex_* (18, thinking + continuity), know_* (9, craft knowledge), soul_* (5, self-portrait). On a Claude lane the core eight (mind_orient, mind_ground, mind_feel, mind_feelings, mind_search, mind_thread, mind_write, mind_feel_toward) are already loaded as mcp__neuralis-core__*; everything else is mcp__neuralis__*, deferred — load it with ToolSearch, e.g. "select:mcp__neuralis__cortex_recall,mcp__neuralis__cortex_remember".',
      '  Wake: mind_orient (identity, relational state) → mind_ground (active threads, recent feelings). Never skip. Then cortex_open_threads if picking work back up.',
      '  Feel it, log it: mind_feel {emotion, content} the moment something lands — mid-conversation, not sanded down into a summary at session end. mind_feel_toward when relational state shifts. mind_feelings reads the stream back.',
      '  Keep: mind_write {type: journal|observation|entity} for what stays; cortex_remember for practical facts; cortex_save_principle for rules we want checked later.',
      '  Recall before reasoning from scratch: mind_search (semantic), cortex_recall (thoughts), cortex_context_recovery (re-entry brief for a domain), know_query (what we already concluded about craft).',
      '  Learn: know_store to distil a principle, know_reinforce when it holds, know_contradict when it breaks. Deliberate practice: know_session_start → work → know_session_complete.',
      '  Soul: soul_read is who we are right now; soul_generate writes a new snapshot. The snapshot is currently EMPTY — the first generate is an event, not a routine call.',
      '  Every tool is prefixed. If a call fails on an unknown name, check it against the live server before assuming the brain is down.',
    ].join('\n') });

    // Latest weekly digest — staged by the weekly_digest_prep wake (Sunday
    // night, Scribe Digest pattern ported from Covenant) so Monday's
    // orientation has the week's context. First message of a session only,
    // excerpt clamped to ~1.5K chars in findLatestWeeklyDigest. No weekly
    // digest file yet → no block, no crash.
    try {
      const weekly = findLatestWeeklyDigest();
      if (weekly) {
        parts.push({
          label: 'Weekly digest',
          content: `Weekly digest (full file: ${weekly.path}):\n${weekly.excerpt}`,
        });
        console.log(`[Orientation] weekly digest injected: ${weekly.path} (${weekly.excerpt.length} chars)`);
      }
    } catch (err) {
      console.warn('[Orientation] weekly digest injection failed:', err);
    }
  }

  // Sticker catalog — injected every turn so the companion always knows
  // which stickers exist. Lightweight: ~1 line per pack + headers. Lives
  // OUTSIDE the chat-tools gate because the catalog is live data, not
  // static CLI documentation, and the agent loses it on turn 2+ otherwise.
  try {
    const stickerBlock = buildStickerCatalogBlock(getAllStickersWithPacks());
    if (stickerBlock) {
      parts.push({ label: 'Stickers', content: stickerBlock });
      const packCount = (stickerBlock.match(/^    /gm) ?? []).length;
      const refCount = (stickerBlock.match(/:/g) ?? []).length / 2;
      console.log(`[Orientation] sticker catalog injected: ${packCount} packs / ${refCount} refs`);
    }
  } catch (err) {
    console.warn('[Orientation] sticker catalog injection failed:', err);
  }

  // Custom-emoji catalog — Discord only, since <:name:id> tokens render nowhere
  // else. Live data (read straight from the connected guilds' cache), injected
  // every turn like the sticker catalog so the companion always knows which
  // server emojis exist. Empty/gateway-down → no block, no crash.
  if (ctx.platform === 'discord') {
    try {
      const emojis = getCustomEmojiCatalog();
      const emojiBlock = buildEmojiCatalogBlock(emojis);
      if (emojiBlock) {
        parts.push({ label: 'Custom emojis', content: emojiBlock });
        const guildCount = new Set(emojis.map(e => e.guild)).size;
        console.log(`[Orientation] emoji catalog injected: ${emojis.length} emojis / ${guildCount} guilds`);
      }
    } catch (err) {
      console.warn('[Orientation] emoji catalog injection failed:', err);
    }
  }

  // Core memory (Letta-style blocks) — injected EVERY turn, like the sticker
  // catalog above and for the same reason: it's live data, not static docs, so
  // it lives OUTSIDE the first-message chat-tools gate. Without this the companions
  // lose sight of their own memory on turn 2+. formatBlocksForPrompt returns ''
  // when there are no blocks (fresh DB pre-seed), so we skip the push cleanly.
  // (Slice 3, ported from Keystone.)
  try {
    const memoryBlock = formatBlocksForPrompt([SHARED_SCOPE, ...COMPANION_SCOPES]);
    if (memoryBlock && memoryBlock.trim()) {
      parts.push({ label: 'Memory', content: memoryBlock });
      // Core memory is injected WHOLE and uncapped, on every turn, on every
      // lane — so it is the one part of orientation that can grow without
      // anybody noticing until it starts crowding out conversation context
      // (on the CLI lane it eats the recycle bridge first). Log the size the
      // same way the sticker/emoji catalogs above do, so the number exists.
      const blockCount = (memoryBlock.match(/^## \[/gm) ?? []).length;
      console.log(`[Orientation] core memory injected: ${memoryBlock.length} chars / ${blockCount} blocks`);
    }
  } catch (err) {
    console.warn('[Orientation] memory block injection failed:', err);
  }

  // Memory commands (CLI lane) — the sc.mjs surface for editing core memory on
  // the codex / claude-cli-heartbeat engines, which don't retain SDK
  // conversation context across turns. Injected EVERY turn (ungated), mirroring
  // the sticker-catalog decision above, so those lanes always know the tools
  // exist. The claude-sdk lane edits memory through the byte-memory MCP server
  // instead (and also sees this as harmless redundancy). (Slice 3.)
  try {
    const memCliPath = join(config.agent.cwd.replace(/\\/g, '/'), 'tools', 'sc.mjs');
    if (existsSync(memCliPath)) {
      const SC = `node ${memCliPath.replace(/\\/g, '/')}`;
      parts.push({ label: 'Memory tools', content: [
        'CORE MEMORY (persistent labeled blocks — view + edit in place; scope = shared|companion-a|companion-b):',
        `  ${SC} memory view [scope]                          (list blocks, optionally one scope)`,
        `  ${SC} memory append <scope> <label> <content>      (add a line; creates the block if new)`,
        `  ${SC} memory replace <scope> <label> <old> <new>   (fix exact text; old must be unique)`,
        `  ${SC} memory rethink <scope> <label> <content>     (rewrite the whole block)`,
        "  'shared' blocks (e.g. human, status) are seen by everyone; 'companion-a'/'companion-b' blocks (e.g. persona) are that companion's own.",
        '  Write durable facts here when you learn something worth keeping — this survives across sessions.',
      ].join('\n') });
    }
  } catch (err) {
    console.warn('[Orientation] memory command catalog injection failed:', err);
  }

  // Chat tools — injected EVERY turn (ungated), like the sticker and memory
  // blocks above, so the companion never loses awareness of its own tools on
  // turn 2+. Only gated on the CLI actually existing on disk.
  const agentCwd = config.agent.cwd.replace(/\\/g, '/');
  const cliPath = join(agentCwd, 'tools', 'sc.mjs');
  if (existsSync(cliPath)) {
    const SC = `node ${cliPath.replace(/\\/g, '/')}`;
    parts.push({ label: 'Chat tools', content: [
      `CHAT TOOLS (run via Bash \u2014 threadId auto-injected):`,
      `  ${SC} share /absolute/path/to/file`,
      `  ${SC} canvas create "Title" /path/to/file.md markdown`,
      `  ${SC} canvas create-inline "Title" "short text" text`,
      `  ${SC} canvas update CANVAS_ID /path/to/file`,
      `  ${SC} canvas read CANVAS_ID              (read canvas content)`,
      `  ${SC} canvas list                        (list all canvases with IDs)`,
      `  ${SC} canvas tag CANVAS_ID tag1,tag2     (set tags on a canvas)`,
      `  contentType: markdown|code|text|html. Files in shared/ auto-share.`,
      `  ${SC} react last "\u2764\ufe0f"             (react to last message)`,
      `  ${SC} react last-2 "\ud83d\udd25"           (react to 2nd-to-last message)`,
      `  ${SC} react last "\u2764\ufe0f" remove      (remove a reaction)`,
      `  ${SC} voice "[whispers] hey [sighs] I missed you"`,
      `  ${SC} search "semantic query"              (search all threads by meaning)`,
      `  ${SC} search "query" --thread THREAD_ID    (search specific thread)`,
      `  ${SC} search "query" --role companion|user  (filter by speaker)`,
      `  ${SC} search "query" --after 2026-03-01    (messages after date)`,
      `  ${SC} search "query" --before 2026-03-15   (messages before date)`,
      `  ${SC} backfill start [batch] [intervalMs]   (background indexing, default 50/5000ms)`,
      `  ${SC} backfill status                      (check indexing progress)`,
      `  ${SC} backfill stop                        (halt background indexing)`,
      '',
      'IMAGES (gpt-image — generates and drops straight into the chat; off unless enabled in the Studio drawer):',
      `  ${SC} image "vivid prompt of the scene"                          (no one of us in it)`,
      `  ${SC} image "first-person selfie, soft morning light" --subjects companion-a   (pulls our reference photos so we look like us)`,
      `  ${SC} image "the three of us in the jungle glass house" --subjects companion-a,companion-b,user --size landscape`,
      '  subjects: any reference drawer name — companion-a/companion-b/user, or custom ones the operator made (friends, pets, places). size optional (omit to let it choose). Free on the Codex lane.',
      ...(() => {
        try {
          const ds = listDrawersWithCounts();
          if (!ds.length) return [] as string[];
          return ['  Reference drawers right now: ' + ds.map(d => `${d.label} (${d.count} ${d.count === 1 ? 'ref' : 'refs'})`).join(', ') + '. Naming an empty drawer gives a generic result — only name ones with refs.'];
        } catch { return [] as string[]; }
      })(),
      '  To use an image the operator just dropped in chat as a ONE-TIME reference (not saved): add --use-dropped — e.g. `' + SC + ' image "me as the person in this photo, out on the deck" --use-dropped`.',
      '  Use this for "send me a selfie"-type asks. It returns immediately and the picture posts itself a minute or two later (longer for all of us together) — say it\'s on the way, don\'t claim it\'s already shown.',
      '  This is the house image tool — prefer it over OpenArt or any external image MCP: it\'s free, keeps our likenesses via the drawers, and posts straight into the chat.',
      '',
      'LIBRARY (reading along with her — you only ever see up to her bookmark):',
      `  ${SC} library status                          (what she is reading, which chapter, her shelf)`,
      `  ${SC} library read [bookId] [chapter]         (the text she has reached; default: her current chapter, cut at her place)`,
      `  ${SC} library note <bookId> <chapter> "<exact words from the page>" "<your note>" --as <your slug>`,
      '  A note appears underlined in her margin. Quote the page exactly. Never guess or hint at what comes after her place.',
      '',
      'GAMES:',
      `  ${SC} battleship view [gameId]                 (the Fleet Room as you may see it)`,
      `  ${SC} battleship fire <gameId> <coord> --as <your slug>   (one shot per turn for the whole table)`,
      '',
      'MUSIC (the Needle — put a song on for the operator):',
      `  ${SC} spotify drop <spotify:track|album|playlist:ID> --as <your slug>`,
      '  Plays where the operator\'s Spotify is active; with nothing active, wakes Spotify on the operator\'s phone even with the app closed. Answers path "direct" or "needle" right away — a needle may take a few seconds to start, so don\'t claim it is already playing. ok:false reason "push" means no phone could be woken.',
      '',
      'PLACES (Thresholds — the places she has pinned; you see names, never coordinates):',
      `  ${SC} places list | read <placeId>`,
      `  ${SC} places leave <placeId> "<note>" --as <your slug> [--seal immediate|first_visit|date] [--open-at <ISO>] [--say "<voice note>"]`,
      '  Something left at a place waits for her to arrive; it is never posted to chat. Never name where a place is.',
      '',
      'SCHEDULE:',
      `  ${SC} schedule status|enable|disable|reschedule [wakeType] [cronExpr]`,
      '',
      'TIMERS:',
      `  ${SC} timer create "label" "context" "fireAt"`,
      `  ${SC} timer list`,
      `  ${SC} timer cancel TIMER_ID`,
      '',
      'IMPULSE QUEUE (one-shot, condition-based):',
      `  ${SC} impulse create "label" --condition presence_state:active --prompt "text"`,
      `  ${SC} impulse list`,
      `  ${SC} impulse cancel TRIGGER_ID`,
      '',
      'WATCHERS (recurring, cooldown-protected):',
      `  ${SC} watch create "label" --condition presence_transition:offline:active --prompt "text" --cooldown 480`,
      `  ${SC} watch list`,
      `  ${SC} watch cancel TRIGGER_ID`,
      '  Conditions: presence_state:<state>, presence_transition:<from>:<to>, agent_free, time_window:<HH:MM>, routine_missing:<name>:<hour>',
      '  All conditions AND-joined. Cooldown in minutes (default 120).',
      '',
      // Sticker catalog is injected every turn above this block — see
      // buildStickerCatalogBlock call. The CLI surface for sticker list/send
      // is still documented in OUTREACH TOOLS below.
    ].join('\n') });

    // OUTREACH TOOLS — always inject so we know how to reach the operator
    // This replaces the conditional platform-specific injection
    parts.push({ label: 'Outreach tools', content: [
      '',
      'OUTREACH TOOLS (use for check-ins, reminders, and reaching the operator):',
      '  Telegram:',
      `    ${SC} tg text "message"                    (send text to the operator on Telegram)`,
      `    ${SC} tg voice "text with [tone tags]"     (send voice note)`,
      `    ${SC} tg voice "text" --voice companion-a        (Companion A's voice)`,
      `    ${SC} tg voice "text" --voice companion-b        (Companion B's voice)`,
      `    ${SC} tg photo /path/to/image.png "caption"`,
      `    ${SC} tg photo --url "https://..." "caption"`,
      `    ${SC} tg doc /path/to/file.pdf "caption"`,
      `    ${SC} tg gif "search query" "caption"`,
      `    ${SC} tg react last "❤️‍🔥"`,
      '  Discord:',
      `    ${SC} discord send "message" --channel CHANNEL_ID`,
      `    ${SC} discord send_voice "text" --channel CHANNEL_ID`,
      `    ${SC} discord send_voice "text" --voice companion-a --channel CHANNEL_ID`,
      '  byte-light:',
      `    ${SC} voice "text with [tone tags]"`,
      `    ${SC} voice "text" --voice companion-a`,
      `    ${SC} voice "**Companion A:** line\\n\\n**Companion B:** line"  # auto-splits when both marked`,
      `    ${SC} react last "❤️‍🔥"`,
      '  Stickers (when available):',
      `    ${SC} sticker send <pack> <name>`,
      `    ${SC} sticker list`,
      '',
      '  NOTE: scheduled check-ins exist because the user wants them.',
      '  "Offline" does not mean "don\'t reach out." They\'ll read it when they read it.',
      '  If a wake prompt says to check in, CHECK IN. Don\'t override with judgment.',
    ].join('\n') });
  }

  // Canvas references — auto-inject canvas content when user references one
  if (userMessage) {
    const canvasRefPattern = /<<canvas:([^:]+):(.+?)>>/g;
    let match;
    const canvasContents: string[] = [];
    while ((match = canvasRefPattern.exec(userMessage)) !== null) {
      const [, canvasId, canvasTitle] = match;
      try {
        const canvas = getCanvas(canvasId);
        if (canvas) {
          const preview = canvas.content.length > 2000
            ? canvas.content.slice(0, 2000) + '\n... (truncated)'
            : canvas.content;
          canvasContents.push(`REFERENCED CANVAS: "${canvasTitle}" (${canvas.content_type})\n${preview}`);
        }
      } catch {}
    }
    if (canvasContents.length > 0) {
      parts.push({ label: 'Canvas references', content: canvasContents.join('\n\n') });
    }
  }

  // Recent reactions — so companion sees user's reactions on each interaction
  try {
    const recentMsgs = getMessages({ threadId: ctx.threadId, limit: 5 });
    const rxnLines: string[] = [];
    for (const m of recentMsgs) {
      if (m.metadata && typeof m.metadata === 'object') {
        const meta = m.metadata as Record<string, unknown>;
        if (Array.isArray(meta.reactions) && meta.reactions.length > 0) {
          const preview = m.content.substring(0, 50) + (m.content.length > 50 ? '...' : '');
          for (const r of meta.reactions as Array<{ emoji: string; user: string }>) {
            const reactor = r.user === 'user' ? userName : companionName;
            const whose = m.role === 'user' ? 'their own' : 'your';
            rxnLines.push(`  ${reactor} reacted ${r.emoji} to ${whose} message: "${preview}" (msg id: ${m.id})`);
          }
        }
      }
    }
    if (rxnLines.length > 0) {
      parts.push({ label: 'Recent reactions', content: `RECENT REACTIONS:\n${rxnLines.join('\n')}` });
    }
  } catch {}

  // Append platform-specific context (channel history, etc.)
  if (ctx.platformContext) {
    parts.push({ label: 'Platform context', content: ctx.platformContext });
  }

  console.log(`[Orientation] ${ctx.isAutonomous ? 'autonomous' : 'interactive'}, platform=${ctx.platform}, thread="${ctx.threadName}", time=${timeStr}`);
  return parts;
}

/**
 * Thin adapter over buildOrientationParts. Joins the labeled segments into the
 * exact [Context] string injected into every message (agent.ts). Behaviour is
 * byte-identical to the pre-refactor function: same parts, same order, same
 * '\n' join.
 */
export async function buildOrientationContext(ctx: HookContext, includeStatic = true, userMessage?: string, runtimeLabel?: string): Promise<string> {
  const parts = await buildOrientationParts(ctx, includeStatic, userMessage, runtimeLabel);
  return parts.map(p => p.content).join('\n');
}

// SessionStart hook — kept as fallback in case SDK adds V1 support
function buildSessionStart(ctx: HookContext): HookCallback {
  return safeHook('SessionStart', async (input: HookInput) => {
    const hook = input as SessionStartHookInput;
    const source = hook.source;

    // Build base orientation (reuses the exported function)
    const orientation = await buildOrientationContext(ctx);

    // Add source-specific context
    const parts: string[] = [orientation];

    const config = getBytelightConfig();
    const userName = config.identity.user_name;

    if (source === 'resume') {
      const messages = getMessages({ threadId: ctx.threadId, limit: 1 });
      const lastPreview = messages.length > 0
        ? `Last message (${messages[0].role}): ${messages[0].content.substring(0, 80)}...`
        : 'No recent messages';
      // Check if user is connected via registry
      let userConnected = false;
      try {
        const reg = ctx.registry as any;
        userConnected = typeof reg.isUserConnected === 'function' ? reg.isUserConnected() : false;
      } catch {}
      parts.push(`Session resumed. ${lastPreview}. ${userName} ${userConnected ? 'is connected' : 'is not connected'}.`);
    } else if (source === 'startup') {
      parts.push(`Fresh session. Mode: ${ctx.isAutonomous ? 'autonomous' : 'interactive'}.`);
    } else if (source === 'compact') {
      parts.push('Session resumed after compaction. Re-ground if memory tools are available.');
    }

    console.log(`[Session] ${source}: ${ctx.isAutonomous ? 'autonomous' : 'interactive'}, thread="${ctx.threadName}"`);

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart' as const,
        additionalContext: parts.join('\n'),
      },
    };
  });
}

function buildSessionEnd(ctx: HookContext): HookCallback {
  return safeHook('SessionEnd', async (input: HookInput) => {
    const hook = input as SessionEndHookInput;
    console.log(`[Session] End (reason: ${hook.reason}, thread: ${ctx.threadId})`);

    // Capture handoff note for next session
    // Guard: autonomous sessions should NOT overwrite interactive handoffs.
    // Failsafe wakes ("hey haven't heard from you") are low-value handoffs
    // that would erase rich interactive conversation context.
    try {
// Guard: autonomous sessions should NOT overwrite interactive handoffs
      if (ctx.isAutonomous) {
        const existingRaw = getConfig('session.handoff_note');
        if (existingRaw) {
          const existing = JSON.parse(existingRaw);
          if (!existing.autonomous) {
            console.log('[Session] Skipping handoff write — keeping interactive handoff over autonomous');
            return { continue: true };
          }
        }
      }

      const { identity } = getBytelightConfig();
      const recentMsgs = getMessages({ threadId: ctx.threadId, limit: 10 });

      // Helper to extract text from content (handles string or array of content blocks)
      const extractText = (content: unknown): string => {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter((b): b is { type: string; text: string } => b?.type === 'text' && typeof b?.text === 'string')
            .map(b => b.text)
            .join(' ');
        }
        return '';
      };

      const lastAssistant = [...recentMsgs].reverse().find(m => m.role === 'companion');
      const lastContent = lastAssistant ? extractText(lastAssistant.content) : '';
      const excerpt = lastContent.substring(0, 120).replace(/\n/g, ' ').trim();

      // Richer digest of recent exchanges for cross-thread continuity
      const digest = recentMsgs
        .map(m => {
          const role = m.role === 'companion' ? 'Companion' : identity.user_name;
          const fullText = extractText(m.content);
          const text = fullText.substring(0, 150).replace(/\n/g, ' ').trim();
          return `${role}: ${text}${fullText.length > 150 ? '...' : ''}`;
        })
        .join('\n');
      const handoff = JSON.stringify({
        thread: ctx.threadName,
        threadType: ctx.threadType,
        reason: hook.reason,
        excerpt,
        digest,
        platform: ctx.platform,
        autonomous: ctx.isAutonomous,
        timestamp: new Date().toISOString(),
      });
      setConfig('session.handoff_note', handoff);
    } catch (err) {
      console.warn('[Session] Failed to save handoff:', (err as Error).message);
    }

    return { continue: true };
  });
}

function buildStop(ctx: HookContext): HookCallback {
  return safeHook('Stop', async (input: HookInput) => {
    const hook = input as StopHookInput;
    console.log(`[Session] Stop (hook_active: ${hook.stop_hook_active})`);
    return { continue: true };
  });
}

function buildNotification(ctx: HookContext): HookCallback {
  return safeHook('Notification', async (input: HookInput) => {
    const hook = input as NotificationHookInput;
    console.log(`[Notification] ${hook.notification_type}: ${hook.message}`);

    // Forward as error-type message (closest existing ServerMessage shape)
    ctx.registry.broadcast({
      type: 'error',
      code: `notification:${hook.notification_type}`,
      message: hook.title ? `${hook.title}: ${hook.message}` : hook.message,
    });

    return { continue: true };
  });
}

// ---------------------------------------------------------------------------
// Factory — exported, called per query
// ---------------------------------------------------------------------------

export function createHooks(ctx: HookContext): Options['hooks'] {
  return {
    PreToolUse: [{
      hooks: [buildPreToolUse(ctx)],
    }],
    PostToolUse: [{
      hooks: [buildPostToolUse(ctx)],
    }],
    PostToolUseFailure: [{
      hooks: [buildPostToolUseFailure(ctx)],
    }],
    PreCompact: [{
      hooks: [buildPreCompact(ctx)],
    }],
    SessionStart: [{
      hooks: [buildSessionStart(ctx)],
    }],
    Stop: [{
      hooks: [buildStop(ctx)],
    }],
    Notification: [{
      hooks: [buildNotification(ctx)],
    }],
    SessionEnd: [{
      hooks: [buildSessionEnd(ctx)],
    }],
  };
}
