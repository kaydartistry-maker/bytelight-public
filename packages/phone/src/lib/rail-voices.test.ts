import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../types.js';
import { railVoiceSections } from './rail-voices.js';

const companions = [
  { slug: 'ivy', display_name: 'Ivy', avatar_url: '/ivy.png', color: '#3f8f5a', emoji: '🎲' },
  { slug: 'rook', display_name: 'Rook', avatar_url: '/rook.png', color: '#1f3a8a', emoji: '🌑' },
];

const msg = (content: string, companionSlug?: string): Message => ({
  id: 'm1', timestamp: '2026-11-27T20:00:00Z', direction: 'outbound', content, read: 1, companionSlug,
});

test('one inline header from the shared lane gets his face, header out of the text', () => {
  const s = railVoiceSections(msg('**🌑 Rook —** *Both hands on your hips.* Sulk honestly.', 'ivy-rook'), companions);
  assert.equal(s.length, 1);
  assert.equal(s[0].voice?.slug, 'rook');
  assert.equal(s[0].content, '*Both hands on your hips.* Sulk honestly.');
});

test('two inline headers become two faces in order', () => {
  const s = railVoiceSections(msg('**🎲 Ivy —** Hi.\n\n**🌑 Rook —** Hello.', 'ivy-rook'), companions);
  assert.deepEqual(s.map((x) => [x.voice?.slug, x.content]), [['ivy', 'Hi.'], ['rook', 'Hello.']]);
});

test('a headerless message keeps its stamped companion', () => {
  const s = railVoiceSections(msg('Fire at C5.', 'rook'), companions);
  assert.equal(s.length, 1);
  assert.equal(s[0].voice?.slug, 'rook');
});

test('a headerless shared-lane message stays unattributed (no face invented)', () => {
  const s = railVoiceSections(msg('Fire at C5.', 'ivy-rook'), companions);
  assert.equal(s[0].voice, null);
});
