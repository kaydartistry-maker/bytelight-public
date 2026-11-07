// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseLocalSttUrl, toLocalSttWav, transcribeLocally, transcribeWithLocalServer } from './local-stt.js';

async function withServer(
  handler: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, Buffer.concat(chunks), res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/inference`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('an unset, blank or non-http setting reads as no local server', () => {
  assert.equal(parseLocalSttUrl(null), null);
  assert.equal(parseLocalSttUrl(undefined), null);
  assert.equal(parseLocalSttUrl('   '), null);
  assert.equal(parseLocalSttUrl('not a url'), null);
  assert.equal(parseLocalSttUrl('ftp://127.0.0.1/inference'), null);
  assert.equal(parseLocalSttUrl(' http://127.0.0.1:8179/inference '), 'http://127.0.0.1:8179/inference');
});

test('the recording goes over as a multipart file and the text comes back trimmed', async () => {
  const audio = Buffer.from('pretend-opus-bytes');
  let seen = '';
  await withServer((req, body, res) => {
    seen = `${req.headers['content-type']}\n${body.toString('latin1')}`;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ backend: 'moonshine-streaming', text: '  This fucking printer jams every morning.  ' }));
  }, async (url) => {
    const text = await transcribeWithLocalServer(url, audio, 'audio/webm;codecs=opus');
    assert.equal(text, 'This fucking printer jams every morning.');
  });
  assert.match(seen, /multipart\/form-data/);
  assert.match(seen, /name="file"; filename="recording\.webm"/);
  assert.match(seen, /pretend-opus-bytes/);
  assert.match(seen, /name="response_format"\r\n\r\njson/);
});

test('silence is an answer, not a failure', async () => {
  await withServer((_req, _body, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: '' }));
  }, async (url) => {
    assert.equal(await transcribeWithLocalServer(url, Buffer.from('x'), 'audio/wav'), '');
  });
});

test('a server error, a missing text field and a hang all throw so the caller can fall back', async () => {
  await withServer((_req, _body, res) => {
    res.statusCode = 500;
    res.end('model not loaded');
  }, async (url) => {
    await assert.rejects(transcribeWithLocalServer(url, Buffer.from('x'), 'audio/webm'), /answered 500: model not loaded/);
  });

  await withServer((_req, _body, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ segments: [] }));
  }, async (url) => {
    await assert.rejects(transcribeWithLocalServer(url, Buffer.from('x'), 'audio/webm'), /without a text field/);
  });

  await withServer(() => { /* never answers */ }, async (url) => {
    await assert.rejects(transcribeWithLocalServer(url, Buffer.from('x'), 'audio/webm', { timeoutMs: 100 }));
  });
});

test('nobody listening throws rather than hanging', async () => {
  await assert.rejects(
    transcribeWithLocalServer('http://127.0.0.1:1/inference', Buffer.from('x'), 'audio/webm', { timeoutMs: 2000 }),
  );
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** A streaming webm with one-second clusters, the shape a MediaRecorder writes. */
function streamingWebm(seconds: number): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), 'local-stt-test-'));
  try {
    const out = join(dir, 'tone.webm');
    const made = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:a', 'libopus', '-f', 'webm', '-live', '1', '-cluster_time_limit', '1000', out,
    ]);
    return made.status === 0 ? readFileSync(out) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function wavFacts(wav: Buffer): { channels: number; rate: number; seconds: number } {
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.toString('latin1', 8, 12), 'WAVE');
  let offset = 12;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataBytes = -1;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(offset + 10);
      rate = wav.readUInt32LE(offset + 12);
      bits = wav.readUInt16LE(offset + 22);
    }
    if (id === 'data') {
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  assert.ok(dataBytes > 0, 'a data chunk');
  return { channels, rate, seconds: dataBytes / (channels * rate * (bits / 8)) };
}

test('a streaming webm comes back whole, as 16 kHz mono WAV', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async (t) => {
  const webm = streamingWebm(3);
  if (!webm) {
    t.skip('this ffmpeg cannot write opus');
    return;
  }
  const facts = wavFacts(await toLocalSttWav(webm, 'audio/webm;codecs=opus'));
  assert.equal(facts.channels, 1);
  assert.equal(facts.rate, 16000);
  assert.ok(Math.abs(facts.seconds - 3) < 0.2, `three seconds went in and ${facts.seconds} came out`);
});

test('a WAV goes over untouched', async () => {
  const wav = Buffer.from('RIFF....WAVEfmt pretend');
  assert.equal(await toLocalSttWav(wav, 'audio/wav'), wav);
});

test('bytes that are not audio are refused', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  await assert.rejects(toLocalSttWav(Buffer.from('not audio at all'), 'audio/webm'), /ffmpeg could not convert/);
});

const identity = async (audio: Buffer) => audio;

test('real words from the local step are the answer, and the server is sent WAV', async () => {
  let seen = '';
  await withServer((_req, body, res) => {
    seen = body.toString('latin1');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: ' Where the fuck did I leave my keys? ' }));
  }, async (url) => {
    const result = await transcribeLocally(url, Buffer.from('wav-bytes'), 'audio/webm;codecs=opus', { convert: identity });
    assert.deepEqual(result, { ok: true, text: 'Where the fuck did I leave my keys?' });
  });
  assert.match(seen, /filename="recording\.wav"/);
  assert.match(seen, /Content-Type: audio\/wav/);
});

test('an empty transcript, a server error and a failed conversion all hand the turn on', async () => {
  await withServer((_req, _body, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: '' }));
  }, async (url) => {
    const result = await transcribeLocally(url, Buffer.from('x'), 'audio/webm', { convert: identity });
    assert.deepEqual(result, { ok: false, reason: 'empty transcript' });
  });

  await withServer((_req, _body, res) => {
    res.statusCode = 500;
    res.end('model not loaded');
  }, async (url) => {
    const result = await transcribeLocally(url, Buffer.from('x'), 'audio/webm', { convert: identity });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /answered 500/);
  });

  const refused = await transcribeLocally('http://127.0.0.1:1/inference', Buffer.from('x'), 'audio/webm', {
    convert: async () => { throw new Error('ffmpeg could not convert the recording: nope'); },
  });
  assert.deepEqual(refused, { ok: false, reason: 'ffmpeg could not convert the recording: nope' });
});

test("the caller's own abort is thrown rather than handed on", async () => {
  await withServer(() => { /* never answers */ }, async (url) => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    await assert.rejects(transcribeLocally(url, Buffer.from('x'), 'audio/webm', { convert: identity, signal: abort.signal }));
  });
});
