import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTimezone, trustedDetectedTimezone, processNameFor, joinNames, withEnvSwitches } from './setup-helpers.mjs';

test('real zones are valid, made-up ones are not', () => {
  assert.equal(isValidTimezone('America/New_York'), true);
  assert.equal(isValidTimezone('Europe/Lisbon'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
  assert.equal(isValidTimezone(''), false);
  assert.equal(isValidTimezone(undefined), false);
});

test('UTC from a cloud VM is not trusted as the person\'s zone', () => {
  assert.equal(trustedDetectedTimezone('UTC'), null);
  assert.equal(trustedDetectedTimezone('Etc/UTC'), null);
  assert.equal(trustedDetectedTimezone(''), null);
  assert.equal(trustedDetectedTimezone('America/Chicago'), 'America/Chicago');
});

test('house names become safe, distinct pm2 names', () => {
  assert.equal(processNameFor('River'), 'river');
  assert.equal(processNameFor("River's House"), 'rivers-house');
  assert.equal(processNameFor('  Café  Noir!! '), 'cafe-noir');
  assert.equal(processNameFor('🐉'), 'bytelight');
  assert.equal(processNameFor(''), 'bytelight');
  assert.ok(processNameFor('x'.repeat(80)).length <= 40);
});

test('names read as plain English', () => {
  assert.equal(joinNames(['River']), 'River');
  assert.equal(joinNames(['River', 'Stone']), 'River and Stone');
  assert.equal(joinNames(['A', 'B', 'C']), 'A, B and C');
});

import { ENGINES, engineSettings, yamlQuote } from './setup-helpers.mjs';

test('Claude and Codex never start a house on an old model', () => {
  assert.equal(engineSettings('claude-cli').model, 'claude-cli/claude-sonnet-5-5');
  assert.equal(engineSettings('claude-sdk').model, 'sonnet');
  assert.equal(ENGINES[0].key, 'claude-cli', 'the warm CLI lane is the default pick');
  assert.match(ENGINES.find((e) => e.key === 'claude-sdk').label, /SDK lane/);
  assert.equal(engineSettings('codex').model, 'codex-cli/gpt-6.1-sol');
  for (const e of ENGINES) assert.ok(!String(e.model).includes('4-6'));
});

test('an API engine writes exactly its own provider block', () => {
  const or = engineSettings('api', { provider: 'openrouter', key: 'sk-or-x', model: 'z-ai/glm-4.6' });
  assert.equal(or.model, 'openrouter/z-ai/glm-4.6');
  assert.equal(or.providersYaml, 'providers:\n  openrouter:\n    api_key: "sk-or-x"\n');
  const ol = engineSettings('api', { provider: 'ollama', model: 'llama3.3' });
  assert.match(ol.providersYaml, /base_url: "http:\/\/localhost:11434"/);
  assert.match(ol.providersYaml, /enabled: true/);
  assert.throws(() => engineSettings('api', { provider: 'openrouter', model: '' }));
  assert.throws(() => engineSettings('nope'));
});

test('yaml strings survive quotes and backslashes', () => {
  assert.equal(yamlQuote('a"b\\c'), '"a\\"b\\\\c"');
});

test('Gemini is offered with its warning, on a current model', () => {
  const g = ENGINES.find((e) => e.key === 'gemini');
  assert.ok(g.warning.includes('separate Google account'));
  assert.equal(engineSettings('gemini').model, 'antigravity/gemini-4-neon-high');
});

test('every house gets the Claude CLI lane switched on, whatever engine came first', () => {
  const fresh = withEnvSwitches('# bytelight Environment\n');
  assert.match(fresh, /^CLAUDE_CLI_HEARTBEAT_ENABLED=true$/m);
  assert.ok(fresh.startsWith('# bytelight Environment\n'));
});

test('an older .env gets the switch added; a line the person set is never changed', () => {
  assert.match(withEnvSwitches('DISCORD_ENABLED=true'), /DISCORD_ENABLED=true\n# .*\nCLAUDE_CLI_HEARTBEAT_ENABLED=true\n$/);
  const theirs = 'CLAUDE_CLI_HEARTBEAT_ENABLED=false\n';
  assert.equal(withEnvSwitches(theirs), theirs);
  const once = withEnvSwitches('');
  assert.equal(withEnvSwitches(once), once);
});
