import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferenceWithTools,
  streamInference,
  type InferenceEvent,
  type ProviderConfig,
  type StreamInferenceEvent,
  type ToolSchema,
} from './router.js';

const CONFIG: ProviderConfig = { openrouter: { api_key: 'test-key' } };
let originalFetch: typeof globalThis.fetch;

beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

async function drain<T>(gen: AsyncGenerator<T, void, void>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('OpenRouter provider-native usage', () => {
  test('captures exact usage and cost from the final streaming SSE chunk', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":7,"cost":0.0042,"prompt_tokens_details":{"cached_tokens":40}}}',
      'data: [DONE]',
      '',
    ].join('\n');
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.usage, { include: true });
      assert.equal(body.max_tokens, 8192);
      assert.equal(body.session_id, 'bl-cache-test');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;

    const events = await drain<StreamInferenceEvent>(
      streamInference([{ role: 'user', content: 'hi' }], 'z-ai/glm-5.2', 'openrouter', CONFIG, false, 'bl-cache-test'),
    );

    assert.deepEqual(events, [
      { type: 'token', text: 'hello' },
      { type: 'usage', usage: { input: 123, output: 7, cacheRead: 40, cost: 0.0042 } },
    ]);
  });

  test('accumulates every tool-loop receipt, including the max-iteration final nudge', async () => {
    const tool: ToolSchema = { name: 'lookup', description: 'lookup', input_schema: { type: 'object' } };
    let call = 0;
    globalThis.fetch = (async (_url, init) => {
      call += 1;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.usage, { include: true });
      assert.equal(body.session_id, 'bl-tools-cache-test');
      if (call <= 5) {
        return Response.json({
          choices: [{ message: { content: '', tool_calls: [{ id: `c${call}`, function: { name: 'lookup', arguments: '{}' } }] } }],
          usage: { prompt_tokens: 10 * call, completion_tokens: call, cost: 0.01 * call },
        });
      }
      return Response.json({
        choices: [{ message: { content: 'final answer', tool_calls: [] } }],
        usage: { prompt_tokens: 60, completion_tokens: 6, cost: 0.06 },
      });
    }) as typeof globalThis.fetch;

    const events = await drain<InferenceEvent>(inferenceWithTools(
      [{ role: 'user', content: 'use tools' }],
      'z-ai/glm-5.2',
      'openrouter',
      CONFIG,
      [tool],
      async () => ({ result: 'ok', ok: true }),
      false,
      5, // Explicitly exercise the bounded final-nudge receipt path.
      'bl-tools-cache-test',
    ));

    assert.equal(call, 6);
    const usage = events.find((event) => event.type === 'usage');
    assert.equal(usage?.type, 'usage');
    if (usage?.type !== 'usage') throw new Error('missing usage event');
    assert.equal(usage.usage.input, 210);
    assert.equal(usage.usage.output, 21);
    assert.ok(Math.abs((usage.usage.cost ?? 0) - 0.21) < 1e-12);
    const done = events.find((event) => event.type === 'done');
    assert.equal(done?.type === 'done' ? done.content : undefined, 'final answer');
  });
});
