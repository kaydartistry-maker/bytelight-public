import test from 'node:test';
import assert from 'node:assert/strict';
import { nameplateOf } from './nameplate.js';

const LOGO = 'data:image/webp;base64,UklGRg==';

test('nothing shows until she gives it something', () => {
  assert.equal(nameplateOf({}), null);
  assert.equal(nameplateOf({ osName: 'Bytelight OS' }), null); // name is off by default: never forced
});

test('a logo shows by default once uploaded; the name only when switched on', () => {
  assert.deepEqual(nameplateOf({ appLogo: LOGO }), { logo: LOGO, name: undefined });
  assert.deepEqual(nameplateOf({ appLogo: LOGO, osName: 'Glass Hause', nameplateName: true }), { logo: LOGO, name: 'Glass Hause' });
  assert.deepEqual(nameplateOf({ appLogo: LOGO, osName: 'Glass Hause', nameplateName: true, nameplateLogo: false }), { logo: undefined, name: 'Glass Hause' });
  assert.equal(nameplateOf({ appLogo: LOGO, nameplateLogo: false }), null);
  assert.equal(nameplateOf({ osName: '   ', nameplateName: true }), null);
});

test('only real raster images count as a logo', () => {
  assert.equal(nameplateOf({ appLogo: 'data:image/svg+xml;base64,PHN2Zz4=' }), null);
  assert.equal(nameplateOf({ appLogo: 'https://example.com/x.png' }), null);
});
