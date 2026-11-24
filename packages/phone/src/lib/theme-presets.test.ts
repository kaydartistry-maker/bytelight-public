import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AppTheme } from '../types';
import type { ThemeAsset } from '../bytelight/theme-assets';
import { buildThemeBundle, createThemePreset, decodeThemeAsset, MAX_THEME_BUNDLE_BYTES, parseThemeBundle, persistThemePresetList, preflightThemeAssetImport, presetName, remapThemeAssetReferences, sanitizePresetTheme, THEME_ASSET_IMPORT_LIMITS, validateThemePresetList, type ThemeBundle } from './theme-presets';

const OLD = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const UNUSED = '33333333-3333-4333-8333-333333333333';
const BASE: AppTheme = { mode: 'dark', id: 'magenta' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const bytes = decodeThemeAsset(PNG);
const image: ThemeAsset = { id: OLD, name: 'overlay.png', kind: 'image', mime: 'image/png', bytes: bytes.length, url: `/api/theme-assets/${OLD}/file`, createdAt: '2026-11-18T00:00:00Z' };
const wrapped = (theme: AppTheme = BASE): ThemeBundle => ({ format: 'virelle-theme', version: 1, name: 'My look', theme, assets: [] });

describe('theme-only preset data', () => {
  it('allowlists legacy appearance and never captures app setup, identity or service keys', () => {
    const source = { ...BASE, contacts: { secret: 'private' }, appSettings: { apiKey: 'private' }, extras: { notes: 'private' }, model: 'private', apiKey: 'private' };
    assert.deepEqual(sanitizePresetTheme(source), BASE);
    const preset = createThemePreset(source, ' Saved look ');
    assert.equal(preset.name, 'Saved look'); assert.deepEqual(preset.theme, BASE);
    assert.equal(JSON.stringify(preset).includes('private'), false);
    assert.notEqual(createThemePreset(BASE, 'Other').id, preset.id);
    assert.throws(() => sanitizePresetTheme(source, true), /Unsupported theme field/);
  });
  it('round trips all legacy fields without replacing undefined defaults or per-mode colors', async () => {
    const full: AppTheme = {
      ...BASE, skin: 'none', fx: { aura: 200, glow: 90, motion: 90 }, accentOverride: null, accentPalette: 'Blush', typography: null,
      wallpaper: `data:image/png;base64,${PNG}`, lockScreenWallpaper: '/assets/clouds.png', wallpapers: ['/phone/assets/snow.png'], slideshowEnabled: false,
      customColors: { light: { panelBg: '#FFFFFF', userBubbleBg: '#11223399', noteText: 'rgba(0, 0, 0, 0.5)' }, dark: { panelBg: '#09090B', compBubbleText: 'white' } },
      stickyNoteColors: ['#112233', '#334455'], shapeRadius: 18,
      lockFace: 'classic', lockClockPosition: 'low', lockClockSize: 'l', lockClockAt: { classic: { x: 0.4, y: 0.8 } }, lockWeatherAt: { x: 0, y: 1 },
      lockHidden: ['weather'], lockShortcuts: ['studio', null], lockShow: 'first-line', lockCards: 'auto',
      homeWidgets: ['weather', 'day'], homeWidgetSpots: { weather: { col: 2, row: 3 } }, homeQuietLine: true,
    };
    const bundle = await buildThemeBundle('Full legacy look', full, [], async () => { throw new Error('No asset reads expected'); });
    assert.deepEqual(bundle.theme, full);
    assert.deepEqual(parseThemeBundle(JSON.stringify(bundle)).theme, full);
    assert.deepEqual(sanitizePresetTheme({ ...BASE, wallpaper: undefined }), BASE);
    assert.deepEqual(sanitizePresetTheme(BASE), BASE);
  });
  it('validates names, versions, enums, legacy numeric bounds and CSS colors', () => {
    for (const name of ['', ' ', 'x'.repeat(81), 'bad\nname']) assert.throws(() => presetName(name));
    for (const theme of [{ ...BASE, id: 'unknown' }, { ...BASE, mode: 'system' }, { ...BASE, shapeRadius: 100 }, { ...BASE, fx: { motion: -1 } }, { ...BASE, customColors: { dark: { panelBg: 'url(https://evil.invalid)' } } }, { ...BASE, lockClockAt: { classic: { x: 5, y: 0 } } }]) {
      assert.throws(() => sanitizePresetTheme(theme, true));
    }
    assert.throws(() => parseThemeBundle(JSON.stringify({ ...wrapped(), version: 2 })), /version/);
    assert.throws(() => parseThemeBundle(JSON.stringify({ ...wrapped(), appSettings: {} })), /Unsupported theme field/);
  });
  it('rejects unknown/dangerous keys and unsupported appearance values before import', () => {
    assert.throws(() => parseThemeBundle('{"format":"virelle-theme","version":1,"name":"X","theme":{"mode":"dark","id":"magenta","__proto__":{"polluted":true}},"assets":[]}'), /Unsafe/);
    for (const appearance of [{ version: 2 }, { version: 1, cards: { fill: { opacity: 1000 } } }, { version: 1, chat: { defaults: { blur: 5 } } }, { version: 1, cards: { url: 'https://evil.invalid' } }, { version: 1, cards: { fill: { color: '#fff' }, unknown: {} } }]) {
      assert.throws(() => parseThemeBundle(JSON.stringify(wrapped({ ...BASE, appearance } as any))));
    }
    assert.equal(({} as any).polluted, undefined);
  });
  it('rejects oversized, malformed and overly complex files', () => {
    assert.throws(() => parseThemeBundle(' '.repeat(MAX_THEME_BUNDLE_BYTES + 1)), /20 MB/);
    assert.throws(() => parseThemeBundle('not JSON'), /valid JSON/);
    let nested: any = {}; for (let i = 0; i < 30; i++) nested = { child: nested };
    assert.throws(() => parseThemeBundle(JSON.stringify({ ...wrapped(), unknown: nested })), /deeply/);
    assert.throws(() => parseThemeBundle(JSON.stringify({ ...wrapped(), assets: Array.from({ length: 30_001 }, () => ({})) })), /complex/);
    assert.throws(() => decodeThemeAsset('abcd=bad'));
    assert.throws(() => decodeThemeAsset('===='));
  });
  it('embeds only referenced private assets, deduplicates references and never reads unrelated files', async () => {
    const theme: AppTheme = { ...BASE, wallpaper: image.url, appearance: { version: 1, cards: { overlay: { assetId: OLD } }, chat: { user: { border: { overlay: { assetId: OLD } } } } } };
    const reads: string[] = [];
    const bundle = await buildThemeBundle('Layered', theme, [image, { ...image, id: UNUSED, url: `/api/theme-assets/${UNUSED}/file` }], async asset => { reads.push(asset.id); return bytes; });
    assert.deepEqual(reads, [OLD]); assert.equal(bundle.assets.length, 1);
    assert.equal(bundle.assets[0].data, PNG);
    assert.deepEqual(parseThemeBundle(JSON.stringify(bundle)), bundle);
  });
  it('never fetches arbitrary metadata URLs or remote legacy wallpaper URLs', async () => {
    let reads = 0; const reader = async () => { reads++; return bytes; };
    const remote = { ...BASE, wallpaper: 'https://example.invalid/private.png' };
    assert.deepEqual(sanitizePresetTheme(remote), remote); // Existing local saved look is retained.
    await assert.rejects(buildThemeBundle('Remote', remote, [], reader), /Remote wallpaper/);
    assert.throws(() => parseThemeBundle(JSON.stringify(wrapped(remote))), /Remote wallpaper/);
    const theme = { ...BASE, appearance: { version: 1, cards: { overlay: { assetId: OLD } } } } as AppTheme;
    await assert.rejects(buildThemeBundle('Evil', theme, [{ ...image, url: 'https://evil.invalid/track' }], reader));
    assert.equal(reads, 0);
    for (const wallpaper of ['javascript:alert(1)', '//evil.invalid/a.png', 'data:image/svg+xml;base64,PHN2Zy8+', '/api/theme-assets/not-an-id/file', '/assets/../private']) assert.throws(() => sanitizePresetTheme({ ...BASE, wallpaper }, true, true));
  });
  it('embeds typed uploaded fonts and rejects image/font slot mismatches', async () => {
    const fontBytes = new Uint8Array(32), view = new DataView(fontBytes.buffer);
    view.setUint32(0, 0x00010000); view.setUint16(4, 1); view.setUint32(20, 28); view.setUint32(24, 4);
    const font: ThemeAsset = { ...image, kind: 'font', name: 'custom.ttf', mime: 'font/ttf', bytes: fontBytes.length };
    const theme: AppTheme = { ...BASE, appearance: { version: 1, typography: { heading: { assetId: OLD } } } };
    const bundle = await buildThemeBundle('Typography', theme, [font], async () => fontBytes);
    assert.equal(bundle.assets[0].kind, 'font');
    assert.deepEqual(parseThemeBundle(JSON.stringify(bundle)), bundle);
    await assert.rejects(buildThemeBundle('Wrong kind', theme, [image], async () => { throw new Error('Must not read'); }), /wrong kind/);
    assert.throws(() => parseThemeBundle(JSON.stringify({ ...bundle, assets: [{ id: OLD, name: 'image.png', kind: 'image', mime: 'image/png', data: PNG }] })), /kind/);
  });
  it('requires exact embedded reference sets, filenames, kind/mime and actual content signatures', () => {
    const theme = { ...BASE, appearance: { version: 1, cards: { overlay: { assetId: OLD } } } } as AppTheme;
    const valid = { ...wrapped(theme), assets: [{ id: OLD, name: image.name, kind: image.kind, mime: image.mime, data: PNG }] };
    assert.equal(parseThemeBundle(JSON.stringify(valid)).assets.length, 1);
    assert.throws(() => parseThemeBundle(JSON.stringify(wrapped(theme))), /exactly match/);
    assert.throws(() => parseThemeBundle(JSON.stringify({ ...wrapped(), assets: valid.assets })), /exactly match/);
    assert.throws(() => parseThemeBundle(JSON.stringify({ ...valid, assets: [...valid.assets, ...valid.assets] })), /Duplicate/);
    for (const patch of [{ name: '../x.png' }, { kind: 'font' }, { mime: 'image/svg+xml' }, { data: btoa('<html>') }, { id: '../bad' }, { mime: 'constructor', kind: undefined }]) {
      assert.throws(() => parseThemeBundle(JSON.stringify({ ...valid, assets: [{ ...valid.assets[0], ...patch }] })));
    }
  });
  it('remaps only appearance asset IDs and exact own URLs without mutating the source', () => {
    const theme: AppTheme = { ...BASE, wallpaper: image.url, wallpapers: [image.url, '/assets/local.png'], appearance: { version: 1, cards: { overlay: { assetId: OLD } }, typography: { heading: { assetId: OLD } }, chat: { companions: { [OLD]: { text: { font: OLD } } } } } };
    const remapped = remapThemeAssetReferences(theme, { [OLD]: NEXT });
    assert.equal(remapped.wallpaper, `/api/theme-assets/${NEXT}/file`);
    assert.equal(remapped.wallpapers![1], '/assets/local.png');
    assert.equal(remapped.appearance!.cards!.overlay!.assetId, NEXT);
    assert.equal(remapped.appearance!.typography!.heading!.assetId, NEXT);
    assert.equal(remapped.appearance!.chat!.companions![OLD].text!.font, OLD);
    assert.equal(theme.appearance!.cards!.overlay!.assetId, OLD);
    assert.throws(() => remapThemeAssetReferences(theme, {}), /mapping/);
  });
  it('does not acknowledge preset persistence until the parent write is durable', async () => {
    const list = [createThemePreset(BASE, 'Pending')], events: string[] = [];
    let release!: () => void, acknowledged = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const saving = persistThemePresetList(list, async candidate => {
      assert.equal(candidate, list); events.push('write-start'); await gate; events.push('write-ack');
    }, candidate => { assert.equal(candidate, list); events.push('snapshot-preflight'); });
    const completion = saving.then(() => { acknowledged = true; });
    await Promise.resolve();
    assert.deepEqual(events, ['snapshot-preflight', 'write-start']); assert.equal(acknowledged, false);
    release(); await completion;
    assert.deepEqual(events, ['snapshot-preflight', 'write-start', 'write-ack']); assert.equal(acknowledged, true);
  });
  it('propagates failed writes and rejects a complete-snapshot budget before persistence', async () => {
    const original = [createThemePreset(BASE, 'Existing')], copy = structuredClone(original);
    let writes = 0;
    await assert.rejects(persistThemePresetList(original, async () => { writes++; throw Error('Server write failed'); }), /Server write failed/);
    assert.deepEqual(original, copy);
    await assert.rejects(persistThemePresetList(original, async () => { writes++; }, () => { throw Error('Complete settings snapshot exceeds 10 MB'); }), /snapshot exceeds 10 MB/);
    assert.equal(writes, 1, 'snapshot rejection prevents all persistence'); assert.deepEqual(original, copy);
  });
  it('bounds the entire preset library by count and UTF-8 bytes, including rename growth', () => {
    const preset = createThemePreset(BASE, 'Small');
    assert.doesNotThrow(() => validateThemePresetList(Array.from({ length: 50 }, () => preset)));
    assert.throws(() => validateThemePresetList(Array.from({ length: 51 }, () => preset)), /50/);
    assert.throws(() => validateThemePresetList([{ ...preset, name: '€'.repeat(Math.ceil(MAX_THEME_BUNDLE_BYTES / 3)) }]), /20 MB/);
  });
  it('preflights imported asset count and storage bytes against the known library', () => {
    const theme: AppTheme = { ...BASE, appearance: { version: 1, cards: { overlay: { assetId: OLD } } } };
    const bundle = { ...wrapped(theme), assets: [{ id: OLD, name: image.name, kind: image.kind, mime: image.mime, data: PNG }] };
    assert.doesNotThrow(() => preflightThemeAssetImport(bundle, []));
    assert.throws(() => preflightThemeAssetImport(bundle, Array.from({ length: 200 }, () => image)), /200-asset/);
    assert.throws(() => preflightThemeAssetImport(bundle, [{ ...image, bytes: THEME_ASSET_IMPORT_LIMITS.quotaBytes }]), /250 MB/);
    assert.throws(() => preflightThemeAssetImport(bundle, [{ ...image, bytes: NaN }]), /Reload/);
  });
  it('normalizes bundled filenames before rejecting dot or whitespace-only names', () => {
    const theme: AppTheme = { ...BASE, appearance: { version: 1, cards: { overlay: { assetId: OLD } } } };
    const make = (name: string) => JSON.stringify({ ...wrapped(theme), assets: [{ id: OLD, name, kind: image.kind, mime: image.mime, data: PNG }] });
    assert.throws(() => parseThemeBundle(make(' .hidden.png')), /filename/);
    assert.throws(() => parseThemeBundle(make('   ')), /filename/);
    assert.equal(parseThemeBundle(make('  visible.png  ')).assets[0].name, 'visible.png');
  });
});
