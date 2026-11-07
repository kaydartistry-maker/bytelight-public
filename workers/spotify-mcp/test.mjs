// The worker's tools against a pretend Spotify; nothing leaves this box.
// Run: node workers/spotify-mcp/test.mjs $PWD/workers/spotify-mcp/index.js
import assert from 'node:assert/strict';
const { default: worker } = await import(process.argv[2]);
let calls = [];
let scenario = () => { throw new Error('no scenario'); };
const kv = new Map([['access_token', JSON.stringify({ access_token: 'x', expires_at: Date.now() + 3600e3 })]]);
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace('https://api.spotify.com/v1', '');
  calls.push({ method: opts.method || 'GET', path, body: opts.body, headers: opts.headers || {} });
  return scenario(path, opts);
};
const env = { SPOTIFY_KV: { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, v); } } };
async function rpc(method, params) {
  const req = new Request('https://w.example/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await worker.fetch(req, env)).json();
}
async function tool(name, args) { calls = []; return rpc('tools/call', { name, arguments: args }); }
const out = (a) => JSON.parse(a.result.content[0].text);
const ok = () => new Response(null, { status: 204 });
const json = (v) => new Response(JSON.stringify(v), { status: 200 });
const results = [];
async function check(name, fn) { try { await fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); } }
const SONG = 'spotify:track:5gmf93vJq4IFwRP5GnA6oW', SONG2 = 'spotify:track:7voqYiZoYUyEJnZWWa7d6d';

