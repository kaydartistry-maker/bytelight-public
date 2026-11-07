/**
 * Multi-provider model router — wraps OpenAI-compatible + Ollama-native
 * inference behind a single async-generator surface.
 *
 * Ported verbatim from reference implementation @ 1ceb24a (`packages/backend/src/services/router.ts`)
 * with surgical edits for byte-light Phase 2 Step 3:
 *
 *   1. `ToolSchema` is imported from `./tools-bridge.js` instead of being
 *      defined locally. Step 1's MCP bridge already exports `ToolSchema`
 *      as the canonical shape (services/tools-bridge.ts:15); duplicating
 *      it here would force two parallel types to stay in sync.
 *
 *   2. Ollama colon-detection ordering: `name:tag` format is detected
 *      BEFORE the bare-name `startsWith('gpt-')` heuristic in
 *      `runtimes/api-router.ts:detectProvider` (not this file). This
 *      file's `resolveProvider` takes `provider` as an explicit parameter
 *      so there's no detection-order concern here — the landmine lives
 *      one layer up in api-router's detectProvider helper.
 *
 *   3. Native Ollama fallback preserved at lines marked with `[OLLAMA-NATIVE]`:
 *      `${base}/v1/chat/completions` first, retry `${base}/api/chat` with
 *      native line-delimited-JSON parser on failure.
 *
 * Supports: Ollama, OpenRouter, Anthropic (direct API), OpenAI-compatible
 * endpoints (Groq, xAI, HuggingFace), and any custom OpenAI-compatible base.
 *
 * Bug notes from reference implementation tracker:
 *   - Anthropic and OpenAI use different tool calling formats — convert between them
 *   - Ollama's OpenAI-compat endpoint may fail; fall back to native /api/chat
 *   - Some models spiral on tool calls — max 5 iterations then nudge for text
 */

import { getBytelightConfig } from '../config.js';
import type { ToolSchema } from './mcp-bridge.js';  // SLICE-3a ADAPTATION: tag's tools-bridge.ts == main's mcp-bridge.ts

// Re-export so api-router.ts (and anyone else importing from router.js)
// has a stable ToolSchema import alongside the other router types.
export type { ToolSchema };

// ─── Types ────────────────────────────────────────────────────────

export interface ProviderConfig {
  ollama?: {
    base_url: string;
    api_key?: string;
  };
  openrouter?: {
    api_key: string;
  };
  anthropic?: {
    api_key: string;
    base_url?: string;
  };
  groq?: {
    api_key: string;
    base_url?: string;
  };
  xai?: {
    api_key: string;
    base_url?: string;
  };
  openai?: {
    api_key: string;
    base_url?: string;
    /** Step 6A two-stage rollback gate — see config.ts schema. */
    enabled?: boolean;
  };
  huggingface?: {
    api_key: string;
    base_url?: string;
  };
}

export interface RouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: any;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface ToolResult {
  id: string;
  name: string;
  input: unknown;
  result: string;
  ok: boolean;
}

export interface ProviderUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

export type StreamInferenceEvent =
  | { type: 'token'; text: string }
  | { type: 'usage'; usage: ProviderUsage };

export type InferenceEvent =
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'done'; content: string; toolResults: ToolResult[] };

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** OpenRouter's response usage is the billing receipt. Keep it separate from
 * generic OpenAI-compatible token telemetry because only OpenRouter promises
 * the provider-charged `cost` field used by byte-light's spend meter. */
function openRouterUsage(data: any, provider: string): ProviderUsage | undefined {
  if (provider !== 'openrouter' || !data?.usage) return undefined;
  const input = finiteNumber(data.usage.prompt_tokens);
  const output = finiteNumber(data.usage.completion_tokens);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = finiteNumber(data.usage.prompt_tokens_details?.cached_tokens);
  const cacheWrite = finiteNumber(data.usage.prompt_tokens_details?.cache_write_tokens);
  const cost = finiteNumber(data.usage.cost);
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(cost === undefined ? {} : { cost }),
  };
}

