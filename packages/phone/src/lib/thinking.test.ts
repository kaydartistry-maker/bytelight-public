import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageSegment } from '../bytelight/protocol.js';
import { coalesceThinkingSegments, plainThinkingText, thinkingTitle } from './thinking.js';

function thinking(content: string, summary = ''): MessageSegment {
  return { type: 'thinking', content, summary };
}

function kindedThinking(
  content: string,
  kind: 'authored' | 'provider' | 'system',
  summary = '',
): MessageSegment {
  return { type: 'thinking', content, summary, kind } as MessageSegment;
}

function text(content: string): MessageSegment {
  return { type: 'text', content };
}

const thinkingCards = (segments: MessageSegment[]) =>
  coalesceThinkingSegments(segments).filter((s) => s.type === 'thinking');

test('a thought with words in it survives coalescing', () => {
  const out = thinkingCards([thinking('She asked twice, so it matters.'), text('Here.')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type === 'thinking' && out[0].content, 'She asked twice, so it matters.');
});

test('an empty authored thought renders no card at all', () => {
  // The failure this guards: the card still rendered, titled "Thinking…",
  // and tapping it opened an empty box.
  assert.equal(thinkingCards([thinking(''), text('Here.')]).length, 0);
  assert.equal(thinkingCards([thinking('   \n\n  '), text('Here.')]).length, 0);
});

test('the Bytelight routing marker is stripped from the visible reflection', () => {
  assert.equal(plainThinkingText('[BYTELIGHT_THOUGHT]\nMine.'), 'Mine.');
});

test('dropping an empty thought leaves the spoken text alone', () => {
  const out = coalesceThinkingSegments([thinking(''), text('Here.')]);
  assert.deepEqual(out, [text('Here.')]);
});

test('a summary-only thought is a real thought and is kept', () => {
  const out = thinkingCards([thinking('', 'Checking the renderer'), text('Here.')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type === 'thinking' && out[0].content, 'Checking the renderer');
});

test('the session-recycle seam is never swallowed as an empty thought', () => {
  const out = thinkingCards([thinking('[Session recycled — re-primed]'), thinking('')]);
  assert.equal(out.length, 1);
  assert.match(out[0].type === 'thinking' ? out[0].content : '', /^\[Session recycled/);
});

test('thinkingTitle still has its placeholder for callers that hold real text', () => {
  assert.equal(thinkingTitle('  '), 'Thinking…');
});

test('authored kind wins over provider telemetry without marker guessing', () => {
  const out = thinkingCards([
    kindedThinking('provider phase label', 'provider'),
    kindedThinking('I chose the clean seam.', 'authored'),
    text('Here.'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type === 'thinking' && out[0].content, 'I chose the clean seam.');
  assert.equal(out[0].type === 'thinking' && out[0].kind, 'authored');
});

test('system kind remains a hard boundary between provider thought runs', () => {
  const out = coalesceThinkingSegments([
    kindedThinking('phase one', 'provider'),
    kindedThinking('session seam', 'system'),
    kindedThinking('phase two', 'provider'),
  ]).filter((segment) => segment.type === 'thinking');
  assert.equal(out.length, 3);
  assert.equal(out[1].type === 'thinking' && out[1].kind, 'system');
});
