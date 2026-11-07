import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSecrets, type SecretStatus } from './secret-groups';

const slot = (name: string, category: SecretStatus['category'], extra: Partial<SecretStatus> = {}): SecretStatus => ({
  name, label: name, category, hasValue: false, ...extra,
});

test('every backend category the classic panel shows renders, in classic order', () => {
  const groups = groupSecrets([
    slot('giphy_api_key', 'other'),
    slot('discord_bot_token', 'platforms'),
    slot('elevenlabs_api_key', 'voice'),
    slot('tavily_api_key', 'search'),
    slot('mind_api_url', 'other'),
  ]);
  assert.deepEqual(groups.map((g) => g.category), ['search', 'voice', 'platforms', 'other']);
  assert.deepEqual(groups.map((g) => g.label), ['Search', 'Voice', 'Platforms', 'Other']);
  assert.deepEqual(groups[3].items.map((s) => s.name), ['giphy_api_key', 'mind_api_url']);
});

test('provider slots and read-only slots stay off the Keys screen', () => {
  const groups = groupSecrets([
    slot('anthropic_api_key', 'providers', { readonly: true }),
    slot('locked_voice', 'voice', { readonly: true }),
    slot('hume_api_key', 'voice'),
  ]);
  assert.deepEqual(groups.map((g) => g.category), ['voice']);
  assert.deepEqual(groups[0].items.map((s) => s.name), ['hume_api_key']);
});

test('empty categories are dropped', () => {
  assert.deepEqual(groupSecrets([]), []);
});
