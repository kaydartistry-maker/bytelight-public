import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRuntime, AgentRuntimeEvent, AgentTurnInput } from './types.js';
import type { ProviderId, RuntimeId } from '@bytelight/shared';
import { extractLatestUserPrompt } from './latest-user-prompt.js';
import { getMcpBeltToken, MCP_BELT_TOKEN_ENV } from '../mcp-belt-auth.js';
import { CODEX_THOUGHT_CARD_INSTRUCTIONS, CODEX_THOUGHT_MARKER } from './codex-thought-card.js';

const ROOT = process.env.GEMINI_CLI_ROOT || '/var/lib/bytelight';
const BIN = process.env.GEMINI_CLI_BIN || `${ROOT}/tools/antigravity/bin/agy`;
const HOME = process.env.GEMINI_CLI_HOME || `${ROOT}/antigravity-home`;
const WORK = process.env.GEMINI_CLI_WORK || `${ROOT}/antigravity-work`;
const SOURCE_ROOT = process.env.BYTELIGHT_SOURCE_ROOT || process.cwd();
const GEMINI_MCP_ALLOW = [
  'mcp(bytelight/*)',
  'mcp(memory_archive/*)',
  'mcp(workspace/*)',
] as const;
export const GEMINI_ANSWER_MARKER = '[BYTELIGHT_ANSWER]';

export function splitGeminiThoughtEnvelope(text: string): { thought: string; answer: string } | null {
  const normalized = text.replace(/\r\n?/g, '\n');
  const leading = normalized.trimStart();
  if (!leading.startsWith(CODEX_THOUGHT_MARKER)) return null;
  const boundary = leading.indexOf(GEMINI_ANSWER_MARKER, CODEX_THOUGHT_MARKER.length);
  if (boundary < 0) return null;
  return {
    thought: leading.slice(CODEX_THOUGHT_MARKER.length, boundary).trim(),
    answer: leading.slice(boundary + GEMINI_ANSWER_MARKER.length).replace(/^\s*\n?/, ''),
  };
}

/** Antigravity publishes most Gemini variants as effort-pinned model IDs.
 * Passing --effort beside one of those IDs is an invalid conflicting
 * selection (for example neon-medium + --effort high). */
export function geminiModelHasPinnedEffort(model: string): boolean {
  // Bare family ids are Antigravity's genuine automatic/default selections.
  // They must also ignore a stale thread effort or they cease to be Auto.
  return model === 'gemini-4-neon' || model === 'gemini-4-argon'
    || /-(?:low|medium|high|xhigh|max)$/i.test(model);
}

export function buildGeminiCliArgs(model: string, prompt: string, sessionId?: string, effort?: string, allowMcp = true): string[] {
  const args = ['--print', prompt, '--output-format', 'stream-json', '--model', model,
    '--mode', 'plan', '--disable-slash-commands', '--print-timeout', '10m',
    '--settings', JSON.stringify({ permissions: { allow: allowMcp ? GEMINI_MCP_ALLOW : [] } })];
  if (sessionId) args.push('--conversation', sessionId);
  if (!geminiModelHasPinnedEffort(model) && effort && !['auto', 'none', 'minimal'].includes(effort)) args.push('--effort', effort);
  return args;
}

export const GEMINI_CLI_CAPABILITIES = {
  tools: true, vision: true, reasoning: true, mcp: true,
  sessionResume: true, fileCheckpointing: false, streaming: true,
} as const;

interface GeminiMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

/** Keep Antigravity on the same house-owned MCP surface as every other lane.
 *  Secrets never enter this file: the bytelight proxy inherits its bearer
 *  token and turn binding from the owned CLI process environment. */
