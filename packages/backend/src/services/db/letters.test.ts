import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

const root = mkdtempSync(join(tmpdir(), 'letters-test-'));
process.env.RESONANT_HOME = root;
const projectData = join(process.cwd(), '..', '..', 'data');
const mirrorDir = join(root, 'letters');
let madeProjectData = false;

if (!existsSync(projectData)) {
  mkdirSync(projectData, { recursive: true });
  madeProjectData = true;
}
mkdirSync(mirrorDir, { recursive: true });
symlinkSync(mirrorDir, join(projectData, 'letters'), 'dir');

const { initDb, getDb } = await import('../db.js');
const letters = await import('./letters.js');

before(() => initDb(join(root, 'test.db')));
after(() => {
  getDb().close();
  rmSync(join(projectData, 'letters'), { force: true });
  if (madeProjectData) rmSync(projectData, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('vault API is write-once and has no content update or delete export', () => {
  assert.equal('updateLetter' in letters, false);
  assert.equal('deleteLetter' in letters, false);
});

test('seal states, content visibility, hash stability, and mirror', () => {
  const content = 'Words that stay exactly put.';
  const open = letters.sealLetter({ author: 'writer', recipients: ['reader'], kind: 'vow', content });
  assert.equal(open.state, 'open');
  assert.equal(open.content, content);
  assert.equal(open.content_hash, crypto.createHash('sha256').update(content, 'utf8').digest('hex'));

  const future = letters.sealLetter({
    author: 'writer', recipients: ['reader'], kind: 'letter', content: 'Not yet.', seal: 'date',
    openAt: '2999-01-01T00:00:00.000Z',
  });
  const sealed = letters.getLetterView(future.id, 'reader')!;
  assert.equal(sealed.state, 'sealed');
  assert.equal(sealed.content, undefined);
  assert.equal(sealed.content_hash, future.content_hash);

  const past = letters.sealLetter({
    author: 'writer', recipients: ['reader'], kind: 'letter', content: 'The day arrived.', seal: 'date',
    openAt: '2000-01-01T00:00:00.000Z',
  });
  assert.equal(letters.getLetterView(past.id, 'reader')!.state, 'openable');
  assert.equal(letters.getLetterView(past.id, 'reader')!.content, undefined);

  const chosen = letters.sealLetter({
    author: 'writer', recipients: ['reader'], kind: 'confession', content: 'Choose the moment.', seal: 'on_open',
  });
  assert.equal(letters.getLetterView(chosen.id, 'reader')!.state, 'openable');

  const mirror = join(mirrorDir, `${open.id}.md`);
  assert.equal(existsSync(mirror), true);
  const markdown = readFileSync(mirror, 'utf8');
  assert.match(markdown, /Words that stay exactly put\./);
  assert.match(markdown, new RegExp(`content_hash: sha256:${open.content_hash}`));
});

test('opening is recipient-only and happens once without re-stamping', () => {
  const letter = letters.sealLetter({
    author: 'writer', recipients: ['reader'], kind: 'keepsake', content: 'Only once.', seal: 'on_open',
  });
  assert.throws(() => letters.openLetter(letter.id, 'outsider'), /not addressed/);
  const opened = letters.openLetter(letter.id, 'reader');
  assert.equal(opened.state, 'opened');
  assert.equal(opened.content, 'Only once.');
  const firstStamp = opened.opened_at;
  assert.throws(() => letters.openLetter(letter.id, 'reader'), /already broken/);
  const row = getDb().prepare('SELECT opened_at, content_hash FROM letters WHERE id = ?').get(letter.id) as {
    opened_at: string; content_hash: string;
  };
  assert.equal(row.opened_at, firstStamp);
  assert.equal(row.content_hash, letter.content_hash);
});
