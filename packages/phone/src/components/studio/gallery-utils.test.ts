import assert from 'node:assert/strict';
import test from 'node:test';
import { filterGallery, galleryItemToImage } from './gallery-utils.js';

const items = [
  galleryItemToImage({ filename: 'a.png', url: '/a', folderId: 'f1', references: ['fern'] }),
  galleryItemToImage({ filename: 'b.png', url: '/b', folderId: 'f2', references: ['fern', 'nim'] }),
  galleryItemToImage({ filename: 'c.png', url: '/c', folderId: null, references: null }),
];

test('no filter shows the whole gallery', () => {
  assert.deepEqual(filterGallery(items, '', '').map((i) => i.id), ['a.png', 'b.png', 'c.png']);
});

test('folder and subject filters narrow the one fetched list', () => {
  assert.deepEqual(filterGallery(items, 'f2', '').map((i) => i.id), ['b.png']);
  assert.deepEqual(filterGallery(items, '', 'fern').map((i) => i.id), ['a.png', 'b.png']);
  assert.deepEqual(filterGallery(items, 'f1', 'nim').map((i) => i.id), []);
});

test('gallery rows map the fields the route really returns', () => {
  const image = galleryItemToImage({
    filename: 'x.mp4', url: '/api/studio/gallery/x.mp4', mediaType: 'video',
    createdAt: '2026-10-23T00:00:00.000Z', folderId: 'f1', references: ['fern'],
  });
  assert.equal(image.id, 'x.mp4');
  assert.equal(image.mediaType, 'video');
  assert.equal(image.folderId, 'f1');
  assert.deepEqual(image.references, ['fern']);
  assert.equal(image.timestamp, Date.parse('2026-10-23T00:00:00.000Z'));
});

test('gallery rows keep the chat message they came from, when there is one', () => {
  const fromChat = galleryItemToImage({ filename: 'a.png', threadId: 't1', messageId: 'm1', threadName: 'Home' });
  assert.equal(fromChat.threadId, 't1');
  assert.equal(fromChat.messageId, 'm1');
  assert.equal(fromChat.threadName, 'Home');
  const loose = galleryItemToImage({ filename: 'b.png', threadId: null, messageId: null, threadName: null });
  assert.equal(loose.threadId, undefined);
  assert.equal(loose.messageId, undefined);
});
