import test from 'node:test';
import assert from 'node:assert/strict';
import { transformationInput } from './transformation-input';
const image = (token: string) => ({ token, name: token + '.png', preview: 'blob:' + token });
test('face inputs retain base/identity order and keep additional edits separate from assignments', () => {
  assert.deepEqual(transformationInput('face-transplant', [image('base'), image('face1'), image('face2')], 'subscription-auto', 'Add earrings', '2 → left; 3 → right'), {
    kind: 'face-transplant', images: ['base', 'face1', 'face2'], imageModelId: 'subscription-auto', additionalEdits: 'Add earrings', faceAssignments: '2 → left; 3 → right',
  });
});
test('third face needs an explicit assignment; missing base or first identity cannot shift slots', () => {
  assert.throws(() => transformationInput('face-transplant', [image('base'), image('a'), image('b')], 'subscription-auto'), /Face assignments/);
  assert.throws(() => transformationInput('face-transplant', [image('base'), null, image('b')], 'subscription-auto'), /Image 2/);
});
test('smash uses exactly its two isolated uploads without extra edits, styles or character drawers', () => {
  assert.deepEqual(transformationInput('smash', [image('one'), image('two'), null], 'gpt-image-2', 'ignored', 'ignored'), { kind: 'smash', images: ['one', 'two'], imageModelId: 'gpt-image-2' });
  assert.throws(() => transformationInput('smash', [image('one'), image('two'), image('third')], 'gpt-image-2'), /exactly two/);
});
test('two-image face edit does not require a second-person assignment', () => {
  assert.deepEqual(transformationInput('face-transplant', [image('base'), image('face'), null], 'subscription-auto').images, ['base', 'face']);
});
