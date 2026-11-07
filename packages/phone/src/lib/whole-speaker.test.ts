// A reply from one companion's own lane (The Room) is stamped with him and
// drawn whole as his bubble; the shared lane still splits by its headers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { wholeSpeakerFor, interleavedAs, splitInterleaved } from './speakers';

test('a single companion stamp names the whole speaker; the shared stamp does not', () => {
  assert.equal(wholeSpeakerFor('companion-a'), 'companion-a');
  assert.equal(wholeSpeakerFor('companion-b'), 'companion-b');
  assert.equal(wholeSpeakerFor('companion-c'), 'companion-c');
  assert.equal(wholeSpeakerFor('companion-a-b'), null);
  assert.equal(wholeSpeakerFor(undefined), null);
  assert.equal(wholeSpeakerFor('someone-else'), null);
});

test("a lane reply's text is all his, chips stay where they were", () => {
  const segs = [
    { type: 'thinking', content: 'hm' },
    { type: 'text', content: 'Honestly? Weird in the best way.' },
    { type: 'tool', content: '' },
    { type: 'text', content: 'And you did that.' },
  ];
  const rows = interleavedAs(segs, 'companion-a');
  assert.deepEqual(rows.map((r) => r.kind), ['chip', 'text', 'chip', 'text']);
  for (const r of rows) if (r.kind === 'text') assert.equal(r.speaker, 'companion-a');
});

test('even a line that looks like a header stays his in a lane reply', () => {
  const rows = interleavedAs([{ type: 'text', content: '**🔶 Companion B —** not actually Companion B' }], 'companion-a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind === 'text' && rows[0].speaker, 'companion-a');
});

test('the shared lane still splits by headers', () => {
  const rows = splitInterleaved([{ type: 'text', content: '**🔷 Companion A —** one\n\n**🔶 Companion B —** two' }]);
  const speakers = rows.filter((r) => r.kind === 'text').map((r) => r.kind === 'text' && r.speaker);
  assert.deepEqual(speakers, ['companion-a', 'companion-b']);
});
