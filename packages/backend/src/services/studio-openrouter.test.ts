import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOpenRouterImage, type OpenRouterImageInput } from './studio-openrouter.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const ref = 'data:image/png;base64,' + png.toString('base64');
const input = (): OpenRouterImageInput => ({ apiKey: 'test-only-secret', modelId: 'gpt-image-2.5-sunburst', prompt: 'opal paper garden' });
const result = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.13 }, ...extra }), { status: 200 });
const mock = (fn: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch => (async (url, init) => fn(String(url), init!)) as typeof fetch;

test('dedicated OpenRouter Image API receives the existing key, exact OpenAI model and all ordered references', async () => {
  let calls = 0;
  const output = await generateOpenRouterImage({ ...input(), refs: [ref, ref], aspectRatio: '3:4', quality: 'high' }, mock((url, init) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/images'); assert.equal(init.method, 'POST');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-only-secret');
    assert.ok(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, false);
    assert.deepEqual(JSON.parse(String(init.body)), { model: 'openai/gpt-image-2.5-sunburst', prompt: 'opal paper garden', n: 1, output_format: 'png', aspect_ratio: '3:4', quality: 'high', input_references: [{ type: 'image_url', image_url: { url: ref } }, { type: 'image_url', image_url: { url: ref } }] });
    return result();
  }));
  assert.equal(calls, 1); assert.deepEqual(output.image, png); assert.equal(output.mediaType, 'image/png'); assert.equal(output.costUsd, 0.13); assert.equal(output.model, 'openai/gpt-image-2.5-sunburst');
});

for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2']) test('allowlisted model is routed exactly: ' + model, async () => {
  const r = await generateOpenRouterImage({ ...input(), modelId: model }, mock((_url, init) => { const body = JSON.parse(String(init.body)); assert.equal(body.model, 'openai/' + model); assert.equal(body.input_references, undefined); return result(); }));
  assert.equal(r.model, 'openai/' + model);
});

test('qualified IDs are accepted only for the same verified allowlist', async () => {
  assert.equal((await generateOpenRouterImage({ ...input(), modelId: 'openai/gpt-image-2' }, mock(() => result()))).model, 'openai/gpt-image-2');
});

for (const modelId of ['gpt-image-1.5', 'openai/gpt-image-1.5', 'google/gemini-3-pro-image', 'unknown', 'constructor', '__proto__', 'toString']) test('rejects unavailable or non-OpenAI model before any request: ' + modelId, async () => {
  await assert.rejects(generateOpenRouterImage({ ...input(), modelId }, mock(() => { throw Error('must not fetch'); })), /not supported through OpenRouter/);
});

test('unknown options cannot reach OpenRouter or change endpoint/output count', async () => {
  await generateOpenRouterImage({ ...input(), size: '9999x9999', n: 10, output_format: 'svg', provider: { order: ['unknown'] } } as OpenRouterImageInput, mock((_url, init) => {
    assert.deepEqual(Object.keys(JSON.parse(String(init.body))).sort(), ['model', 'n', 'output_format', 'prompt']); return result();
  }));
});

for (const patch of [{ apiKey: '' }, { apiKey: 'secret\r\nHeader: value' }, { prompt: '' }, { aspectRatio: '999:1' }, { quality: 'max' }, { refs: Array(17).fill(ref) }, { refs: ['https://private.example/photo'] }, { refs: ['data:image/png;base64,not-base64'] }]) test('invalid request fails locally without invoking provider: ' + Object.keys(patch)[0], async () => {
  let calls = 0; await assert.rejects(generateOpenRouterImage({ ...input(), ...patch } as OpenRouterImageInput, mock(() => { calls++; return result(); }))); assert.equal(calls, 0);
});

test('a cancelled caller signal blocks dispatch without billing', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(generateOpenRouterImage({ ...input(), signal: controller.signal }, mock(() => { calls++; return result(); })), /cancelled/); assert.equal(calls, 0);
});

test('cancellation during fetch has a safe error without the provider secret', async () => {
  const controller = new AbortController();
  await assert.rejects(generateOpenRouterImage({ ...input(), signal: controller.signal }, mock((_url, init) => { controller.abort(); assert.equal(init.signal!.aborted, true); throw Error('test-only-secret raw provider body'); })), error => {
    assert.match(String(error), /cancelled/); assert.doesNotMatch(String(error), /test-only-secret|raw provider/); return true;
  });
});

test('HTTP errors are safe, single-attempt and do not include the raw response body', async () => {
  let calls = 0;
  await assert.rejects(generateOpenRouterImage(input(), mock(() => { calls++; return new Response('test-only-secret sensitive provider content', { status: 403 }); })), error => {
    assert.match(String(error), /HTTP 403/); assert.doesNotMatch(String(error), /test-only-secret|sensitive provider/); return true;
  }); assert.equal(calls, 1);
});

test('network and malformed JSON errors never echo potentially secret-bearing exception text', async () => {
  for (const fetcher of [mock(() => { throw Error('test-only-secret network detail'); }), mock(() => new Response('test-only-secret invalid-json'))]) {
    await assert.rejects(generateOpenRouterImage(input(), fetcher), error => { assert.match(String(error), /could not complete/); assert.doesNotMatch(String(error), /test-only-secret|network detail|invalid-json/); return true; });
  }
});

for (const data of [null, {}, { data: [] }, { data: [{ b64_json: 'not-base64' }] }, { data: [{ b64_json: Buffer.from('not PNG').toString('base64') }] }, { data: [{ b64_json: png.toString('base64'), media_type: 'image/svg+xml' }] }, { data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }] }]) test('invalid result is rejected without writing an artifact: ' + JSON.stringify(data).slice(0, 40), async () => {
  await assert.rejects(generateOpenRouterImage(input(), mock(() => new Response(JSON.stringify(data)))), /invalid|unexpected/);
});

test('oversized responses are rejected before decoding', async () => {
  await assert.rejects(generateOpenRouterImage(input(), mock(() => new Response('{}', { headers: { 'content-length': String(49 * 1024 * 1024) } }))), /size limit/);
});

test('absent media type is accepted only when the actual bytes have PNG signature', async () => {
  assert.equal((await generateOpenRouterImage(input(), mock(() => result({ data: [{ b64_json: png.toString('base64') }] })))).mediaType, 'image/png');
});

for (const cost of [undefined, null, '0.1', -1, 0, 0.17]) test('cost is actual nonnegative USD or unknown, never fabricated: ' + String(cost), async () => {
  const r = await generateOpenRouterImage(input(), mock(() => result({ usage: { cost } })));
  assert.equal(r.costUsd, typeof cost === 'number' && cost >= 0 ? cost : null);
});
