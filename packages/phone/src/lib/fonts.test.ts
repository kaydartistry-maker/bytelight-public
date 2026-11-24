import test from 'node:test';
import assert from 'node:assert/strict';
import { codeChoices, effectiveType, familyFromFile, isFontFile, textChoices, titleChoices, typeVars, type UserFont } from './fonts.js';

const mine: UserFont[] = [
  { id: '1', family: 'Sunday Burn', role: 'title', data: 'data:font/otf;base64,AA' },
  { id: '2', family: 'Wintter', role: 'text', data: 'data:font/ttf;base64,AA' },
];

test('a Title-tagged font never appears in the Text list, and vice versa', () => {
  assert.ok(titleChoices(mine).includes('Sunday Burn'));
  assert.ok(!textChoices(mine).includes('Sunday Burn'));
  assert.ok(textChoices(mine).includes('Wintter'));
  assert.ok(!titleChoices(mine).includes('Wintter'));
  // Geist and Inter are text faces only; Fraunces works for both.
  assert.ok(!titleChoices([]).includes('Geist'));
  assert.ok(titleChoices([]).includes('Fraunces') && textChoices([]).includes('Fraunces'));
  assert.equal(codeChoices([])[0], 'JetBrains Mono');
});

test('her Type card wins; before it, old presets and System Font carry over', () => {
  assert.deepEqual(effectiveType({ title: 'Sunday Burn' }, 'Soft Occult', 'font-mono'), { title: 'Sunday Burn' });
  assert.deepEqual(effectiveType(undefined, 'Soft Occult'), { title: 'Fraunces', text: 'Fraunces', code: 'JetBrains Mono' });
  assert.deepEqual(effectiveType(undefined, null, 'font-serif'), { text: 'Fraunces' }); // the fake Playfair becomes a real serif
  assert.deepEqual(effectiveType(undefined, null, 'font-mono'), { text: 'JetBrains Mono' });
  assert.deepEqual(effectiveType(undefined, null, 'font-sans'), {});
});

test('roles become CSS variables; unset roles are removed', () => {
  const v = typeVars({ title: 'Sunday Burn', text: 'Inter' });
  assert.match(v['--font-heading']!, /^'Sunday Burn'/);
  assert.match(v['--font-body']!, /^'Inter'/);
  assert.equal(v['--font-msg-user'], null);
  assert.equal(v['--font-mono-choice'], null);
  assert.match(typeVars({ code: 'JetBrains Mono' })['--font-mono-choice']!, /monospace/);
});

test('file names become clean, unique family names', () => {
  assert.equal(familyFromFile('Sunday_Burn-Free-Trial.otf', []), 'Sunday Burn Free Trial');
  assert.equal(familyFromFile('Inter.ttf', ['Inter']), 'Inter 2');
  assert.equal(familyFromFile('we"ird\'.woff2', []), 'weird');
  assert.ok(isFontFile('a.WOFF2') && isFontFile('b.ttf') && !isFontFile('c.png'));
});