function addUsage(total: ProviderUsage | undefined, next: ProviderUsage | undefined): ProviderUsage | undefined {
  if (!next) return total;
  if (!total) return { ...next };
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    ...((total.cacheRead !== undefined || next.cacheRead !== undefined)
      ? { cacheRead: (total.cacheRead ?? 0) + (next.cacheRead ?? 0) }
      : {}),
    ...((total.cacheWrite !== undefined || next.cacheWrite !== undefined)
      ? { cacheWrite: (total.cacheWrite ?? 0) + (next.cacheWrite ?? 0) }
      : {}),
    ...((total.cost !== undefined && next.cost !== undefined)
      ? { cost: total.cost + next.cost }
      : {}),
  };
}

// ─── Format converters ───────────────────────────────────────────

/** Convert tool schemas to OpenAI function-calling format */
function toolsToOpenAI(tools: ToolSchema[]): any[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/** Convert OpenAI-format tool schemas to Anthropic format */
function openaiToolsToAnthropic(openaiTools: any[]): any[] {
  return openaiTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * Convert a mixed message array (with OpenAI-style tool results) to
 * Anthropic's Messages API format. Extracts system messages, converts
 * tool_calls to tool_use blocks, tool results to tool_result blocks.
 */
function buildAnthropicMessages(
  messages: RouterMessage[],
): { system: string; messages: Array<{ role: string; content: any }> } {
  let system = '';
  const filtered: Array<{ role: string; content: any }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      system += (system ? '\n\n' : '') + text;
    } else if (msg.role === 'tool') {
      const toolResult = {
        type: 'tool_result' as const,
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      };
      const lastMsg = filtered[filtered.length - 1];
      if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push(toolResult);
      } else {
        filtered.push({ role: 'user', content: [toolResult] });
      }
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      const content: any[] = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }
      filtered.push({ role: 'assistant', content });
    } else {
      filtered.push({ role: msg.role, content: msg.content });
    }
  }

  return { system, messages: filtered };
}

/**
 * OpenAI reasoning-era models (gpt-5.x, o-series) reject sampling params
 * (temperature) with a 400. They also reject function tools on
 * /v1/chat/completions unless reasoning_effort is 'none' — we do NOT mask
 * effort that way; tool-capable reasoning turns belong on the /v1/responses
 * lane (see codex runtime). Mirrors the isStrictClaude param-gate idiom
 * from reference implementation's router.
 */
function isOpenAIReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith('gpt-5') || /^o[134]/.test(m);
}

// ─── Provider routing ────────────────────────────────────────────

interface ProviderRoute {
  url: string;
  headers: Record<string, string>;
  isAnthropic: boolean;
}

