import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { unexpectedExitDelay } from './supervisor.js';

describe('heartbeat fast-exit backoff', () => {
  test('keeps one quick retry, then backs off repeated code-1 crashes', () => {
    assert.equal(unexpectedExitDelay(1), 2_000);
    assert.equal(unexpectedExitDelay(2), 10_000);
    assert.equal(unexpectedExitDelay(3), 30_000);
    assert.equal(unexpectedExitDelay(4), 60_000);
  });

  test('caps a sustained crash loop at five minutes', () => {
    assert.equal(unexpectedExitDelay(5), 300_000);
    assert.equal(unexpectedExitDelay(500), 300_000);
  });
});

// ─── ensure() recycle semantics (warm-session economics slice) ───────
//
// Only a MODEL change may recycle a running session. Operational-template
// changes ride the next natural recycle: every forced recycle is a fresh
// session UUID + a full cache write of the boot surface (the cold-start
// leak this slice seals). Matches the upstream warm lane's semantics.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HeartbeatSession } from './supervisor.js';

describe('ensure() recycle triggers', () => {
  function makeRunningSession(name: string): HeartbeatSession {
    const s = new HeartbeatSession(name);
    // Simulate an already-running warm session without spawning a child:
    // ensure() only reads `status`/`model`; the .restart flag file is the
    // observable recycle request.
    (s as any).status = 'running';
    (s as any).reaped = true; // skip orphan reaping (no pid file games)
    return s;
  }

  function restartRequested(s: HeartbeatSession): boolean {
    return existsSync(join(s.dir, 'io', '.restart'));
  }

  function cleanup(s: HeartbeatSession): void {
    try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  test('template change alone does NOT recycle a running session', () => {
    const s = makeRunningSession('test-ensure-template');
    try {
      // First ensure() provisions the dir — first write flips templateChanged.
      const recycled = s.ensure('model-a');
      assert.equal(recycled, false, 'template change must ride the next natural recycle');
      assert.equal(restartRequested(s), false, 'no .restart flag written');
    } finally {
      cleanup(s);
    }
  });

  test('model change DOES recycle a running session', () => {
    const s = makeRunningSession('test-ensure-model');
    try {
      s.ensure('model-a'); // seeds this.model
      const recycled = s.ensure('model-b');
      assert.equal(recycled, true, 'model change must request a recycle');
      assert.equal(restartRequested(s), true, '.restart flag written for the watchdog');
    } finally {
      cleanup(s);
    }
  });

  test('same model, unchanged template — steady state, no recycle', () => {
    const s = makeRunningSession('test-ensure-steady');
    try {
      s.ensure('model-a');
      const recycled = s.ensure('model-a');
      assert.equal(recycled, false);
      assert.equal(restartRequested(s), false);
    } finally {
      cleanup(s);
    }
  });
});
