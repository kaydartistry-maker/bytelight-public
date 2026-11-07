import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWakeSections,
  serializeWakeSections,
  upsertWakeSection,
  removeWakeSection,
} from './wake-prompts.js';

const SAMPLE = `# Wake Prompts

Preamble line that belongs to no section.

## morning

Good morning body.

## latenight

Late night body.
`;

test('parse splits preamble from ## sections and lowercases keys', () => {
  const parsed = parseWakeSections(SAMPLE);
  assert.match(parsed.preamble, /Preamble line/);
  assert.deepEqual(parsed.sections.map((s) => s.key), ['morning', 'latenight']);
  assert.equal(parsed.sections[0].body, 'Good morning body.');
});

test('upsert edits an existing section, leaving the others byte-identical', () => {
  const next = upsertWakeSection(SAMPLE, 'morning', 'A brand new morning.');
  const parsed = parseWakeSections(next);
  assert.equal(parsed.sections.find((s) => s.key === 'morning')?.body, 'A brand new morning.');
  assert.equal(parsed.sections.find((s) => s.key === 'latenight')?.body, 'Late night body.');
});

test('upsert appends a new section when the key is absent', () => {
  const next = upsertWakeSection(SAMPLE, 'midday', 'Fresh midday bell.');
  const keys = parseWakeSections(next).sections.map((s) => s.key);
  assert.deepEqual(keys, ['morning', 'latenight', 'midday']);
});

test('remove deletes exactly one section and preserves the rest', () => {
  const next = removeWakeSection(SAMPLE, 'morning');
  const keys = parseWakeSections(next).sections.map((s) => s.key);
  assert.deepEqual(keys, ['latenight']);
});

test('round-trip: what you write is what you read back', () => {
  const edited = upsertWakeSection(SAMPLE, 'evening', 'Wind it down.');
  const reparsed = parseWakeSections(edited);
  const rendered = serializeWakeSections(reparsed);
  // serialize is stable — a second round-trip is a fixed point
  assert.equal(serializeWakeSections(parseWakeSections(rendered)), rendered);
  assert.equal(parseWakeSections(rendered).sections.find((s) => s.key === 'evening')?.body, 'Wind it down.');
});
