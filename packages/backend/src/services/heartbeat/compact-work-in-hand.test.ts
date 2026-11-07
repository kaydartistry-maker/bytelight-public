// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionSessionDir } from './provision.js';
import { activityTailIsOpen } from './supervisor.js';

// A room squashing its memory can go five minutes without a tick, a chunk or
// a tool line, and the watchdog used to kill it mid-squash. The room it
// reopened was still too full, went straight back to compacting, and was
// killed the same way, so the house built a new room and the old one was
// gone. A compaction now opens and closes like a tool, which both clocks
// already wait on.

function lane(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bytelight-compact-'));
  provisionSessionDir(dir);
  return dir;
}

function runActivity(dir: string, phase: 'pre' | 'post', hookInput: object) {
  return spawnSync(process.execPath, [join(dir, 'hooks', 'activity.cjs'), phase, 'compact'], {
    cwd: dir,
    input: JSON.stringify(hookInput),
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('the lane is wired to mark a compaction from its start to its end', () => {
  const dir = lane();
  try {
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    const commands = (event: string): string[] =>
      (settings.hooks[event] ?? []).flatMap((m: { hooks: { command: string }[] }) => m.hooks.map((h) => h.command));
    const activity = join(dir, 'hooks', 'activity.cjs');
    assert.deepStrictEqual(commands('PreCompact'), [`node "${activity}" pre compact`]);
    assert.deepStrictEqual(commands('PostCompact'), [`node "${activity}" post compact`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a compaction counts as work in hand until it finishes, under one id', () => {
  const dir = lane();
  try {
    const log = join(dir, 'io', 'activity.jsonl');
    assert.strictEqual(runActivity(dir, 'pre', { hook_event_name: 'PreCompact', trigger: 'auto' }).status, 0);
    const opened = readFileSync(log, 'utf8');
    assert.strictEqual(activityTailIsOpen(opened), true, 'the watchdog must see work in hand');
    const start = JSON.parse(opened.trim().split('\n').pop()!);
    assert.strictEqual(start.tool, 'Compacting');
    assert.strictEqual(start.id, 'compact');

    assert.strictEqual(runActivity(dir, 'post', { hook_event_name: 'PostCompact', trigger: 'auto' }).status, 0);
    const closed = readFileSync(log, 'utf8');
    assert.strictEqual(activityTailIsOpen(closed), false);
    // The reply window pairs a start with its end by id; both halves run as
    // separate processes, so the id has to be the same fixed one.
    assert.strictEqual(JSON.parse(closed.trim().split('\n').pop()!).id, 'compact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
