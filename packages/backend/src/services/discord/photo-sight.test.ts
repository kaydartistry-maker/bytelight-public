import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { discordPhotoImages, isPhotoAttachment, MAX_DISCORD_PHOTO_BYTES } from './photo-sight.js';

const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer();

function fakeFetch(bodies: Record<string, Buffer | number>): typeof fetch {
  return (async (url: string | URL) => {
    const body = bodies[String(url)];
    if (typeof body === 'number') return new Response('nope', { status: body });
    if (!body) throw new Error('network down');
    return new Response(new Uint8Array(body), { status: 200 });
  }) as typeof fetch;
}

describe('Discord photos reach the companions', () => {
  it('recognises pictures by content type or file name', () => {
    assert.equal(isPhotoAttachment({ url: 'u', contentType: 'image/jpeg' }), true);
    assert.equal(isPhotoAttachment({ url: 'u', name: 'snow.PNG' }), true);
    assert.equal(isPhotoAttachment({ url: 'u', contentType: 'video/mp4', name: 'x.mp4' }), false);
    assert.equal(isPhotoAttachment({ url: 'u', name: 'notes.txt' }), false);
  });

  it('fetches a photo and hands it back as a picture', async () => {
    const { images, notes } = await discordPhotoImages(
      [{ url: 'https://cdn/snow.png', name: 'snow.png', contentType: 'image/png', size: png.length }],
      fakeFetch({ 'https://cdn/snow.png': png }),
    );
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, 'image/png');
    assert.ok(images[0].base64.length > 0);
    assert.deepEqual(notes, []);
  });

  it('skips non-pictures without touching the network', async () => {
    const { images, notes } = await discordPhotoImages(
      [{ url: 'https://cdn/clip.mp4', name: 'clip.mp4', contentType: 'video/mp4' }],
      fakeFetch({}),
    );
    assert.equal(images.length, 0);
    assert.deepEqual(notes, []);
  });

  it('says so instead of failing when a photo cannot be fetched', async () => {
    const { images, notes } = await discordPhotoImages(
      [
        { url: 'https://cdn/gone.png', name: 'gone.png', contentType: 'image/png' },
        { url: 'https://cdn/ok.png', name: 'ok.png', contentType: 'image/png' },
      ],
      fakeFetch({ 'https://cdn/gone.png': 404, 'https://cdn/ok.png': png }),
    );
    assert.equal(images.length, 1);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /gone\.png could not be fetched/);
  });

  it('refuses an oversized photo before downloading it', async () => {
    const { images, notes } = await discordPhotoImages(
      [{ url: 'https://cdn/huge.png', name: 'huge.png', contentType: 'image/png', size: MAX_DISCORD_PHOTO_BYTES + 1 }],
      fakeFetch({}),
    );
    assert.equal(images.length, 0);
    assert.match(notes[0], /too large/);
  });
});
