import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import sharp from 'sharp';
import {
  MAX_FRAMES_PER_VISUAL,
  describeInlineVisuals,
  fileToVisualImages,
  findInlineVisualRefs,
  inlineVisualImages,
  pickFrameIndexes,
  resolveInlineVisuals,
  type InlineVisualLookups,
} from './inline-visuals.js';
import { attachImagesToLatestUserMessage } from './agent/attachment-images.js';

async function stillPng(dir: string, name: string, rgb: [number, number, number]): Promise<string> {
  const path = join(dir, name);
  const buf = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
  writeFileSync(path, buf);
  return path;
}

/** A GIF whose frames are solid colours, so a frame can be told apart by its colour. */
async function animatedGif(dir: string, name: string, colours: Array<[number, number, number]>): Promise<string> {
  const size = 16;
  const raw = Buffer.alloc(size * size * 3 * colours.length);
  colours.forEach(([r, g, b], frame) => {
    for (let px = 0; px < size * size; px += 1) {
      const at = (frame * size * size + px) * 3;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b;
    }
  });
  const path = join(dir, name);
  const buf = await sharp(raw, { raw: { width: size, height: size * colours.length, channels: 3, pageHeight: size } })
    .gif({ delay: colours.map(() => 100) })
    .toBuffer();
  writeFileSync(path, buf);
  return path;
}

async function dominantColour(image: { base64: string }): Promise<[number, number, number]> {
  const { dominant } = await sharp(Buffer.from(image.base64, 'base64')).stats();
  return [dominant.r, dominant.g, dominant.b];
}

function near(actual: number, expected: number, slack = 40): boolean {
  return Math.abs(actual - expected) <= slack;
}

