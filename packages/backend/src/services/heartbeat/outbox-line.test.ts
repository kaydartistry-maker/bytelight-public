import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutboxLine, splitConcatenatedJson } from './outbox-line.js';

test('a normal line parses to one object', () => {
  const line = JSON.stringify({ turn_id: 'abc', content: 'hello' });
  const out = parseOutboxLine(line);
  assert.equal(out.length, 1);
  assert.equal(out[0].turn_id, 'abc');
});

test('two objects glued by a missing newline both survive', () => {
  // The exact shape found in this house's outbox at line 2347: a write that did not
  // end with a newline, so the next reply landed on the same line. JSON.parse throws
  // on the whole line and BOTH replies used to be discarded.
  const a = JSON.stringify({ turn_id: 'one', content: 'first reply' });
  const b = JSON.stringify({ turn_id: 'two', content: 'second reply' });
  const out = parseOutboxLine(a + b);
  assert.equal(out.length, 2, 'both glued replies should be recovered');
  assert.equal(out[0].content, 'first reply');
  assert.equal(out[1].content, 'second reply');
});

test('braces and escaped quotes inside her prose do not split a line', () => {
  const line = JSON.stringify({
    turn_id: 'x',
    content: 'she said "}{" and then {"not":"json"} in the middle of a sentence',
  });
  assert.equal(splitConcatenatedJson(line).length, 1);
  const out = parseOutboxLine(line);
  assert.equal(out.length, 1);
  assert.equal(out[0].turn_id, 'x');
});

test('an unreadable line reports itself instead of vanishing', () => {
  // Line 31's shape: an invalid escape from a line built with printf rather than
  // json.dumps. Nothing can be recovered — but it must not disappear in silence.
  const bad = '{"turn_id":"z","content":"a bad \\escape here"}';
  const seen: string[] = [];
  const out = parseOutboxLine(bad, (_fragment, error) => seen.push(error));
  assert.equal(out.length, 0);
  assert.equal(seen.length, 1, 'the caller must be told a reply was lost');
});

test('a partial fragment is reported rather than parsed into the wrong shape', () => {
  const out = parseOutboxLine('ent":"half a reply"}', () => {});
  assert.equal(out.length, 0);
});

test('an unreadable fragment is reported exactly once', () => {
  const seen: string[] = [];
  parseOutboxLine('{"broken": ', (_f, e) => seen.push(e));
  assert.equal(seen.length, 1, 'no double-reporting of the same failure');
});

test('empty and whitespace lines are not failures', () => {
  const seen: string[] = [];
  assert.deepEqual(parseOutboxLine('', (_f, e) => seen.push(e)), []);
  assert.deepEqual(parseOutboxLine('   \n ', (_f, e) => seen.push(e)), []);
  assert.equal(seen.length, 0);
});
