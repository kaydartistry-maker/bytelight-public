import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterModelCatalog } from './model-catalog.js';

test('catalog searches labels and IDs, sorts naturally and preserves provider defaults', () => {
  const models = [{ name: 'Model 10', id: 'vendor/ten' }, { name: 'Model 2', id: 'vendor/two' }, { name: 'Another', id: 'raw-special' }];
  const select = (query: string) => filterModelCatalog(models, query, m => m.name, m => m.id);
  assert.deepEqual(select('').map(m => m.name), ['Another', 'Model 2', 'Model 10']);
  assert.deepEqual(select(' MODEL ').map(m => m.id), ['vendor/two', 'vendor/ten']);
  assert.deepEqual(select('RAW-SPECIAL'), [models[2]]);
  assert.deepEqual(select('missing'), []);
  assert.equal(models[0].id, 'vendor/ten');
});

test('web search retains deliberate wrapper, icon, input and focus styling with one empty status', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../components/ModelSelector.svelte', import.meta.url), 'utf8');
  assert.match(source, /class="model-search-wrap"[\s\S]*?class="model-search-icon" aria-hidden="true"[\s\S]*?class="model-search"/);
  assert.match(source, /\.model-search:focus\s*\{[^}]*border-color:[^}]*box-shadow:/);
  assert.equal(source.match(/No matching models/g)?.length, 1);
  assert.match(source, /role="status">No matching models/);
});
