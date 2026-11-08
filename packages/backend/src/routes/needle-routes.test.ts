// The Needle over HTTP: the companions' localhost drop door and the phone's
// signed-in report door. Real express, real socket on 127.0.0.1, real sqlite;
// the needle itself runs on fake Spotify and fake push.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

const tmpRoot = mkdtempSync(join(tmpdir(), 'needle-route-test-'));
process.env.RESONANT_HOME = tmpRoot;
process.env.APP_PASSWORD = 'needle-test-password';
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { loadConfig } = await import('../config.js');
loadConfig(join(tmpRoot, 'config.yaml'));
const { initDb } = await import('../services/db.js');
const { createWebSession } = await import('../services/db/web-sessions.js');
const { createInternalRoutes } = await import('./internal-routes.js');
const needleRouter = (await import('./needle.js')).default;
const { createNeedle, setNeedleForTest } = await import('../services/needle.js');
const { SpotifyError } = await import('../services/spotify.js');

const SONG = 'spotify:track:5googFqOqpopYdcvV22T3t';
const TOKEN = 'needle-test-session';

initDb(':memory:');
createWebSession({
  id: 'needle-test', token: TOKEN, createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});

const app = express();
app.use(express.json());
app.use('/api', createInternalRoutes());
app.use('/api/spotify/needle', needleRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function post(path: string, body: unknown, cookie = true) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = `bytelight_session=${TOKEN}`;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
}

const lines: string[] = [];
let device = true;
let phones = 1;
setNeedleForTest(createNeedle({
  play: async () => {
    if (!device) throw new SpotifyError('device', 'Open Spotify on your phone first, then try again.');
    return { ok: true };
  },
  connectInfo: async () => ({ clientId: '0123456789abcdef0123456789abcdef', redirectUri: 'https://example.test/cb' }),
  sendData: async () => ({ devices: phones, sent: phones }),
  newId: () => 'drop-route-1',
  log: (line) => lines.push(line),
}));

test.after(() => {
  setNeedleForTest(null);
  server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('drop, direct: an active device plays it and the answer says direct', async () => {
  device = true;
  const { status, json } = await post('/api/internal/spotify/drop', { companion: 'companion-a', uri: SONG }, false);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, path: 'direct' });
});

test('drop, needle: no active device sends the needle and answers at once with the drop id', async () => {
  device = false;
  phones = 1;
  const { status, json } = await post('/api/internal/spotify/drop', { companion: 'companion-b', uri: SONG }, false);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, path: 'needle', dropId: 'drop-route-1', devices: 1 });
});

test('landed: the phone reports with its session and the house logs one line', async () => {
  const unsigned = await post('/api/spotify/needle/landed', { dropId: 'drop-route-1', ok: true, road: 'remote' }, false);
  assert.equal(unsigned.status, 401, "the report door needs the operator's session");
  const { status, json } = await post('/api/spotify/needle/landed', { dropId: 'drop-route-1', ok: true, road: 'remote' });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true });
  assert.equal(lines.at(-1), `[Needle] companion-b dropped ${SONG}: landed on the operator's phone by Spotify App Remote`);
  const again = await post('/api/spotify/needle/landed', { dropId: 'drop-route-1', ok: true, road: 'remote' });
  assert.equal(again.status, 404);
  const bad = await post('/api/spotify/needle/landed', { dropId: 'drop-route-1', ok: true, road: 'carrier pigeon' });
  assert.equal(bad.status, 400);
});

test('drop, no phone: no active device and no FCM device answers ok:false reason push', async () => {
  device = false;
  phones = 0;
  const { status, json } = await post('/api/internal/spotify/drop', { companion: 'companion-a', uri: SONG }, false);
  assert.equal(status, 502);
  assert.equal(json.ok, false);
  assert.equal(json.reason, 'push');
});

test('drop: a bad request is refused before Spotify', async () => {
  const { status, json } = await post('/api/internal/spotify/drop', { companion: 'companion-a', uri: 'spotify:artist:nope' }, false);
  assert.equal(status, 400);
  assert.equal(json.reason, 'request');
});
