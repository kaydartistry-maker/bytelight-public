import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  HumeRealtimeProsodySession,
  extractTopHumeProsodyScores,
  type HumeRealtimeSocket,
} from './hume-realtime-prosody.js';

class FakeHumeSocket extends EventEmitter implements HumeRealtimeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closeCalls = 0;
  terminateCalls = 0;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}

test('buffers audio until open, pauses EVI first, and returns the top three final scores', async () => {
  const socket = new FakeHumeSocket();
  let requestedUrl = '';
  const session = new HumeRealtimeProsodySession(
    'server-only-key',
    (url) => {
      requestedUrl = url;
      return socket;
    },
    { connectTimeoutMs: 1_000, maxSessionMs: 2_000 },
  );

  session.pushAudio(Buffer.from('first'));
  session.pushAudio(Buffer.from('second'));
  assert.deepEqual(socket.sent, []);

  socket.open();
  assert.equal(new URL(requestedUrl).origin, 'wss://api.hume.ai');
  assert.equal(new URL(requestedUrl).pathname, '/v0/evi/chat');
  assert.equal(new URL(requestedUrl).searchParams.get('api_key'), 'server-only-key');
  assert.deepEqual(socket.sent.map((entry) => JSON.parse(entry)), [
    { type: 'pause_assistant_message' },
    { type: 'audio_input', data: Buffer.from('first').toString('base64') },
    { type: 'audio_input', data: Buffer.from('second').toString('base64') },
  ]);

  const resultPromise = session.finish(1_000);
  socket.message({
    type: 'user_message',
    interim: true,
    models: { prosody: { scores: { ShouldNotWin: 1 } } },
  });
  socket.message({
    type: 'user_message',
    interim: false,
    models: {
      prosody: {
        scores: {
          Calmness: 0.31,
          Amusement: 0.91,
          Interest: 0.65,
          Excitement: 0.73,
          Concentration: 0.48,
          Satisfaction: 0.58,
          NotNumeric: '0.99',
        },
      },
    },
  });

  assert.deepEqual(await resultPromise, {
    Amusement: 0.91,
    Excitement: 0.73,
    Interest: 0.65,
  });
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.terminateCalls, 0);
});

test('a missing final result times out cleanly and never rejects the caller', async () => {
  const socket = new FakeHumeSocket();
  const session = new HumeRealtimeProsodySession(
    'server-only-key',
    () => socket,
    { connectTimeoutMs: 1_000, maxSessionMs: 2_000 },
  );
  socket.open();

  assert.equal(await session.finish(10), null);
  assert.equal(socket.closeCalls + socket.terminateCalls, 1);
});

test('finish allows a later Hume-split clause and aggregates the strongest signals', async () => {
  const socket = new FakeHumeSocket();
  const session = new HumeRealtimeProsodySession(
    'server-only-key',
    () => socket,
    { connectTimeoutMs: 1_000, maxSessionMs: 2_000 },
  );
  socket.open();
  socket.message({
    type: 'user_message',
    interim: false,
    models: { prosody: { scores: { Amusement: 0.8, Calmness: 0.7, Interest: 0.6 } } },
  });
  session.pushAudio(Buffer.from('later-clause'));

  const resultPromise = session.finish(1_000);
  assert.equal(socket.closeCalls, 0, 'a pre-existing clause must not close the stream immediately');
  socket.message({
    type: 'user_message',
    interim: false,
    models: { prosody: { scores: { Excitement: 0.9, Interest: 0.85, Calmness: 0.1 } } },
  });

  assert.deepEqual(await resultPromise, {
    Excitement: 0.9,
    Interest: 0.85,
    Amusement: 0.8,
  });
  assert.equal(socket.closeCalls, 1);
});

test('abort terminates a connecting socket and score extraction rejects non-final messages', () => {
  const socket = new FakeHumeSocket();
  const session = new HumeRealtimeProsodySession(
    'server-only-key',
    () => socket,
    { connectTimeoutMs: 1_000, maxSessionMs: 2_000 },
  );

  assert.equal(extractTopHumeProsodyScores({ type: 'assistant_message' }), null);
  assert.equal(extractTopHumeProsodyScores({
    type: 'user_message',
    interim: true,
    models: { prosody: { scores: { Amusement: 1 } } },
  }), null);

  session.abort();
  assert.equal(socket.terminateCalls, 1);
});
