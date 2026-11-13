/**
 * Slice 3b cut-3 pin: dual-path dispatch.
 *
 * (a) A foreign (non-claude-sdk) ref dispatched through _processQuery
 *     reaches `runtime.runTurn` — proven by observing the canonical
 *     consumer's auth_required degrade output, a string only the
 *     foreign branch can produce — and never touches the Claude SDK
 *     `query()` loop (which would spawn a CLI session and could never
 *     emit that sentinel).
 * (b) Every real live Claude model name fails the foreign-branch
 *     predicate (`descriptor.modelRef.runtime !== 'claude-sdk'`), so
 *     Claude traffic can never take the foreign lane.
 *
 * Mirrors db.bridge.test.ts's bootstrap: temp RESONANT_HOME + real
 * disk-backed DB through the production initDb migration path.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'dual-path-test-'));
process.env.RESONANT_HOME = tmpRoot;
// Isolate the Codex auth check from the real machine: point it at a
// nonexistent file inside tmpRoot so isCodexLoggedIn() returns false and
// the clean auth_required degrade fires (otherwise a connected Codex on the
// host makes getCodexAuthPath() resolve to a REAL data/codex-auth.json and
// this "logged out" scenario false-reds).
process.env.CODEX_AUTH_PATH = join(tmpRoot, 'no-codex-auth.json');
process.env.CODEX_CLI_AUTH_PATH = join(tmpRoot, 'no-codex-cli-auth.json');

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_VARIANTS } from '@bytelight/shared';
import {
  initDb,
  createThread,
  setConfig as setDbConfig,
  getMessages,
  getProviderSession,
} from './db.js';
import { AgentService, resolveRuntimeDescriptor } from './agent.js';
import { loadConfig } from '../config.js';

const THREAD_ID = 'dual-path-thread';

before(() => {
  // Nonexistent path → pure DEFAULTS (no live bytelight.yaml pickup).
  loadConfig(join(tmpRoot, 'bytelight.yaml'));
  initDb(join(tmpRoot, 'dual-path.db'));
  createThread({
    id: THREAD_ID,
    name: 'dual-path',
    type: 'named',
    createdAt: new Date().toISOString(),
  });
});

describe('Slice 3b dual-path dispatch', () => {
  test('(b) no live Claude model name satisfies the foreign-branch predicate', () => {
    const names = ['claude-sonnet-4-6', ...MODEL_VARIANTS.map((v) => v.modelApiId)];
    for (const model of names) {
      const d = resolveRuntimeDescriptor(model);
      // The dispatch gate in _processQuery is exactly this comparison.
      assert.equal(
        d.modelRef.runtime !== 'claude-sdk',
        false,
        `'${model}' must never take the foreign branch`,
      );
    }
  });

  test('(a) foreign ref reaches runTurn (canonical consumer), never query()', async () => {
    // Canonical codex ref — resolveRuntimeForRef returns the codex
    // runtime unconditionally (auth is gated INSIDE runTurn), so with
    // no OAuth file in tmpRoot the turn degrades to the auth_required
    // sentinel. The Claude query() lane cannot produce this string:
    // it would spawn an SDK subprocess and stream SDK messages.
    setDbConfig('agent.model', 'openai-codex/gpt-5.5');
    try {
      const svc = new AgentService();
      const result = await (svc as unknown as {
        _processQuery(threadId: string, content: string): Promise<string>;
      })._processQuery(THREAD_ID, 'hello from the dual-path test');

      assert.match(
        result,
        /Codex authentication required/,
        'foreign turn must surface the runtime auth_required degrade',
      );

      // Same text persisted as the companion message (shared tail ran).
      const msgs = getMessages({ threadId: THREAD_ID, limit: 5 });
      const companion = msgs.filter((m) => m.role === 'companion').pop();
      assert.ok(companion, 'companion message persisted');
      assert.match(companion!.content, /Codex authentication required/);

      // Unauthed codex emits no `session` event → no sidecar row for
      // the foreign key (write is gated on a captured sessionId).
      const row = getProviderSession({
        threadId: THREAD_ID,
        runtimeId: 'codex',
        provider: 'openai-codex',
        modelRef: 'openai-codex/gpt-5.5',
      });
      assert.equal(row, null);
    } finally {
      // Leave the config clean for any later suite in the same process.
      setDbConfig('agent.model', 'claude-sonnet-4-6');
    }
  });
});
