# Spotify worker upgrade list

What the phone's Spotify app (ported from Aerie) asks the operator's Spotify MCP worker
("Jukebox") to do, next to what that worker has today, so you know what
to add. Nothing in the worker was changed. Aerie's own worker
(`workers/spotify-mcp/index.js`, which says version 1.1.1) has every tool below.

Which server the app uses: set `integrations.spotify_server: "Jukebox"`
in `bytelight.yaml` (its id from Integrations > MCP works too). Unset, the app
picks the first switched-on MCP server with "spotify" in its name or address.

## Tools the app calls, and whether Jukebox has them

Jukebox's list was read from the tools this session can see on Oct 24 2026.

| Tool | Used for | Jukebox |
|---|---|---|
| spotify_now_playing | What is playing | has it |
| spotify_recently_played | The recent row (`limit`) | has it |
| spotify_get_playlists | The playlist grid (`limit`, `offset`) | has it, but see note 2 |
| spotify_get_playlist_tracks | A playlist's songs (`playlist_id`, `limit`, `offset`) | has it |
| spotify_search | Search (`query`, `type: track`, `limit`) | has it |
| spotify_play | Play a song, a playlist, an album, or carry on | has it, but see note 1 |
| spotify_pause | Pause | has it |
| spotify_skip | Next or previous (`direction`) | has it |
| spotify_create_playlist | New playlist (`name`, `description`, `public: false`) | has it |
| spotify_update_playlist | Rename (`playlist_id`, `name`, `description`) | has it |
| spotify_add_tracks | Add songs (`playlist_id`, `track_uris`) | has it |
| spotify_remove_tracks | Take songs out (`playlist_id`, `track_uris`) | has it |
| spotify_player_state | Shuffle, repeat, volume, where in the song, which device | **missing** |
| spotify_devices | "Where it plays" sheet | **missing** |
| spotify_transfer | Move the music to another device (`device_id`, `play: true`) | **missing** |
| spotify_shuffle | Shuffle on or off (`state: boolean`) | **missing** |
| spotify_repeat | Repeat (`state: "off" \| "track" \| "context"`) | **missing** |
| spotify_volume | Volume (`percent` 0 to 100) | **missing** |
| spotify_seek | Jump in the song (`position_ms`) | **missing** |
| spotify_saved_tracks | Liked Songs (`limit`, `offset`) | **missing** |
| spotify_is_saved | Is this song hearted (`uris: string[]`) | **missing** |
| spotify_save | Heart a song (`uris: string[]`) | **missing** |
| spotify_unsave | Take the heart off (`uris: string[]`) | **missing** |
| spotify_reorder_tracks | Move a song up or down in a playlist (`playlist_id`, `range_start`, `insert_before`, `range_length`) | **missing** |
| spotify_playlist_cover | Set a playlist's picture (`playlist_id`, `image_base64`) | **missing** |

The app never calls spotify_queue, spotify_top_tracks, spotify_top_artists or
spotify_get_recommendations. Jukebox can keep them.

## Notes

1. **spotify_play needs two more inputs: `context_uri` and `offset_uri`.**
   Jukebox's spotify_play takes only `track_uri`, `playlist_uri` and
   `device_id`. The app sends `{ context_uri, offset_uri }` when you tap a song
   inside a playlist or a song from Recently played or Search (it starts that
   playlist or album at the song), and `{ context_uri }` for an album. An old
   worker drops those inputs and just resumes whatever was playing. The Play
   button on a playlist (`playlist_uri`), pause, skip and resume work as they
   are. Aerie's version turns `context_uri` (or `playlist_uri`) into Spotify's
   `context_uri`, and `offset_uri` into `offset: { uri }`.
2. **spotify_get_playlists should say `mine: true/false` for each playlist**
   (true when you own it or it is collaborative). The app only offers "Add to a
   playlist", rename, move, take out and picture on playlists marked `mine`.
   Without it, those choices stay hidden. Playing and browsing still work.
3. **Answer shapes the app reads** (from Aerie's worker): now_playing answers
   `{ playing, track, artist, album, progress_ms, duration_ms, uri }`.
   recently_played and get_playlist_tracks rows carry `album_uri`.
   player_state answers `{ active, playing, shuffle, repeat, progress_ms,
   duration_ms, device: { id, name, type, volume_percent, supports_volume } }`,
   or `{ active: false }`. is_saved answers `{ "<uri>": true|false }`.
   create_playlist must answer the new playlist's `id`.
4. **Sign-in permissions.** Hearts and Liked Songs need `user-library-read`
   and `user-library-modify`, and playlist pictures need `ugc-image-upload`.
   Add them to the worker's scopes and sign in again at its `/auth` page. The
   app turns Spotify's "insufficient scope" error into a plain sentence with
   that sign-in page.
5. The app's `/api/spotify/connect` reads the client id off the worker's
   `/auth` redirect. Only Aerie's Android wake used it, and byte-light left the
   wake out, so nothing needs it now.
