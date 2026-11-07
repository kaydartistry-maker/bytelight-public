// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAttachmentMarkers, pickStoredFile, uploadName } from './attach-markers.js';

const ID = 'cb1b6b99-3c55-4313-a5f4-5a64957e9f27';

test('the stored picture is picked, not the name tag that sits beside it', () => {
  // The order readdir handed over on Oct 20 2026: the sidecar first.
  assert.equal(pickStoredFile(ID, [`${ID}.name`, `${ID}.png`]), `${ID}.png`);
  assert.equal(pickStoredFile(ID, [`${ID}.png`, `${ID}.name`]), `${ID}.png`);
});

test('a folder or a derived file that starts with the id is never the file', () => {
  assert.equal(pickStoredFile(ID, [`${ID}_analysis`, `${ID}.mp3`]), `${ID}.mp3`);
  assert.equal(pickStoredFile(ID, [`${ID}_analysis`, `${ID}.name`]), null);
  assert.equal(pickStoredFile(ID, []), null);
  assert.equal(pickStoredFile(ID.slice(0, 8), [`${ID}.png`]), null, 'a part of an id is not the id');
});

test('the upload carries the name the owner gave it, ending in the stored extension', () => {
  assert.equal(uploadName(`${ID}.png`, 'starlight-squish.png'), 'starlight-squish.png');
  assert.equal(uploadName(`${ID}.png`, 'starlight squish'), 'starlight squish.png');
  assert.equal(uploadName(`${ID}.png`, null), `${ID}.png`);
  assert.equal(uploadName(`${ID}.png`, '   '), `${ID}.png`);
  assert.equal(uploadName(`${ID}.png`, '../../etc/starlight.png'), 'starlight.png', 'a path is never a name');
});

test('a marker in a reply becomes the picture itself, under their name for it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bytelight-discord-attach-'));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    writeFileSync(join(dir, `${ID}.name`), 'starlight-squish.png', 'utf8');
    writeFileSync(join(dir, `${ID}.png`), png);
    mkdirSync(join(dir, `${ID}_analysis`));

    const parsed = parseAttachmentMarkers(`**Companion A**\nHere it is. [discord-attach:${ID}]`, dir);
    assert.equal(parsed.text, '**Companion A**\nHere it is.');
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].name, 'starlight-squish.png');
    assert.ok(Buffer.isBuffer(parsed.files[0].attachment));
    assert.deepEqual(parsed.files[0].attachment, png, 'the bytes are the picture, not the 20-byte name tag');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file with no name tag goes out under its stored name, and a missing one sends nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bytelight-discord-attach-'));
  try {
    writeFileSync(join(dir, `${ID}.jpg`), Buffer.from([0xff, 0xd8, 0xff]));
    const parsed = parseAttachmentMarkers(`[discord-attach:${ID}]`, dir);
    assert.equal(parsed.text, '');
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].name, `${ID}.jpg`);

    const none = parseAttachmentMarkers('[discord-attach:00000000-0000-0000-0000-000000000000] hi', dir);
    assert.equal(none.text, 'hi');
    assert.equal(none.files.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
