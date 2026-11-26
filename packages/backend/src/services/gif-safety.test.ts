// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPlainName, escapeDrawtextValue, drawtextTextFileOption, isDrawtextColor, isDrawtextSize } from './gif-safety.js';

test('a session or frame name has to be a plain name', () => {
  assert.equal(isPlainName('2f1c6a0e-8d1b-4a59-9b8e-0c2f4b6d8e10'), true);
  assert.equal(isPlainName('frame-0001.png'), true);
  assert.equal(isPlainName('original-frame-0001.png'), true);
  for (const bad of ['', '..', '../aerie.yaml', 'a/b', '/etc/passwd', 'a\\b', 'x\0y', 42, null, ['frame-0001.png']]) {
    assert.equal(isPlainName(bad), false, String(bad));
  }
});

test('a drawtext colour or size cannot open a filter option of its own', () => {
  for (const ok of ['white', '#ff8800', '0xff8800', 'black@0.5']) assert.equal(isDrawtextColor(ok), true, ok);
  for (const bad of ['white:textfile=/etc/passwd', "red'", 'a b', '', 7]) assert.equal(isDrawtextColor(bad), false, String(bad));
  assert.equal(isDrawtextSize(24), true);
  assert.equal(isDrawtextSize('24'), true);
  assert.equal(isDrawtextSize('24:x=0'), false);
  assert.equal(isDrawtextSize(0), false);
  assert.equal(isDrawtextSize(true), false);
});

test('a font name is escaped so it stays inside its quotes', () => {
  assert.equal(escapeDrawtextValue('DejaVu Sans'), 'DejaVu Sans');
  assert.equal(escapeDrawtextValue("a'b:c\\d"), "a'\\''b\\:c\\\\d");
});

test('a caption reaches drawtext from a file, so an apostrophe cannot break the filter', () => {
  // Nov 4 2026: "It's been 84 years ..." closed the inline quote early and the
  // GIF showed drawtext's own options as tiny text instead of the caption.
  const opt = drawtextTextFileOption('/data/gif-work/s1/abc-text.txt');
  assert.equal(opt, "textfile='/data/gif-work/s1/abc-text.txt':expansion=none");
  const route = readFileSync(fileURLToPath(new URL('../routes/gif.ts', import.meta.url)), 'utf-8');
  assert.doesNotMatch(route, /drawtext=text=/, 'a caption is never written into the filter itself');
  assert.equal((route.match(/drawtextTextFileOption\(textFile\)/g) || []).length, 2, 'both caption doors read from a file');
});

test('a captioned GIF is written whole, so no frame leans on one that was cleared', () => {
  // Nov 4 2026: with transdiff on, the caption step made shared pixels
  // see-through over frames that carry disposal=background, and their phone
  // showed black specks across the face.
  const route = readFileSync(fileURLToPath(new URL('../routes/gif.ts', import.meta.url)), 'utf-8');
  const body = route.slice(route.indexOf('function drawTextArgs'), route.indexOf('function drawTextArgs') + 1200);
  assert.match(body, /'-gifflags', '-offsetting-transdiff'/);
});
