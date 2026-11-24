import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readClaudeCodeVersionFromSdk } from './runtime-health.js';

function pkg(dir: string, body: object): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'package.json');
  writeFileSync(p, JSON.stringify(body));
  return p;
}

test('reads claudeCodeVersion from a single path', () => {
  const root = mkdtempSync(join(tmpdir(), 'rh-'));
  const p = pkg(join(root, 'a'), { version: '0.3.296', claudeCodeVersion: '2.1.296' });
  assert.equal(readClaudeCodeVersionFromSdk(p), '2.1.296');
});

test('falls through to the workspace install when the root one is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'rh-'));
  const missing = join(root, 'root', 'package.json');
  const workspace = pkg(join(root, 'ws'), { version: '0.3.296', claudeCodeVersion: '2.1.296' });
  assert.equal(readClaudeCodeVersionFromSdk([missing, workspace]), '2.1.296');
});

test('skips a package.json that has no claudeCodeVersion', () => {
  const root = mkdtempSync(join(tmpdir(), 'rh-'));
  const bare = pkg(join(root, 'bare'), { version: '1.0.0' });
  const good = pkg(join(root, 'good'), { claudeCodeVersion: '2.1.300' });
  assert.equal(readClaudeCodeVersionFromSdk([bare, good]), '2.1.300');
});

test('null when nothing is installed anywhere', () => {
  const root = mkdtempSync(join(tmpdir(), 'rh-'));
  assert.equal(readClaudeCodeVersionFromSdk([join(root, 'x.json'), join(root, 'y.json')]), null);
});