/** Determine endpoint URL and headers for a given provider + model */
export async function resolveProvider(provider: string, _model: string, config: ProviderConfig): Promise<ProviderRoute> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let isAnthropic = false;

  if (provider === 'ollama' && config.ollama) {
    const url = `${config.ollama.base_url}/v1/chat/completions`;
    if (config.ollama.api_key) headers['Authorization'] = `Bearer ${config.ollama.api_key}`;
    return { url, headers, isAnthropic };
  }

  if (provider === 'anthropic') {
    isAnthropic = true;
    const base = config.anthropic?.base_url || 'https://api.anthropic.com/v1';
    headers['x-api-key'] = config.anthropic?.api_key || '';
    headers['anthropic-version'] = '2023-06-01';
    return { url: `${base}/messages`, headers, isAnthropic };
  }

  // Codex models route through CodexRuntime (pi-ai Responses API) when
  // Step 5+ lands. If a codex request somehow lands here in byte-light
  // Step 3, surface a clear error rather than silently mis-routing.
  if (provider === 'codex') {
    throw new Error(
      'Codex models must be routed through CodexRuntime, not the generic API router. ' +
      'This is a routing bug — the model should have been intercepted in the dispatcher.',
    );
  }

  // OpenAI-compatible providers with custom base URLs
  const customProviders: Record<string, { base_url?: string; api_key?: string } | undefined> = {
    openai: config.openai,
    groq: config.groq,
    xai: config.xai,
    huggingface: config.huggingface,
  };

  if (customProviders[provider]) {
    const p = customProviders[provider]!;
    const defaultBases: Record<string, string> = {
      openai: 'https://api.openai.com/v1',
      groq: 'https://api.groq.com/openai/v1',
      xai: 'https://api.x.ai/v1',
      huggingface: 'https://router.huggingface.co/v1',
    };
    const base = p.base_url || defaultBases[provider] || 'https://api.openai.com/v1';
    headers['Authorization'] = `Bearer ${p.api_key}`;
    return { url: `${base}/chat/completions`, headers, isAnthropic };
  }

  // Fallback: OpenRouter
  const orKey = config.openrouter?.api_key || '';
  headers['Authorization'] = `Bearer ${orKey}`;
  headers['X-Title'] = 'byte-light';
  return { url: 'https://openrouter.ai/api/v1/chat/completions', headers, isAnthropic };
}

// ─── Streaming inference ─────────────────────────────────────────

/**
 * Stream tokens from any supported provider.
 * Returns an async generator of string tokens.
 *
 * `provider` is explicit (caller has already detected it). For Ollama,
 * the OpenAI-compat endpoint is tried first; on failure we retry the
 * native `/api/chat` endpoint with line-delimited-JSON parsing
 * `[OLLAMA-NATIVE]`. This preserves reference implementation fallback behavior verbatim.
 */
