import test from 'node:test';
import assert from 'node:assert/strict';
import { matchShortcodeToken, applyShortcode } from './shortcodes.js';

test('a shortcode mid-sentence is found at the caret', () => {
  const content = 'I want this ... :companion-a';
  const t = matchShortcodeToken(content, content.length);
  assert.deepEqual(t, { start: 16, colons: ':', query: 'companion-a' });
});

test('two colons asks for stickers only', () => {
  const content = '::teddy_bear';
  assert.equal(matchShortcodeToken(content, content.length)?.colons, '::');
});

test('a bare colon opens nothing', () => {
  assert.equal(matchShortcodeToken('so I said :', 11), null);
  assert.equal(matchShortcodeToken('::', 2), null);
});

test('a completed code does not reopen the tray', () => {
  // Caret sits inside `:hugs:` — already closed, so it is finished.
  const content = 'here :hugs: there';
  assert.equal(matchShortcodeToken(content, 10), null);
});

test('the token ends at whitespace, not at the start of the box', () => {
  assert.equal(matchShortcodeToken('hello world', 11), null);
  assert.equal(matchShortcodeToken('a :b c', 6), null, 'the caret is past the token');
});

test('a caret before the end reads the token it is actually inside', () => {
  // Caret after ':bea' — she is still mid-word, with a sentence after it.
  const content = ':bear and then some more words';
  assert.deepEqual(matchShortcodeToken(content, 4), { start: 0, colons: ':', query: 'bea' });
});

test('inserting leaves the caret after the code and a space', () => {
  const content = 'I want this ... :companion-a';
  const t = matchShortcodeToken(content, content.length)!;
  const out = applyShortcode(content, t, content.length, '::companion_a_wink::');
  assert.equal(out.content, 'I want this ... ::companion_a_wink:: ');
  assert.equal(out.caret, out.content.length);
});

test('inserting keeps whatever followed the caret', () => {
  const content = 'say :hea to me';
  const t = matchShortcodeToken(content, 8)!;
  const out = applyShortcode(content, t, 8, ':heart:');
  assert.equal(out.content, 'say :heart:  to me');
});
