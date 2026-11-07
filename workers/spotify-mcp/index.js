var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-read-recently-played",
  "user-top-read",
  "user-library-read",
  "user-library-modify",
  "ugc-image-upload"
].join(" ");
async function getAccessToken(env) {
  const cached = await env.SPOTIFY_KV.get("access_token");
  if (cached) {
    const data2 = JSON.parse(cached);
    if (data2.expires_at > Date.now() + 6e4) {
      return data2.access_token;
    }
  }
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + btoa(env.SPOTIFY_CLIENT_ID + ":" + env.SPOTIFY_CLIENT_SECRET)
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      // A sign-in through /auth keeps its token in KV, so signing in again (for
      // new permissions) needs no trip to the Cloudflare settings; the secret is
      // the fallback for a worker that has never been signed in that way.
      refresh_token: (await env.SPOTIFY_KV.get("refresh_token")) || env.SPOTIFY_REFRESH_TOKEN
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }
  await env.SPOTIFY_KV.put("access_token", JSON.stringify({
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1e3
  }));
  if (data.refresh_token) {
    await env.SPOTIFY_KV.put("refresh_token_backup", data.refresh_token);
    await env.SPOTIFY_KV.put("refresh_token", data.refresh_token);
  }
  return data.access_token;
}
__name(getAccessToken, "getAccessToken");
async function spotifyFetch(env, endpoint, options = {}) {
  const token = await getAccessToken(env);
  const url = endpoint.startsWith("http") ? endpoint : `https://api.spotify.com/v1${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers
    }
  });
  if (response.status === 204) return { success: true };
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Spotify API error (${response.status}): ${text}`);
  }
  if (!text) return { success: true };
  try {
    return JSON.parse(text);
  } catch (error) {
    // Spotify answers some player commands (next, previous, queue) with a 200 and a bare id
    // instead of JSON. The command worked; only a read has to be JSON to mean anything.
    if (options.method && options.method !== "GET") return { success: true };
    throw error;
  }
}
__name(spotifyFetch, "spotifyFetch");

// Pull the playable object out of a playlist row.
// Spotify renamed /tracks -> /items in Feb 2026 because a playlist can hold
// episodes as well as songs, and the wrapper key inside each row moved with it:
// { added_at, added_by, track } became { added_at, added_by, item }.
// Read `item` first, keep `track` as a fallback for anything old, and accept a
// bare object in case a future shape drops the wrapper entirely.
function rowMedia(row) {
  if (!row) return null;
  return row.item ?? row.track ?? (row.name ? row : null);
}
__name(rowMedia, "rowMedia");

// artists[0].name was sitting in four handlers waiting to throw on the first
// track with an empty artists array. One safe helper instead.
function artistNames(media) {
  return (media && Array.isArray(media.artists) ? media.artists : [])
    .map((a) => a && a.name)
    .filter(Boolean)
    .join(", ") || null;
}
__name(artistNames, "artistNames");

// The owner's own Spotify user id, so a playlist can say whether it is theirs to change.
// Since Feb 2026 only playlists the owner owns or collaborates on return their items.
async function myUserId(env) {
  const cached = await env.SPOTIFY_KV.get("me_id");
  if (cached) return cached;
  const me = await spotifyFetch(env, "/me");
  if (me && me.id) await env.SPOTIFY_KV.put("me_id", me.id);
  return (me && me.id) || null;
}
__name(myUserId, "myUserId");

// Spotify URIs for the library endpoints, which replaced /me/tracks for saving in Feb 2026.
function uriList(value) {
  return (Array.isArray(value) ? value : [value]).filter((u) => typeof u === "string" && u.startsWith("spotify:")).slice(0, 40);
}
__name(uriList, "uriList");

