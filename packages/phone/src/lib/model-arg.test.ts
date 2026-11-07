import test from 'node:test';
import assert from 'node:assert/strict';
import { matchModelArgToken, applyModelArg } from './model-arg.js';

test('`/model ` with nothing typed opens the whole list', () => {
  const content = '/model ';
  assert.deepEqual(matchModelArgToken(content, content.length), { start: 7, query: '' });
});

test('a partial id is the query', () => {
  const content = '/model claude-opus';
  assert.deepEqual(matchModelArgToken(content, content.length), { start: 7, query: 'claude-opus' });
});

test('ids carrying a provider separator still match', () => {
  // Ollama ids look like `llama3.1:8b`; Anthropic's carry dots and hyphens.
  assert.equal(matchModelArgToken('/model llama3.1:8b', 18)?.query, 'llama3.1:8b');
  assert.equal(matchModelArgToken('/model claude-opus-4-5', 22)?.query, 'claude-opus-4-5');
});

test('the tray stays shut for any other command', () => {
  assert.equal(matchModelArgToken('/cost ', 6), null);
  assert.equal(matchModelArgToken('/models claude', 14), null);
  assert.equal(matchModelArgToken('what model are you in right now', 31), null);
});

test('`/model` with no space is the command palette, not this', () => {
  // The two must not both be open — the palette owns the box until a space.
  assert.equal(matchModelArgToken('/model', 6), null);
});

test('a second word closes it — the id is the whole argument', () => {
  assert.equal(matchModelArgToken('/model claude-opus-5 please', 27), null);
});

test('it matches up to the caret, so an id can be fixed mid-message', () => {
  const content = '/model claude- and then some';
  assert.deepEqual(matchModelArgToken(content, 14), { start: 7, query: 'claude-' });
});

test('applying an id replaces only what was typed of it', () => {
  const content = '/model claude-op';
  const token = matchModelArgToken(content, content.length)!;
  assert.deepEqual(applyModelArg(content, token, content.length, 'claude-opus-4-5'), {
    content: '/model claude-opus-4-5',
    caret: 22,
  });
});

test('applying keeps anything sitting after the caret', () => {
  const content = '/model claude- and then some';
  const token = matchModelArgToken(content, 14)!;
  const out = applyModelArg(content, token, 14, 'claude-opus-5');
  assert.equal(out.content, '/model claude-opus-5 and then some');
  assert.equal(out.caret, 20);
});

test('the case that took the lane down', () => {
  // `opus 4.5` is a name, not an id. The space ends the token, so the tray is
  // still open on `opus` with the real ids one tap away.
  assert.equal(matchModelArgToken('/model opus', 11)?.query, 'opus');
  assert.equal(matchModelArgToken('/model opus 4.5', 15), null);
});
