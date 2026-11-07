import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_VARIANTS } from '@bytelight/shared';
import {
  CODEX_CLI_FALLBACK,
  DEFAULT_BRAIN,
  LEGACY_CLAUDE_OPTIONS,
  PROVIDER_ROWS,
  defaultEngineBodies,
  effortChoices,
  effortConfig,
  engineFromEffective,
  initialSplit,
  modelsForProvider,
  normalizeCatalog,
  providerEnabled,
  saveBlocker,
  switchProvider,
  type TierEngine,
} from './house-engine';

const opus: TierEngine = { provider: 'claude-cli', model: 'claude-opus-4-7', effort: 'high' };
const codex: TierEngine = { provider: 'codex-cli', model: 'gpt-6-sol', effort: 'medium' };

test('all nine lanes are offered', () => {
  assert.deepEqual(
    PROVIDER_ROWS.map((r) => r.id),
    ['claude', 'claude-cli', 'codex-cli', 'openai-codex', 'openai', 'openrouter', 'groq', 'xai', 'ollama'],
  );
});

test('Claude lanes read the shared shelf; legacy ids only on the classic lane', () => {
  const cli = modelsForProvider('claude-cli', {});
  const api = modelsForProvider('claude', {});
  assert.ok(Array.isArray(cli) && Array.isArray(api));
  assert.deepEqual(cli.map((m) => m.id), MODEL_VARIANTS.map((v) => v.modelApiId));
  assert.deepEqual(api.map((m) => m.id), [...MODEL_VARIANTS.map((v) => v.modelApiId), ...LEGACY_CLAUDE_OPTIONS.map((m) => m.id)]);
});

test('fetched lanes read their own catalog, never another lane', () => {
  const catalogs = {
    groq: [{ id: 'llama', name: 'Llama' }],
    openrouter: [{ id: 'x/y', name: 'XY' }],
  };
  assert.deepEqual(modelsForProvider('groq', catalogs), [{ id: 'llama', name: 'Llama' }]);
  assert.equal(modelsForProvider('ollama', catalogs), undefined);
  assert.equal(modelsForProvider('openai', { openai: 'error' }), 'error');
});

test('Codex CLI falls back to the shelf when discovery fails or is empty', () => {
  assert.deepEqual(modelsForProvider('codex-cli', { 'codex-cli': 'error' }), CODEX_CLI_FALLBACK);
  assert.deepEqual(modelsForProvider('codex-cli', { 'codex-cli': [] }), CODEX_CLI_FALLBACK);
  assert.deepEqual(modelsForProvider('codex-cli', { 'codex-cli': [{ id: 'a', name: 'A' }] }), [{ id: 'a', name: 'A' }]);
});

test('normalizeCatalog fills missing names and skips junk', () => {
  assert.deepEqual(normalizeCatalog([{ id: 'a' }, { id: 'b', name: 'B' }, null, { name: 'no id' }]), [
    { id: 'a', name: 'a' },
    { id: 'b', name: 'B' },
  ]);
  assert.deepEqual(normalizeCatalog({ error: 'nope' }), []);
});

test('availability gate matches the classic panel', () => {
  assert.equal(providerEnabled('claude-cli', null).enabled, true);
  assert.equal(providerEnabled('codex-cli', null).enabled, true);
  assert.equal(providerEnabled('groq', null).enabled, false);
  assert.equal(providerEnabled('groq', { routing: 'sdk', groq: { configured: true } }).enabled, false);
  assert.equal(providerEnabled('groq', { routing: 'hybrid', groq: { configured: true } }).enabled, true);
  assert.equal(providerEnabled('openai-codex', { routing: 'sdk', 'openai-codex': { available: true } }).enabled, true);
  assert.equal(providerEnabled('ollama', { routing: 'hybrid', ollama: { configured: true, enabled: false } }).enabled, false);
  assert.ok(providerEnabled('openai', { routing: 'hybrid', openai: { configured: false } }).hint);
});

test('hydrates a tier from the effective GET body', () => {
  const body = {
    companionId: DEFAULT_BRAIN, tier: 'interactive', threadId: null,
    provider: 'claude-cli', model: 'claude-opus-4-7', thinkingEffort: 'high',
    source: 'companion', matchedCompanionId: DEFAULT_BRAIN,
  };
  assert.deepEqual(engineFromEffective(body), opus);
  assert.deepEqual(engineFromEffective({ provider: 'codex-cli', model: 'gpt-6-sol' }), { provider: 'codex-cli', model: 'gpt-6-sol', effort: 'auto' });
  assert.equal(engineFromEffective({ error: 'x' }), null);
  assert.equal(engineFromEffective(null), null);
});

test('autonomous opens split only when it differs from chat', () => {
  assert.equal(initialSplit(opus, { ...opus }), false);
  assert.equal(initialSplit(opus, codex), true);
  assert.equal(initialSplit(opus, { ...opus, effort: 'max' }), true);
  assert.equal(initialSplit(null, codex), false);
});

test('switching provider resets the model and drops an effort the lane cannot take', () => {
  const claudeMax: TierEngine = { ...opus, effort: 'max' };
  const next = switchProvider(claudeMax, 'codex-cli', [{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }]);
  assert.deepEqual(next, { provider: 'codex-cli', model: 'gpt-6-sol', effort: 'auto' });
  assert.deepEqual(switchProvider(opus, 'codex-cli', undefined), { provider: 'codex-cli', model: '', effort: 'high' });
});

test('effort chips follow the lane vocabulary', () => {
  const claude = effortChoices('claude-cli').map((c) => c.id);
  const codexIds = effortChoices('codex-cli').map((c) => c.id);
  assert.ok(claude.includes('max') && !claude.includes('none'));
  assert.ok(codexIds.includes('none') && !codexIds.includes('max'));
  assert.equal(effortChoices('claude-cli')[0].id, 'auto');
});

test('unified save mirrors chat onto autonomous', () => {
  assert.deepEqual(defaultEngineBodies(opus, codex, false), [
    { companionId: DEFAULT_BRAIN, tier: 'interactive', providerId: 'claude-cli', modelId: 'claude-opus-4-7', thinkingEffort: 'high' },
    { companionId: DEFAULT_BRAIN, tier: 'autonomous', providerId: 'claude-cli', modelId: 'claude-opus-4-7', thinkingEffort: 'high' },
  ]);
});

test('split save writes each tier its own engine', () => {
  assert.deepEqual(defaultEngineBodies(opus, codex, true)[1], {
    companionId: DEFAULT_BRAIN, tier: 'autonomous', providerId: 'codex-cli', modelId: 'gpt-6-sol', thinkingEffort: 'medium',
  });
});

test('effort config tracks the rows and clears the wake override when unified', () => {
  assert.deepEqual(effortConfig(opus, codex, false), {
    preferences: { thinking_effort: 'high', thinking_effort_autonomous: null },
    settings: [
      { key: 'agent.thinking_effort', value: 'high' },
      { key: 'agent.thinking_effort_autonomous', value: '' },
    ],
  });
  assert.deepEqual(effortConfig(opus, codex, true).preferences, { thinking_effort: 'high', thinking_effort_autonomous: 'medium' });
});

test('save is blocked on an empty model', () => {
  assert.equal(saveBlocker(opus, codex, true), null);
  assert.ok(saveBlocker({ ...opus, model: '' }, codex, false));
  assert.equal(saveBlocker(opus, { ...codex, model: '' }, false), null);
  assert.ok(saveBlocker(opus, { ...codex, model: '' }, true));
});
