import test from 'node:test';
import assert from 'node:assert/strict';
import { studioImageAspect } from './studio-image-aspect.js';
import { generateOpenRouterImage } from './studio-openrouter.js';

test('semantic presets survive rounded pixel sizes and custom sizes preserve their exact ratio', () => {
  assert.equal(studioImageAspect('21:9', '1536x658'), '21:9');
  assert.equal(studioImageAspect('portrait', '1024x1536'), '2:3');
  assert.equal(studioImageAspect('custom', '1280x1024'), '5:4');
  assert.equal(studioImageAspect('square', '1024x1024'), '1:1');
  assert.throws(() => studioImageAspect('custom', 'NaNx0'), /valid/);
});

test('the OpenRouter wrapper sends semantic ultrawide and refuses unsupported custom geometry before fetch', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  let calls = 0;
  const mockFetch: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init!.body as string).aspect_ratio, '21:9');
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.04 } }), { headers: { 'content-type': 'application/json' } });
  };
  await generateOpenRouterImage({ apiKey: 'fixture-key', modelId: 'gpt-image-2.5-sunburst', prompt: 'test', aspectRatio: studioImageAspect('21:9', '1536x658') }, mockFetch);
  assert.equal(calls, 1);
  await assert.rejects(generateOpenRouterImage({ apiKey: 'fixture-key', modelId: 'gpt-image-2.5-sunburst', prompt: 'test', aspectRatio: studioImageAspect('custom', '1000x733') }, mockFetch), /aspect ratio/);
  assert.equal(calls, 1);
});
