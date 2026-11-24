/** OpenAI image models via OpenRouter's dedicated Image API. No persistence or billing consent is performed here. */
const ENDPOINT = 'https://openrouter.ai/api/v1/images';
const TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_REFERENCE_LENGTH = 24 * 1024 * 1024;
const ASPECT_RATIOS = new Set(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', 'auto', '4:5', '5:4', '2:1', '1:2', '3:1', '1:3']);
// Verified against public /images/models and each /endpoints on 2026-11-17.
// GPT Image 1.5 is deliberately absent: its OpenRouter image endpoint returned 404.
const MODELS: Readonly<Record<string, string>> = Object.freeze({
  'gpt-image-2.5-sunburst': 'openai/gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare': 'openai/gpt-image-2.5-flare',
  'gpt-image-2': 'openai/gpt-image-2',
});

export interface OpenRouterImageInput {
  apiKey: string;
  modelId: string;
  prompt: string;
  refs?: readonly string[];
  aspectRatio?: string;
  quality?: 'auto' | 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface OpenRouterImageResult {
  image: Buffer;
  mediaType: 'image/png';
  model: string;
  /** Actual provider-reported USD; null means unavailable, never "free". */
  costUsd: number | null;
}

export class OpenRouterImageError extends Error {
  constructor(message: string) { super(message); this.name = 'OpenRouterImageError'; }
}

function fail(message: string): never { throw new OpenRouterImageError(message); }
function validBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    && Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail('OpenRouter image response exceeded the size limit.');
  if (!response.body) fail('OpenRouter returned no image response.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) fail('OpenRouter image response exceeded the size limit.');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Does not retry or fall back to another model/provider, and never exposes raw provider errors. */
export async function generateOpenRouterImage(
  input: OpenRouterImageInput,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OpenRouterImageResult> {
  const model = typeof input.modelId === 'string' && (Object.hasOwn(MODELS, input.modelId) ? MODELS[input.modelId] : Object.values(MODELS).find(id => id === input.modelId));
  if (!model) fail('That OpenAI image model is not supported through OpenRouter.');
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey)) fail('The existing OpenRouter API key is unavailable or invalid.');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 48_000) fail('The image prompt is missing or too long.');
  if (input.aspectRatio !== undefined && !ASPECT_RATIOS.has(input.aspectRatio)) fail('That aspect ratio is not supported by this OpenRouter image model.');
  if (input.quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(input.quality)) fail('That quality setting is not supported by this OpenRouter image model.');
  const refs = input.refs ?? [];
  if (!Array.isArray(refs) || refs.length > 16) fail('OpenRouter image generation accepts at most sixteen references.');
  let totalReferenceLength = 0;
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref.length > MAX_REFERENCE_LENGTH) fail('An image reference is invalid or too large.');
    const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(ref);
    if (!match || !validBase64(match[1])) fail('Image references must be valid base64 image data URLs.');
    totalReferenceLength += ref.length;
    if (totalReferenceLength > 192 * 1024 * 1024) fail('The combined image references exceed the request size limit.');
  }
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(input.signal ? [input.signal] : [])]);
  if (signal.aborted) fail('OpenRouter image generation was cancelled.');
  const body = {
    model, prompt: input.prompt, n: 1, output_format: 'png',
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(refs.length ? { input_references: refs.map(url => ({ type: 'image_url', image_url: { url } })) } : {}),
  };
  let raw: unknown;
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Virelle Art Studio' },
      body: JSON.stringify(body), signal, redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(`OpenRouter image request failed (HTTP ${response.status}). Check account access, credits and the selected model.`);
    }
    raw = await boundedJson(response);
  } catch (error) {
    if (error instanceof OpenRouterImageError) throw error;
    if (signal.aborted) fail(input.signal?.aborted ? 'OpenRouter image generation was cancelled.' : 'OpenRouter image generation timed out.');
    fail('OpenRouter image generation could not complete. No automatic retry was made.');
  }
  const data = raw as { data?: Array<{ b64_json?: unknown; media_type?: unknown }>; usage?: { cost?: unknown } } | null;
  if (!data || !Array.isArray(data.data) || data.data.length !== 1) fail('OpenRouter returned an invalid image result.');
  const item = data.data[0];
  if (!item || typeof item.b64_json !== 'string' || !validBase64(item.b64_json)) fail('OpenRouter returned invalid image bytes.');
  const image = Buffer.from(item.b64_json, 'base64');
  if (item.media_type !== undefined && item.media_type !== 'image/png') fail('OpenRouter returned an unexpected image format.');
  if (image.length < 8 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('OpenRouter returned invalid PNG image bytes.');
  const cost = data.usage?.cost;
  return { image, mediaType: 'image/png', model, costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null };
}
