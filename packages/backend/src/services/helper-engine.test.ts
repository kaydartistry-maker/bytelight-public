import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperEngineForHouse, resolveHelperEngine } from './helper-engine.js';

test('a Claude house keeps its helpers on Haiku, whichever Claude lane it uses', () => {
  assert.deepEqual(helperEngineForHouse('claude', 'sonnet'), { provider: 'sdk', model: 'haiku' });
  assert.deepEqual(helperEngineForHouse('claude-cli', 'claude-fable-5-1'), { provider: 'sdk', model: 'haiku' });
});

test('a Codex house runs its helpers on its own model through the Codex sign-in', () => {
  assert.deepEqual(helperEngineForHouse('codex-cli', 'gpt-6.1-sol'), { provider: 'codex', model: 'gpt-6.1-sol' });
  assert.deepEqual(helperEngineForHouse('openai-codex', 'gpt-5.6-sol'), { provider: 'codex', model: 'gpt-5.6-sol' });
});

test('an API house runs its helpers on the same provider and model', () => {
  assert.deepEqual(helperEngineForHouse('openrouter', 'z-ai/glm-4.6'), { provider: 'openrouter', model: 'z-ai/glm-4.6' });
  assert.deepEqual(helperEngineForHouse('ollama', 'llama3.3'), { provider: 'ollama', model: 'llama3.3' });
});

test('swapping the house moves the helpers with it', () => {
  let house = { provider: 'codex-cli', model: 'gpt-6.1-sol' };
  const now = () => resolveHelperEngine(undefined, undefined, () => 'x', () => house);
  assert.deepEqual(now(), { provider: 'codex', model: 'gpt-6.1-sol', source: 'house' });
  house = { provider: 'openrouter', model: 'z-ai/glm-4.6' };
  assert.deepEqual(now(), { provider: 'openrouter', model: 'z-ai/glm-4.6', source: 'house' });
});

test('a helper\'s own saved choice still wins', () => {
  const house = () => ({ provider: 'openrouter', model: 'z-ai/glm-4.6' });
  assert.deepEqual(resolveHelperEngine('sdk', 'haiku', () => 'x', house), { provider: 'sdk', model: 'haiku', source: 'override' });
  assert.deepEqual(resolveHelperEngine('ollama', '', (p) => `${p}-default`, house), { provider: 'ollama', model: 'ollama-default', source: 'override' });
});

test('a Gemini house runs its helpers on Gemini through the Antigravity CLI', () => {
  assert.deepEqual(helperEngineForHouse('antigravity', 'gemini-4-neon-high'), { provider: 'antigravity', model: 'gemini-4-neon-high' });
});
