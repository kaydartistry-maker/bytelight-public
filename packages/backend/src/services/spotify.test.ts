// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify, for seeing: the reader, with the network replaced by a fake. The
// answers below are the shapes their server gave on Oct 20 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSpotify,
  findSpotifyServer,
  keyedAddress,
  NO_DEVICE_LINE,
  readPauseRequest,
  readPlayRequest,
  readSearchQuery,
  readSkipRequest,
  rpcAnswerOf,
  signInPageOf,
  SpotifyError,
  UNSURE_LINE,
  type Fetcher,
} from './spotify.js';
import type { McpServerRow } from './db/mcp-servers.js';

const SERVER = 'https://spotify-example.someone.workers.dev/mcp';

/** A JSON-RPC answer the way their server writes it: the tool's JSON as text. */
function toolAnswer(value: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] } });
}

function json(body: string, status = 200, type = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

type Call = { tool: string; args: Record<string, unknown> };

/**
 * A fake network. `tools` answers the MCP server by tool name; `covers`
 * answers oEmbed by the page it asks about (a string is a thumbnail_url, a
 * number a status, 'throw' a network failure, and { after, url } a cover
 * that arrives late).
 */
function fakeNet(
  tools: Record<string, (args: Record<string, unknown>) => Response>,
  covers: Record<string, string | number | 'throw' | { after: number; url: string }> = {},
) {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    if (url === SERVER) {
      const body = JSON.parse(String(init?.body));
      calls.push({ tool: body.params.name, args: body.params.arguments });
      const answer = tools[body.params.name];
      if (!answer) throw new Error(`no fake for ${body.params.name}`);
      return answer(body.params.arguments);
    }
    const page = new URL(url).searchParams.get('url') ?? '';
    lookups.push(page);
    const cover = covers[page];
    if (cover === undefined) return json('{}', 404);
    if (cover === 'throw') throw new TypeError('fetch failed');
    if (typeof cover === 'object') {
      await new Promise((resolve) => setTimeout(resolve, cover.after));
      return json(JSON.stringify({ type: 'rich', thumbnail_url: cover.url }));
    }
    if (typeof cover === 'number') return json('{"error":"nope"}', cover);
    return json(JSON.stringify({ type: 'rich', thumbnail_url: cover, thumbnail_width: 300 }));
  };
  return { fetcher, calls, lookups };
}

const server = () => ({ url: SERVER, apiKey: null });

const PLAYLISTS = [
  { name: 'Late Night 🔥', id: '2VwXyZaBcDeFgHiJkLmNoP', tracks: 23, uri: 'spotify:playlist:2VwXyZaBcDeFgHiJkLmNoP' },
  { name: 'Sunday Mix', id: '1AbCdEfGhIjKlMnOpQrStU', tracks: 5, uri: 'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU' },
];
const page = (kind: string, id: string) => `https://open.spotify.com/${kind}/${id}`;

test('a JSON-RPC answer is read from plain JSON and from an event stream', () => {
  const plain = rpcAnswerOf(toolAnswer({ playing: false }));
  assert.deepEqual(plain?.result, { content: [{ type: 'text', text: '{\n  "playing": false\n}' }] });

  const stream = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,',
    'data: "result":{"content":[{"type":"text","text":"[]"}]}}',
    '',
  ].join('\n');
  assert.deepEqual(rpcAnswerOf(stream)?.result, { content: [{ type: 'text', text: '[]' }] },
    'the notification is passed over and a payload split across data lines is joined');
  assert.equal(rpcAnswerOf('<!doctype html><html></html>'), null);
  assert.equal(rpcAnswerOf(''), null);
});

test('every playlist comes back with its cover, and one cover that fails leaves only that one without a picture', async () => {
  const net = fakeNet(
    { spotify_get_playlists: () => json(toolAnswer(PLAYLISTS)) },
    {
      [page('playlist', PLAYLISTS[0].id)]: 'https://mosaic.scdn.co/300/tray',
      [page('playlist', PLAYLISTS[1].id)]: 'throw',
    },
  );
  const reader = createSpotify({ fetch: net.fetcher, server, coverFile: null });
  const view = await reader.playlists();
  assert.deepEqual(view.playlists, [
    { id: PLAYLISTS[0].id, name: 'Late Night 🔥', tracks: 23, uri: PLAYLISTS[0].uri, cover: 'https://mosaic.scdn.co/300/tray' },
    { id: PLAYLISTS[1].id, name: 'Sunday Mix', tracks: 5, uri: PLAYLISTS[1].uri, cover: null },
  ]);
  assert.deepEqual(net.calls, [{ tool: 'spotify_get_playlists', args: { limit: 50, offset: 0 } }]);
});