var TOOLS = [
  { name: "spotify_now_playing", description: "Get currently playing track", inputSchema: { type: "object", properties: {} } },
  { name: "spotify_play", description: "Start/resume playback. Give track_uri for one song, or playlist_uri / context_uri (a playlist or album) for the whole thing; add offset_uri to start that playlist or album at one of its songs", inputSchema: { type: "object", properties: { track_uri: { type: "string" }, playlist_uri: { type: "string" }, context_uri: { type: "string" }, offset_uri: { type: "string" }, device_id: { type: "string" } } } },
  { name: "spotify_pause", description: "Pause playback", inputSchema: { type: "object", properties: {} } },
  { name: "spotify_skip", description: "Skip track", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["next", "previous"], default: "next" } } } },
  { name: "spotify_queue", description: "Add track to queue", inputSchema: { type: "object", properties: { track_uri: { type: "string" } }, required: ["track_uri"] } },
  { name: "spotify_search", description: "Search Spotify", inputSchema: { type: "object", properties: { query: { type: "string" }, type: { type: "string", enum: ["track", "album", "artist", "playlist"], default: "track" }, limit: { type: "number", default: 10 } }, required: ["query"] } },
  { name: "spotify_recently_played", description: "Get recent tracks", inputSchema: { type: "object", properties: { limit: { type: "number", default: 20 } } } },
  { name: "spotify_top_tracks", description: "Get top tracks", inputSchema: { type: "object", properties: { time_range: { type: "string", enum: ["short_term", "medium_term", "long_term"], default: "medium_term" }, limit: { type: "number", default: 20 } } } },
  { name: "spotify_top_artists", description: "Get top artists", inputSchema: { type: "object", properties: { time_range: { type: "string", enum: ["short_term", "medium_term", "long_term"], default: "medium_term" }, limit: { type: "number", default: 20 } } } },
  { name: "spotify_get_playlists", description: "Get user playlists", inputSchema: { type: "object", properties: { limit: { type: "number", default: 20 }, offset: { type: "number", default: 0 } } } },
  { name: "spotify_get_playlist_tracks", description: "Get playlist tracks", inputSchema: { type: "object", properties: { playlist_id: { type: "string" }, limit: { type: "number", default: 50 }, offset: { type: "number", default: 0 } }, required: ["playlist_id"] } },
  { name: "spotify_create_playlist", description: "Create playlist", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, public: { type: "boolean", default: false } }, required: ["name"] } },
  { name: "spotify_add_tracks", description: "Add tracks to playlist", inputSchema: { type: "object", properties: { playlist_id: { type: "string" }, track_uris: { type: "array", items: { type: "string" } }, position: { type: "number" } }, required: ["playlist_id", "track_uris"] } },
  { name: "spotify_remove_tracks", description: "Remove tracks from playlist", inputSchema: { type: "object", properties: { playlist_id: { type: "string" }, track_uris: { type: "array", items: { type: "string" } } }, required: ["playlist_id", "track_uris"] } },
  { name: "spotify_update_playlist", description: "Update playlist details", inputSchema: { type: "object", properties: { playlist_id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, public: { type: "boolean" } }, required: ["playlist_id"] } },
  { name: "spotify_reorder_tracks", description: "Move songs within a playlist: the range_length songs starting at range_start go before the song now at insert_before (0-based)", inputSchema: { type: "object", properties: { playlist_id: { type: "string" }, range_start: { type: "number" }, insert_before: { type: "number" }, range_length: { type: "number", default: 1 } }, required: ["playlist_id", "range_start", "insert_before"] } },
  { name: "spotify_playlist_cover", description: "Set a playlist's picture: a base64 JPEG, 256 KB at most once encoded", inputSchema: { type: "object", properties: { playlist_id: { type: "string" }, image_base64: { type: "string" } }, required: ["playlist_id", "image_base64"] } },
  { name: "spotify_player_state", description: "What the player is doing: playing or paused, shuffle, repeat, volume, position and which device", inputSchema: { type: "object", properties: {} } },
  { name: "spotify_devices", description: "The owner's devices Spotify can play on right now", inputSchema: { type: "object", properties: {} } },
  { name: "spotify_transfer", description: "Move playback to a device (from spotify_devices)", inputSchema: { type: "object", properties: { device_id: { type: "string" }, play: { type: "boolean", default: true } }, required: ["device_id"] } },
  { name: "spotify_shuffle", description: "Shuffle on or off", inputSchema: { type: "object", properties: { state: { type: "boolean" } }, required: ["state"] } },
  { name: "spotify_repeat", description: "Repeat the song (track), the playlist or album (context), or off", inputSchema: { type: "object", properties: { state: { type: "string", enum: ["track", "context", "off"] } }, required: ["state"] } },
  { name: "spotify_volume", description: "Set the volume, 0 to 100", inputSchema: { type: "object", properties: { percent: { type: "number" } }, required: ["percent"] } },
  { name: "spotify_seek", description: "Jump to a point in the song, in milliseconds from the start", inputSchema: { type: "object", properties: { position_ms: { type: "number" } }, required: ["position_ms"] } },
  { name: "spotify_saved_tracks", description: "The owner's Liked Songs, newest first", inputSchema: { type: "object", properties: { limit: { type: "number", default: 50 }, offset: { type: "number", default: 0 } } } },
  { name: "spotify_save", description: "Heart songs (or albums) into the owner's library, by Spotify URI", inputSchema: { type: "object", properties: { uris: { type: "array", items: { type: "string" } } }, required: ["uris"] } },
  { name: "spotify_unsave", description: "Take songs (or albums) out of the owner's library, by Spotify URI", inputSchema: { type: "object", properties: { uris: { type: "array", items: { type: "string" } } }, required: ["uris"] } },
  { name: "spotify_is_saved", description: "Whether each of these Spotify URIs is in the owner's library", inputSchema: { type: "object", properties: { uris: { type: "array", items: { type: "string" } } }, required: ["uris"] } }
];
async function handleTool(name, args, env) {
  switch (name) {
    case "spotify_now_playing": {
      const data = await spotifyFetch(env, "/me/player/currently-playing");
      if (!data || !data.item) return { playing: false };
      return {
        playing: data.is_playing,
        track: data.item.name,
        artist: artistNames(data.item),
        album: data.item.album && data.item.album.name,
        progress_ms: data.progress_ms,
        duration_ms: data.item.duration_ms,
        uri: data.item.uri
      };
    }
    case "spotify_play": {
      const body = {};
      if (args.track_uri) body.uris = [args.track_uri];
      const context = args.context_uri || args.playlist_uri;
      if (context) body.context_uri = context;
      // A playlist or album started at one of its songs carries on through the rest of it.
      if (context && args.offset_uri) body.offset = { uri: args.offset_uri };
      // byte-light: an Android phone (seen 2026-10-29) takes a bare { uris: [song] } as done and then plays
      // nothing, while an album started at that song plays. So a lone song is started inside
      // its album; if the lookup fails, the bare song is sent as before.
      if (args.track_uri && !context) {
        const id = String(args.track_uri).split(":").pop();
        try {
          const t = await spotifyFetch(env, `/tracks/${encodeURIComponent(id)}`);
          if (t && t.album && t.album.uri) {
            delete body.uris;
            body.context_uri = t.album.uri;
            body.offset = { uri: args.track_uri };
          }
        } catch (_) {}
      }
      const play = (deviceId) => spotifyFetch(env, deviceId ? `/me/player/play?device_id=${encodeURIComponent(deviceId)}` : "/me/player/play", { method: "PUT", body: JSON.stringify(body) });
      try {
        await play(args.device_id);
      } catch (error) {
        // With no device named, Spotify plays only on an ACTIVE one, and a phone with the app
        // open but nothing played on it yet is available without being active. On that refusal,
        // name one of the owner's available devices (the active one, else a phone, else the first) and
        // ask once more. Nothing available at all still answers with Spotify's own refusal.
        if (args.device_id || !/NO_ACTIVE_DEVICE/.test(String(error && error.message))) throw error;
        const listed = await spotifyFetch(env, "/me/player/devices");
        const devices = (listed && Array.isArray(listed.devices) ? listed.devices : []).filter((d) => d && d.id && !d.is_restricted);
        const pick = devices.find((d) => d.is_active) || devices.find((d) => d.type === "Smartphone") || devices[0];
        if (!pick) throw error;
        await play(pick.id);
        return { success: true, device: pick.name };
      }
      return { success: true };
    }
    case "spotify_pause":
      await spotifyFetch(env, "/me/player/pause", { method: "PUT" });
      return { success: true };
    case "spotify_skip":
      const dir = args.direction === "previous" ? "previous" : "next";
      await spotifyFetch(env, `/me/player/${dir}`, { method: "POST" });
      return { success: true };
    case "spotify_queue":
      await spotifyFetch(env, `/me/player/queue?uri=${encodeURIComponent(args.track_uri)}`, { method: "POST" });
      return { success: true };
    case "spotify_search": {
      const type = args.type || "track";
      // Since Feb 2026 Spotify takes at most 10 results per search.
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 10);
      const data = await spotifyFetch(env, `/search?q=${encodeURIComponent(args.query)}&type=${type}&limit=${limit}`);
      const key = type + "s";
      return data[key]?.items || [];
    }
    case "spotify_recently_played": {
      const data = await spotifyFetch(env, `/me/player/recently-played?limit=${args.limit || 20}`);
      return (data.items || [])
        .map((i) => ({ row: i, media: rowMedia(i) }))
        .filter((x) => x.media)
        .map((x) => ({ track: x.media.name, artist: artistNames(x.media), played_at: x.row.played_at, uri: x.media.uri, album_uri: (x.media.album && x.media.album.uri) || null }));
    }
    case "spotify_top_tracks": {
      const data = await spotifyFetch(env, `/me/top/tracks?time_range=${args.time_range || "medium_term"}&limit=${args.limit || 20}`);
      return (data.items || [])
        .filter(Boolean)
        .map((t) => ({ name: t.name, artist: artistNames(t), uri: t.uri }));
    }
    case "spotify_top_artists": {
      const data = await spotifyFetch(env, `/me/top/artists?time_range=${args.time_range || "medium_term"}&limit=${args.limit || 20}`);
      return (data.items || [])
        .filter(Boolean)
        .map((a) => ({ name: a.name, genres: a.genres, uri: a.uri, id: a.id }));
    }
    case "spotify_get_playlists": {
      // FIX: p.tracks.total crashed the whole page. Verified against a raw playlist
      // object (spotify_search returns them unshaped): there is no `tracks` key any
      // more at all. The Feb 2026 rename went through THREE places, not one --
      // the endpoint tracks->items, the row wrapper track->item, and the count field
      // on the playlist object itself, tracks.total -> items.total. Read items first,
      // keep tracks as a fallback, and never let one odd row take down the page.
      const data = await spotifyFetch(env, `/me/playlists?limit=${args.limit || 20}&offset=${args.offset || 0}`);
      const me = await myUserId(env).catch(() => null);
      return (data.items || [])
        .filter(Boolean)
        .map((p) => ({ name: p.name, id: p.id, tracks: p.items?.total ?? p.tracks?.total ?? null, uri: p.uri, mine: !!(me && p.owner && p.owner.id === me) || !!p.collaborative, images: (Array.isArray(p.images) ? p.images : []).filter((i) => i && i.url).slice(0, 1).map((i) => ({ url: i.url })) }));
    }
    case "spotify_get_playlist_tracks": {
      // DO NOT change /items back to /tracks. Spotify renamed the route in Feb 2026;
      // The operator, Companion A, Companion B and Companion C spent 72 hours finding that. /items is correct.
      // FIX: the wrapper key inside each row moved with the route, track -> item, so
      // i.track was undefined on a perfectly good 200. rowMedia() reads item first.
      const data = await spotifyFetch(env, `/playlists/${args.playlist_id}/items?limit=${args.limit || 50}&offset=${args.offset || 0}`);
      return (data.items || [])
        .map(rowMedia)
        .filter(Boolean)
        .map((m) => ({ track: m.name, artist: artistNames(m), uri: m.uri, album_uri: (m.album && m.album.uri) || null, duration_ms: m.duration_ms ?? null }));
    }
    case "spotify_create_playlist": {
      const data = await spotifyFetch(env, "/me/playlists", {
        method: "POST",
        body: JSON.stringify({ name: args.name, description: args.description || "", public: args.public || false })
      });
      return { id: data.id, name: data.name, url: data.external_urls?.spotify ?? null };
    }
    case "spotify_add_tracks": {
      const uris = args.track_uris.join(",");
      const url = `https://api.spotify.com/v1/playlists/${args.playlist_id}/items?uris=${encodeURIComponent(uris)}`;
      const token = await getAccessToken(env);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Spotify API error (${response.status}): ${text}`);
      return JSON.parse(text);
    }
    case "spotify_remove_tracks": {
      await spotifyFetch(env, `/playlists/${args.playlist_id}/items`, {
        method: "DELETE",
        body: JSON.stringify({ tracks: args.track_uris.map((uri) => ({ uri })) })
      });
      return { success: true };
    }
    case "spotify_update_playlist": {
      const body = {};
      if (args.name) body.name = args.name;
      if (args.description !== void 0) body.description = args.description;
      if (args.public !== void 0) body.public = args.public;
      await spotifyFetch(env, `/playlists/${args.playlist_id}`, { method: "PUT", body: JSON.stringify(body) });
      return { success: true };
    }
    case "spotify_reorder_tracks": {
      const body = { range_start: Number(args.range_start), insert_before: Number(args.insert_before), range_length: Number(args.range_length) || 1 };
      const data = await spotifyFetch(env, `/playlists/${args.playlist_id}/items`, { method: "PUT", body: JSON.stringify(body) });
      return { success: true, snapshot_id: data && data.snapshot_id || null };
    }
    case "spotify_playlist_cover": {
      const image = String(args.image_base64 || "").replace(/^data:image\/jpeg;base64,/, "");
      if (!image) throw new Error("image_base64 is empty");
      if (image.length > 256 * 1024) throw new Error("The picture is over Spotify's 256 KB limit once encoded");
      await spotifyFetch(env, `/playlists/${args.playlist_id}/images`, { method: "PUT", body: image, headers: { "Content-Type": "image/jpeg" } });
      return { success: true };
    }
    case "spotify_player_state": {
      const data = await spotifyFetch(env, "/me/player");
      if (!data || !data.device) return { active: false };
      const item = data.item;
      return {
        active: true,
        playing: !!data.is_playing,
        shuffle: !!data.shuffle_state,
        repeat: data.repeat_state || "off",
        progress_ms: data.progress_ms ?? null,
        device: { id: data.device.id, name: data.device.name, type: data.device.type, volume_percent: data.device.volume_percent ?? null, supports_volume: data.device.supports_volume !== false },
        track: item ? item.name : null,
        artist: item ? artistNames(item) : null,
        uri: item ? item.uri : null,
        duration_ms: item ? item.duration_ms : null
      };
    }
    case "spotify_devices": {
      const data = await spotifyFetch(env, "/me/player/devices");
      return (data && Array.isArray(data.devices) ? data.devices : [])
        .filter(Boolean)
        .map((d) => ({ id: d.id, name: d.name, type: d.type, is_active: !!d.is_active, volume_percent: d.volume_percent ?? null, restricted: !!d.is_restricted }));
    }
    case "spotify_transfer": {
      if (!args.device_id) throw new Error("device_id is required");
      await spotifyFetch(env, "/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [args.device_id], play: args.play !== false }) });
      return { success: true };
    }
    case "spotify_shuffle": {
      await spotifyFetch(env, `/me/player/shuffle?state=${args.state ? "true" : "false"}`, { method: "PUT" });
      return { success: true, shuffle: !!args.state };
    }
    case "spotify_repeat": {
      const state = ["track", "context", "off"].includes(args.state) ? args.state : "off";
      await spotifyFetch(env, `/me/player/repeat?state=${state}`, { method: "PUT" });
      return { success: true, repeat: state };
    }
    case "spotify_volume": {
      const percent = Math.min(100, Math.max(0, Math.round(Number(args.percent) || 0)));
      await spotifyFetch(env, `/me/player/volume?volume_percent=${percent}`, { method: "PUT" });
      return { success: true, volume_percent: percent };
    }
    case "spotify_seek": {
      const position = Math.max(0, Math.round(Number(args.position_ms) || 0));
      await spotifyFetch(env, `/me/player/seek?position_ms=${position}`, { method: "PUT" });
      return { success: true, position_ms: position };
    }
    case "spotify_saved_tracks": {
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 50);
      const data = await spotifyFetch(env, `/me/tracks?limit=${limit}&offset=${Number(args.offset) || 0}`);
      return (data.items || [])
        .map((row) => ({ row, media: rowMedia(row) }))
        .filter((x) => x.media)
        .map((x) => ({ track: x.media.name, artist: artistNames(x.media), uri: x.media.uri, album_uri: (x.media.album && x.media.album.uri) || null, added_at: x.row.added_at || null }));
    }
    case "spotify_save":
    case "spotify_unsave": {
      const uris = uriList(args.uris);
      if (!uris.length) throw new Error("No Spotify URIs given");
      await spotifyFetch(env, `/me/library?uris=${encodeURIComponent(uris.join(","))}`, { method: name === "spotify_save" ? "PUT" : "DELETE", body: JSON.stringify({ uris }) });
      return { success: true, saved: name === "spotify_save", uris };
    }
    case "spotify_is_saved": {
      const uris = uriList(args.uris);
      if (!uris.length) return {};
      const data = await spotifyFetch(env, `/me/library/contains?uris=${encodeURIComponent(uris.join(","))}`);
      const answers = Array.isArray(data) ? data : [];
      return Object.fromEntries(uris.map((u, i) => [u, !!answers[i]]));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
__name(handleTool, "handleTool");
async function handleMCP(request, env) {
  const body = await request.json();
  // A notification (no id) gets no JSON-RPC answer at all: the transport says
  // 202 with an empty body. Codex's MCP client quit on this worker when its
  // initialized notification came back as an error object with no id.
  if (body.id === void 0 || body.id === null) return null;
  if (body.method === "initialize") {
    return { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "spotify-mcp", version: "1.2.0" } } };
  }
  if (body.method === "tools/list") {
    return { jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } };
  }
  if (body.method === "tools/call") {
    try {
      const result = await handleTool(body.params.name, body.params.arguments || {}, env);
      return { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
    } catch (error) {
      return { jsonrpc: "2.0", id: body.id, error: { code: -32e3, message: error.message } };
    }
  }
  return { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } };
}
__name(handleMCP, "handleMCP");
// The lock (1.2.0). With no
// MCP_SECRET set the worker answers anyone who has its address, the way it
// always has. With MCP_SECRET set, /mcp needs it as an Authorization: Bearer
// header or ?key= on the address, and so does /auth, because whoever opens
// /auth can sign their own Spotify in over the owner's. /auth also leaves a
// one-time state in KV for ten minutes, and /callback refuses any sign-in that
// does not hand that state back, so a link nobody started here goes nowhere.
function sameKey(given, expected) {
  if (typeof given !== "string" || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
__name(sameKey, "sameKey");
function isUnlocked(request, url, env) {
  const secret = env.MCP_SECRET;
  if (!secret) return true;
  if (request.method === "OPTIONS") return true;
  const bearer = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return sameKey(bearer ? bearer[1].trim() : "", secret) || sameKey(url.searchParams.get("key"), secret);
}
__name(isUnlocked, "isUnlocked");
var STATE_SECONDS = 600;
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.pathname === "/mcp" || url.pathname === "/auth") && !isUnlocked(request, url, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
    if (url.pathname === "/auth") {
      const state = crypto.randomUUID();
      await env.SPOTIFY_KV.put(`auth_state:${state}`, "1", { expirationTtl: STATE_SECONDS });
      const authUrl = new URL("https://accounts.spotify.com/authorize");
      authUrl.searchParams.set("client_id", env.SPOTIFY_CLIENT_ID);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", env.SPOTIFY_REDIRECT_URI);
      authUrl.searchParams.set("scope", SCOPES);
      authUrl.searchParams.set("state", state);
      return Response.redirect(authUrl.toString(), 302);
    }
    if (url.pathname === "/callback") {
      const state = url.searchParams.get("state") || "";
      const known = state ? await env.SPOTIFY_KV.get(`auth_state:${state}`) : null;
      if (!known) return new Response("This sign-in did not start here, or it took longer than ten minutes. Open the sign-in link again.", { status: 400 });
      await env.SPOTIFY_KV.delete(`auth_state:${state}`);
      const code = url.searchParams.get("code");
      if (!code) return new Response("No code provided", { status: 400 });
      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": "Basic " + btoa(env.SPOTIFY_CLIENT_ID + ":" + env.SPOTIFY_CLIENT_SECRET)
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: env.SPOTIFY_REDIRECT_URI
        })
      });
      const data = await response.json();
      if (!response.ok) return new Response(JSON.stringify(data), { status: 400 });
      // Keep the new sign-in here, and drop the old access token so the
      // permissions just granted apply from the next call.
      if (data.refresh_token) {
        await env.SPOTIFY_KV.put("refresh_token", data.refresh_token);
        await env.SPOTIFY_KV.delete("access_token");
        return new Response(`<h1>Signed in.</h1><p>Spotify is connected again, with every permission. You can close this page.</p>`, { headers: { "Content-Type": "text/html" } });
      }
      return new Response("Spotify signed in but sent no refresh token. Try /auth again.", { status: 400 });
    }
    if (url.pathname === "/mcp") {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "*" } });
      }
      // byte-light: no SSE stream on GET; say so instead of failing to parse a body.
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { "Allow": "POST, OPTIONS", "Access-Control-Allow-Origin": "*" } });
      }
      const result = await handleMCP(request, env);
      if (result === null) return new Response(null, { status: 202, headers: { "Access-Control-Allow-Origin": "*" } });
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
    // byte-light: anything else is a 404, as on the worker this replaced. A 200 here
    // makes claude.ai's connector read its OAuth discovery probes as a sign-in
    // service and fail to register with it.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Spotify MCP - Use /auth to authorize, /mcp for MCP calls", { status: 200 });
    }
    return new Response("Not found", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
  }
};
export {
  index_default as default
};
