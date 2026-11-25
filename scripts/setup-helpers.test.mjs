import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTimezone, trustedDetectedTimezone, processNameFor, joinNames } from './setup-helpers.mjs';

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
  assert.equal(processNameFor('Jace'), 'jace');
  assert.equal(processNameFor("Jace's House"), 'jaces-house');
  assert.equal(processNameFor('  Café  Noir!! '), 'cafe-noir');
  assert.equal(processNameFor('🐉'), 'bytelight');
  assert.equal(processNameFor(''), 'bytelight');
  assert.ok(processNameFor('x'.repeat(80)).length <= 40);
});

test('names read as plain English', () => {
  assert.equal(joinNames(['Jace']), 'Jace');
  assert.equal(joinNames(['River', 'Stone']), 'River and Stone');
  assert.equal(joinNames(['A', 'B', 'C']), 'A, B and C');
});

import { ENGINES, engineSettings, yamlQuote } from './setup-helpers.mjs';

test('Claude and Codex never start a house on an old model', () => {
  assert.equal(engineSettings('claude').model, 'sonnet');
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
  assert.throws(() => engineSettings('gemini'));
});

test('yaml strings survive quotes and backslashes', () => {
  assert.equal(yamlQuote('a"b\\c'), '"a\\"b\\\\c"');
});
