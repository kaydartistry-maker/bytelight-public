import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TOOL_ITERATIONS, inferenceWithTools, type InferenceEvent, type ToolSchema } from './router.js';

const config = { openrouter: { api_key: 'synthetic-unit-test-key' } };
const tool: ToolSchema = { name: 'workspace_step', description: 'Synthetic bounded step', input_schema: { type: 'object' } };
let original: typeof globalThis.fetch;
beforeEach(() => { original = globalThis.fetch; });
afterEach(() => { globalThis.fetch = original; });
async function drain(generator: AsyncGenerator<InferenceEvent, void, void>) {
  const events: InferenceEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}
const step = (n: number) => Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 'step-' + n, function: { name: tool.name, arguments: JSON.stringify({ step: n }) } }] } }] });
const answer = (text: string) => Response.json({ choices: [{ message: { content: text, tool_calls: [] } }] });

test('ordinary native API turns complete six sequential tool rounds and artifact readback without changing model', async () => {
  let requests = 0, executions = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    assert.equal(body.model, 'google/gemini-4-neon'); assert.ok(body.tools?.length, 'No early tool-less nudge after five rounds');
    return requests <= 6 ? step(requests) : answer('ARTIFACT_READBACK_COMPLETE');
  }) as typeof globalThis.fetch;
  const events = await drain(inferenceWithTools([{ role: 'user', content: 'Synthetic inspect/write/edit/build/wait/read sequence' }], 'google/gemini-4-neon', 'openrouter', config, [tool], async (_name, args) => {
    executions++; assert.equal(args.step, executions); return { ok: true, result: 'step complete' };
  }));
  assert.equal(requests, 7); assert.equal(executions, 6);
  assert.equal(events.filter(e => e.type === 'tool_result').length, 6);
  assert.ok(events.some(e => e.type === 'done' && e.content === 'ARTIFACT_READBACK_COMPLETE'));
});

test('default budget remains finite: exactly 25 tool rounds and one final tool-less nudge', async () => {
  let requests = 0, executions = 0;
  assert.equal(DEFAULT_TOOL_ITERATIONS, 25);
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    if (body.tools) return step(requests);
    assert.equal(requests, 26); assert.match(body.messages.at(-1).content, /Do not call any more tools/);
    return answer('BOUND_REACHED_HONESTLY');
  }) as typeof globalThis.fetch;
  const events = await drain(inferenceWithTools([{ role: 'user', content: 'Synthetic exhaustion check' }], 'google/gemini-4-neon', 'openrouter', config, [tool], async () => { executions++; return { ok: true, result: 'ok' }; }));
  assert.equal(executions, 25); assert.equal(requests, 26);
  assert.ok(events.some(e => e.type === 'done' && e.content === 'BOUND_REACHED_HONESTLY'));
});

test('optional caller budget is validated and exhaustion never executes extra tools', async () => {
  let requests = 0, executions = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    return body.tools ? step(requests) : answer('TWO_ROUND_LIMIT');
  }) as typeof globalThis.fetch;
  await drain(inferenceWithTools([{ role: 'user', content: 'Synthetic lower bound' }], 'google/gemini-4-neon', 'openrouter', config, [tool], async () => { executions++; return { ok: true, result: 'ok' }; }, false, 2));
  assert.equal(requests, 3); assert.equal(executions, 2);
});

test('invalid iteration budgets fail before any provider request or tool side effect', async () => {
  let requests = 0, executions = 0;
  globalThis.fetch = (async () => { requests++; return answer('unexpected'); }) as typeof globalThis.fetch;
  for (const limit of [0, -1, 1.5, 101, Number.NaN]) {
    await assert.rejects(drain(inferenceWithTools([{ role: 'user', content: 'invalid' }], 'google/gemini-4-neon', 'openrouter', config, [tool], async () => { executions++; return { ok: true, result: 'unexpected' }; }, false, limit)), /integer from 1 to 100/);
  }
  assert.equal(requests, 0); assert.equal(executions, 0);
});
