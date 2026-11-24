import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { STICKER_TOKEN, resolveStickerRef, stickerRefSplits } from './sticker-ref.js';

describe('sticker refs with underscores in the sticker name', () => {
  test('every split is offered, first underscore first', () => {
    assert.deepEqual(stickerRefSplits('Operator_heart_hands'), [['Operator', 'heart_hands'], ['Operator_heart', 'hands']]);
    assert.deepEqual(stickerRefSplits('Operator_stabby'), [['Operator', 'stabby']]);
  });

  test('Operator_heart_hands resolves to pack Operator, sticker heart_hands', () => {
    const known = new Set(['operator/heart_hands', 'operator/stabby', 'operator/i_shoot']);
    const lookup = (p: string, n: string) => (known.has(`${p.toLowerCase()}/${n.toLowerCase()}`) ? `${p}/${n}` : null);
    assert.equal(resolveStickerRef('Operator_heart_hands', lookup), 'Operator/heart_hands');
    assert.equal(resolveStickerRef('operator_i_shoot', lookup), 'operator/i_shoot');
    assert.equal(resolveStickerRef('Operator_stabby', lookup), 'Operator/stabby');
    assert.equal(resolveStickerRef('Operator_nope_nope', lookup), null);
  });

  test('a lookup that throws reads as no match', () => {
    assert.equal(resolveStickerRef('Operator_x', () => { throw new Error('db down'); }), null);
  });

  test('tokens are found in text, with and without extra underscores', () => {
    const bodies = [...':Operator_heart_hands: and :Operator_stabby: but not :plain:'.matchAll(STICKER_TOKEN)].map((m) => m[1]);
    assert.deepEqual(bodies, ['Operator_heart_hands', 'Operator_stabby']);
  });
});
