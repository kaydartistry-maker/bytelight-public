import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTE_ROLES } from '@bytelight/shared';
import { NOTE_ROLE_TUNING } from './note-colors.js';

// resolveNoteColor picks a swatch by the role's INDEX, so the tuning table and
// the canonical list have to agree on membership AND order. Add a role in one
// place only and every note below it silently paints as its neighbour.
test('the tuning table covers every canonical role, in order', () => {
  assert.deepEqual(NOTE_ROLE_TUNING, [...NOTE_ROLES]);
});
