import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, normalizeModelRef, providerToRuntime } from '../../../shared/src/model-manifest.js';
import { SECRETS } from './secrets.js';
import { readFileSync } from 'node:fs';

test('Z.ai Coding Plan is a full Claude-SDK house lane with an encrypted key slot', () => {
  const model = MODELS.find((entry) => entry.provider === 'zai');
  assert.equal(model?.id, 'glm-5.4[1m]');
  assert.equal(model?.capabilities.tools, true);
  assert.equal(model?.capabilities.mcp, true);
  assert.equal(providerToRuntime('zai'), 'claude-sdk');
  assert.equal(normalizeModelRef('zai/glm-5.4[1m]').provider, 'zai');
  assert.ok(SECRETS.some((secret) => secret.name === 'provider_zai_coding_plan_api_key'));
});

test('Z.ai credentials are turn-local and never replace ambient Anthropic auth', () => {
  const source = readFileSync(new URL('./agent.ts', import.meta.url), 'utf8');
  assert.match(source, /resolvedModelRef\.provider === 'zai'/);
  assert.match(source, /ANTHROPIC_BASE_URL: 'https:\/\/api\.z\.ai\/api\/anthropic'/);
  assert.match(source, /ANTHROPIC_API_KEY: undefined/);
  assert.match(source, /options\.permissionMode = 'default'/);
  assert.match(source, /options\.allowDangerouslySkipPermissions = false/);
  assert.match(source, /options\.canUseTool = async \(toolName, input\)/);
  assert.match(source, /behavior: 'allow', updatedInput: input/);
});

test('the phone Providers screen exposes the encrypted Z.ai key slot', () => {
  const source = readFileSync(new URL('../../../phone/src/components/ProvidersApp.tsx', import.meta.url), 'utf8');
  assert.match(source, /Z\.ai GLM Coding Plan/);
  assert.match(source, /provider_zai_coding_plan_api_key/);
  assert.match(source, /\/api\/secrets\/\$\{encodeURIComponent\(ZAI_SECRET\)\}/);
});
