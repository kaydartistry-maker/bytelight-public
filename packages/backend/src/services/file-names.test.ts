// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NAME_SIDECAR_EXT,
  displayFilename,
  downloadFilename,
  isNameSidecar,
  safeDisplayName,
  isGenericUploadName,
} from './file-names.js';

const UUID = 'dc5739ce-bb40-453f-a9dd-ac13df56b87b';

// THE FAULT: files are stored as <uuid><ext> with no table behind them, so
// every save took the name the user gave it and threw it away. The Files app has
// always listed the bare uuid, which is how a text file could become
// unreachable on the phone: nobody can pick one uuid out of a list of them.
test('the name the owner gave wins wherever we kept one', () => {
  assert.equal(displayFilename('studio-style-prompts.txt', `${UUID}.txt`), 'studio-style-prompts.txt');
  assert.equal(downloadFilename(UUID, 'studio-style-prompts.txt', '.txt'), 'studio-style-prompts.txt');
});

// ~3,900 files predate the sidecar. None of them get a migration.
test('a file with no remembered name falls back rather than breaking', () => {
  assert.equal(displayFilename(null, `${UUID}.txt`), `${UUID}.txt`);
  assert.equal(displayFilename('', `${UUID}.txt`), `${UUID}.txt`);
  // A wall of hex in a downloads list is worse than no name, so that one case
  // keeps the short stamped form it has always had.
  assert.equal(downloadFilename(UUID, `${UUID}.txt`, '.txt'), 'bytelight-dc5739ce.txt');
});

// The name arrives from an uploader. It is display text and a
// Content-Disposition value, never a path.
test('a name that tries to be a path is reduced to its basename', () => {
  assert.equal(safeDisplayName('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(safeDisplayName('C:\\Users\\owner\\notes.txt'), 'notes.txt');
  assert.equal(safeDisplayName('/etc/shadow'), 'shadow');
});

// Quotes and newlines would terminate a Content-Disposition header early;
// attachmentFilename strips the quotes, this strips what it does not.
test('control characters never survive', () => {
  assert.equal(safeDisplayName('notes\n.txt'), 'notes.txt');
  assert.equal(safeDisplayName('notes\u0000.txt'), 'notes.txt');
  assert.equal(safeDisplayName('  spaced.txt  '), 'spaced.txt');
});

test('a name cannot grow without limit', () => {
  assert.equal(safeDisplayName(`${'a'.repeat(500)}.txt`).length, 120);
});

test('a name that is not a string is not a name', () => {
  assert.equal(safeDisplayName(undefined), '');
  assert.equal(safeDisplayName(null), '');
  assert.equal(safeDisplayName(42), '');
  assert.equal(safeDisplayName('///'), '');
});

// A sidecar matches the uuid filename pattern too. Listing it would put a
// phantom entry beside every named file the user owns.
test('a sidecar is never mistaken for a file', () => {
  assert.equal(isNameSidecar(NAME_SIDECAR_EXT), true);
  assert.equal(isNameSidecar('.NAME'), true);
  assert.equal(isNameSidecar('.txt'), false);
  assert.equal(isNameSidecar('.png'), false);
});

test('a camera default name is not worth remembering', () => {
  for (const generic of ['image.jpg', 'IMG.PNG', 'photo.jpeg', 'video.mp4', 'file.txt', 'untitled.pdf', '']) {
    assert.equal(isGenericUploadName(generic), true, generic);
  }
});

test('a name the owner actually chose is worth remembering', () => {
  for (const real of ['emoji-sparkle.png', 'shift-notes.txt', 'img_2026-09-08T02-14-46-342Z_a3c831.png', 'road trip mix.md']) {
    assert.equal(isGenericUploadName(real), false, real);
  }
});
