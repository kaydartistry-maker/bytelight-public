// What is already written near this line?
//
// Shared walls can return neighboring text because every companion receives
// them. Another companion's private wall returns a count only: enough to know
// related memory exists, never enough to disclose it.
import { embed } from './embeddings.js';
import * as memoryBlocks from './memory-blocks.js';

export interface NeighborHit {
  scope: string;
  label: string;
  /** Absent on another companion's private wall. */
  text?: string;
  similarity: number;
}

export interface NeighborReport {
  near: NeighborHit[];
  elsewhere: { scope: string; label: string; hits: number }[];
}

const MIN_LINE = 40;
const THRESHOLD = 0.6;
const TOP_N = 3;
const MAX_LINES_PER_BLOCK = 500;

interface CacheEntry {
  fingerprint: string;
  lines: { text: string; vec: Float32Array }[];
}
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry['lines']>>();

/** Past this, the write lands without its neighbor report rather than waiting. */
export const NEIGHBOR_BUDGET_MS = 5000;

function fingerprintOf(content: string): string {
  return `${content.length}:${content.slice(0, 64)}:${content.slice(-64)}`;
}

function splitLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_LINE)
    .slice(0, MAX_LINES_PER_BLOCK);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function vectorsFor(
  scope: string,
  label: string,
  content: string,
  embedFn: (text: string) => Promise<Float32Array>,
) {
  const key = `${scope}/${label}`;
  const fingerprint = fingerprintOf(content);
  // A search that outran its budget keeps running. If one is already embedding
  // this wall, wait for it and build on its vectors instead of starting a
  // second full pass beside it (after a restart, every save would otherwise
  // launch its own whole-wall embed).
  const running = inflight.get(key);
  if (running) await running.catch(() => undefined);
  const hit = cache.get(key);
  if (hit && hit.fingerprint === fingerprint) return hit.lines;
  const work = embedLines(key, fingerprint, content, hit, embedFn);
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    if (inflight.get(key) === work) inflight.delete(key);
  }
}

async function embedLines(
  key: string,
  fingerprint: string,
  content: string,
  hit: CacheEntry | undefined,
  embedFn: (text: string) => Promise<Float32Array>,
) {
  // An append changes the block's fingerprint, but every older line is the
  // same text it was. Reuse those vectors so a long wall costs one embed per
  // new line instead of one per line it has ever held.
  const known = new Map((hit?.lines ?? []).map((line) => [line.text, line.vec]));
  const lines: CacheEntry['lines'] = [];
  for (const text of splitLines(content)) {
    lines.push({ text, vec: known.get(text) ?? (await embedFn(text)) });
  }
  cache.set(key, { fingerprint, lines });
  return lines;
}

export interface NeighborDeps {
  getBlocks: () => { scope: string; label: string; content: string }[];
  embed: (text: string) => Promise<Float32Array>;
}

const defaultDeps: NeighborDeps = {
  getBlocks: () => memoryBlocks.getAllBlocks(),
  embed,
};

/** Find semantically similar existing lines without crossing private scopes. */
export async function findNeighbors(
  writerScope: string,
  content: string,
  deps: NeighborDeps = defaultDeps,
): Promise<NeighborReport> {
  const probe = await deps.embed(content);
  const near: NeighborHit[] = [];
  const elsewhere: NeighborReport['elsewhere'] = [];

  for (const block of deps.getBlocks()) {
    if (!block.content) continue;
    const readable = block.scope === memoryBlocks.SHARED_SCOPE || block.scope === writerScope;
    const lines = await vectorsFor(block.scope, block.label, block.content, deps.embed);
    const hits = lines
      .map((line) => ({ text: line.text, similarity: cosine(probe, line.vec) }))
      .filter((hit) => hit.similarity >= THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity);
    if (!hits.length) continue;
    if (readable) {
      for (const hit of hits.slice(0, TOP_N)) {
        near.push({ scope: block.scope, label: block.label, text: hit.text, similarity: hit.similarity });
      }
    } else {
      elsewhere.push({ scope: block.scope, label: block.label, hits: hits.length });
    }
  }

  near.sort((a, b) => b.similarity - a.similarity);
  return { near: near.slice(0, TOP_N), elsewhere };
}

/**
 * findNeighbors, but never longer than budgetMs. Returns null on timeout or
 * failure: the report is a courtesy, the write is the job. A search that runs
 * past the budget keeps going in the background and warms the cache for the
 * next write.
 */
export async function findNeighborsWithin(
  writerScope: string,
  content: string,
  budgetMs: number = NEIGHBOR_BUDGET_MS,
  deps: NeighborDeps = defaultDeps,
): Promise<NeighborReport | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const search = findNeighbors(writerScope, content, deps).catch(() => null);
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([search, budget]);
  } finally {
    clearTimeout(timer);
  }
}
