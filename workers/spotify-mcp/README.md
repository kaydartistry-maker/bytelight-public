# Spotify MCP worker

The MCP server the house and the lanes use to read and drive Spotify:
now playing, play, pause, skip, queue, search, recent, top tracks and
artists, recommendations, playlists read and written.

Base code built by Kay (https://github.com/kaydartistry-maker/Spotify-MCP)
and modified to be used in the app.

index.js is the whole worker, one file (the version in `initialize` says
which one is running; this worker has no BUILD marker).

## Setting it up

1. In Spotify's developer dashboard (developer.spotify.com/dashboard), create
   an app. Its redirect URI is your worker's address plus `/callback`, for
   example `https://spotify-mcp.<your-subdomain>.workers.dev/callback`.
2. Deploy this folder as a Cloudflare worker (the steps are at the top of
   `wrangler.toml`, or paste `index.js` into the dashboard), with a KV namespace
   bound as `SPOTIFY_KV` and three secrets: `SPOTIFY_CLIENT_ID` and
   `SPOTIFY_CLIENT_SECRET` from the dashboard, and `SPOTIFY_REDIRECT_URI`, the
   same redirect as step 1.
3. Open `/auth` on the worker once and say yes. The sign-in is kept in the
   worker's KV, so if it ever lapses, opening `/auth` again is the whole fix.
4. In Bytelight, add the worker's `/mcp` address under Integrations > MCP. Any name
   with "spotify" in it (or in the address) is how the Spotify app finds it.

## Locking it

Out of the box the worker answers anyone who has its address: they could
play, read your listening history and edit your playlists, and anyone who
opened `/auth` could sign their own Spotify in over yours. Set one more
secret, `MCP_SECRET`, to any long random string, and from then on:

- `/mcp` answers 401 unless a call carries the key, as an
  `Authorization: Bearer <key>` header or as `?key=<key>` on the address.
- `/auth` needs the key too (`/auth?key=<key>`), and it leaves a one-time
  state that Spotify hands back to `/callback`. A sign-in that did not start
  at your own `/auth`, or took longer than ten minutes, is refused.

Then give the key to everything that calls the worker:

- In Bytelight, put it in the Spotify server's API key field under
  Integrations > MCP. The house sends it with every call and carries it onto
  the sign-in link the Spotify app shows you.
- A Claude Code lane's `.mcp.json`: add
  `"headers": {"Authorization": "Bearer <key>"}` to the Spotify entry.
- Codex (`~/.codex/config.toml`): add
  `http_headers = { "Authorization" = "Bearer <key>" }` under the Spotify
  server.
- A claude.ai connector, or any app that only takes an address: use the
  address with `?key=<key>` on the end.

With `MCP_SECRET` unset nothing changes, so you can deploy first and lock
when every caller has the key.

To let the Android app wake Spotify on the phone when it is closed, add your
app to the same Spotify app's settings as an Android package: its package name
(the `applicationId` in `packages/phone/android/app/build.gradle`) and the SHA1
fingerprint of the key your APK is signed with. The phone reads the client id
and redirect off the worker's `/auth` page, so there is nothing else to set.
Spotify has to be installed and signed in on the phone, and the first wake may
show Spotify's own consent screen.

What changed from the base code:

- Playlist rows are read from `item`, falling back to `track`, and the count
  from `items.total`: the same Spotify change reached the shape of the rows
  as well as the endpoint. Artist names and lists are read null-safe. Do not
  revert any of it.
- `spotify_play` with no device named, on NO_ACTIVE_DEVICE, lists
  `/me/player/devices`, picks the active one, else a phone, else the first,
  and asks once more. A named device is never swapped. (Oct 20 2026)
- A player command whose 2xx answer is not JSON counts as done; a read still
  has to be JSON. (Oct 20 2026)
- `spotify_play` takes `context_uri` and `offset_uri` (start a playlist or
  album at one of its songs); recent rows carry `album_uri`. (Oct 20 2026)
- A JSON-RPC notification gets 202 with an empty body instead of an error
  object with no id, which Codex's MCP client quit on. (Oct 23 2026)

- v1.1.0 (Oct 23 2026): hearting songs (`spotify_save`, `spotify_unsave`,
  `spotify_is_saved`, through Spotify's Feb 2026 `/me/library`) and Liked
  Songs (`spotify_saved_tracks`); shuffle, repeat, volume, seek; devices and
  transfer; `spotify_player_state`; moving songs within a playlist; a
  playlist picture. Playlists say `mine`. Search asks for ten at most, the
  Feb 2026 cap. `spotify_get_recommendations` is gone: Spotify answers 404.
- A sign-in through `/auth` is kept in KV and used from then on, so signing
  in again is open `/auth`, say yes, close the page; the
  `SPOTIFY_REFRESH_TOKEN` secret is only the fallback.

- v1.2.0: the lock (see Locking it): `MCP_SECRET` gates `/mcp` and `/auth`,
  and `/auth` leaves a one-time state in KV that `/callback` checks.

`test.mjs` runs every new tool against a pretend Spotify.

Bindings: KV `SPOTIFY_KV`; secrets `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, `SPOTIFY_REFRESH_TOKEN`, and
`MCP_SECRET` once it is locked. When the sign-in lapses, open `/auth` on the
worker (with `?key=` once it is locked), say yes, and put the
token it shows into the worker's `SPOTIFY_REFRESH_TOKEN` on Cloudflare.

Deploying: read the live code and settings first and keep a copy, upload
with `keep_bindings: ["secret_text"]`, bump the version in `initialize`,
then read back the settings, the live code and the front door.

## Bytelight's changes to this file

This is Aerie's worker 1.2.0, with three changes. Each one is marked
`byte-light:` in index.js:

- Any address the worker doesn't know answers 404 (Aerie's answers 200).
  With a 200, claude.ai's connector takes its sign-in discovery probes as a
  sign-in service and fails with "Couldn't register with ... sign-in service".
- `GET /mcp` answers 405 instead of failing to read a body.
- A single song (`track_uri` with no `context_uri`) is started inside its
  album at that song. An Android phone (seen 2026-10-29) accepts a bare `{ uris: [song] }`
  and then plays nothing, while an album started at a song plays.

Deployed through Cloudflare's API with the bindings it already had
(`SPOTIFY_KV`, the Spotify secrets, `MCP_SECRET`), plus `SPOTIFY_REDIRECT_URI`
as plain text.
