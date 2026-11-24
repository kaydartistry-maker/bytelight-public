import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Usage renders an honest GLM Coding Plan meter', () => {
  const source = readFileSync(new URL('./SubscriptionUsageMeters.tsx', import.meta.url), 'utf8');
  assert.match(source, /GLM Coding Plan usage/);
  assert.match(source, /\/api\/usage\/zai/);
  assert.match(source, /tracked locally/i);
  assert.doesNotMatch(source, /GLM[\s\S]{0,300}remaining/);
});
