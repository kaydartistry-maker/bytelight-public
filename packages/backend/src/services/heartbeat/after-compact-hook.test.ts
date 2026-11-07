// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { provisionSessionDir } from './provision.js';
import { DRIFT_TEXT_BUDGET, driftFitsInline, renderDrift } from './block-drift.js';

// A note meant to tell a room it had just been squashed, written into
// PostCompact's output, never reaches the room: Claude Code only ever shows
// that output on a screen. SessionStart with the "compact" matcher is the slot
// that is read back in. Separately, hook commands named by a short path fail
// whenever the shell stands in a subfolder, which turns the guest gate off
// for that stretch.

function lane(): string {
  const root = mkdtempSync(join(tmpdir(), 'bytelight-after-compact-'));
  const dir = join(root, 'data', 'heartbeat', 'primary');
  mkdirSync(dir, { recursive: true });
  provisionSessionDir(dir);
  return dir;
}

function settingsOf(dir: string) {
  return JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
}

function scriptOf(command: string): string {
  const quoted = /^node "([^"]+)"/.exec(command);
  return quoted ? quoted[1] : command.split(' ')[1];
}

test('a squash hands the room a note through the slot Claude Code reads back in', () => {
  const dir = lane();
  try {
    const entries = settingsOf(dir).hooks.SessionStart ?? [];
    const compact = entries.filter((entry: { matcher?: string }) => entry.matcher === 'compact');
    assert.strictEqual(compact.length, 1, 'one SessionStart hook for compactions');
    const script = scriptOf(compact[0].hooks[0].command);
    assert.ok(script.endsWith('compacted.cjs'));
    assert.ok(existsSync(script), 'the hook it names is written beside the others');
  } finally { rmSync(join(dir, '..', '..', '..'), { recursive: true, force: true }); }
});

test('every hook is found by an absolute path, so a shell standing in a subfolder still finds the gate', () => {
  const dir = lane();
  try {
    const hooks = settingsOf(dir).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    for (const [event, entries] of Object.entries(hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          const script = scriptOf(h.command);
          assert.ok(isAbsolute(script), `${event} names ${script} by a short path`);
          assert.ok(existsSync(script), `${event} names ${script}, which does not exist`);
        }
      }
    }
    // A guest turn, and the shell standing in io/images: the gate must still
    // run and refuse. A gate that is not found exits 1, which lets the call through.
    writeFileSync(join(dir, 'io', '.turn-audience'), JSON.stringify({ turn: 't-guest', audience: { kind: 'guest', trust: 'standard' } }));
    const gateCommand = hooks.PreToolUse.flatMap((entry) => entry.hooks.map((h) => h.command)).find((c) => c.includes('gate.cjs'))!;
    const ran = spawnSync(gateCommand, {
      cwd: join(dir, 'io', 'images'),
      shell: true,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat /etc/passwd' } }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.strictEqual(ran.status, 2, `the gate refused from a subfolder (status ${ran.status}: ${ran.stderr})`);
  } finally { rmSync(join(dir, '..', '..', '..'), { recursive: true, force: true }); }
});

function runCompacted(dir: string, base: string): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(dir, 'hooks', 'compacted.cjs')], {
      cwd: dir,
      env: { ...process.env, BYTELIGHT_INTERNAL_BASE: base },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (status) => resolveRun({ status, stdout }));
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }));
  });
}

test('the note goes out even when the house cannot be reached', async () => {
  const dir = lane();
  try {
    const { status, stdout } = await runCompacted(dir, 'http://127.0.0.1:9');
    assert.strictEqual(status, 0);
    const out = JSON.parse(stdout);
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /^\[We just squashed \(/);
    assert.match(out.hookSpecificOutput.additionalContext, /nothing to announce/);
  } finally { rmSync(join(dir, '..', '..', '..'), { recursive: true, force: true }); }
});

test('the memory blocks that moved while the room was open come with the note', async () => {
  const dir = lane();
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, refresh: 'BLOCKS THAT MOVED: the status block.' }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  try {
    const port = (server.address() as { port: number }).port;
    const { status, stdout } = await runCompacted(dir, `http://127.0.0.1:${port}`);
    assert.strictEqual(status, 0);
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
    assert.match(context, /^\[We just squashed/);
    assert.ok(context.endsWith('\n\nBLOCKS THAT MOVED: the status block.'), context);
    assert.deepStrictEqual(asked, ['/api/internal/compaction-refresh?lane=primary']);
  } finally {
    server.close();
    rmSync(join(dir, '..', '..', '..'), { recursive: true, force: true });
  }
});

test('the whole hook output stays under the 10,000 characters Claude Code passes through', async () => {
  const dir = lane();
  const walls = (chars: number) => [
    { scope: 'shared', label: 'status', content: 'x'.repeat(chars) },
    { scope: 'companion-a', label: 'persona', content: 'I am here.' },
  ];
  // The biggest wall that still fits inline, then far over it, as the route answers.
  let biggest = DRIFT_TEXT_BUDGET;
  while (!driftFitsInline(walls(biggest))) biggest -= 1;
  const inline = renderDrift(walls(biggest));
  assert.ok(inline.includes('xxxx'), 'the first case really is the inline form');
  for (const refresh of [inline, renderDrift(walls(120_000), ['shared/gone'], '/home/someone/lane/io/walls-moved.md')]) {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, refresh }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
    try {
      const port = (server.address() as { port: number }).port;
      const { stdout } = await runCompacted(dir, `http://127.0.0.1:${port}`);
      const context = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
      assert.ok(context.endsWith(refresh), 'the drift text arrives whole');
      assert.ok(context.length <= DRIFT_TEXT_BUDGET, `context is ${context.length}`);
      assert.ok(context.length < 10_000);
    } finally { server.close(); }
  }
  rmSync(join(dir, '..', '..', '..'), { recursive: true, force: true });
});
