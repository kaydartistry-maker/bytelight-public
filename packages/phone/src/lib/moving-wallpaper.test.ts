import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVING_MAX_BYTES, movingKindOf } from './moving-wallpaper.js';

test('videos play as video; GIFs and animated WebPs play as pictures; stills are refused', () => {
  assert.equal(movingKindOf({ name: 'waterfall.mp4', type: 'video/mp4' }), 'video');
  assert.equal(movingKindOf({ name: 'waterfall.webm', type: '' }), 'video'); // Android often sends no type
  assert.equal(movingKindOf({ name: 'IMG_0001.MOV', type: 'video/quicktime' }), 'video');
  assert.equal(movingKindOf({ name: 'sparkle.gif', type: 'image/gif' }), 'image');
  assert.equal(movingKindOf({ name: 'loop.webp', type: '' }), 'image');
  assert.equal(movingKindOf({ name: 'photo.jpg', type: 'image/jpeg' }), null);
  assert.equal(movingKindOf({ name: 'notes.txt', type: 'text/plain' }), null);
});

test('the size limit is 20 MB', () => {
  assert.equal(MOVING_MAX_BYTES, 20 * 1024 * 1024);
});
