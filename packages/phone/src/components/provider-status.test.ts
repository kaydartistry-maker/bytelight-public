import assert from 'node:assert/strict';
import test from 'node:test';
import { providerCardStatus, reachAfterCheck, reachFromCatalog, UNKNOWN_REACH, type ModelsStatus } from './provider-status';

const live = (ollama = UNKNOWN_REACH, openai = UNKNOWN_REACH) => ({ ollama, openai });
const auto: ModelsStatus = { routing: 'auto' };

test('anthropic is always connected through the SDK', () => {
  assert.deepEqual(providerCardStatus('anthropic', null, live(), ''), { dot: 'connected', text: 'connected · Claude Agent SDK' });
});

test('openai walks the classic gates in order', () => {
  const s = (openai: ModelsStatus['openai'], routing: ModelsStatus['routing'] = 'auto'): ModelsStatus => ({ routing, openai });
  assert.equal(providerCardStatus('openai', s({ configured: false, enabled: false }), live(), '').text, 'disabled · add API key');
  assert.equal(providerCardStatus('openai', s({ configured: true, enabled: false }), live(), '').text, 'disabled · enable to use');
  assert.deepEqual(providerCardStatus('openai', s({ configured: true, enabled: true }, 'sdk'), live(), ''), { dot: 'needs-key', text: 'routing=sdk · switch to auto for OpenAI direct turns' });
  assert.equal(providerCardStatus('openai', s({ configured: true, enabled: true }), live(UNKNOWN_REACH, { count: 0, reachable: false }), '').text, 'needs-key · check key/base URL');
  assert.equal(providerCardStatus('openai', s({ configured: true, enabled: true }), live(), '').text, 'enabled · checking…');
  assert.equal(providerCardStatus('openai', s({ configured: true, enabled: true }), live(UNKNOWN_REACH, { count: 1, reachable: true }), '').text, 'connected · 1 model');
  assert.equal(providerCardStatus('openai', s({ configured: true, enabled: true }), live(UNKNOWN_REACH, { count: 42, reachable: true }), '').text, 'connected · 42 models');
});

test('key-only lanes need a key and a routing mode other than sdk', () => {
  assert.deepEqual(providerCardStatus('groq', { ...auto, groq: { configured: false } }, live(), ''), { dot: 'disabled', text: 'disabled · add API key' });
  assert.deepEqual(providerCardStatus('xai', { routing: 'sdk', xai: { configured: true } }, live(), ''), { dot: 'needs-key', text: 'routing=sdk · switch to auto to use' });
  assert.deepEqual(providerCardStatus('openrouter', { routing: 'api', openrouter: { configured: true } }, live(), ''), { dot: 'connected', text: 'connected · key set' });
});

test('ollama reports configuration, gate, reach and catalog size', () => {
  const on = { configured: true, enabled: true, url: 'http://box:11434' };
  assert.equal(providerCardStatus('ollama', { ollama: { configured: false, enabled: false } }, live(), '').text, 'not configured · add a base URL');
  assert.equal(providerCardStatus('ollama', { ollama: { ...on, enabled: false } }, live(), '').text, 'disabled · two-stage gate off');
  assert.equal(providerCardStatus('ollama', { ollama: on }, live({ count: 0, reachable: false }), '').text, 'unreachable at http://box:11434 · check URL');
  assert.equal(providerCardStatus('ollama', { ollama: on }, live(), '').text, 'enabled at http://box:11434');
  assert.equal(providerCardStatus('ollama', { ollama: on }, live({ count: 3, reachable: true }), '').text, 'running at http://box:11434 · 3 models');
  assert.equal(providerCardStatus('ollama', { ollama: { configured: true, enabled: true } }, live(), 'http://draft:1').text, 'enabled at http://draft:1');
});

test('huggingface says it is not wired', () => {
  assert.deepEqual(providerCardStatus('huggingface', { huggingface: { configured: true } }, live(), ''), { dot: 'coming-soon', text: 'coming soon · not wired yet' });
});

test('catalog answers and Check results fold into reach like classic', () => {
  assert.deepEqual(reachFromCatalog(null, true), { count: 0, reachable: false });
  assert.deepEqual(reachFromCatalog([], false), { count: 0, reachable: false });
  assert.deepEqual(reachFromCatalog([], true), { count: 0, reachable: true });
  assert.deepEqual(reachFromCatalog([{}, {}], false), { count: 2, reachable: true });
  assert.deepEqual(reachAfterCheck({ count: 5, reachable: false }, { ok: true, models: 7 }), { count: 7, reachable: true });
  assert.deepEqual(reachAfterCheck({ count: 5, reachable: true }, { ok: false }), { count: 5, reachable: false });
});
