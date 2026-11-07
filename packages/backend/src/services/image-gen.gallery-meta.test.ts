import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { chatGalleryMeta, galleryDimensions } = await import('./image-gen.js');

describe('gallery card for a picture made from chat', () => {
  it('keeps the prompt, model, size and who is in it — the same card the Studio tab writes', () => {
    const meta = chatGalleryMeta({
      prompt: 'three of us on the couch',
      subjects: ['user', 'companion-a', 'companion-b'],
      size: 'landscape',
      model: 'gpt-image-2',
      backend: 'codex',
      messageId: 'm1',
      threadId: 't1',
      createdAt: '2026-10-28T05:00:00.000Z',
    });
    assert.deepEqual(meta, {
      messageId: 'm1',
      threadId: 't1',
      createdAt: '2026-10-28T05:00:00.000Z',
      prompt: 'three of us on the couch',
      model: 'gpt-image-2',
      backend: 'codex',
      width: 1536,
      height: 1024,
      aspectRatio: 'landscape',
      references: ['user', 'companion-a', 'companion-b'],
    });
  });

  it('leaves the cast off when nobody was named, and calls an unsized picture square', () => {
    const meta = chatGalleryMeta({ prompt: 'a lamp', messageId: 'm2', threadId: 't2', createdAt: 'x' });
    assert.equal(meta.references, undefined);
    assert.equal(meta.aspectRatio, 'square');
    assert.equal(meta.width, 1024);
    assert.equal(meta.height, 1024);
  });

  it('sizes the same way the Studio tab does', () => {
    assert.deepEqual(galleryDimensions('portrait'), { width: 1024, height: 1536 });
    assert.deepEqual(galleryDimensions('custom', 800, 600), { width: 800, height: 600 });
  });
});
