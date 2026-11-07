/**
 * persistAgentSetting — the three legs move together.
 *
 * /model used to write only the DB config row, which nothing dispatches from:
 * a row nobody reads, a live model untouched, and a success toast. These pin
 * that an agent.* write reaches the yaml (restart survival), that non-yaml
 * keys still land without touching the file, and that yaml structure/other
 * keys survive the round-trip. (Aerie agent-settings.test intent, against our
 * adapted module.)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

import { initDb, getConfig } from './db.js';
import { persistAgentSetting } from './agent-settings.js';

const dir = mkdtempSync(join(tmpdir(), 'bl-agent-settings-'));
const scratchYaml = join(dir, 'bytelight.yaml');

before(() => {
  initDb(join(dir, 'test.db'));
  writeFileSync(scratchYaml, yaml.dump({
    identity: { companion_name: 'Companion', user_name: 'Owner' },
    agent: { model: 'claude-opus-4-7', routing: 'auto' },
    server: { port: 1234 },
  }), 'utf-8');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('an agent.model write reaches the DB row AND the yaml', () => {
  persistAgentSetting('agent.model', 'claude-opus-5', scratchYaml);
  assert.equal(getConfig('agent.model'), 'claude-opus-5');
  const parsed = yaml.load(readFileSync(scratchYaml, 'utf-8')) as any;
  assert.equal(parsed.agent.model, 'claude-opus-5');
});

test('other yaml sections and keys survive the round-trip', () => {
  const parsed = yaml.load(readFileSync(scratchYaml, 'utf-8')) as any;
  assert.equal(parsed.identity.companion_name, 'Companion');
  assert.equal(parsed.server.port, 1234);
  assert.equal(parsed.agent.routing, 'auto');
});

test('a key with no yaml home lands in the DB only', () => {
  const beforeYaml = readFileSync(scratchYaml, 'utf-8');
  persistAgentSetting('agent.some_experimental_dial', 'on', scratchYaml);
  assert.equal(getConfig('agent.some_experimental_dial'), 'on');
  assert.equal(readFileSync(scratchYaml, 'utf-8'), beforeYaml, 'yaml untouched for non-yaml keys');
});

test('a non-agent key never touches the yaml', () => {
  const beforeYaml = readFileSync(scratchYaml, 'utf-8');
  persistAgentSetting('memext.mode', 'write', scratchYaml);
  assert.equal(getConfig('memext.mode'), 'write');
  assert.equal(readFileSync(scratchYaml, 'utf-8'), beforeYaml);
});
