import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const hooks = readFileSync(new URL('./hooks.ts', import.meta.url), 'utf8');
const cli = readFileSync(new URL('../../../../tools/sc.mjs', import.meta.url), 'utf8');
const block = hooks.split("'  Discord:'")[1]?.split("'  byte-light:'")[0] ?? '';
test('orientation teaches implemented Discord commands with positional text', () => {
  assert.ok(block.includes('discord send "message" --channel CHANNEL_ID'));
  assert.ok(block.includes('discord send_voice "text" --channel CHANNEL_ID'));
  assert.ok(block.includes('discord send_voice "text" --voice companion-a --channel CHANNEL_ID'));
  for (const verb of ['discord', 'send', 'send_voice']) assert.ok(cli.includes("case '" + verb + "':"));
  assert.ok(cli.includes('body.message = positional[0]'));
  assert.ok(cli.includes('body.text = positional[0]'));
  assert.ok(!block.includes('dc text') && !block.includes('dc voice'));
});
test('Discord does not promise local voice splitting', () => {
  assert.ok(block.length > 0);
  assert.ok(!block.includes('auto-splits'));
  assert.ok(hooks.split("'  byte-light:'")[1].includes('# auto-splits'));
});