await check('version 1.2.0, recommendations gone, fourteen new tools listed', async () => {
  const init = await rpc('initialize', {});
  assert.equal(init.result.serverInfo.version, '1.2.0');
  const names = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  assert.ok(!names.includes('spotify_get_recommendations'));
  for (const n of ['spotify_reorder_tracks', 'spotify_playlist_cover', 'spotify_player_state', 'spotify_devices', 'spotify_transfer', 'spotify_shuffle', 'spotify_repeat', 'spotify_volume', 'spotify_seek', 'spotify_saved_tracks', 'spotify_save', 'spotify_unsave', 'spotify_is_saved']) assert.ok(names.includes(n), n);
});
await check('the sign-in asks for the library and picture permissions', async () => {
  const res = await worker.fetch(new Request('https://w.example/auth'), { ...env, SPOTIFY_CLIENT_ID: 'c', SPOTIFY_REDIRECT_URI: 'https://w.example/callback' });
  const scope = new URL(res.headers.get('location')).searchParams.get('scope');
  for (const s of ['user-library-read', 'user-library-modify', 'ugc-image-upload', 'playlist-modify-private']) assert.ok(scope.includes(s), s);
});
await check('reorder moves a range with PUT /items', async () => {
  scenario = () => json({ snapshot_id: 'snap' });
  const a = out(await tool('spotify_reorder_tracks', { playlist_id: 'P', range_start: 4, insert_before: 0 }));
  assert.equal(calls[0].method + ' ' + calls[0].path, 'PUT /playlists/P/items');
  assert.deepEqual(JSON.parse(calls[0].body), { range_start: 4, insert_before: 0, range_length: 1 });
  assert.equal(a.snapshot_id, 'snap');
});
await check('a cover goes up as a bare JPEG body, data URL prefix stripped', async () => {
  scenario = () => new Response(null, { status: 202 });
  await tool('spotify_playlist_cover', { playlist_id: 'P', image_base64: 'data:image/jpeg;base64,QUJD' });
  assert.equal(calls[0].method + ' ' + calls[0].path, 'PUT /playlists/P/images');
  assert.equal(calls[0].body, 'QUJD');
  assert.equal(calls[0].headers['Content-Type'], 'image/jpeg');
});
await check('a cover over 256 KB is refused before it is sent', async () => {
  scenario = () => ok();
  const a = await tool('spotify_playlist_cover', { playlist_id: 'P', image_base64: 'A'.repeat(256 * 1024 + 1) });
  assert.ok(a.error); assert.equal(calls.length, 0);
});
await check('player state reads shuffle, repeat, volume and device', async () => {
  scenario = () => json({ is_playing: true, shuffle_state: true, repeat_state: 'context', progress_ms: 1000, device: { id: 'd', name: 'phone', type: 'Smartphone', volume_percent: 60 }, item: { name: 'Rain', uri: SONG, duration_ms: 200000, artists: [{ name: 'Sleep Token' }] } });
  const a = out(await tool('spotify_player_state', {}));
  assert.deepEqual([a.active, a.playing, a.shuffle, a.repeat, a.device.volume_percent, a.track], [true, true, true, 'context', 60, 'Rain']);
});
await check('player state with nothing active says so', async () => {
  scenario = () => ok();
  assert.deepEqual(out(await tool('spotify_player_state', {})), { active: false });
});
await check('devices, transfer, shuffle, repeat, volume and seek hit the right doors', async () => {
  scenario = () => json({ devices: [{ id: 'd', name: 'phone', type: 'Smartphone', is_active: false, volume_percent: 40 }] });
  assert.equal(out(await tool('spotify_devices', {}))[0].name, 'phone');
  scenario = () => ok();
  await tool('spotify_transfer', { device_id: 'd' });
  assert.deepEqual([calls[0].method, calls[0].path, JSON.parse(calls[0].body).device_ids[0], JSON.parse(calls[0].body).play], ['PUT', '/me/player', 'd', true]);
  await tool('spotify_shuffle', { state: false }); assert.equal(calls[0].path, '/me/player/shuffle?state=false');
  await tool('spotify_repeat', { state: 'track' }); assert.equal(calls[0].path, '/me/player/repeat?state=track');
  await tool('spotify_repeat', { state: 'nonsense' }); assert.equal(calls[0].path, '/me/player/repeat?state=off');
  await tool('spotify_volume', { percent: 140 }); assert.equal(calls[0].path, '/me/player/volume?volume_percent=100');
  await tool('spotify_seek', { position_ms: 61234.6 }); assert.equal(calls[0].path, '/me/player/seek?position_ms=61235');
});
await check('liked songs read the saved list', async () => {
  scenario = () => json({ items: [{ added_at: '2026-10-01T00:00:00Z', track: { name: 'Rain', uri: SONG, artists: [{ name: 'Sleep Token' }], album: { uri: 'spotify:album:a' } } }] });
  const rows = out(await tool('spotify_saved_tracks', { limit: 500 }));
  assert.equal(calls[0].path, '/me/tracks?limit=50&offset=0');
  assert.deepEqual([rows[0].track, rows[0].album_uri, rows[0].added_at], ['Rain', 'spotify:album:a', '2026-10-01T00:00:00Z']);
});
await check('save and unsave go through /me/library with URIs, junk filtered out', async () => {
  scenario = () => ok();
  await tool('spotify_save', { uris: [SONG, 'not a uri'] });
  assert.equal(calls[0].method, 'PUT'); assert.ok(calls[0].path.startsWith('/me/library?uris=')); assert.deepEqual(JSON.parse(calls[0].body).uris, [SONG]);
  await tool('spotify_unsave', { uris: [SONG] }); assert.equal(calls[0].method, 'DELETE');
  const empty = await tool('spotify_save', { uris: ['nope'] }); assert.ok(empty.error);
});
await check('is-saved maps each URI to its answer', async () => {
  scenario = () => json([true, false]);
  const a = out(await tool('spotify_is_saved', { uris: [SONG, SONG2] }));
  assert.ok(calls[0].path.startsWith('/me/library/contains?uris='));
  assert.deepEqual(a, { [SONG]: true, [SONG2]: false });
});
await check('playlists say which are the owner\'s, and the owner id is asked once', async () => {
  kv.delete('me_id');
  scenario = (p) => p === '/me' ? json({ id: 'owner-id' }) : json({ items: [{ name: 'Slow Songs', id: '1', uri: 'u1', owner: { id: 'owner-id' }, items: { total: 4 } }, { name: 'Daily Mix', id: '2', uri: 'u2', owner: { id: 'spotify' } }] });
  const rows = out(await tool('spotify_get_playlists', {}));
  assert.deepEqual(rows.map((r) => r.mine), [true, false]);
  calls = [];
  await tool('spotify_get_playlists', {});
  assert.ok(!calls.some((c) => c.path === '/me'), 'asked for the owner id again');
});
await check('a playlist hands over its own picture, private ones included', async () => {
  scenario = (p) => p === '/me' ? json({ id: 'owner-id' }) : json({ items: [{ name: 'Road Trip', id: '9', uri: 'u9', owner: { id: 'owner-id' }, public: false, images: [{ url: 'https://image-cdn-ak.spotifycdn.com/image/big', height: 640 }, { url: 'https://x/small' }] }, { name: 'Bare', id: '8', uri: 'u8', owner: { id: 'owner-id' } }] });
  const rows = out(await tool('spotify_get_playlists', {}));
  assert.deepEqual(rows[0].images, [{ url: 'https://image-cdn-ak.spotifycdn.com/image/big' }]);
  assert.deepEqual(rows[1].images, []);
});
await check('search never asks for more than ten', async () => {
  scenario = () => json({ tracks: { items: [] } });
  await tool('spotify_search', { query: 'rain', limit: 50 });
  assert.ok(calls[0].path.includes('limit=10'), calls[0].path);
});
await check('a sign-in through /auth is kept in KV and used from then on, and the old access token dropped', async () => {
  let deleted = [];
  const env2 = { ...env, SPOTIFY_CLIENT_ID: 'c', SPOTIFY_CLIENT_SECRET: 's', SPOTIFY_REDIRECT_URI: 'https://w.example/callback', SPOTIFY_REFRESH_TOKEN: 'old-secret', SPOTIFY_KV: { ...env.SPOTIFY_KV, async delete(k) { deleted.push(k); kv.delete(k); } } };
  scenario = (p) => p.includes('accounts.spotify.com') ? json({ refresh_token: 'fresh', access_token: 'a2', expires_in: 3600 }) : ok();
  // A sign-in has to start at /auth (1.2.0): the state it leaves is what /callback checks.
  const started = await worker.fetch(new Request('https://w.example/auth'), env2);
  const state = new URL(started.headers.get('location')).searchParams.get('state');
  assert.ok(state, '/auth hands Spotify a state');
  assert.equal((await worker.fetch(new Request('https://w.example/callback?code=abc'), env2)).status, 400, 'a sign-in with no state is refused');
  const page = await worker.fetch(new Request(`https://w.example/callback?code=abc&state=${state}`), env2);
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes('fresh'), 'the token is not shown on the page');
  assert.equal(kv.get('refresh_token'), 'fresh');
  assert.ok(deleted.includes('access_token'));
  calls = [];
  scenario = (p) => p.includes('accounts.spotify.com') ? json({ access_token: 'a3', expires_in: 3600 }) : ok();
  const req = new Request('https://w.example/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spotify_pause', arguments: {} } }) });
  await worker.fetch(req, env2);
  const refresh = calls.find((c) => c.path.includes('accounts.spotify.com'));
  assert.ok(refresh && String(refresh.body).includes('refresh_token=fresh'), 'refreshed with ' + (refresh && refresh.body));
});
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
