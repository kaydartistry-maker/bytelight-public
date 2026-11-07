import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  codexDaemonStartupAction,
  codexLaunchFingerprint,
  findOwnedDaemonPids,
  materializeCodexSkillsDoor,
} from './codex-supervisor.js';

const tempDirs: string[] = [];

function makeAgentCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-skills-door-'));
  tempDirs.push(cwd);
  mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true });
  return cwd;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Codex daemon lifecycle', () => {
  test('reuses a healthy socket after backend ownership state is lost', () => {
    assert.equal(codexDaemonStartupAction(true), 'reuse');
  });

  test('starts the daemon only when no socket exists', () => {
    assert.equal(codexDaemonStartupAction(false), 'start');
    assert.equal(codexDaemonStartupAction(false, 'a', 'b'), 'start');
  });

  test('adopts a reachable daemon only while its launch config matches', () => {
    assert.equal(codexDaemonStartupAction(true, 'same', 'same'), 'reuse');
    assert.equal(codexDaemonStartupAction(true, 'old', 'new'), 'restart');
    // A daemon from code that never recorded a fingerprint is restarted once.
    assert.equal(codexDaemonStartupAction(true, null, 'new'), 'restart');
  });

  test('fingerprints change with any arg (e.g. an .mcp.json edit) and nothing else', () => {
    const a = codexLaunchFingerprint('codex', ['app-server', '-c', 'mcp_servers={bytelight={url="x"}}']);
    assert.equal(a, codexLaunchFingerprint('codex', ['app-server', '-c', 'mcp_servers={bytelight={url="x"}}']));
    assert.notEqual(a, codexLaunchFingerprint('codex', ['app-server', '-c', 'mcp_servers={bytelight={url="y"}}']));
    assert.notEqual(a, codexLaunchFingerprint('/opt/codex', ['app-server', '-c', 'mcp_servers={bytelight={url="x"}}']));
  });

  test('finds only the app-server bound to byte-light\'s private socket', () => {
    const proc = mkdtempSync(join(tmpdir(), 'fake-proc-'));
    tempDirs.push(proc);
    const write = (pid: string, args: string[]) => {
      mkdirSync(join(proc, pid));
      writeFileSync(join(proc, pid, 'cmdline'), args.join('\0') + '\0');
    };
    const sock = '/home/user/.codex/app-server-control/bytelight-app-server.sock';
    write('101', ['codex', '--dangerously-bypass-approvals-and-sandbox', 'app-server', '--listen', `unix://${sock}`, '-c', 'mcp_servers={}']);
    write('202', ['codex', 'app-server', '--listen', 'unix:///home/user/.codex/other.sock']); // The operator's own Codex
    write('303', ['node', 'server.js', `unix://${sock}`]); // mentions the socket but is not an app-server
    mkdirSync(join(proc, 'self'));
    assert.deepEqual(findOwnedDaemonPids(sock, proc), [101]);
    assert.deepEqual(findOwnedDaemonPids(sock, '/nonexistent-proc'), []);
  });
});

describe('materializeCodexSkillsDoor', () => {
  test('creates a symlink to the project skills directory', () => {
    const cwd = makeAgentCwd();

    materializeCodexSkillsDoor(cwd);

    const door = join(cwd, '.agents', 'skills');
    assert.equal(lstatSync(door).isSymbolicLink(), true);
    assert.equal(readlinkSync(door), join(cwd, '.claude', 'skills'));
  });

  test('leaves an already-correct symlink unchanged', () => {
    const cwd = makeAgentCwd();
    const door = join(cwd, '.agents', 'skills');
    mkdirSync(join(cwd, '.agents'), { recursive: true });
    symlinkSync('../.claude/skills', door, 'dir');

    materializeCodexSkillsDoor(cwd);

    assert.equal(readlinkSync(door), '../.claude/skills');
  });

  test('warns and preserves an existing real directory', () => {
    const cwd = makeAgentCwd();
    const door = join(cwd, '.agents', 'skills');
    mkdirSync(door, { recursive: true });
    writeFileSync(join(door, 'keep.txt'), 'user data');
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);

    try {
      materializeCodexSkillsDoor(cwd);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(lstatSync(door).isDirectory(), true);
    assert.equal(readFileSync(join(door, 'keep.txt'), 'utf8'), 'user data');
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /Leaving it unchanged/);
  });
});