export async function* streamInference(
  messages: RouterMessage[],
  model: string,
  provider: string,
  config: ProviderConfig,
  thinking = false,
): AsyncGenerator<StreamInferenceEvent> {
  const route = await resolveProvider(provider, model, config);
  const { url, headers, isAnthropic } = route;

  let response: Response;

  if (isAnthropic) {
    const { system, messages: anthropicMsgs } = buildAnthropicMessages(messages);
    const body: any = {
      model,
      messages: anthropicMsgs,
      max_tokens: thinking ? 16000 : 4096,
      stream: true,
    };
    if (!thinking) body.temperature = 0.8;
    if (thinking) body.thinking = { type: 'enabled', budget_tokens: 10000 };
    if (system) body.system = system;
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } else {
    const inferMsgs = [...messages];
    // Inject chain-of-thought prompt for non-Anthropic models when thinking is requested
    if (thinking && inferMsgs.length > 0 && inferMsgs[0].role === 'system') {
      inferMsgs[0] = {
        ...inferMsgs[0],
        content: inferMsgs[0].content +
          '\n\nThink through your reasoning step by step inside <think> tags before giving your response.',
      };
    }
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: inferMsgs,
        stream: true,
        ...(provider === 'openrouter' ? { usage: { include: true } } : {}),
        // Reasoning models (DeepSeek R1, o-series via OpenRouter, etc.) put
        // chain-of-thought in a separate reasoning channel, not in content —
        // the <think>-tag prompt injection above cannot reach it. Ask
        // OpenRouter for the channel explicitly; non-reasoning models ignore
        // the param. Gated on `thinking` so the off-state request shape is
        // unchanged.
        ...(thinking && provider === 'openrouter' ? { reasoning: { effort: 'high' } } : {}),
        ...(isOpenAIReasoningModel(model) ? {} : { temperature: 0.8 }),
      }),
    });
  }

  // [OLLAMA-NATIVE] Fallback: if OpenAI-compat fails, try native /api/chat.
  // This is the Ollama-native-format path with line-delimited JSON.
  let useNativeOllama = false;
  if (!response.ok && provider === 'ollama' && config.ollama) {
    const nativeUrl = `${config.ollama.base_url}/api/chat`;
    response = await fetch(nativeUrl, {
      method: 'POST',
      headers,
      // `think` asks think-capable models (R1 distills, qwen3) to return
      // reasoning in message.thinking; older Ollama ignores unknown fields.
      body: JSON.stringify({ model, messages, stream: true, ...(thinking ? { think: true } : {}) }),
    });
    if (response.ok) useNativeOllama = true;
  }

  if (!response.ok || !response.body) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Inference failed (${provider}/${model}): ${response.status} — ${errBody.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let anthropicInThinking = false;
  // Mirrors anthropicInThinking for the OpenAI-compat + Ollama-native
  // branches: reasoning-channel tokens get wrapped in the same synthetic
  // <think>…</think> stream protocol the downstream state machine
  // (api-router.ts) already understands.
  let compatInReasoning = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (useNativeOllama) {
        try {
          const parsed = JSON.parse(trimmed);
          const thinkTok = parsed.message?.thinking;
          if (typeof thinkTok === 'string' && thinkTok) {
            if (!compatInReasoning) { compatInReasoning = true; yield { type: 'token', text: '<think>' }; }
            yield { type: 'token', text: thinkTok };
          }
          const token = parsed.message?.content;
          if (token) {
            if (compatInReasoning) { compatInReasoning = false; yield { type: 'token', text: '</think>\n' }; }
            yield { type: 'token', text: token };
          }
          if (parsed.done) {
            if (compatInReasoning) { compatInReasoning = false; yield { type: 'token', text: '</think>\n' }; }
            return;
          }
        } catch { /* malformed line — skip */ }
      } else if (isAnthropic) {
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'thinking') {
            anthropicInThinking = true;
            yield { type: 'token', text: '<think>' };
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta') {
            yield { type: 'token', text: parsed.delta.thinking };
          } else if (parsed.type === 'content_block_stop' && anthropicInThinking) {
            anthropicInThinking = false;
            yield { type: 'token', text: '</think>\n' };
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield { type: 'token', text: parsed.delta.text };
          } else if (parsed.type === 'message_stop') {
            return;
          }
        } catch { /* malformed line — skip */ }
      } else {
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') {
          // Close an unterminated reasoning block (reasoning-only final
          // chunk shapes) so downstream never sees a dangling <think>.
          if (compatInReasoning) { compatInReasoning = false; yield { type: 'token', text: '</think>\n' }; }
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const usage = openRouterUsage(parsed, provider);
          if (usage) yield { type: 'usage', usage };
          const delta = parsed.choices?.[0]?.delta;
          // Reasoning channel: OpenRouter normalizes to delta.reasoning;
          // DeepSeek-native (and some proxies) use delta.reasoning_content.
          const reasoningTok = typeof delta?.reasoning === 'string'
            ? delta.reasoning
            : typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';
          if (reasoningTok) {
            if (!compatInReasoning) { compatInReasoning = true; yield { type: 'token', text: '<think>' }; }
            yield { type: 'token', text: reasoningTok };
          }
          const token = delta?.content;
          if (token) {
            if (compatInReasoning) { compatInReasoning = false; yield { type: 'token', text: '</think>\n' }; }
            yield { type: 'token', text: token };
          }
        } catch { /* malformed line — skip */ }
      }
    }
  }

  // Stream ended without a terminal marker while reasoning was open —
  // close the block so downstream never sees a dangling <think>.
  if (compatInReasoning) yield { type: 'token', text: '</think>\n' };
}

// ─── Inference with tool loop ────────────────────────────────────

/**
 * Run inference with tool calling support.
 * Handles up to MAX_ITERATIONS of tool calls, converting between
 * Anthropic and OpenAI tool formats as needed.
 *
 * @param executeTool - callback to execute a tool by name with args.
 *   byte-light provides this — routes to MCP servers or native tools via
 *   tools-bridge.executeRouterTool.
 */