test('covers are kept by uri in a file, written whole, and a new reader finds them without asking again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spotify-covers-'));
  const coverFile = join(dir, 'spotify-covers.json');
  try {
    const recent = [{ track: 'MY HEAD', artist: 'Layto', played_at: '2026-10-20T00:17:27.554Z', uri: 'spotify:track:7qItfeoWaFGMij40oPR96M' }];
    const first = fakeNet(
      { spotify_recently_played: () => json(toolAnswer(recent)) },
      { [page('track', '7qItfeoWaFGMij40oPR96M')]: 'https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e0221b700e6f5ecf4b11c14fc56' },
    );
    const view = await createSpotify({ fetch: first.fetcher, server, coverFile }).recent();
    assert.deepEqual(view.tracks, [{
      name: 'MY HEAD', artist: 'Layto', uri: 'spotify:track:7qItfeoWaFGMij40oPR96M', playedAt: '2026-10-20T00:17:27.554Z',
      cover: 'https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e0221b700e6f5ecf4b11c14fc56',
    }]);
    assert.deepEqual(first.calls[0].args, { limit: 20 });
    const kept = JSON.parse(readFileSync(coverFile, 'utf8'));
    assert.equal(kept.covers['spotify:track:7qItfeoWaFGMij40oPR96M'].cover, view.tracks[0].cover);
    assert.deepEqual(readdirSync(dir), ['spotify-covers.json'], 'no scratch copy is left beside it');

    const second = fakeNet({ spotify_recently_played: () => json(toolAnswer(recent)) }, {});
    const again = await createSpotify({ fetch: second.fetcher, server, coverFile }).recent();
    assert.equal(again.tracks[0].cover, view.tracks[0].cover);
    assert.deepEqual(second.lookups, [], 'a kept cover is not looked up again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slow cover never holds the list: it goes out without that picture, and the picture is kept when it lands', async () => {
  const song = { track: 'Villain', artist: 'MISSIO', uri: 'spotify:track:5googFqOqpopYdcvV22T3t' };
  const net = fakeNet(
    { spotify_get_playlist_tracks: () => json(toolAnswer([song])) },
    { [page('track', '5googFqOqpopYdcvV22T3t')]: { after: 300, url: 'https://i.scdn.co/image/villain' } },
  );
  const reader = createSpotify({ fetch: net.fetcher, server, coverFile: null, coverBudgetMs: 50 });
  const started = Date.now();
  const view = await reader.playlistTracks('3HfCdNDuXNw4biCQZzfXXD');
  assert.ok(Date.now() - started < 250, 'the list did not wait for the cover');
  assert.deepEqual(view, { id: '3HfCdNDuXNw4biCQZzfXXD', tracks: [{ name: 'Villain', artist: 'MISSIO', uri: song.uri, cover: null }] });
  assert.deepEqual(net.calls[0].args, { playlist_id: '3HfCdNDuXNw4biCQZzfXXD', limit: 50, offset: 0 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const later = await reader.playlistTracks('3HfCdNDuXNw4biCQZzfXXD');
  assert.equal(later.tracks[0].cover, 'https://i.scdn.co/image/villain', 'the late cover was kept for the next read');
  assert.equal(net.lookups.length, 1, 'and not asked for twice');

  const quick = fakeNet(
    { spotify_get_playlist_tracks: () => json(toolAnswer([song])) },
    { [page('track', '5googFqOqpopYdcvV22T3t')]: 'throw' },
  );
  const timedOut = createSpotify({ fetch: quick.fetcher, server, coverFile: null });
  await timedOut.playlistTracks('3HfCdNDuXNw4biCQZzfXXD');
  await timedOut.playlistTracks('3HfCdNDuXNw4biCQZzfXXD');
  assert.equal(quick.lookups.length, 2, 'a cover that could not be told is asked for again, never remembered as missing');
});

test('a long playlist is read page by page until a short page', async () => {
  const songs = Array.from({ length: 53 }, (_, i) => ({ track: `Song ${i}`, artist: 'Someone', uri: `spotify:track:t${i}` }));
  const net = fakeNet({
    spotify_get_playlist_tracks: (args) => json(toolAnswer(songs.slice(Number(args.offset), Number(args.offset) + Number(args.limit)))),
  });
  const view = await createSpotify({ fetch: net.fetcher, server, coverFile: null }).playlistTracks('abc');
  assert.equal(view.tracks.length, 53);
  assert.deepEqual(net.calls.map((c) => c.args.offset), [0, 50]);
});

test('what is playing now: nothing, a song with its cover, or a paused song', async () => {
  const idle = fakeNet({ spotify_now_playing: () => json(toolAnswer({ playing: false })) });
  assert.deepEqual(await createSpotify({ fetch: idle.fetcher, server, coverFile: null }).now(), { playing: false, track: null });
  assert.deepEqual(idle.lookups, []);

  const playing = fakeNet(
    { spotify_now_playing: () => json(toolAnswer({ playing: true, track: 'Beauty', artist: 'Layto', album: 'Beauty', uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ' })) },
    { [page('track', '463ahmflVo5cjEewhhbgAJ')]: 'https://i.scdn.co/image/beauty' },
  );
  assert.deepEqual(await createSpotify({ fetch: playing.fetcher, server, coverFile: null }).now(), {
    playing: true,
    track: { name: 'Beauty', artist: 'Layto', uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ', cover: 'https://i.scdn.co/image/beauty', album: 'Beauty' },
  });

  // Spotify's own shape, in case the server ever passes it through: a paused song keeps its track.
  const paused = fakeNet({
    spotify_now_playing: () => json(toolAnswer({
      is_playing: false,
      item: { name: 'IOU', artists: [{ name: 'Layto' }, { name: 'WesGhost' }], album: { name: 'IOU', images: [{ url: 'https://i.scdn.co/image/iou' }] }, uri: 'spotify:track:20ynCu27m96LUeTZU64CxA' },
    })),
  });
  const view = await createSpotify({ fetch: paused.fetcher, server, coverFile: null }).now();
  assert.deepEqual(view, {
    playing: false,
    track: { name: 'IOU', artist: 'Layto, WesGhost', uri: 'spotify:track:20ynCu27m96LUeTZU64CxA', cover: 'https://i.scdn.co/image/iou', album: 'IOU' },
  });
  assert.deepEqual(paused.lookups, [], 'a picture the answer already carried is used as it is');
});

test('a lapsed sign-in becomes the owner plain sentence, with the worker\'s own sign-in page', async () => {
  const lapsed = fakeNet({
    spotify_now_playing: () => json(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Token refresh failed: Refresh token revoked' } })),
  });
  await assert.rejects(createSpotify({ fetch: lapsed.fetcher, server, coverFile: null }).now(), (error: unknown) => {
    assert.ok(error instanceof SpotifyError, 'the read fails as a SpotifyError');
    assert.deepEqual(error.toProblem(), {
      error: "Spotify's sign-in on the Spotify worker has lapsed. Open its sign-in page and say yes to Spotify. (A worker older than 1.1.0 also wants the token it shows you put into its settings on Cloudflare.)",
      reason: 'signin',
      authUrl: 'https://spotify-example.someone.workers.dev/auth',
    });
    return true;
  });
});

test('any other error from Spotify is said in Spotify\'s own words, and a server that cannot be reached says so', async () => {
  const bad = fakeNet({
    spotify_get_playlist_tracks: () => json(JSON.stringify({
      jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Spotify API error (400): {"error": {"status": 400, "message": "Invalid base62 id" } }' },
    })),
  });
  await assert.rejects(createSpotify({ fetch: bad.fetcher, server, coverFile: null }).playlistTracks('nope'), (error: unknown) => {
    assert.deepEqual((error as SpotifyError).toProblem(), { error: 'Spotify answered with an error: Invalid base62 id.', reason: 'spotify' });
    return true;
  });

  const flagged = fakeNet({
    spotify_recently_played: () => json(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Rate limited, try later' }] } })),
  });
  await assert.rejects(createSpotify({ fetch: flagged.fetcher, server, coverFile: null }).recent(), /Spotify answered with an error: Rate limited, try later\./);

  const down: Fetcher = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(createSpotify({ fetch: down, server, coverFile: null }).recent(), (error: unknown) => {
    assert.deepEqual((error as SpotifyError).toProblem(), { error: "Spotify's server could not be reached just now.", reason: 'unreachable' });
    return true;
  });

  const page502: Fetcher = async () => json('<html>Bad gateway</html>', 502, 'text/html');
  await assert.rejects(createSpotify({ fetch: page502, server, coverFile: null }).recent(), /could not be reached just now \(it answered 502\)/);
});

test('the server is found in the house\'s own MCP list, and one switched off there is respected', () => {
  const row = (over: Partial<McpServerRow>): McpServerRow => ({
    id: 1, name: 'SpotifyMCP', url: SERVER, api_key: null, enabled: 1, tools_cache: null, last_discovered: null, created_at: '', ...over,
  });
  assert.deepEqual(findSpotifyServer([row({ name: 'DiscordMCP', url: 'https://d.example/mcp' }), row({})]), { url: SERVER, apiKey: null });
  assert.deepEqual(findSpotifyServer([row({ api_key: ' key ' })]), { url: SERVER, apiKey: 'key' });
  const off = findSpotifyServer([row({ enabled: 0 })]);
  assert.ok(off instanceof SpotifyError, 'a switched-off server is not used');
  assert.deepEqual(off.toProblem(), { error: 'The Spotify server is switched off in Integrations > MCP.', reason: 'unset' });
  const none = findSpotifyServer([row({ name: 'DiscordMCP', url: 'https://d.example/mcp' })]);
  assert.ok(none instanceof SpotifyError, 'no Spotify server, no server');
  assert.equal(none.reason, 'unset');
});

// byte-light adaptation: integrations.spotify_server names the server by id or name.
test('a server chosen by name or id is used even when nothing in it says Spotify, and auto-detect is the fallback', () => {
  const row = (over: Partial<McpServerRow>): McpServerRow => ({
    id: 1, name: 'SpotifyMCP', url: SERVER, api_key: null, enabled: 1, tools_cache: null, last_discovered: null, created_at: '', ...over,
  });
  const jukebox = row({ id: 7, name: 'Jukebox', url: 'https://jukebox.example.workers.dev/mcp' });
  const rows = [row({}), jukebox];
  assert.deepEqual(findSpotifyServer(rows, 'jukebox'), { url: 'https://jukebox.example.workers.dev/mcp', apiKey: null }, 'by name, any case');
  assert.deepEqual(findSpotifyServer(rows, '7'), { url: 'https://jukebox.example.workers.dev/mcp', apiKey: null }, 'by id');
  assert.deepEqual(findSpotifyServer(rows, null), { url: SERVER, apiKey: null }, 'unset: auto-detect');
  assert.deepEqual(findSpotifyServer(rows, 'Nobody'), { url: SERVER, apiKey: null }, 'a choice no server answers to falls back to auto-detect');
  const off = findSpotifyServer([row({}), { ...jukebox, enabled: 0 }], 'Jukebox');
  assert.ok(off instanceof SpotifyError, 'a chosen server switched off is respected, not swapped for another');
  assert.equal(off.reason, 'unset');
  assert.match(off.message, /Jukebox/);
});

// ─── Playing ─────────────────────────────────────────────────────────

const SONG = 'spotify:track:5googFqOqpopYdcvV22T3t';
const WEDDING = 'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU';
const ALBUM = 'spotify:album:1ghzdXKc5kfvQbSpUgDpRS';
const rpcError = (message: string) => () => json(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }));
const NO_DEVICE_FROM_SPOTIFY = 'Spotify API error (404): {"error": {"status": 404, "message": "Player command failed: No active device found", "reason": "NO_ACTIVE_DEVICE" } }';

/** A reader whose presses all answer `answer`, with the log kept. */
function presser(answer: () => Response) {
  const net = fakeNet({ spotify_play: answer, spotify_pause: answer, spotify_skip: answer });
  const lines: string[] = [];
  const reader = createSpotify({ fetch: net.fetcher, server, coverFile: null, log: (line) => lines.push(line) });
  return { reader, calls: net.calls, lines };
}

async function refusedAs(work: Promise<unknown>, reason: string, sentence: string, what: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof SpotifyError, `${what}: fails as a SpotifyError, not ${String(error)}`);
    assert.deepEqual(error.toProblem(), { error: sentence, reason }, `${what}: says it plainly`);
    return true;
  }, `${what}: the press is refused`);
}

test('each press asks their server once, for the right tool with the right arguments', async () => {
  const { reader, calls } = presser(() => json(toolAnswer('Playback started')));
  assert.deepEqual(await reader.play({ trackUri: SONG }), { ok: true }, 'a song is taken');
  assert.deepEqual(await reader.play({ playlistUri: WEDDING }), { ok: true }, 'a playlist is taken');
  assert.deepEqual(await reader.play({}), { ok: true }, 'carrying on is taken');
  assert.deepEqual(await reader.pause(), { ok: true }, 'pause is taken');
  assert.deepEqual(await reader.skip('next'), { ok: true }, 'next is taken');
  assert.deepEqual(await reader.skip('previous'), { ok: true }, 'previous is taken');
  assert.deepEqual(calls, [
    { tool: 'spotify_play', args: { track_uri: SONG } },
    { tool: 'spotify_play', args: { playlist_uri: WEDDING } },
    { tool: 'spotify_play', args: {} },
    { tool: 'spotify_pause', args: {} },
    { tool: 'spotify_skip', args: { direction: 'next' } },
    { tool: 'spotify_skip', args: { direction: 'previous' } },
  ], 'one call per press, each with only what it needs');

  const quiet = presser(() => json(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } })));
  assert.deepEqual(await quiet.reader.pause(), { ok: true }, 'a yes with no words is still a yes');
});

test('a press with nowhere to play says to open Spotify on their phone, however the server words it', async () => {
  assert.equal(NO_DEVICE_LINE, 'Open Spotify on your phone first, then try again.', 'the owner sentence, as offered');
  const asError = presser(rpcError(NO_DEVICE_FROM_SPOTIFY));
  await refusedAs(asError.reader.play({ trackUri: SONG }), 'device', NO_DEVICE_LINE, "Spotify's own refusal, passed on as an error");

  const flagged = presser(() => json(JSON.stringify({
    jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Player command failed: No active device found' }] },
  })));
  await refusedAs(flagged.reader.skip('next'), 'device', NO_DEVICE_LINE, 'a tool answer flagged as an error');

  const disguised = presser(() => json(toolAnswer('No active device found. Open Spotify on a device first.')));
  await refusedAs(disguised.reader.pause(), 'device', NO_DEVICE_LINE, 'a refusal worded as if it were a yes');
});

test('a press their server could not read says it could not tell, rather than that it failed', async () => {
  assert.equal(UNSURE_LINE, "Spotify's server could not tell whether that worked.", 'the sentence for not knowing');
  for (const words of [
    'Unexpected token \'J\', "JXUTzWLwGr"... is not valid JSON',
    'Unexpected end of JSON input',
    'Unexpected token J in JSON at position 0',
  ]) {
    const { reader } = presser(rpcError(words));
    await refusedAs(reader.skip('next'), 'spotify', UNSURE_LINE, `their server's "${words}"`);
  }
});

test('on a press, a lapsed sign-in and every other refusal read the way they do for a look', async () => {
  const lapsed = presser(rpcError('Token refresh failed: Refresh token revoked'));
  await assert.rejects(lapsed.reader.play({ playlistUri: WEDDING }), (error: unknown) => {
    assert.ok(error instanceof SpotifyError, 'a lapsed sign-in fails as a SpotifyError');
    assert.deepEqual(error.toProblem(), {
      error: "Spotify's sign-in on the Spotify worker has lapsed. Open its sign-in page and say yes to Spotify. (A worker older than 1.1.0 also wants the token it shows you put into its settings on Cloudflare.)",
      reason: 'signin',
      authUrl: 'https://spotify-example.someone.workers.dev/auth',
    }, 'with the owner sentence and the sign-in page');
    return true;
  }, 'a lapsed sign-in refuses the press');

  const premium = presser(rpcError('Spotify API error (403): {"error": {"status": 403, "message": "Player command failed: Premium required", "reason": "PREMIUM_REQUIRED" } }'));
  await refusedAs(premium.reader.play({ trackUri: SONG }), 'spotify', 'Spotify answered with an error: Player command failed: Premium required.', "any other refusal, in Spotify's own words");

  const down: Fetcher = async () => { throw new TypeError('fetch failed'); };
  const unreachable = createSpotify({ fetch: down, server, coverFile: null, log: () => {} });
  await refusedAs(unreachable.pause(), 'unreachable', "Spotify's server could not be reached just now.", 'a server that cannot be reached');
});

test('nothing unchecked reaches their server: the door refuses it, and so does the reader behind it', async () => {
  assert.deepEqual(readPlayRequest({ trackUri: SONG }), { ok: true, value: { trackUri: SONG } }, 'a song');
  assert.deepEqual(readPlayRequest({ playlistUri: WEDDING }), { ok: true, value: { playlistUri: WEDDING } }, 'a playlist');
  assert.deepEqual(readPlayRequest({}), { ok: true, value: {} }, 'nothing: carry on');
  assert.deepEqual(readPlayRequest(undefined), { ok: true, value: {} }, 'no body: carry on');
  const notPlayed: Array<[unknown, string]> = [
    [{ trackUri: SONG, playlistUri: WEDDING, albumUri: ALBUM }, 'Play takes a playlist or an album, not both.'],
    [{ playlistUri: WEDDING, albumUri: ALBUM }, 'Play takes a playlist or an album, not both.'],
    [{ trackUri: SONG, deviceId: 'abc' }, 'Play takes a song, a playlist or an album, and nothing else.'],
    [{ trackUri: SONG, offset_uri: SONG }, 'Play takes a song, a playlist or an album, and nothing else.'],
    [{ track_uri: SONG }, 'Play takes a song, a playlist or an album, and nothing else.'],
    [[SONG], 'Play takes a song, a playlist or an album, and nothing else.'],
    [SONG, 'Play takes a song, a playlist or an album, and nothing else.'],
    [null, 'Play takes a song, a playlist or an album, and nothing else.'],
    [{ trackUri: SONG, albumUri: WEDDING }, 'That is not a Spotify album.'],
    [{ trackUri: SONG, albumUri: `${ALBUM}?si=1` }, 'That is not a Spotify album.'],
    [{ trackUri: 'spotify:track:nope', playlistUri: WEDDING }, 'That is not a Spotify song.'],
    [{ trackUri: SONG, playlistUri: ALBUM }, 'That is not a Spotify playlist.'],
    [{ trackUri: WEDDING }, 'That is not a Spotify song.'],
    [{ trackUri: 'spotify:track:nope' }, 'That is not a Spotify song.'],
    [{ trackUri: null }, 'That is not a Spotify song.'],
    [{ trackUri: 'https://open.spotify.com/track/5googFqOqpopYdcvV22T3t' }, 'That is not a Spotify song.'],
    [{ playlistUri: SONG }, 'That is not a Spotify playlist.'],
    [{ playlistUri: `${WEDDING}?si=1` }, 'That is not a Spotify playlist.'],
  ];
  for (const [body, sentence] of notPlayed) {
    assert.deepEqual(readPlayRequest(body), { ok: false, error: sentence }, `play refuses ${JSON.stringify(body)}`);
  }

  assert.deepEqual(readSkipRequest({ direction: 'next' }), { ok: true, value: 'next' }, 'next');
  assert.deepEqual(readSkipRequest({ direction: 'previous' }), { ok: true, value: 'previous' }, 'previous');
  for (const body of [{}, undefined, { direction: 'Next' }, { direction: 'forward' }, { direction: 'next', times: 2 }, ['next'], 'next']) {
    assert.deepEqual(readSkipRequest(body), { ok: false, error: 'Skip goes to the next song or the previous one, and nothing else.' },
      `skip refuses ${JSON.stringify(body)}`);
  }

  assert.deepEqual(readPauseRequest({}), { ok: true, value: null }, 'pause with nothing');
  assert.deepEqual(readPauseRequest(undefined), { ok: true, value: null }, 'pause with no body');
  assert.deepEqual(readPauseRequest({ volume: 0 }), { ok: false, error: 'Pause takes nothing.' }, 'pause refuses anything with it');

  const { reader, calls } = presser(() => json(toolAnswer('Playback started')));
  await refusedAs(reader.play({ trackUri: 'spotify:track:nope' }), 'spotify', 'That is not a Spotify song.', 'the reader checks a song itself');
  await refusedAs(reader.play({ playlistUri: SONG }), 'spotify', 'That is not a Spotify playlist.', 'the reader checks a playlist itself');
  await refusedAs(reader.play({ trackUri: SONG, albumUri: SONG }), 'spotify', 'That is not a Spotify album.', 'the reader checks an album itself');
  await refusedAs(reader.skip('sideways' as never), 'spotify', 'Skip goes to the next song or the previous one, and nothing else.', 'the reader checks a direction itself');
  assert.deepEqual(calls, [], 'and their server was never asked');
});

test('every press goes to the log with what was pressed and what their server said', async () => {
  const taken = presser(() => json(toolAnswer('Playback started')));
  await taken.reader.play({ trackUri: SONG });
  assert.deepEqual(taken.lines, [`[spotify] play ${SONG}: the server took it (Playback started)`], 'a yes, with its words');

  const refused = presser(rpcError(NO_DEVICE_FROM_SPOTIFY));
  await refused.reader.skip('previous').catch(() => {});
  assert.deepEqual(refused.lines, [`[spotify] skip previous: device (${NO_DEVICE_FROM_SPOTIFY})`], "a no, with the server's own words");
});

test('a song tapped with its playlist or album starts that playlist or album at the song, and a song alone is still asked for alone', async () => {
  assert.deepEqual(readPlayRequest({ trackUri: SONG, playlistUri: WEDDING }), { ok: true, value: { trackUri: SONG, playlistUri: WEDDING } }, 'a song in its playlist');
  assert.deepEqual(readPlayRequest({ trackUri: SONG, albumUri: ALBUM }), { ok: true, value: { trackUri: SONG, albumUri: ALBUM } }, 'a song in its album');
  assert.deepEqual(readPlayRequest({ albumUri: ALBUM }), { ok: true, value: { albumUri: ALBUM } }, 'an album from its top');
  const { reader, calls, lines } = presser(() => json(toolAnswer({ success: true })));
  assert.deepEqual(await reader.play({ trackUri: SONG, playlistUri: WEDDING }), { ok: true });
  assert.deepEqual(await reader.play({ trackUri: SONG, albumUri: ALBUM }), { ok: true });
  assert.deepEqual(await reader.play({ albumUri: ALBUM }), { ok: true });
  assert.deepEqual(await reader.play({ trackUri: SONG }), { ok: true });
  assert.deepEqual(calls, [
    { tool: 'spotify_play', args: { context_uri: WEDDING, offset_uri: SONG } },
    { tool: 'spotify_play', args: { context_uri: ALBUM, offset_uri: SONG } },
    { tool: 'spotify_play', args: { context_uri: ALBUM } },
    { tool: 'spotify_play', args: { track_uri: SONG } },
  ], 'the playlist or album is the context and the song its starting place; no song is ever sent beside a context');
  assert.match(lines[0], new RegExp(`play ${SONG} in ${WEDDING}: the server took it`), 'the log says which song in which playlist');
});

test('what is playing carries how far in and how long the song is, when their server says them plainly', async () => {
  const net = fakeNet(
    { spotify_now_playing: () => json(toolAnswer({ playing: true, track: 'Rain', artist: 'Sleep Token', album: 'Sundowning', progress_ms: 61234, duration_ms: 241000, uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ' })) },
    { [page('track', '463ahmflVo5cjEewhhbgAJ')]: 'https://i.scdn.co/image/rain' },
  );
  assert.deepEqual(await createSpotify({ fetch: net.fetcher, server, coverFile: null }).now(), {
    playing: true,
    track: { name: 'Rain', artist: 'Sleep Token', uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ', cover: 'https://i.scdn.co/image/rain', album: 'Sundowning' },
    progressMs: 61234,
    durationMs: 241000,
  }, 'both numbers ride along with the song and its cover');

  const strange = fakeNet({ spotify_now_playing: () => json(toolAnswer({ playing: true, track: 'Rain', artist: 'Sleep Token', progress_ms: 'soon', duration_ms: -5, uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ' })) });
  const view = await createSpotify({ fetch: strange.fetcher, server, coverFile: null, coverBudgetMs: 0 }).now();
  assert.equal('progressMs' in view, false, 'a progress that is not a number is not passed on');
  assert.equal('durationMs' in view, false, 'nor a length below nothing');

  const idle = fakeNet({ spotify_now_playing: () => json(toolAnswer({ playing: false, progress_ms: 0 })) });
  assert.deepEqual(await createSpotify({ fetch: idle.fetcher, server, coverFile: null }).now(), { playing: false, track: null }, 'with no song there is nothing to time');
});

test('their recent songs carry their album, so a tap can start it at that song', async () => {
  const net = fakeNet({
    spotify_recently_played: () => json(toolAnswer([
      { track: 'Rain', artist: 'Sleep Token', played_at: '2026-10-20T21:09:00Z', uri: SONG, album_uri: ALBUM },
      { track: 'An Episode', artist: '', played_at: null, uri: 'spotify:episode:5googFqOqpopYdcvV22T3t', album_uri: null },
      { track: 'Odd', artist: 'Someone', played_at: null, uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ', album_uri: 'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU' },
    ])),
  });
  const { tracks } = await createSpotify({ fetch: net.fetcher, server, coverFile: null, coverBudgetMs: 0 }).recent();
  assert.equal(tracks[0].albumUri, ALBUM, 'the album their server named');
  assert.equal('albumUri' in tracks[1], false, 'no album named, none carried');
  assert.equal('albumUri' in tracks[2], false, 'an address that is not an album is not one');
});

test('search reads songs through their server, best match first, each with its cover and album', async () => {
  const raw = [
    { name: 'Rain', artists: [{ name: 'Sleep Token' }], album: { name: 'Sundowning', uri: ALBUM, images: [{ url: 'https://i.scdn.co/image/sundowning', height: 640 }] }, uri: SONG, type: 'track' },
    { name: 'Rain', artists: [{ name: 'Someone Else' }], album: { name: 'Weather', uri: 'spotify:album:5googFqOqpopYdcvV22T3t' }, uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ', type: 'track' },
  ];
  const net = fakeNet({ spotify_search: () => json(toolAnswer(raw)) }, { [page('track', '463ahmflVo5cjEewhhbgAJ')]: 'https://i.scdn.co/image/weather' });
  const reader = createSpotify({ fetch: net.fetcher, server, coverFile: null });
  assert.deepEqual(await reader.search('  rain   sleep token '), {
    query: 'rain sleep token',
    tracks: [
      { name: 'Rain', artist: 'Sleep Token', uri: SONG, cover: 'https://i.scdn.co/image/sundowning', albumUri: ALBUM },
      { name: 'Rain', artist: 'Someone Else', uri: 'spotify:track:463ahmflVo5cjEewhhbgAJ', cover: 'https://i.scdn.co/image/weather', albumUri: 'spotify:album:5googFqOqpopYdcvV22T3t' },
    ],
  }, 'the picture a song came with is used; one without is looked up');
  assert.deepEqual(net.calls, [{ tool: 'spotify_search', args: { query: 'rain sleep token', type: 'track', limit: 10 } }], 'one search, for songs');

  const none = fakeNet({ spotify_search: () => json(toolAnswer([])) });
  assert.deepEqual(await createSpotify({ fetch: none.fetcher, server, coverFile: null }).search('zzzz'), { query: 'zzzz', tracks: [] }, 'nothing found is an empty list');
});

test('a search needs words, and not too many, and nothing else reaches their server', async () => {
  assert.deepEqual(readSearchQuery(' Meet  Me in the Woods '), { ok: true, value: 'Meet Me in the Woods' });
  for (const raw of ['', '   ', undefined, null, ['rain'], 42, { q: 'rain' }]) {
    assert.deepEqual(readSearchQuery(raw), { ok: false, error: 'Search needs something to look for.' }, `refused: ${JSON.stringify(raw)}`);
  }
  assert.deepEqual(readSearchQuery('a'.repeat(101)), { ok: false, error: 'Search takes at most 100 letters.' });
  assert.equal(readSearchQuery('a'.repeat(100)).ok, true, 'a hundred letters is fine');
  const net = fakeNet({ spotify_search: () => json(toolAnswer([])) });
  await refusedAs(createSpotify({ fetch: net.fetcher, server, coverFile: null }).search('   '), 'spotify', 'Search needs something to look for.', 'the reader checks the words itself');
  assert.deepEqual(net.calls, [], 'and their server was never asked');
});

test('a locked worker\'s sign-in page carries the house\'s key, and an unlocked one is left alone', () => {
  const worker = 'https://spotify.example.workers.dev/mcp';
  assert.equal(signInPageOf(worker), 'https://spotify.example.workers.dev/auth');
  assert.equal(keyedAddress(worker, null), worker);
  const keyed = keyedAddress(worker, 'k3y/with+odd=chars');
  const page = new URL(signInPageOf(keyed)!);
  assert.equal(page.pathname, '/auth');
  assert.equal(page.searchParams.get('key'), 'k3y/with+odd=chars');
  assert.equal(signInPageOf(keyedAddress('https://example.com/mcp', 'k')), null, 'only a Cloudflare worker has /auth');
});

test('a lapsed sign-in on a locked worker hands the phone a sign-in link with the key on it', async () => {
  const spotify = createSpotify({
    server: () => ({ url: 'https://spotify.example.workers.dev/mcp', apiKey: 'sekrit' }),
    fetch: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'No refresh token stored. Visit /auth first.' } }), { status: 200 }),
    coverFile: null,
  });
  await assert.rejects(spotify.now(), (error: unknown) => {
    assert.ok(error instanceof SpotifyError);
    assert.equal(error.reason, 'signin');
    assert.equal(new URL(error.authUrl!).searchParams.get('key'), 'sekrit');
    return true;
  });
});
