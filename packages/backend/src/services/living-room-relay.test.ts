import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, isRemoteBrain, remoteDisplayName } from './living-room-relay.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for await (const ev of parseSse(body)) out.push(ev);
  return out;
}

test('parses multiple frames in one chunk', async () => {
  const events = await collect(streamOf([
    'event: start\ndata: {"messageId":"m1"}\n\nevent: token\ndata: {"text":"hello"}\n\n',
  ]));
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'start');
  assert.equal(events[0].data.messageId, 'm1');
  assert.equal(events[1].event, 'token');
  assert.equal(events[1].data.text, 'hello');
});

test('reassembles a frame split across chunk boundaries', async () => {
  const events = await collect(streamOf([
    'event: tok',
    'en\ndata: {"te',
    'xt":"split ok"}\n',
    '\n',
  ]));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'token');
  assert.equal(events[0].data.text, 'split ok');
});

test('ignores heartbeat comments and frames without data', async () => {
  const events = await collect(streamOf([
    ': hb 123\n\n',
    'event: end\ndata: {"final":null}\n\n',
    ': hb 456\n\n',
  ]));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'end');
});

test('skips malformed JSON frames without killing the stream', async () => {
  const events = await collect(streamOf([
    'event: token\ndata: {not json}\n\n',
    'event: token\ndata: {"text":"survived"}\n\n',
  ]));
  assert.equal(events.length, 1);
  assert.equal(events[0].data.text, 'survived');
});

test('isRemoteBrain knows companion-c and rejects the local pair', () => {
  assert.equal(isRemoteBrain('companion-c'), true);
  assert.equal(isRemoteBrain('companion-a-b'), false);
});

test('a remote brain goes by its display name in the room', () => {
  assert.equal(remoteDisplayName('companion-c'), 'Companion C');
  assert.equal(remoteDisplayName('nova'), 'Nova');
});
