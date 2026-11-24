import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extensionForMime,
  fitDimensions,
  normalizeImageFilename,
  sniffImageBytes,
} from './image-resize.js';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

function pngChunk(type: string, dataLen = 0): number[] {
  return [...u32be(dataLen), ...ascii(type), ...new Array(dataLen).fill(0), 0, 0, 0, 0];
}

function makeWebp(chunks: Array<{ fourcc: string; data: number[] }>): Uint8Array {
  const body: number[] = [];
  for (const c of chunks) {
    body.push(...ascii(c.fourcc), ...u32le(c.data.length), ...c.data);
    if (c.data.length % 2 === 1) body.push(0);
  }
  return new Uint8Array([...ascii('RIFF'), ...u32le(body.length + 4), ...ascii('WEBP'), ...body]);
}

test('sniffImageBytes identifies static and animated PNG/WebP/GIF/JPEG', () => {
  const staticPng = new Uint8Array([...PNG_SIG, ...pngChunk('IHDR', 13), ...pngChunk('IDAT', 4)]);
  assert.deepEqual(sniffImageBytes(staticPng), { mime: 'image/png', animated: false });

  const apng = new Uint8Array([...PNG_SIG, ...pngChunk('IHDR', 13), ...pngChunk('acTL', 8), ...pngChunk('IDAT', 4)]);
  assert.deepEqual(sniffImageBytes(apng), { mime: 'image/png', animated: true });

  const staticWebp = makeWebp([{ fourcc: 'VP8 ', data: [0, 0, 0, 0] }]);
  assert.deepEqual(sniffImageBytes(staticWebp), { mime: 'image/webp', animated: false });

  const vp8xStatic = makeWebp([{ fourcc: 'VP8X', data: [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0] }]);
  assert.deepEqual(sniffImageBytes(vp8xStatic), { mime: 'image/webp', animated: false });

  const vp8xAnim = makeWebp([{ fourcc: 'VP8X', data: [0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0] }]);
  assert.deepEqual(sniffImageBytes(vp8xAnim), { mime: 'image/webp', animated: true });

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  assert.deepEqual(sniffImageBytes(jpeg), { mime: 'image/jpeg', animated: false });

  const staticGif = new Uint8Array([...ascii('GIF89a'), 0x21, 0xf9, 0x04, 0, 0, 0, 0, 0]);
  assert.deepEqual(sniffImageBytes(staticGif), { mime: 'image/gif', animated: false });

  const animGif = new Uint8Array([...ascii('GIF89a'), 0x21, 0xf9, 0x04, 0, 0, 0x21, 0xf9, 0x04, 0, 0]);
  assert.deepEqual(sniffImageBytes(animGif), { mime: 'image/gif', animated: true });

  assert.equal(sniffImageBytes(new Uint8Array([1, 2, 3, 4])), null);
});

test('fitDimensions respects both maxDimension and maxPixels proportionally', () => {
  assert.deepEqual(fitDimensions(1200, 800, 2000, 16_000_000), { width: 1200, height: 800, scaled: false });

  const byDim = fitDimensions(4000, 2000, 2000);
  assert.deepEqual(byDim, { width: 2000, height: 1000, scaled: true });

  const byPixels = fitDimensions(5000, 4000, undefined, 15_000_000);
  assert.equal(byPixels.scaled, true);
  assert.ok(byPixels.width * byPixels.height <= 15_000_000);
  assert.ok(Math.abs(byPixels.width / byPixels.height - 1.25) < 0.02);
});

test('normalizeImageFilename aligns extensions to real MIME and strips path characters', () => {
  assert.equal(normalizeImageFilename('photo.heic', 'image/webp'), 'photo.webp');
  assert.equal(normalizeImageFilename('sticker.PNG', 'image/webp'), 'sticker.webp');
  assert.equal(normalizeImageFilename('wallpaper', 'image/jpeg'), 'wallpaper.jpg');
  assert.equal(normalizeImageFilename('..hidden/name.png', 'image/png'), 'hidden_name.png');
  assert.equal(extensionForMime('image/gif'), '.gif');
});
