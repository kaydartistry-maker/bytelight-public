import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearanceField, editAppearanceField } from './appearance-edit';

test('editing one nested field preserves siblings and the original snapshot', () => {
  const original = { border: { color: '#123456', width: 2 }, fill: { opacity: 80 } };
  const edited = editAppearanceField(original, 'border.width', 4);
  assert.equal(edited.border.width, 4);
  assert.equal(original.border.width, 2);
  assert.equal(edited.border.color, '#123456');
  assert.equal(appearanceField(edited, 'fill.opacity'), 80);
});
test('clearing and new nested fields do not overwrite adjacent settings', () => {
  const value = editAppearanceField({ border: { width: 2, color: '#abcdef' } }, 'border.width', undefined);
  assert.deepEqual(value, { border: { color: '#abcdef' } });
  assert.deepEqual(editAppearanceField({}, 'overlay.opacity', 0), { overlay: { opacity: 0 } });
  assert.equal(appearanceField({}, 'missing.value'), undefined);
});
test('internal path edits reject prototype and executable syntax', () => {
  for (const path of ['__proto__.polluted', 'constructor.prototype', 'border[0]', '', 'border..width']) {
    assert.throws(() => editAppearanceField({}, path, true));
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
