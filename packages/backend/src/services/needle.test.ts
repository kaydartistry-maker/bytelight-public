// The Needle: a companion's drop plays straight through Spotify when it can,
// wakes the operator's phone with a data-only push when Spotify has no active device, and
// matches the phone's report to its drop.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createNeedle, readDropRequest, readLandedRequest, playRequestFor } = await import('./needle.js');
const { SpotifyError } = await import('./spotify.js');

const SONG = 'spotify:track:5googFqOqpopYdcvV22T3t';
const ALBUM = 'spotify:album:5googFqOqpopYdcvV22T3t';
const LIST = 'spotify:playlist:2DzetX1lNIOp3thxhTXIRh';
const CONNECT = { clientId: '0123456789abcdef0123456789abcdef', redirectUri: 'https://example.test/callback' };

function rig(overrides: Partial<Parameters<typeof createNeedle>[0]> = {}) {
  const lines: string[] = [];
  const played: unknown[] = [];
  const pushed: Array<Record<string, string>> = [];
  let clock = 1_000_000;
  const needle = createNeedle({
    play: async (request) => { played.push(request); return { ok: true }; },
    connectInfo: async () => CONNECT,
    sendData: async (data) => { pushed.push(data); return { devices: 1, sent: 1 }; },
    now: () => clock,
    newId: () => 'drop-1',
    log: (line) => lines.push(line),
    ...overrides,
  });
  return { needle, lines, played, pushed, advance: (ms: number) => { clock += ms; } };
}

const noDevice = async () => { throw new SpotifyError('device', 'Open Spotify on your phone first, then try again.'); };

test('a drop is a companion and a song, album or playlist, nothing else', () => {
  assert.equal(readDropRequest({ companion: 'companion-a', uri: SONG }).ok, true);
  assert.equal(readDropRequest({ companion: 'companion-b', uri: ALBUM }).ok, true);
  assert.equal(readDropRequest({ companion: 'companion-b', uri: LIST }).ok, true);
  assert.equal(readDropRequest({ companion: 'companion-c', uri: SONG }).ok, false, 'only the companions drop');
  assert.equal(readDropRequest({ companion: 'companion-a', uri: 'spotify:artist:5googFqOqpopYdcvV22T3t' }).ok, false);
  assert.equal(readDropRequest({ companion: 'companion-a', uri: 'https://open.spotify.com/track/x' }).ok, false);
  assert.equal(readDropRequest(null).ok, false);
  assert.equal(readDropRequest([]).ok, false);
  assert.deepEqual(playRequestFor(SONG), { trackUri: SONG });
  assert.deepEqual(playRequestFor(ALBUM), { albumUri: ALBUM });
  assert.deepEqual(playRequestFor(LIST), { playlistUri: LIST });
});

test('direct: with an active device the song plays through Spotify and no push goes out', async () => {
  const { needle, lines, played, pushed } = rig();
  const answer = await needle.drop({ companion: 'companion-a', uri: SONG });
  assert.deepEqual(answer, { ok: true, path: 'direct' });
  assert.deepEqual(played, [{ trackUri: SONG }]);
  assert.equal(pushed.length, 0);
  assert.deepEqual(lines, [`[Needle] companion-a dropped ${SONG}: played straight through Spotify`]);
});

test('needle: with no active device a data-only push carries the song, the app id and the drop id', async () => {
  const { needle, pushed, lines } = rig({ play: noDevice });
  const answer = await needle.drop({ companion: 'companion-b', uri: LIST });
  assert.deepEqual(answer, { ok: true, path: 'needle', dropId: 'drop-1', devices: 1 });
  assert.deepEqual(pushed, [{
    kind: 'needle', uri: LIST, by: 'companion-b', dropId: 'drop-1',
    clientId: CONNECT.clientId, redirectUri: CONNECT.redirectUri,
  }]);
  assert.equal(needle.waiting(), 1);
  assert.match(lines[0], /^\[Needle\] companion-b dropped spotify:playlist:2DzetX1lNIOp3thxhTXIRh: no active device; needle sent to 1 phone/);
});

