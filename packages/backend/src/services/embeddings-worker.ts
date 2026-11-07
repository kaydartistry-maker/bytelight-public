// Embeddings sidecar — the only process that loads onnxruntime.
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { errMessage } from '../util/errors.js';

const MODEL_ID = 'sentence-transformers/all-MiniLM-L6-v2';
let pipeline: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;
let embedsSinceSpawn = 0;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (pipeline) return pipeline;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const { pipeline: createPipeline } = await import('@huggingface/transformers');
    console.log('[embeddings-worker] Loading model…');
    const p = await createPipeline('feature-extraction', MODEL_ID, { dtype: 'fp32', revision: 'main' });
    console.log('[embeddings-worker] Model loaded.');
    pipeline = p as FeatureExtractionPipeline;
    loadingPromise = null;
    return pipeline;
  })();
  return loadingPromise;
}

async function embedText(text: string): Promise<Float32Array> {
  const p = await getPipeline();
  const output = await p(text.length > 2000 ? text.slice(0, 2000) : text, { pooling: 'mean', normalize: true });
  try { return new Float32Array(output.data as Float32Array); }
  finally { (output as { dispose?: () => void })?.dispose?.(); embedsSinceSpawn++; }
}

if (!process.send) {
  console.error('[embeddings-worker] Not spawned via fork IPC — exiting.');
  process.exit(1);
}

process.on('message', async (msg: { id: number; text: string }) => {
  try {
    const vector = await embedText(msg.text);
    process.send?.({ id: msg.id, vector, rssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024), embedsSinceSpawn });
  } catch (err) {
    process.send?.({ id: msg.id, error: errMessage(err) });
  }
});

process.on('disconnect', () => process.exit(0));