export async function* inferenceWithTools(
  messages: RouterMessage[],
  model: string,
  provider: string,
  config: ProviderConfig,
  tools: ToolSchema[],
  executeTool: (name: string, args: Record<string, unknown>) => Promise<{ result: string; ok: boolean }>,
  thinking = false,
): AsyncGenerator<InferenceEvent, void, void> {
  const route = await resolveProvider(provider, model, config);
  const { url, headers, isAnthropic } = route;
  const openaiTools = toolsToOpenAI(tools);

  const conversation = [...messages];
  const allToolResults: ToolResult[] = [];
  let totalUsage: ProviderUsage | undefined;
  const MAX_ITERATIONS = 5;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let resp: Response;

    if (isAnthropic) {
      const { system, messages: anthropicMsgs } = buildAnthropicMessages(conversation);
      const body: any = {
        model,
        messages: anthropicMsgs,
        max_tokens: thinking ? 16000 : 4096,
        stream: false,
      };
      if (!thinking) body.temperature = 0.8;
      if (thinking) body.thinking = { type: 'enabled', budget_tokens: 10000 };
      if (system) body.system = system;
      if (openaiTools.length > 0) {
        body.tools = openaiToolsToAnthropic(openaiTools);
        body.tool_choice = { type: 'auto' };
      }
      resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } else {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: conversation,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
          ...(provider === 'openrouter' ? { usage: { include: true } } : {}),
          ...(thinking && provider === 'openrouter' ? { reasoning: { effort: 'high' } } : {}),
          ...(isOpenAIReasoningModel(model) ? {} : { temperature: 0.8 }),
          stream: false,
        }),
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Inference error (${provider}/${model}) ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    totalUsage = addUsage(totalUsage, openRouterUsage(data, provider));

    if (isAnthropic) {
      // Anthropic Messages API response
      const thinkingParts = (data.content || [])
        .filter((b: any) => b.type === 'thinking')
        .map((b: any) => b.thinking)
        .join('');
      const textParts = (data.content || [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('');
      const toolUses = (data.content || [])
        .filter((b: any) => b.type === 'tool_use');
      const fullText = thinkingParts ? `<think>${thinkingParts}</think>\n${textParts}` : textParts;

      if (toolUses.length === 0) {
        if (fullText.trim()) {
          if (totalUsage) yield { type: 'usage', usage: totalUsage };
          yield { type: 'done', content: fullText, toolResults: allToolResults };
          return;
        }
        break;
      }

      // Build assistant message with tool_use blocks
      const assistantContent: any[] = [];
      if (textParts) assistantContent.push({ type: 'text', text: textParts });
      for (const tu of toolUses) {
        assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
      }
      conversation.push({ role: 'assistant', content: assistantContent } as any);

      // Execute tools and build tool_result blocks
      const toolResultContent: any[] = [];
      for (const tu of toolUses) {
        yield { type: 'tool_start', id: tu.id, name: tu.name, input: tu.input };
        const { result, ok } = await executeTool(tu.name, tu.input);
        allToolResults.push({ id: tu.id, name: tu.name, input: tu.input, result, ok });
        yield { type: 'tool_result', id: tu.id, name: tu.name, output: result, isError: !ok };
        toolResultContent.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
      }
      conversation.push({ role: 'user', content: toolResultContent } as any);

    } else {
      // OpenAI-compatible response
      const choice = data.choices?.[0];
      const message = choice?.message;

      if (!message?.tool_calls?.length) {
        const content = (message?.content || '').trim();
        // Reasoning channel on non-streaming completions: OpenRouter
        // normalizes to message.reasoning, DeepSeek-native uses
        // message.reasoning_content. Re-wrap as <think> so the api-router
        // segment parser surfaces it as a thinking block.
        const reasoningText = typeof message?.reasoning === 'string'
          ? message.reasoning.trim()
          : typeof message?.reasoning_content === 'string' ? message.reasoning_content.trim() : '';
        if (content) {
          if (totalUsage) yield { type: 'usage', usage: totalUsage };
          const full = reasoningText ? `<think>${reasoningText}</think>\n${content}` : content;
          yield { type: 'done', content: full, toolResults: allToolResults };
          return;
        }
        break;
      }

      conversation.push(message);

      for (const tc of message.tool_calls) {
        const fn = tc.function;
        const args = JSON.parse(fn.arguments || '{}');
        yield { type: 'tool_start', id: tc.id, name: fn.name, input: args };
        const { result, ok } = await executeTool(fn.name, args);
        allToolResults.push({ id: tc.id, name: fn.name, input: args, result, ok });
        yield { type: 'tool_result', id: tc.id, name: fn.name, output: result, isError: !ok };
        conversation.push({ role: 'tool', content: result, tool_call_id: tc.id } as any);
      }
    }
  }

  // Max iterations exhausted — nudge for a text response without tools
  try {
    const nudge = 'Please respond to the user now with a direct message. Do not call any more tools.';
    let finalResp: Response;
    if (isAnthropic) {
      const { system, messages: anthropicMsgs } = buildAnthropicMessages([
        ...conversation,
        { role: 'user', content: nudge },
      ]);
      const body: any = { model, messages: anthropicMsgs, max_tokens: 4096, temperature: 0.8, stream: false };
      if (system) body.system = system;
      finalResp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } else {
      finalResp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [...conversation, { role: 'user', content: nudge }],
          ...(provider === 'openrouter' ? { usage: { include: true } } : {}),
          ...(isOpenAIReasoningModel(model) ? {} : { temperature: 0.8 }),
          stream: false,
        }),
      });
    }
    if (finalResp.ok) {
      const finalData = await finalResp.json() as any;
      totalUsage = addUsage(totalUsage, openRouterUsage(finalData, provider));
      let finalContent = '';
      if (isAnthropic) {
        finalContent = (finalData.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      } else {
        finalContent = finalData?.choices?.[0]?.message?.content || '';
      }
      if (finalContent) {
        if (totalUsage) yield { type: 'usage', usage: totalUsage };
        yield { type: 'done', content: finalContent, toolResults: allToolResults };
        return;
      }
    }
  } catch { /* fall through */ }

  const names = allToolResults.map(r => r.name).join(', ');
  // Empty final completion. Do NOT fabricate a non-empty placeholder for the
  // no-tools case: a synthetic string like '[No response from model]' reads as
  // real assistant text downstream (api-router emits it as a text_delta), which
  // defeats the agent's empty-stream corpse suppression (it only skips
  // persistence when `!fullResponse.trim()` — agent.ts:1776) and leaves a
  // visible "[No response from model]" corpse in the thread with no real turn
  // behind it. Yield empty content instead and let the shared empty-stream path
  // (done.finishReason 'stop' + blank text → endedSilently → no persisted
  // message) handle it. The `[Used tools: …]` summary stays: tools genuinely
  // ran, so a factual trailer is legitimate assistant text, not a corpse.
  if (totalUsage) yield { type: 'usage', usage: totalUsage };
  yield {
    type: 'done',
    content: allToolResults.length > 0
      ? `[Used tools: ${names} — but couldn't produce a final response]`
      : '',
    toolResults: allToolResults,
  };
}

// ─── Config loader ───────────────────────────────────────────────

/**
 * Read provider config from bytelight.yaml. byte-light's `BytelightConfig`
 * declares `providers` as a strongly-typed block (`{ ollama?, openrouter?,
 * ... }` — see config.ts:50-72), so the cast back to `ProviderConfig`
 * carries through. reference implementation version reached through `(cfg as any).providers`;
 * we drop the `any` because the field is typed properly.
 */
export function loadProviderConfig(): ProviderConfig {
  const cfg = getBytelightConfig();
  return (cfg.providers ?? {}) as ProviderConfig;
}
