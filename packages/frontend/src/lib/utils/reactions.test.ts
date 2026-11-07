import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupReactions } from './reactions';

const r = (emoji: string, user: string) => ({ emoji, user, created_at: '2026-10-13T00:00:00Z' });

test('one chip per emoji, first-seen order, users kept', () => {
  assert.deepEqual(groupReactions([r('😏', 'user'), r('💀', 'companion-a'), r('😏', 'companion-b')]), [
    { emoji: '😏', count: 2, users: ['user', 'companion-b'] },
    { emoji: '💀', count: 1, users: ['companion-a'] },
  ]);
});

test('no reactions, no chips', () => {
  assert.deepEqual(groupReactions([]), []);
});
