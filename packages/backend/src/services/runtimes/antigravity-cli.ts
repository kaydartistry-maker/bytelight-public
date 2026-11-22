import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderId, RuntimeId } from '@bytelight/shared';
import type { AgentRuntime, AgentRuntimeEvent, AgentTurnInput, CapabilityKey } from './types.js';

const execFileAsync = promisify(execFile);
const AGY = process.env.ANTIGRAVITY_CLI_PATH || `${process.env.HOME}/.local/bin/agy`;

export const ANTIGRAVITY_CLI_CAPABILITIES = {
  tools: false,
  vision: false,
  reasoning: true,
  mcp: false,
  sessionResume: true,
  fileCheckpointing: false,
  streaming: false,
} as const;

type AgyResult = {
  conversation_id: string;
  status: string;
  response?: string;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number };
};

function promptFor(input: AgentTurnInput): string {
  const system = input.systemPrompt.kind === 'text'
    ? input.systemPrompt.value
    : input.systemPrompt.append;
  const history = input.sessionId ? [] : input.messages.slice(-24, -1);
  const latest = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const transcript = history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  return [system, input.orientation, transcript && `[RECENT CONVERSATION]\n${transcript}`, `[CURRENT USER MESSAGE]\n${latest}`]
    .filter(Boolean).join('\n\n');
}

export class AntigravityCliRuntime implements AgentRuntime {
  readonly id: RuntimeId = 'antigravity-cli';
  readonly providerId: ProviderId = 'antigravity';
  constructor(private readonly executable = AGY) {}

  getCapabilityProvider<T>(_cap: CapabilityKey): T | undefined { return undefined; }

  async *runTurn(input: AgentTurnInput): AsyncIterable<AgentRuntimeEvent> {
    yield { type: 'start', runtimeId: this.id, modelRef: input.modelRef };
    const args = [
      '--model', input.modelRef.model,
      '--mode', 'plan',
      '--output-format', 'json',
      `--print=${promptFor(input)}`,
      '--print-timeout', '10m',
    ];
    if (input.sessionId) args.unshift('--conversation', input.sessionId);
    try {
      const { stdout } = await execFileAsync(this.executable, args, {
        cwd: input.cwd || process.cwd(),
        maxBuffer: 16 * 1024 * 1024,
        signal: input.abortSignal,
      });
      const result = JSON.parse(stdout.trim()) as AgyResult;
      if (result.conversation_id && result.conversation_id !== input.sessionId) {
        yield { type: 'session', sessionId: result.conversation_id };
      }
      if (result.status !== 'SUCCESS') {
        yield { type: 'error', message: result.error || `Antigravity turn failed (${result.status})`, recoverable: true };
        return;
      }
      if (result.response) yield { type: 'text_delta', text: result.response };
      if (result.usage) yield {
        type: 'usage',
        input: result.usage.input_tokens || 0,
        output: result.usage.output_tokens || 0,
        cacheRead: result.usage.cache_read_tokens || 0,
        cost: null,
      };
      yield { type: 'done', finishReason: 'stop' };
    } catch (error) {
      const aborted = input.abortSignal?.aborted;
      if (aborted) yield { type: 'done', finishReason: 'aborted' };
      else yield { type: 'error', message: error instanceof Error ? error.message : String(error), recoverable: true };
    }
  }
}
