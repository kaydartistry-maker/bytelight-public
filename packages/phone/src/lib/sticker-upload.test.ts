import assert from 'node:assert/strict';
import test from 'node:test';
import { checkStickerBytes, sniffStickerType, stickerExtension, STICKER_MAX_BYTES } from './sticker-upload.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function png(extra: number[] = []): Uint8Array {
  return new Uint8Array([...PNG, ...extra]);
}
function webp(chunk: string): Uint8Array {
  return new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(chunk), 0, 0, 0, 0]);
}

test('static PNG and WebP are accepted with their real type', () => {
  assert.deepEqual(checkStickerBytes(png(ascii('IHDR'))), { ok: true, mime: 'image/png' });
  assert.deepEqual(checkStickerBytes(webp('VP8 ')), { ok: true, mime: 'image/webp' });
});

test('animated WebP and APNG are accepted as-is (no resize path exists)', () => {
  assert.deepEqual(checkStickerBytes(webp('VP8X')), { ok: true, mime: 'image/webp' });
  assert.deepEqual(checkStickerBytes(png([...ascii('IHDR'), ...ascii('acTL')])), { ok: true, mime: 'image/png' });
});

test('GIF and JPEG are refused, whatever the file was named', () => {
  assert.deepEqual(checkStickerBytes(new Uint8Array(ascii('GIF89a......'))), { ok: false, reason: 'type' });
  assert.deepEqual(checkStickerBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), { ok: false, reason: 'type' });
  assert.equal(sniffStickerType(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')])), null);
  assert.equal(sniffStickerType(new Uint8Array()), null);
});

test('files over the server cap are refused before upload', () => {
  const big = new Uint8Array(STICKER_MAX_BYTES + 1);
  big.set(PNG);
  assert.deepEqual(checkStickerBytes(big), { ok: false, reason: 'size' });
  const exact = new Uint8Array(STICKER_MAX_BYTES);
  exact.set(PNG);
  assert.equal(checkStickerBytes(exact).ok, true);
});

test('the upload filename extension follows the real type', () => {
  assert.equal(stickerExtension('image/png'), '.png');
  assert.equal(stickerExtension('image/webp'), '.webp');
});
