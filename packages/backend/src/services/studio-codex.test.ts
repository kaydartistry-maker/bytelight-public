import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStudioCodexBin } from './studio-codex.js';

test('subscription CLI resolution supports system installations and preserves explicit overrides', () => {
  const home = mkdtempSync(join(tmpdir(), 'studio-codex-'));
  try {
    assert.equal(resolveStudioCodexBin(null, undefined, home), 'codex');
    assert.equal(resolveStudioCodexBin('/explicit/codex', '/environment/codex', home), '/explicit/codex');
    assert.equal(resolveStudioCodexBin(null, '/environment/codex', home), '/environment/codex');
    const bin = join(home, '.local', 'bin', 'codex');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    assert.equal(resolveStudioCodexBin(null, undefined, home), 'codex');
    chmodSync(bin, 0o700);
    assert.equal(resolveStudioCodexBin(null, undefined, home), bin);
    rmSync(bin); mkdirSync(bin);
    assert.equal(resolveStudioCodexBin(null, undefined, home), 'codex');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
