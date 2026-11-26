import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeTab } from './card-room-resume';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const fresh = '2026-11-26T11:00:00Z';

test('a house that never dealt opens on the bare table', () => {
  assert.equal(resumeTab(null, NOW), null);
  assert.equal(resumeTab(undefined, NOW), null);
});

test('a live, recent game is picked back up', () => {
  assert.equal(resumeTab({ game: 'rat-screw', status: 'playing', updatedAt: fresh }, NOW), 'ratscrew');
  assert.equal(resumeTab({ game: 'hearts', status: 'playing', updatedAt: fresh }, NOW), 'hearts');
});

test('an old, finished or unknown game stays on the bare table', () => {
  assert.equal(resumeTab({ game: 'hearts', status: 'playing', updatedAt: '2026-11-01T00:00:00Z' }, NOW), null);
  assert.equal(resumeTab({ game: 'hearts', status: 'complete', updatedAt: fresh }, NOW), null);
  assert.equal(resumeTab({ game: 'mystery', status: 'playing', updatedAt: fresh }, NOW), null);
  assert.equal(resumeTab({ game: 'hearts', status: 'playing', updatedAt: null }, NOW), null);
});
