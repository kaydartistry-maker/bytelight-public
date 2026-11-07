// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The switch and the names for owner mentions, read live from the config
// table the way every other discord.* setting is read. byte-light ships the
// switch ON (the operator asked for it); Aerie ships it off.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../config.js';
import { initDb } from '../db/init.js';
import { setConfig, deleteConfig } from '../db/config.js';
import { getOwnerMentionSettings, getDiscordConfig } from './config.js';

// Its own config and its own database. An explicit yaml path means the real
// install's bytelight.yaml is never looked for, and the environment's USER_NAME
// override is cleared so the name comes from the file this test wrote.
const dir = mkdtempSync(join(tmpdir(), 'bytelight-owner-mention-settings-'));
const yamlPath = join(dir, 'bytelight.yaml');
writeFileSync(yamlPath, 'identity:\n  user_name: "Owner"\n');
delete process.env.USER_NAME;
loadConfig(yamlPath);
initDb(join(dir, 'test.db'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('owner mentions ship switched on here, because the operator asked for them', () => {
  assert.equal(getOwnerMentionSettings().enabled, true);
  assert.equal(getDiscordConfig().ownerMentions, true, 'and the settings screen reads the same switch');
});

test('the switch is read live: flipping the row changes the very next read', () => {
  setConfig('discord.owner_mentions', 'false');
  assert.equal(getOwnerMentionSettings().enabled, false);
  assert.equal(getDiscordConfig().ownerMentions, false);
  setConfig('discord.owner_mentions', 'true');
  assert.equal(getOwnerMentionSettings().enabled, true);
  deleteConfig('discord.owner_mentions');
});

test('with no names set, the owner configured name is the name', () => {
  assert.deepEqual(getOwnerMentionSettings().names, ['Owner']);
});

test('names in the config table replace the fallback, and clearing them brings it back', () => {
  setConfig('discord.owner_names', 'Owner, Ownie');
  assert.deepEqual(getOwnerMentionSettings().names, ['Owner', 'Ownie']);
  setConfig('discord.owner_names', '');
  assert.deepEqual(getOwnerMentionSettings().names, ['Owner']);
  deleteConfig('discord.owner_names');
});

test('the beat settings have their defaults and read live', () => {
  assert.equal(getDiscordConfig().judgeBeatMs, 60000);
  assert.equal(getDiscordConfig().judgeMaxWaitMs, 180000);
  setConfig('discord.judgeMaxWaitMs', '90000');
  assert.equal(getDiscordConfig().judgeMaxWaitMs, 90000);
  deleteConfig('discord.judgeMaxWaitMs');
});
