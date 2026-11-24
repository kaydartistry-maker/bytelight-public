import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, applyAppLayout, migrateAppIds, loadAppLayout } from './apps';

const original = ['messages', 'status', 'integrations', 'agent', 'packs', 'commandcenter', 'canvas', 'companions', 'memory', 'journal', 'letters', 'library', 'theater', 'fieldnotes', 'spotify', 'treehouse', 'studio', 'files', 'inbox', 'weather', 'artifacts', 'xray', 'settings', 'notes', 'games'];

test('canonical launcher restores original BL plus independent custom Questing and art tools', () => {
  assert.deepEqual(APPS.map(app => app.id).sort(), [...original, 'questing', 'gif', 'cutout'].sort());
  assert.equal(new Set(APPS.map(app => app.id)).size, APPS.length);
  assert.equal(APPS.find(app => app.id === 'companions')?.name, 'Companion Editor');
});

test('legacy hub aliases resolve without duplicates and unknown ids stay harmless', () => {
  assert.deepEqual(migrateAppIds(['messages', 'cortex', 'memoryblocks', 'memory', 'unknown', 'selfknowledge', 'studio', 'messages']), ['messages', 'memory', 'studio']);
});

test('saved sparse layouts preserve restored features and append all unplaced apps', () => {
  const storage = new Map([['bytelight_app_layout_v1', JSON.stringify(['messages', 'canvas', null, 'spotify', 'unknown', 'studio'])]]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  const slots = loadAppLayout()!;
  assert.deepEqual(slots, ['messages', 'canvas', null, 'spotify', null, 'studio']);
  assert.deepEqual(applyAppLayout(APPS, slots).filter(Boolean).map(app => app!.id).sort(), APPS.map(app => app.id).sort());
});
