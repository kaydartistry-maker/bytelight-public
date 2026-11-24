import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLookFile, cleanLook, lookFileName, parseLookFile } from './look-file.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const VID = 'data:video/mp4;base64,AAAAIGZ0eXBpc29t';

test('a look survives the round trip: build, send, parse', () => {
  const look = { mode: 'dark', id: 'cosmos', wallpaper: IMG, movingWallpaper: true, movingPoster: IMG,
    glass: { mode: 'texture', texture: IMG, opacity: 40, textureFit: 'sheet' }, type: { title: 'Magic Retro', text: 'Inter' },
    lockFace: 'classic', lockCards: 'dark', stickyNoteColors: ['#112233'] } as never;
  const file = buildLookFile('Moon Glow', look, { kind: 'video', name: 'moon.mp4', data: VID });
  assert.deepEqual(file.fonts, ['Magic Retro', 'Inter']); // names only
  const parsed = parseLookFile(JSON.stringify(file));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.file.name, 'Moon Glow');
  assert.deepEqual(parsed.file.look, look);
  assert.equal(parsed.file.moving?.data, VID);
});

test('tampered files: CSS injection in colours and font names is dropped', () => {
  const evil = cleanLook({
    id: 'custom',
    customColors: { dark: { pageBg: 'red; } body { display:none } :root {', accent: '#ff00aa', sneaky: '#000' }, light: {} },
    accentOverride: 'url(javascript:alert(1))',
    textOverride: '#fff',
    type: { title: "Comic'; } * { color: red } x{", text: 'Inter' },
    glass: { tint: 'expression(alert(1))', borderColor: '#e8c07a' },
  }) as Record<string, any>;
  assert.deepEqual(evil.customColors, { light: {}, dark: { accent: '#ff00aa' } }); // bad value + unknown key gone
  assert.equal(evil.accentOverride, undefined);
  assert.equal(evil.textOverride, '#fff');
  assert.deepEqual(evil.type, { text: 'Inter' });
  assert.deepEqual(evil.glass, { borderColor: '#e8c07a' });
});

test('tampered files: SVG pictures, unknown settings and furniture are dropped', () => {
  const svg = 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+';
  const c = cleanLook({ wallpaper: svg, wallpapers: [svg, IMG], lockShortcuts: ['x'], homeWidgets: ['y'], id: 'not-a-theme', mode: 'sideways', shapeRadius: 999 }) as Record<string, unknown>;
  assert.equal(c.wallpaper, undefined);
  assert.deepEqual(c.wallpapers, [IMG]);
  assert.ok(!('lockShortcuts' in c) && !('homeWidgets' in c) && !('id' in c) && !('mode' in c));
  assert.equal(c.shapeRadius, 24);
});

test('not-a-look files get a plain answer, never a crash', () => {
  assert.equal(parseLookFile('').ok, false);
  assert.equal(parseLookFile('{nope').ok, false);
  const notOurs = parseLookFile(JSON.stringify({ format: 'something-else', look: {} }));
  assert.ok(!notOurs.ok && 'reason' in notOurs && /isn't a ByteLight look/.test(notOurs.reason));
  const newer = parseLookFile(JSON.stringify({ format: 'bytelight-look', version: 99, look: { mode: 'dark' } }));
  assert.ok(!newer.ok && 'reason' in newer && /newer version/.test(newer.reason));
  const empty = parseLookFile(JSON.stringify({ format: 'bytelight-look', version: 1, look: { junk: 1 } }));
  assert.ok(!empty.ok);
});

test('a moving look whose video is missing or bad comes in as still', () => {
  const p = parseLookFile(JSON.stringify({ format: 'bytelight-look', version: 1, name: 'X', look: { movingWallpaper: true, wallpaper: IMG }, moving: { kind: 'video', data: 'data:text/html;base64,PHNjcmlwdD4=' } }));
  assert.ok(p.ok && p.file.moving === undefined && p.file.look.movingWallpaper === false);
});

test('share file names are safe', () => {
  assert.equal(lookFileName('Moon Glow'), 'Moon Glow.bllook');
  assert.equal(lookFileName('a/b:c*?'), 'abc.bllook');
  assert.equal(lookFileName('  '), 'My look.bllook');
});
