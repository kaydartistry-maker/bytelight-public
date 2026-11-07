/**
 * Warm-lane context gauge — transcript reader invariants:
 *   • usage sums assistant entries; contextTokens is the LAST turn's window
 *     occupancy, not an accumulation,
 *   • '<synthetic>' death certificates never count as replies or name the model,
 *   • native compaction summaries are counted (the banner's transition signal),
 *   • the size+mtime cache recounts a grown file rather than trusting it,
 *   • contextWindowFor resolves exact, dated-prefix, and unknown ids.
 */
import assert from 'node:assert/strict';
import { describe, test, afterEach } from 'node:test';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readSessionUsage, contextWindowFor, projectKeyForDir,
  DEFAULT_CONTEXT_WINDOW_TOKENS, __resetUsageCacheForTests,
} from './transcript-usage.js';

const dir = mkdtempSync(join(tmpdir(), 'bl-transcript-'));
afterEach(() => __resetUsageCacheForTests());

function assistantLine(usage: Record<string, number>, model = 'claude-fable-5'): string {
  return JSON.stringify({ type: 'assistant', message: { model, usage } });
}

function writeTranscript(name: string, lines: string[]): { path: string; size: number; mtime: number } {
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  const st = statSync(path);
  return { path, size: st.size, mtime: st.mtimeMs };
}

describe('readSessionUsage', () => {
  test('sums totals; contextTokens is the last turn, not an accumulation', async () => {
    const f = writeTranscript('sum.jsonl', [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistantLine({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
      assistantLine({ input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
    ]);
    const u = await readSessionUsage(f.path, f.size, f.mtime);
    assert.ok(u);
    assert.equal(u.replies, 2);
    assert.equal(u.inputTokens, 30);
    assert.equal(u.outputTokens, 12);
    assert.equal(u.cacheReadTokens, 300);
    assert.equal(u.cacheWriteTokens, 80);
    assert.equal(u.contextTokens, 20 + 200 + 30, 'gauge is the LAST assistant turn');
    assert.equal(u.model, 'claude-fable-5');
  });

  test('synthetic death certificate never counts or names the model', async () => {
    const f = writeTranscript('synth.jsonl', [
      assistantLine({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 }),
      assistantLine({ input_tokens: 0, output_tokens: 0 }, '<synthetic>'),
    ]);
    const u = await readSessionUsage(f.path, f.size, f.mtime);
    assert.ok(u);
    assert.equal(u.replies, 1);
    assert.equal(u.model, 'claude-fable-5');
    assert.equal(u.contextTokens, 100, 'synthetic entry must not zero the gauge');
  });

  test('counts native compaction summaries', async () => {
    const f = writeTranscript('compact.jsonl', [
      assistantLine({ input_tokens: 10, output_tokens: 5 }),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'summary of everything' } }),
      assistantLine({ input_tokens: 5, output_tokens: 2 }),
    ]);
    const u = await readSessionUsage(f.path, f.size, f.mtime);
    assert.ok(u);
    assert.equal(u.compactions, 1);
  });

  test('a grown file is recounted, not trusted from cache', async () => {
    const f1 = writeTranscript('grow.jsonl', [
      assistantLine({ input_tokens: 10, output_tokens: 5 }),
    ]);
    const first = await readSessionUsage(f1.path, f1.size, f1.mtime);
    assert.equal(first?.replies, 1);
    const f2 = writeTranscript('grow.jsonl', [
      assistantLine({ input_tokens: 10, output_tokens: 5 }),
      assistantLine({ input_tokens: 20, output_tokens: 5 }),
    ]);
    const second = await readSessionUsage(f2.path, f2.size, f2.mtime + 1);
    assert.equal(second?.replies, 2, 'size/mtime change busts the cache');
  });

  test('a transcript with no assistant turns reads as undefined', async () => {
    const f = writeTranscript('empty.jsonl', [
      JSON.stringify({ type: 'user', message: { content: 'hello?' } }),
    ]);
    assert.equal(await readSessionUsage(f.path, f.size, f.mtime), undefined);
  });
});

describe('contextWindowFor', () => {
  test('exact catalog id', () => {
    assert.equal(contextWindowFor('claude-fable-5'), 1_000_000);
  });
  test('dated id resolves via longest catalog prefix', () => {
    assert.equal(contextWindowFor('claude-sonnet-4-5-20250929'), 200_000);
  });
  test('unknown id falls back to the default window', () => {
    assert.equal(contextWindowFor('mystery-model-9'), DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});

describe('projectKeyForDir', () => {
  test('matches Claude Code transcript-dir slugging', () => {
    assert.equal(
      projectKeyForDir('/home/operator/byte-light/data/heartbeat/primary'),
      '-home-operator-byte-light-data-heartbeat-primary',
    );
  });
});

// Scratch-dir janitor — node:test has no global afterAll here; final cleanup.
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } });
