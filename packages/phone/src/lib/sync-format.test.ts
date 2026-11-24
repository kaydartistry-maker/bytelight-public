import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUSE_KEYS, findDataUrls, isSyncBlob, mergeById, pickHouse, settingsFromSync, swapStrings, themeFromSync } from './sync-format.js';

const BIG = 'data:image/webp;base64,' + 'A'.repeat(4000);
const BIG2 = 'data:font/ttf;base64,' + 'B'.repeat(4000);
const REF = 'bl-asset:' + 'a'.repeat(64);

test('house settings travel; connection settings and furniture never do', () => {
  const h = pickHouse({ osName: 'Glass Hause', appLogo: BIG, groupChatName: 'Bblers', workerUrl: 'https://x', backendUrl: 'https://y', giphyApiKey: 'k', elevenLabsApiKey: 'k', pushRelayUrl: 'z', dockAppIds: ['a'], customEmojis: [] } as never) as Record<string, unknown>;
  assert.deepEqual(Object.keys(h).sort(), ['appLogo', 'groupChatName', 'osName']);
  for (const k of ['workerUrl', 'backendUrl', 'pushRelayUrl', 'giphyApiKey', 'elevenLabsApiKey', 'dockAppIds', 'pushNotificationsEnabled']) {
    assert.ok(!(HOUSE_KEYS as readonly string[]).includes(k), `${k} must stay on the device`);
  }
});

test('a pulled look leaves furniture alone; a pulled house clears what the other device cleared', () => {
  const theme = { mode: 'dark', wallpaper: 'old', homeWidgets: ['weather'], lockShortcuts: ['x'] } as never;
  const after = { ...(theme as object), ...themeFromSync({ mode: 'light' }) } as Record<string, unknown>;
  assert.equal(after.mode, 'light');
  assert.equal(after.wallpaper, undefined);
  assert.deepEqual(after.homeWidgets, ['weather']);
  assert.deepEqual(after.lockShortcuts, ['x']);
  const s = { ...{ appLogo: 'old', workerUrl: 'keep' }, ...settingsFromSync({ osName: 'X' }) } as Record<string, unknown>;
  assert.equal(s.appLogo, undefined);
  assert.equal(s.workerUrl, 'keep');
});

test('big files are found anywhere and swapped for references both ways', () => {
  const value = { look: { wallpaper: BIG, wallpapers: [BIG, 'data:image/png;base64,tiny'] }, fonts: [{ data: BIG2 }] };
  const found = findDataUrls(value);
  assert.deepEqual([...found], [BIG, BIG2]); // deduped, tiny ones stay inline
  const out = swapStrings(value, new Map([[BIG, REF]]));
  assert.equal(out.look.wallpaper, REF);
  assert.equal(out.look.wallpapers[1], 'data:image/png;base64,tiny');
  assert.equal(out.fonts[0].data, BIG2);
  const back = swapStrings(out, new Map([[REF, BIG]]));
  assert.deepEqual(back, value);
});

test('libraries merge by id: deletions win, newer edits win', () => {
  const local = [{ id: 'a', updatedAt: 5, n: 'local-a' }, { id: 'b', updatedAt: 1, n: 'local-b' }, { id: 'new', updatedAt: 9, n: 'only-here' }];
  const server = [{ id: 'a', updatedAt: 3, n: 'server-a' }, { id: 'b', updatedAt: 4, n: 'server-b' }, { id: 'gone', updatedAt: 1, n: 'x' }];
  const merged = mergeById(local, server, new Set(['gone']));
  assert.deepEqual(merged.map((x) => x.n).sort(), ['local-a', 'only-here', 'server-b']);
});

test('only this version of the setup is trusted for automatic pulls', () => {
  assert.equal(isSyncBlob(null), false);
  assert.equal(isSyncBlob({ theme: {}, appSettings: {} }), false); // the old shape
  assert.equal(isSyncBlob({ v: 2, look: {}, house: {}, fonts: [], closet: [], moving: null, deleted: { fonts: [], looks: [] } }), true);
});