describe('stickers and custom emoji become pictures at the front door', () => {
  test('finds known stickers and emoji in typed order and ignores unknown ones', () => {
    const lookups: InlineVisualLookups = {
      stickerPath: (pack, name) => (pack === 'cats' && name === 'wave' ? '/s/wave.png' : null),
      emojiPath: (name) => (name === 'panda' ? '/e/panda.png' : null),
    };
    const refs = findInlineVisualRefs('hi :panda: look :cats_wave: and :nope_nothing: :panda:', lookups);
    assert.deepEqual(refs.map((r) => [r.kind, r.ref, r.path]), [
      ['emoji', ':panda:', '/e/panda.png'],
      ['sticker', ':cats_wave:', '/s/wave.png'],
    ]);
  });

  test('a sticker whose own name has underscores is still found', () => {
    const lookups: InlineVisualLookups = {
      stickerPath: (pack, name) => (pack === 'Operator' && name === 'heart_hands' ? '/tmp/heart_hands.png' : null),
      emojiPath: () => null,
    };
    const refs = findInlineVisualRefs('look :Operator_heart_hands:', lookups);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].ref, ':Operator_heart_hands:');
    assert.equal(refs[0].path, '/tmp/heart_hands.png');
  });

  test('a lookup that throws leaves the message as text', () => {
    const lookups: InlineVisualLookups = {
      stickerPath: () => { throw new Error('db closed'); },
      emojiPath: () => { throw new Error('db closed'); },
    };
    assert.deepEqual(findInlineVisualRefs(':cats_wave: :panda:', lookups), []);
  });

  test('a still sticker is handed over as its own file, untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inline-visuals-'));
    const path = await stillPng(dir, 'wave.png', [200, 30, 30]);
    const opened = await fileToVisualImages(path, MAX_FRAMES_PER_VISUAL);
    assert.ok(opened);
    assert.equal(opened.animated, false);
    assert.equal(opened.images.length, 1);
    assert.equal(opened.images[0].mimeType, 'image/png');
  });

  test('a large still is cut down to frame size before it is handed over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inline-visuals-big-'));
    const path = join(dir, 'big.png');
    writeFileSync(path, await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 40, b: 90 } } }).png().toBuffer());
    const opened = await fileToVisualImages(path, MAX_FRAMES_PER_VISUAL);
    assert.ok(opened);
    assert.equal(opened.images.length, 1);
    assert.equal(opened.animated, false);
    assert.equal(opened.images[0].mimeType, 'image/png');
    const meta = await sharp(Buffer.from(opened.images[0].base64, 'base64')).metadata();
    assert.ok((meta.width ?? 0) <= 512 && (meta.height ?? 0) <= 512, `got ${meta.width}x${meta.height}`);
    assert.equal(meta.width, 512);
  });

  test('an animated one is opened into frames in time order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inline-visuals-'));
    const colours: Array<[number, number, number]> = [
      [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255],
    ];
    const path = await animatedGif(dir, 'spin.gif', colours);
    const opened = await fileToVisualImages(path, MAX_FRAMES_PER_VISUAL);
    assert.ok(opened);
    assert.equal(opened.animated, true);
    assert.equal(opened.totalFrames, 6);
    assert.equal(opened.images.length, MAX_FRAMES_PER_VISUAL);
    assert.ok(opened.images.every((i) => i.mimeType === 'image/png'));
    const first = await dominantColour(opened.images[0]);
    const last = await dominantColour(opened.images[opened.images.length - 1]);
    assert.ok(near(first[0], 255) && near(first[1], 0) && near(first[2], 0), `first frame was ${first}`);
    assert.ok(near(last[0], 255) && near(last[1], 0) && near(last[2], 255), `last frame was ${last}`);
  });

  test('frame picks keep the first and last frame', () => {
    assert.deepEqual(pickFrameIndexes(6, 4), [0, 2, 3, 5]);
    assert.deepEqual(pickFrameIndexes(2, 4), [0, 1]);
    assert.deepEqual(pickFrameIndexes(1, 4), [0]);
    assert.deepEqual(pickFrameIndexes(30, 1), [0]);
  });

  test('a file that is not an image is skipped, not thrown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inline-visuals-'));
    const path = join(dir, 'broken.png');
    writeFileSync(path, 'not an image');
    assert.equal(await fileToVisualImages(path, 4), null);
    assert.equal(await fileToVisualImages(join(dir, 'missing.png'), 4), null);
  });

  test('pictures never exceed what the message may still carry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inline-visuals-'));
    const gif = await animatedGif(dir, 'spin.gif', [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255]]);
    const png = await stillPng(dir, 'panda.png', [10, 10, 10]);
    const lookups: InlineVisualLookups = {
      stickerPath: (pack, name) => (pack === 'fun' ? (name === 'spin' ? gif : name === 'twirl' ? gif : null) : null),
      emojiPath: (name) => (name === 'panda' ? png : null),
    };
    const roomy = await resolveInlineVisuals(':fun_spin: :panda:', lookups, 8);
    assert.deepEqual(roomy.map((v) => [v.ref, v.images.length]), [[':fun_spin:', 4], [':panda:', 1]]);

    const tight = await resolveInlineVisuals(':fun_spin: :fun_twirl: :panda:', lookups, 3);
    assert.deepEqual(tight.map((v) => [v.ref, v.images.length]), [[':fun_spin:', 1], [':fun_twirl:', 1], [':panda:', 1]]);
    assert.ok(inlineVisualImages(tight).length <= 3);

    assert.deepEqual(await resolveInlineVisuals(':fun_spin:', lookups, 0), []);
  });

  test('the line naming the pictures says which are frames of one animation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inline-visuals-'));
    const gif = await animatedGif(dir, 'spin.gif', [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255]]);
    const png = await stillPng(dir, 'panda.png', [10, 10, 10]);
    const lookups: InlineVisualLookups = {
      stickerPath: () => gif,
      emojiPath: (name) => (name === 'panda' ? png : null),
    };
    const visuals = await resolveInlineVisuals(':fun_spin: :panda:', lookups, 8);
    const note = describeInlineVisuals(visuals, 1);
    assert.match(note, /after the 1 attached image,/);
    assert.match(note, /sticker :fun_spin: \(animated: 4 frames in time order, from 5\)/);
    assert.match(note, /custom emoji :panda:/);
    assert.equal(describeInlineVisuals([]), '');
  });

  test('every engine other than the SDK lane is handed the pictures on the current message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inline-visuals-'));
    const png = await stillPng(dir, 'wave.png', [200, 30, 30]);
    const lookups: InlineVisualLookups = { stickerPath: () => png, emojiPath: () => null };
    const visuals = await resolveInlineVisuals(':cats_wave:', lookups, 8);
    const history = [
      { role: 'assistant' as const, content: 'earlier', createdAt: '2026-01-01T00:00:00.000Z' },
      { role: 'user' as const, content: ':cats_wave:', createdAt: '2026-01-01T00:00:01.000Z' },
    ];
    const handed = attachImagesToLatestUserMessage(history, inlineVisualImages(visuals), ':cats_wave:');
    assert.equal(handed.length, 2);
    assert.equal(handed[1].images?.length, 1);
    assert.equal(handed[0].images, undefined);
  });
});
