// The Files screen calls a file an orphan when nothing in the house points at
// it, and "Clean orphans" deletes every one of those from disk. It used to
// look only at a message's single `fileId`, so pictures sent several at a time
// (metadata.attachments[]), voice-note audio and profile avatars all read as
// orphans while still in use. These pin the wider net.
import test from 'node:test';
import assert from 'node:assert/strict';
import { referencedFileIds } from './file-references.js';

const A = '61943c7b-df5b-4e42-a959-8b3c79c34892';
const B = 'fb518a1f-8cbc-4edb-a6e0-4529609bde1d';
const C = '0068c90e-c632-4319-b3ab-47c3329d7905';
const LOOSE = '002295af-ada2-4b1d-a8c9-c8280a68842d';
const known = new Set([A, B, C, LOOSE]);

test('a picture in an attachments list is in use', () => {
  const meta = JSON.stringify({ attachments: [{ fileId: A, url: `/api/files/${A}` }, { fileId: B }] });
  const used = referencedFileIds([meta], known);
  assert.ok(used.has(A));
  assert.ok(used.has(B));
});

test('the old single fileId still counts', () => {
  assert.ok(referencedFileIds([JSON.stringify({ fileId: C })], known).has(C));
});

test('a file named only in message text or a setting counts', () => {
  const used = referencedFileIds([`look ![](/api/files/${A}.jpg)`, `{"avatar":"/api/files/${C}"}`], known);
  assert.ok(used.has(A));
  assert.ok(used.has(C));
});

test('a file nothing points at is still an orphan', () => {
  const used = referencedFileIds([JSON.stringify({ attachments: [{ fileId: A }] }), null, ''], known);
  assert.equal(used.has(LOOSE), false);
});

test('ids that are not files on disk are ignored', () => {
  const stranger = 'c0000000-0000-4000-8000-000000000002';
  assert.equal(referencedFileIds([stranger], known).size, 0);
});
