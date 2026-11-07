// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Nothing the house sends to Discord can ping a whole server or a role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('our messages may ping people, never @everyone, @here or a role', async () => {
  const { DISCORD_ALLOWED_MENTIONS } = await import('./index.js');
  assert.deepEqual([...DISCORD_ALLOWED_MENTIONS.parse], ['users']);
  assert.equal(DISCORD_ALLOWED_MENTIONS.repliedUser, true);
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(source, /new Client\(\{\s*(\/\/[^\n]*\n\s*)*allowedMentions: DISCORD_ALLOWED_MENTIONS/, 'the client is built with it');
});
