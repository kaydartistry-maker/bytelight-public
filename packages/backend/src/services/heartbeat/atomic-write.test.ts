// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.js';

// io/.last-tick has two writers in two processes, the Stop hook and the
// supervisor. A scratch name another writer can be holding is a write that can
// fail for reasons that have nothing to do with this one (2026-09-26, 05:43Z).

function scratchCopiesOf(dir: string, name: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(name + '.') && f.endsWith('.tmp'));
}

test('a scratch name another writer is holding does not stop this write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bytelight-atomic-write-'));
  try {
    const target = join(dir, '.last-tick');
    // The other writer's scratch copy, mid-write, under the old shared name.
    mkdirSync(target + '.tmp');
    atomicWrite(target, '12345');
    assert.strictEqual(readFileSync(target, 'utf8'), '12345');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a write that fails leaves no scratch copy of its own behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bytelight-atomic-write-'));
  try {
    const target = join(dir, '.last-tick');
    mkdirSync(target); // nothing can be renamed over a directory
    assert.throws(() => atomicWrite(target, '12345'));
    assert.deepStrictEqual(scratchCopiesOf(dir, '.last-tick'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