test('needle: an app id that cannot be read in time does not hold the drop back', async () => {
  const { needle, pushed } = rig({
    play: noDevice,
    connectInfo: () => new Promise(() => {}),
    connectWaitMs: 20,
  });
  const answer = await needle.drop({ companion: 'companion-a', uri: SONG });
  assert.equal(answer.ok, true);
  assert.deepEqual(pushed, [{ kind: 'needle', uri: SONG, by: 'companion-a', dropId: 'drop-1' }]);
});

test('no phone to wake: no active device and no registered device answers ok:false reason push', async () => {
  const { needle, lines } = rig({ play: noDevice, sendData: async () => ({ devices: 0, sent: 0 }) });
  const answer = await needle.drop({ companion: 'companion-a', uri: SONG });
  assert.equal(answer.ok, false);
  assert.equal(!answer.ok && answer.reason, 'push');
  assert.equal(needle.waiting(), 0, 'nothing waits for a report that cannot come');
  assert.match(lines[0], /no phone registered for push/);
});

test('push that FCM refuses for every device is also reason push', async () => {
  const { needle } = rig({ play: noDevice, sendData: async () => ({ devices: 2, sent: 0 }) });
  const answer = await needle.drop({ companion: 'companion-a', uri: SONG });
  assert.equal(!answer.ok && answer.reason, 'push');
});

test('any other Spotify refusal is said as it is, and no push goes out', async () => {
  const { needle, pushed } = rig({
    play: async () => { throw new SpotifyError('signin', 'Spotify needs signing in again.'); },
  });
  const answer = await needle.drop({ companion: 'companion-b', uri: SONG });
  assert.deepEqual(answer, { ok: false, reason: 'signin', error: 'Spotify needs signing in again.' });
  assert.equal(pushed.length, 0);
});

test('a bad drop never reaches Spotify', async () => {
  const { needle, played } = rig();
  const answer = await needle.drop({ companion: 'companion-a', uri: 'nope' });
  assert.equal(!answer.ok && answer.reason, 'request');
  assert.equal(played.length, 0);
});

test('landed: the phone report is matched to its drop and logged once', async () => {
  const { needle, lines } = rig({ play: noDevice });
  await needle.drop({ companion: 'companion-a', uri: SONG });
  assert.deepEqual(needle.landed({ dropId: 'drop-1', ok: true, road: 'remote' }), { ok: true });
  assert.equal(lines.at(-1), `[Needle] companion-a dropped ${SONG}: landed on the operator's phone by Spotify App Remote`);
  assert.equal(needle.waiting(), 0);
  const again = needle.landed({ dropId: 'drop-1', ok: true, road: 'remote' });
  assert.equal(!again.ok && again.reason, 'unknown', 'a drop reports once');
});

test('landed: a failed fallback is logged with its words', async () => {
  const { needle, lines } = rig({ play: noDevice });
  await needle.drop({ companion: 'companion-b', uri: SONG });
  needle.landed({ dropId: 'drop-1', ok: false, road: 'intent', error: '  Spotify is\nnot installed ' });
  assert.equal(lines.at(-1), `[Needle] companion-b dropped ${SONG}: did not land on the operator's phone (opening Spotify: Spotify is not installed)`);
});

test("landed: the intent road says the song may wait for the operator's tap, and why App Remote missed", async () => {
  const { needle, lines } = rig({ play: noDevice });
  await needle.drop({ companion: 'companion-a', uri: SONG });
  needle.landed({ dropId: 'drop-1', ok: true, road: 'intent', error: 'connect timed out' });
  assert.equal(lines.at(-1), `[Needle] companion-a dropped ${SONG}: handed to Spotify on the operator's phone by intent, may wait for the operator's tap (App Remote: connect timed out)`);
});

test('landed: a forgotten drop and a malformed report are answered plainly', async () => {
  const { needle, advance } = rig({ play: noDevice, keepMs: 1000 });
  await needle.drop({ companion: 'companion-a', uri: SONG });
  advance(2000);
  const late = needle.landed({ dropId: 'drop-1', ok: true, road: 'remote' });
  assert.equal(!late.ok && late.reason, 'unknown');
  assert.equal(readLandedRequest({ dropId: 'drop-1', ok: 'yes', road: 'remote' }).ok, false);
  assert.equal(readLandedRequest({ dropId: 'drop-1', ok: true, road: 'teleport' }).ok, false);
  assert.equal(readLandedRequest({ dropId: '../etc', ok: true, road: 'remote' }).ok, false);
});
