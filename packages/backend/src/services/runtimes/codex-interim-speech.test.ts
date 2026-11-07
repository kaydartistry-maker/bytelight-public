// Copyright 2026 Byte-light contributors. Licensed under the Apache License 2.0.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claimUnsentCodexSpeech, isInterimCodexSpeech } from './codex-interim-speech.js';

const none = new Set<string>();

test('a real spoken message is worth surfacing immediately', () => {
  assert.equal(isInterimCodexSpeech({ id: 'a1', type: 'agentMessage', text: 'On it — reading now.' }, none), true);
});

test('commentary is not speech', () => {
  assert.equal(isInterimCodexSpeech({ id: 'a2', type: 'agentMessage', phase: 'commentary', text: 'Reading' }, none), false);
});

test('the closing message stays in the tail so turn completion closes it once', () => {
  assert.equal(isInterimCodexSpeech({ id: 'a3', type: 'agentMessage', phase: 'final_answer', text: 'Here it is.' }, none), false);
});

test('nothing is sent twice', () => {
  const sent = new Set(['a4']);
  assert.equal(isInterimCodexSpeech({ id: 'a4', type: 'agentMessage', text: 'ack' }, sent), false);
  assert.equal(isInterimCodexSpeech({ id: 'a5', type: 'agentMessage', text: 'ack' }, sent), true);
});

test('the same speech under a second daemon identity is still one delivery', () => {
  const ids = new Set(['notice-id']);
  const texts = new Set(['Same words, second identity.']);
  assert.equal(isInterimCodexSpeech({ id: 'polled-id', type: 'agentMessage', text: 'Same words, second identity.' }, ids, texts), false);
});

test('completion claims identical final answers under different ids once', () => {
  const claimed = claimUnsentCodexSpeech([
    { id: 'notice-final', type: 'agentMessage', phase: 'final_answer', text: 'One final answer.' },
    { id: 'read-final', type: 'agentMessage', phase: 'final_answer', text: 'One final answer.' },
  ], new Set(), new Set());
  assert.deepEqual(claimed.map((item) => item.text), ['One final answer.']);
});

test('an item with no id is never emitted early', () => {
  assert.equal(isInterimCodexSpeech({ type: 'agentMessage', text: 'ack' }, none), false);
  assert.equal(isInterimCodexSpeech({ id: '', type: 'agentMessage', text: 'ack' }, none), false);
});

test('empty, non-text, reasoning, and tool items produce no delivery', () => {
  assert.equal(isInterimCodexSpeech({ id: 'b1', type: 'agentMessage', text: '   ' }, none), false);
  assert.equal(isInterimCodexSpeech({ id: 'b2', type: 'agentMessage', text: 42 }, none), false);
  assert.equal(isInterimCodexSpeech({ id: 'c1', type: 'reasoning', text: 'thinking' }, none), false);
  assert.equal(isInterimCodexSpeech({ id: 'c2', type: 'mcpToolCall', text: 'result' }, none), false);
  assert.equal(isInterimCodexSpeech(null, none), false);
});

test('a two-message turn emits the interim line and claims the final once', () => {
  const items = [
    { id: 'd1', type: 'agentMessage', text: 'Taking a look now.' },
    { id: 'd2', type: 'agentMessage', phase: 'commentary', text: 'Searching' },
    { id: 'd3', type: 'agentMessage', phase: 'final_answer', text: 'Found it.' },
  ];
  const ids = new Set<string>();
  const texts = new Set<string>();
  const spoken: string[] = [];
  for (const item of items) {
    if (isInterimCodexSpeech(item, ids, texts)) {
      ids.add(item.id);
      texts.add(item.text.trim());
      spoken.push(item.text.trim());
    }
  }
  assert.deepEqual(spoken, ['Taking a look now.']);
  assert.deepEqual(claimUnsentCodexSpeech(items, ids, texts).map((item) => item.text), ['Found it.']);
  assert.deepEqual(claimUnsentCodexSpeech(items, ids, texts), []);
});
