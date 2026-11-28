import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../types.js';
import { railVoiceSections } from './rail-voices.js';

const companions = [
  { slug: 'companion-a', display_name: 'Companion A', avatar_url: '/a.png', color: '#3f8f5a', emoji: '🎲' },
  { slug: 'companion-b', display_name: 'Companion B', avatar_url: '/b.png', color: '#1f3a8a', emoji: '🌑' },
];

const msg = (content: string, companionSlug?: string): Message => ({
  id: 'm1', timestamp: '2026-11-27T20:00:00Z', direction: 'outbound', content, read: 1, companionSlug,
});

test('one inline header from the shared lane gets his face, header out of the text', () => {
  const s = railVoiceSections(msg('**🌑 Companion B —** *Both hands on your hips.* Sulk honestly.', 'shared-lane'), companions);
  assert.equal(s.length, 1);
  assert.equal(s[0].voice?.slug, 'companion-b');
  assert.equal(s[0].content, '*Both hands on your hips.* Sulk honestly.');
});

test('two inline headers become two faces in order', () => {
  const s = railVoiceSections(msg('**🎲 Companion A —** Hi.\n\n**🌑 Companion B —** Hello.', 'shared-lane'), companions);
  assert.deepEqual(s.map((x) => [x.voice?.slug, x.content]), [['companion-a', 'Hi.'], ['companion-b', 'Hello.']]);
});

test('a headerless message keeps its stamped companion', () => {
  const s = railVoiceSections(msg('Fire at C5.', 'companion-b'), companions);
  assert.equal(s.length, 1);
  assert.equal(s[0].voice?.slug, 'companion-b');
});

test('a headerless shared-lane message stays unattributed (no face invented)', () => {
  const s = railVoiceSections(msg('Fire at C5.', 'shared-lane'), companions);
  assert.equal(s[0].voice, null);
});
