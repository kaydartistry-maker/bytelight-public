import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ThemeAssetStore, themeAssetIsReferenced, ThemeAssetError } from './theme-assets.js';

const root = mkdtempSync(join(tmpdir(), 'theme-assets-service-'));
after(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
const store = (limits = {}) => new ThemeAssetStore(join(root, String(++serial)), limits);
const png = () => sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 120, g: 40, b: 200, alpha: 0.25 } } }).png().toBuffer();
function sfnt(tag = 0x00010000): Buffer {
  const data = Buffer.alloc(32); data.writeUInt32BE(tag); data.writeUInt16BE(1, 4);
  data.write('test', 12); data.writeUInt32BE(28, 20); data.writeUInt32BE(4, 24); return data;
}
function woff(second = false): Buffer {
  const data = Buffer.alloc(second ? 52 : 68);
  data.write(second ? 'wOF2' : 'wOFF'); data.writeUInt32BE(0x00010000, 4); data.writeUInt32BE(data.length, 8);
  data.writeUInt16BE(1, 12); data.writeUInt32BE(32, 16);
  if (second) data.writeUInt32BE(2, 20);
  else { data.write('test', 44); data.writeUInt32BE(64, 48); data.writeUInt32BE(4, 52); data.writeUInt32BE(4, 56); }
  return data;
}
describe('private typed theme assets', () => {
  it('preserves original transparent image bytes and uses immutable UUID paths', async () => {
    const s = store(), input = await png(), a = await s.save(input, 'precise.png', 'image');
    assert.equal(a.mime, 'image/png'); assert.equal(a.bytes, input.length);
    assert.match(a.id, /^[a-f0-9-]{36}$/); assert.equal(a.url, `/api/theme-assets/${a.id}/file`);
    assert.deepEqual(readFileSync(s.get(a.id)!.path), input);
    assert.equal((await sharp(readFileSync(s.get(a.id)!.path)).metadata()).hasAlpha, true);
    assert.deepEqual(s.list(), [a]); assert.equal(s.get('../metadata'), null);
    assert.equal(readdirSync(s.directory).some(n => n.startsWith('.upload')), false);
  });
  it('checks actual content, extensions, paths, decoded pixel and byte bounds', async () => {
    const s = store(), input = await png();
    for (const [data, name] of [[Buffer.from('<svg/>'), 'image.png'], [Buffer.from('<html/>'), 'x.png'], [input, '../x.png'], [input, 'x.svg'], [input.subarray(0, 25), 'x.png']] as const) {
      await assert.rejects(s.save(data, name, 'image'), ThemeAssetError);
    }
    await assert.rejects(store({ maxBytes: 4 }).save(input, 'x.png', 'image'), { status: 413 });
    await assert.rejects(store({ maxPixels: 1 }).save(input, 'x.png', 'image'), ThemeAssetError);
  });
  it('normalizes filenames before checking hidden/empty names and round trips the normalized name', async () => {
    const s = store(), input = await png();
    for (const name of [' .hidden.png', '   ', '\t.hidden.png  ']) await assert.rejects(s.save(input, name, 'image'), ThemeAssetError);
    const asset = await s.save(input, '   visible.png  ', 'image');
    assert.equal(asset.name, 'visible.png');
    assert.equal(s.get(asset.id)?.asset.name, 'visible.png');
    assert.deepEqual(s.list(), [asset]);
    assert.equal(s.list().reduce((sum, item) => sum + item.bytes, 0), input.length);
  });
  it('accepts each supported raster format without re-encoding uploaded bytes', async () => {
    const s = store();
    for (const format of ['jpeg', 'webp', 'gif'] as const) {
      const bytes = await sharp(await png()).toFormat(format).toBuffer();
      const asset = await s.save(bytes, `texture.${format === 'jpeg' ? 'jpg' : format}`, 'image');
      assert.equal(asset.mime, `image/${format}`);
      assert.deepEqual(readFileSync(s.get(asset.id)!.path), bytes);
    }
  });
  it('accepts bounded structural WOFF/WOFF2/TTF/OTF headers and rejects malformed fonts', async () => {
    const s = store();
    for (const [data, extension] of [[sfnt(), 'ttf'], [sfnt(0x4f54544f), 'otf'], [woff(), 'woff'], [woff(true), 'woff2']] as const) {
      const asset = await s.save(data, `font.${extension}`, 'font');
      assert.equal(asset.mime, `font/${extension}`); assert.equal(asset.fontFamily, `ThemeFont_${asset.id.replaceAll('-', '_')}`);
    }
    for (const data of [Buffer.alloc(2), Buffer.from('<script>alert(1)</script>'), sfnt().subarray(0, 16)]) await assert.rejects(s.save(data, 'bad.ttf', 'font'), ThemeAssetError);
    const corrupt = woff(); corrupt.writeUInt32BE(99999, 48);
    await assert.rejects(s.save(corrupt, 'bad.woff', 'font'), ThemeAssetError);
    await assert.rejects(store({ maxFontBytes: 2 }).save(sfnt(), 'big.ttf', 'font'), { status: 413 });
  });
  it('enforces both quota and asset-count limits without replacing existing bytes', async () => {
    const input = await png(), s = store({ maxAssets: 1 }), a = await s.save(input, 'one.png', 'image');
    await assert.rejects(s.save(input, 'two.png', 'image'), { status: 413 });
    assert.deepEqual(s.list(), [a]);
    await assert.rejects(store({ quotaBytes: input.length - 1 }).save(input, 'one.png', 'image'), { status: 413 });
  });
  it('rechecks quota at publication after concurrent asynchronous image validation', async () => {
    const s = store({ maxAssets: 1 }), input = await png();
    const results = await Promise.allSettled([s.save(input, 'first.png', 'image'), s.save(input, 'second.png', 'image')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.status, 413);
    assert.equal(s.list().length, 1);
  });
  it('protects current and preset references and deletes only an explicitly unused asset', async () => {
    const s = store(), a = await s.save(await png(), 'one.png', 'image');
    const setups = [
      { theme: { appearance: { overlay: { assetId: a.id } } } },
      { themePresets: [{ appearance: { fontAssetId: a.id } }] },
      { appSettings: { themePresets: [{ image: a.url }] } },
      { appSettings: { appearancePresets: [{ border: { imageAssetId: a.id } }] } },
    ];
    for (const setup of setups) assert.throws(() => s.remove(a.id, setup), { status: 409 });
    assert.equal(themeAssetIsReferenced({ appSettings: { apiKey: a.id } }, a.id), false);
    assert.equal(s.remove(a.id, { theme: {} }), true); assert.equal(s.get(a.id), null);
    assert.equal(s.remove(a.id, {}), false);
  });
  it('fails reference scanning closed for excessively nested settings and ignores symlink entries', async () => {
    const s = store(), a = await s.save(await png(), 'one.png', 'image');
    let nested: any = { assetId: a.id }; for (let i = 0; i < 30; i++) nested = { child: nested };
    assert.equal(themeAssetIsReferenced({ theme: nested }, a.id), true);
    assert.equal(themeAssetIsReferenced('corrupt-settings', a.id), true);
    assert.equal(themeAssetIsReferenced({ theme: 'corrupt-theme' }, a.id), true);
    const target = '11111111-1111-4111-8111-111111111111';
    symlinkSync(join(s.directory, a.id), join(s.directory, target));
    assert.equal(s.get(target), null); assert.equal(s.list().length, 1);
  });
});