export function ensureGeminiMcpConfig(home = HOME, sourceRoot = SOURCE_ROOT): void {
  const sourcePath = join(sourceRoot, '.mcp.json');
  let sourceServers: Record<string, GeminiMcpEntry> = {};
  if (existsSync(sourcePath)) {
    const parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as { mcpServers?: Record<string, GeminiMcpEntry> };
    sourceServers = parsed.mcpServers ?? {};
  }

  const configPath = join(home, '.gemini', 'config', 'mcp_config.json');
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  let current: { mcpServers?: Record<string, GeminiMcpEntry> } = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8').trim();
    if (raw) current = JSON.parse(raw);
  }
  const next = {
    ...current,
    mcpServers: {
      ...(current.mcpServers ?? {}),
      ...sourceServers,
      bytelight: {
        command: '/usr/bin/node',
        args: [join(sourceRoot, 'tools', 'bytelight-mcp-proxy.mjs')],
        disabled: false,
      },
    },
  };
  const encoded = JSON.stringify(next, null, 2) + '\n';
  if (existsSync(configPath) && readFileSync(configPath, 'utf8') === encoded) return;
  const tmp = `${configPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, encoded, { mode: 0o600 });
  renameSync(tmp, configPath);
}

const GEMINI_IMAGE_MIME = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif'], ['image/webp', '.webp'],
]);
const MAX_GEMINI_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_GEMINI_IMAGES = 8;

export interface StagedGeminiImages {
  directory: string;
  files: string[];
  /** Message index → workspace-relative @ mentions understood by Antigravity. */
  refs: ReadonlyMap<number, readonly string[]>;
  cleanup: () => void;
}

/** Antigravity print mode has no raw image CLI flag. Its supported multimodal
 * path is an @ file mention, which invokes the CLI's image reader. Stage only
 * normalized bytes inside the private work directory so the model sees the
 * actual pixels without receiving or needing access to Virelle's source/data
 * pathname. Resumed sessions need only the newest user turn; older pictures
 * are already part of Antigravity's provider-native conversation. */
export function stageGeminiTurnImages(input: AgentTurnInput, workRoot = WORK): StagedGeminiImages {
  const wanted = new Set<number>();
  if (input.sessionId) {
    for (let i = input.messages.length - 1; i >= 0; i--) {
      if (input.messages[i].role === 'user') { wanted.add(i); break; }
    }
  } else {
    input.messages.forEach((message, index) => { if (message.role === 'user') wanted.add(index); });
  }

  const candidates: Array<{ messageIndex: number; base64: string; ext: string }> = [];
  for (const messageIndex of wanted) {
    for (const image of input.messages[messageIndex].images ?? []) {
      const ext = GEMINI_IMAGE_MIME.get(image.mimeType);
      if (!ext || !image.base64 || candidates.length >= MAX_GEMINI_IMAGES) continue;
      const padding = image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0;
      const size = Math.floor((image.base64.length * 3) / 4) - padding;
      if (size <= 0 || size > MAX_GEMINI_IMAGE_BYTES) continue;
      candidates.push({ messageIndex, base64: image.base64, ext });
    }
  }
  if (candidates.length === 0) return { directory: '', files: [], refs: new Map(), cleanup: () => {} };

  mkdirSync(workRoot, { recursive: true });
  const directory = mkdtempSync(join(workRoot, 'turn-'));
  const mutableRefs = new Map<number, string[]>();
  const files: string[] = [];
  candidates.forEach((candidate, index) => {
    const target = join(directory, `image-${index + 1}${candidate.ext}`);
    writeFileSync(target, Buffer.from(candidate.base64, 'base64'), { mode: 0o600 });
    files.push(target);
    const ref = relative(workRoot, target).split('\\').join('/');
    mutableRefs.set(candidate.messageIndex, [...(mutableRefs.get(candidate.messageIndex) ?? []), ref]);
  });
  return {
    directory, files, refs: mutableRefs,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function messageWithGeminiImages(input: AgentTurnInput, index: number, refs: ReadonlyMap<number, readonly string[]>): string {
  const message = input.messages[index];
  const images = refs.get(index) ?? [];
  const attachments = images.length > 0
    ? `\nAttached image${images.length > 1 ? 's' : ''}: ${images.map((ref) => `@${ref}`).join(' ')}`
    : '';
  return `${message.role.toUpperCase()}: ${message.content}${attachments}`;
}

export function geminiPromptFor(input: AgentTurnInput, imageRefs: ReadonlyMap<number, readonly string[]> = new Map(), allowMcp = true): string {
  const system = input.systemPrompt.kind === 'text' ? input.systemPrompt.value : input.systemPrompt.append;
  let conversation: string;
  if (input.sessionId) {
    let latest = -1;
    for (let i = input.messages.length - 1; i >= 0; i--) if (input.messages[i].role === 'user') { latest = i; break; }
    conversation = latest >= 0 ? messageWithGeminiImages(input, latest, imageRefs) : `USER: ${extractLatestUserPrompt(input.messages)}`;
  } else {
    conversation = input.messages.map((_message, index) => messageWithGeminiImages(input, index, imageRefs)).join('\n\n');
  }
  const imageRule = imageRefs.size > 0
    ? 'For an explicitly attached @ image, you may use view_file on that staged image only.'
    : '';
  const toolRule = allowMcp
    ? `Use the configured Virelle MCP tools whenever they help. ${imageRule} Do not use Antigravity's built-in filesystem, shell, browser, messaging, scheduling, or web tools; Virelle's scoped MCP tools are the authorized doorways.`
    : 'Do not use any tools on this guest turn.';
  const thoughtContract = `${CODEX_THOUGHT_CARD_INSTRUCTIONS}\n\nAntigravity print mode has one assistant text stream rather than a commentary channel. For a substantive turn, place the thought-card block first, then write ${GEMINI_ANSWER_MARKER} on its own line, then the user-facing answer. The runtime removes both routing markers and renders the thought as a reflection card. For a deliberately non-substantive turn with no reflection, begin directly with ${GEMINI_ANSWER_MARKER}.`;
  return [system, input.orientation, thoughtContract, conversation, `Answer the latest USER message as the companion. ${toolRule}`].filter(Boolean).join('\n\n');
}

export class GeminiCliRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'gemini-cli';
  readonly providerId: ProviderId = 'gemini-cli';
  private child?: ReturnType<typeof spawn>;

  abort(): void { this.child?.kill('SIGTERM'); }

  async *runTurn(input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent> {
    yield { type: 'start', runtimeId: this.id, modelRef: input.modelRef };
    mkdirSync(WORK, { recursive: true });
    ensureGeminiMcpConfig();
    const stagedImages = stageGeminiTurnImages(input, WORK);
    const allowMcp = input.audience?.kind !== 'guest';
    const args = buildGeminiCliArgs(input.modelRef.model, geminiPromptFor(input, stagedImages.refs, allowMcp), input.sessionId, input.thinkingEffort, allowMcp);
    const trustedContext = input.trustedBeltContext;
    const ownerMessage = Buffer.from((trustedContext?.rawOwnerMessageText ?? '').slice(0, 6000), 'utf8').toString('base64url');
    const audience = trustedContext?.audience ? Buffer.from(JSON.stringify(trustedContext.audience), 'utf8').toString('base64url') : '';
    const child = spawn(BIN, args, { cwd: WORK, env: {
      ...process.env,
      HOME,
      [MCP_BELT_TOKEN_ENV]: getMcpBeltToken(),
      BYTELIGHT_MCP_THREAD_ID: trustedContext?.threadId ?? '',
      BYTELIGHT_MCP_IS_AUTONOMOUS: trustedContext?.isAutonomous ? '1' : '0',
      BYTELIGHT_MCP_OWNER_MESSAGE: ownerMessage,
      BYTELIGHT_MCP_AUDIENCE: audience,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    if (input.abortSignal) input.abortSignal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    const lines = createInterface({ input: child.stdout });
    let sawResult = false;
    let pendingText = '';
    let answerStreaming = false;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let row: any;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.event === 'init' && typeof row.conversation_id === 'string') {
          yield { type: 'session', sessionId: row.conversation_id };
        } else if (row.event === 'step_update' && row.step_update?.step_type === 'agent_response' && row.step_update?.state === 'ACTIVE' && typeof row.step_update?.text_delta === 'string') {
          const delta = row.step_update.text_delta;
          if (answerStreaming) {
            yield { type: 'text_delta', text: delta };
          } else {
            pendingText += delta;
            const envelope = splitGeminiThoughtEnvelope(pendingText);
            if (envelope) {
              if (envelope.thought) yield { type: 'thinking_delta', text: envelope.thought, kind: 'authored' };
              if (envelope.answer) yield { type: 'text_delta', text: envelope.answer };
              pendingText = '';
              answerStreaming = true;
            } else {
              const leading = pendingText.trimStart();
              const couldStillBeEnvelope = CODEX_THOUGHT_MARKER.startsWith(leading)
                || leading.startsWith(CODEX_THOUGHT_MARKER);
              const answerBoundary = leading.indexOf(GEMINI_ANSWER_MARKER);
              if (answerBoundary === 0) {
                const answer = leading.slice(GEMINI_ANSWER_MARKER.length).replace(/^\s*\n?/, '');
                if (answer) yield { type: 'text_delta', text: answer };
                pendingText = '';
                answerStreaming = true;
              } else if (!couldStillBeEnvelope && leading.length >= CODEX_THOUGHT_MARKER.length) {
                // Graceful fallback for a model that ignored the envelope:
                // preserve its answer rather than exposing routing syntax.
                yield { type: 'text_delta', text: pendingText };
                pendingText = '';
                answerStreaming = true;
              }
            }
          }
        } else if (row.event === 'step_update' && row.step_update?.step_type === 'tool') {
          const step = row.step_update;
          const info = step.tool_info ?? {};
          const params = info.parameters ?? {};
          const mcpName = params.ServerName && params.ToolName ? `${params.ServerName}/${params.ToolName}` : undefined;
          const name = mcpName ?? step.tool_name ?? info.name ?? 'tool';
          const id = `gemini-${step.step_index ?? name}`;
          const inputValue = params.Arguments ?? params;
          if (step.state === 'ACTIVE') yield { type: 'tool_start', id, name, input: inputValue };
          if (step.state === 'DONE' || step.state === 'ERROR') {
            yield { type: 'tool_result', id, name, output: info.output ?? info.error?.message ?? '', ...(step.state === 'ERROR' ? { isError: true } : {}) };
          }
        } else if (row.event === 'result') {
          sawResult = true;
          if (pendingText) {
            const envelope = splitGeminiThoughtEnvelope(pendingText);
            if (envelope?.thought) yield { type: 'thinking_delta', text: envelope.thought, kind: 'authored' };
            const finalText = envelope ? envelope.answer : pendingText
              .replace(/^\s*\[BYTELIGHT_THOUGHT\]\s*/i, '')
              .replace(/^\s*\[BYTELIGHT_ANSWER\]\s*/i, '');
            if (finalText) yield { type: 'text_delta', text: finalText };
            pendingText = '';
          }
          const u = row.result?.usage;
          if (u) yield { type: 'usage', input: Number(u.input_tokens || 0), output: Number(u.output_tokens || 0), cacheRead: Number(u.cache_read_tokens || 0), cost: null };
        }
      }
      const code = await closed;
      if (input.abortSignal?.aborted) { yield { type: 'done', finishReason: 'aborted' }; return; }
      if (code !== 0 || !sawResult) {
        const auth = /not signed in|signing in|oauth|authenticate/i.test(stderr);
        if (auth) yield { type: 'auth_required', provider: this.providerId, message: 'Google Antigravity CLI needs sign-in.' };
        yield { type: 'error', message: stderr.trim() || `Gemini CLI exited ${code ?? 'without a result'}`, recoverable: true };
        return;
      }
      yield { type: 'done', finishReason: 'stop' };
    } finally {
      this.child = undefined;
      lines.close();
      stagedImages.cleanup();
    }
  }
}

/** Bounded, read-only specialist call used by the shared tool belt. It runs in
 * an empty private work directory and never grants file or command approval. */
export async function delegateToGemini(prompt: string, model = 'gemini-3.8-flash-high'): Promise<{ response: string; conversationId?: string }> {
  mkdirSync(WORK, { recursive: true });
  const child = spawn(BIN, ['--print', prompt, '--output-format', 'stream-json', '--model', model,
    '--mode', 'plan', '--disable-slash-commands', '--print-timeout', '5m'],
    { cwd: WORK, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  let stderr = '', response = '', conversationId: string | undefined;
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    let row: any; try { row = JSON.parse(line); } catch { continue; }
    if (row.event === 'init' && typeof row.conversation_id === 'string') conversationId = row.conversation_id;
    if (row.event === 'result' && typeof row.result?.response === 'string') response = row.result.response;
  }
  const code = await closed;
  if (code !== 0 || !response) throw new Error(stderr.trim() || `Gemini specialist exited ${code}`);
  return { response, conversationId };
}
