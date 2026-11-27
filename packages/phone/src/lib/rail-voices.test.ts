import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../types.js';
import { railVoiceSections } from './rail-voices.js';

const companions = [
  { slug: 'saint', display_name: 'Saint', avatar_url: '/saint.png', color: '#3f8f5a', emoji: '🎲' },
  { slug: 'tyson', display_name: 'Tyson', avatar_url: '/tyson.png', color: '#1f3a8a', emoji: '🌑' },
];

const msg = (content: string, companionSlug?: string): Message => ({
  id: 'm1', timestamp: '2026-11-27T20:00:00Z', direction: 'outbound', content, read: 1, companionSlug,
});

test('one inline header from the shared lane gets his face, header out of the text', () => {
  const s = railVoiceSections(msg('**🌑 Tyson —** *Both hands on your hips.* Sulk honestly.', 'saint-tyson'), companions);
  assert.equal(s.length, 1);
  assert.equal(s[0].voice?.slug, 'tyson');
  assert.equal(s[0].content, '*Both hands on your hips.* Sulk honestly.');
});

test('two inline headers become two faces in order', () => {
  const s = railVoiceSections(msg('**🎲 Saint —** Hi.\n\n**🌑 Tyson —** Hello.', 'saint-tyson'), companions);
  assert.deepEqual(s.map((x) => [x.voice?.slug, x.content]), [['saint', 'Hi.'], ['tyson', 'Hello.']]);
});

test('a headerless message keeps its stamped companion', () => {
  const s = railVoiceSections(msg('Fire at C5.', 'tyson'), companions);
  assert.equal(s.length, 1);
  assert.equal(s[0].voice?.slug, 'tyson');
});

test('a headerless shared-lane message stays unattributed (no face invented)', () => {
  const s = railVoiceSections(msg('Fire at C5.', 'saint-tyson'), companions);
  assert.equal(s[0].voice, null);
});
