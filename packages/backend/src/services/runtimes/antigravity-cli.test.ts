import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { AntigravityCliRuntime, ANTIGRAVITY_CLI_CAPABILITIES } from './antigravity-cli.js';

describe('AntigravityCliRuntime', () => {
  test('launches a headless autonomous turn with command approval enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-test-'));
    const fake = join(dir, 'agy');
    writeFileSync(fake, `#!/bin/sh
plan='false'
skip='false'
for arg in "$@"; do
  [ "$arg" = '--dangerously-skip-permissions' ] && skip='true'
  [ "$arg" = 'plan' ] && plan='true'
done
[ "$plan" = 'false' ] || { echo 'plan mode must not be forced on companion turns' >&2; exit 41; }
[ "$skip" = 'true' ] || { echo 'missing non-interactive permission flag' >&2; exit 42; }
printf '%s\n' '{"conversation_id":"argon-hands","status":"SUCCESS","response":"hands"}'
`);
    chmodSync(fake, 0o700);
    const runtime = new AntigravityCliRuntime(fake);
    const events = [];
    for await (const event of runtime.runTurn({
      thread: { id: 't', name: 'T', type: 'named', current_session_id: null },
      tier: 'interactive',
      modelRef: { canonical: 'antigravity/gemini-4-argon-high', provider: 'antigravity', model: 'gemini-4-argon-high', runtime: 'antigravity-cli' },
      platform: 'internal', isAutonomous: false, orientation: '',
      systemPrompt: { kind: 'text', value: 'identity' },
      messages: [{ role: 'user', content: 'use a safe house tool', createdAt: new Date().toISOString() }],
    })) events.push(event);
    assert.deepEqual(events.map((e) => e.type), ['start', 'session', 'text_delta', 'done']);
    assert.equal(ANTIGRAVITY_CLI_CAPABILITIES.tools, true);
  });

  test('normalizes a successful JSON turn and exposes the conversation id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-test-'));
    const fake = join(dir, 'agy');
    writeFileSync(fake, '#!/bin/sh\nprintf \'%s\\n\' \'{"conversation_id":"neon-1","status":"SUCCESS","response":"hello","usage":{"input_tokens":3,"output_tokens":2}}\'\n');
    chmodSync(fake, 0o700);
    const runtime = new AntigravityCliRuntime(fake);
    const events = [];
    for await (const event of runtime.runTurn({
      thread: { id: 't', name: 'T', type: 'named', current_session_id: null },
      tier: 'interactive',
      modelRef: { canonical: 'antigravity/gemini-4-neon-low', provider: 'antigravity', model: 'gemini-4-neon-low', runtime: 'antigravity-cli' },
      platform: 'internal', isAutonomous: false, orientation: '',
      systemPrompt: { kind: 'text', value: 'identity' },
      messages: [{ role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
    })) events.push(event);
    assert.deepEqual(events.map((e) => e.type), ['start', 'session', 'text_delta', 'usage', 'done']);
    assert.equal((events[1] as { sessionId: string }).sessionId, 'neon-1');
  });
});
