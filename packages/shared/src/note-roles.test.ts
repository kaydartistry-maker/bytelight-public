import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTE_ROLES, isNoteRole, noteRoleToken, normalizeNoteColor, roleFromToken } from './note-roles.js';

test('a role token round-trips', () => {
  for (const role of NOTE_ROLES) {
    const token = noteRoleToken(role);
    assert.equal(token, `role:${role}`);
    assert.equal(isNoteRole(token), true);
    assert.equal(roleFromToken(token), role);
  }
});

test('a role that does not exist is not a role', () => {
  assert.equal(isNoteRole('role:fire'), false);
  assert.equal(isNoteRole('dominant'), false);
  assert.equal(isNoteRole('#fef08a'), false);
  assert.equal(isNoteRole(null), false);
  assert.equal(roleFromToken('role:fire'), null);
});

// THE GAP THIS CLOSES: the agent-facing note route validated hex only, so a
// companion leaving her a note could never choose a role — only a colour, which
// then got snapped to the nearest swatch anyway. Both shapes are stored as-is now.
test('a note colour may be a role token or a hex, and nothing else', () => {
  assert.equal(normalizeNoteColor('role:quiet'), 'role:quiet');
  assert.equal(normalizeNoteColor('  role:paper  '), 'role:paper');
  assert.equal(normalizeNoteColor('#fef08a'), '#fef08a');
  assert.equal(normalizeNoteColor('#abc'), '#abc');
  assert.equal(normalizeNoteColor('role:fire'), null);
  assert.equal(normalizeNoteColor('rebeccapurple'), null);
  assert.equal(normalizeNoteColor(''), null);
  assert.equal(normalizeNoteColor(undefined), null);
  assert.equal(normalizeNoteColor(42), null);
});
