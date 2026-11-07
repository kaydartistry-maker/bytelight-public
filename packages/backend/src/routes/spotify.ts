// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify in the house: the phone's read of the owner listening, with covers, its
// presses, and since Oct 23 2026 the player, their library and their playlists.
//
// Reads (Oct 20 2026) answer the shapes in @bytelight/shared's spotify.ts. The
// presses (that afternoon: "I want to be able to play Spotify stuff")
// were play, pause and skip; the player, hearts and playlist building are at
// the bottom of this file. A
// press's body is checked before anything reaches Spotify's server, and a
// press answers { ok: true } when the server took it. Search (Oct 20 2026) is a read like the others, its words
// checked the same way. Every refusal or failure is a SpotifyProblem: one
// plain sentence the phone shows as it is.

import { Router, type Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  readCoverRequest,
  readLikeRequest,
  readMoveRequest,
  readNewPlaylistRequest,
  readPauseRequest,
  readPlayRequest,
  readRenameRequest,
  readRepeatRequest,
  readSavedQuery,
  readSearchQuery,
  readSeekRequest,
  readShuffleRequest,
  readSkipRequest,
  readTracksRequest,
  readTransferRequest,
  readVolumeRequest,
  spotify,
  SpotifyError,
  type PressRequest,
} from '../services/spotify.js';

const router = Router();
router.use(authMiddleware);

/** A playlist id as Spotify writes one. Anything else never reaches the server. */
const PLAYLIST_ID = /^[A-Za-z0-9]{1,64}$/;

const READ_FAILED = 'Spotify could not be read just now; the server log has the details.';
const PRESS_FAILED = 'Spotify could not be asked just now; the server log has the details.';

function answer(res: Response, work: () => Promise<unknown>, failed = READ_FAILED): void {
  // What is playing changes by the minute; nothing in between may keep a copy.
  res.setHeader('Cache-Control', 'no-store');
  work().then(
    (view) => { res.json(view); },
    (error: unknown) => {
      if (error instanceof SpotifyError) {
        res.status(error.reason === 'unset' ? 503 : error.reason === 'device' ? 409 : 502).json(error.toProblem());
        return;
      }
      console.error('[spotify] could not reach Spotify:', error);
      res.status(500).json({ error: failed, reason: 'unreachable' });
    },
  );
}

/** A request the house will not pass on, said plainly. */
function refuse(res: Response, error: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(400).json({ error, reason: 'spotify' });
}

router.get('/now', (_req, res) => answer(res, () => spotify().now()));
router.get('/recent', (_req, res) => answer(res, () => spotify().recent()));
router.get('/playlists', (_req, res) => answer(res, () => spotify().playlists()));
router.get('/search', (req, res) => {
  const query = readSearchQuery(req.query.q);
  if (!query.ok) {
    refuse(res, query.error);
    return;
  }
  answer(res, () => spotify().search(query.value));
});
router.get('/playlists/:id', (req, res) => {
  const { id } = req.params;
  if (!PLAYLIST_ID.test(id)) {
    refuse(res, 'That is not a Spotify playlist id.');
    return;
  }
  answer(res, () => spotify().playlistTracks(id));
});

router.post('/play', (req, res) => {
  const request = readPlayRequest(req.body);
  if (!request.ok) {
    refuse(res, request.error);
    return;
  }
  answer(res, () => spotify().play(request.value), PRESS_FAILED);
});
router.post('/pause', (req, res) => {
  const request = readPauseRequest(req.body);
  if (!request.ok) {
    refuse(res, request.error);
    return;
  }
  answer(res, () => spotify().pause(), PRESS_FAILED);
});
router.post('/skip', (req, res) => {
  const request = readSkipRequest(req.body);
  if (!request.ok) {
    refuse(res, request.error);
    return;
  }
  answer(res, () => spotify().skip(request.value), PRESS_FAILED);
});

// ── The player, their library and their playlists (Oct 23 2026).
// Every body is checked the same way as play's before anything reaches the owner
// server, and a playlist id is checked like the read's.

/** A press whose body is read by `read`, then handed to `work`. */
function pressWith<T>(read: (body: unknown) => PressRequest<T>, work: (value: T, id: string) => Promise<unknown>) {
  return (req: import('express').Request, res: Response) => {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    if (req.params.id !== undefined && !PLAYLIST_ID.test(id)) {
      refuse(res, 'That is not a Spotify playlist id.');
      return;
    }
    const request = read(req.body);
    if (!request.ok) {
      refuse(res, request.error);
      return;
    }
    answer(res, () => work(request.value, id), PRESS_FAILED);
  };
}

router.get('/connect', (_req, res) => answer(res, () => spotify().connectInfo()));
router.get('/player', (_req, res) => answer(res, () => spotify().player()));
router.get('/devices', (_req, res) => answer(res, () => spotify().devices()));
router.get('/liked', (_req, res) => answer(res, () => spotify().liked()));
router.get('/saved', (req, res) => {
  const uris = readSavedQuery(req.query.uris);
  if (!uris.ok) {
    refuse(res, uris.error);
    return;
  }
  answer(res, () => spotify().saved(uris.value));
});

router.post('/like', pressWith(readLikeRequest, ({ uri, liked }) => spotify().like(uri, liked)));
router.post('/shuffle', pressWith(readShuffleRequest, (on) => spotify().shuffle(on)));
router.post('/repeat', pressWith(readRepeatRequest, (mode) => spotify().repeat(mode)));
router.post('/volume', pressWith(readVolumeRequest, (percent) => spotify().volume(percent)));
router.post('/seek', pressWith(readSeekRequest, (positionMs) => spotify().seek(positionMs)));
router.post('/transfer', pressWith(readTransferRequest, (deviceId) => spotify().transfer(deviceId)));

router.post('/playlists', pressWith(readNewPlaylistRequest, (request) => spotify().createPlaylist(request)));
router.patch('/playlists/:id', pressWith(readRenameRequest, (request, id) => spotify().renamePlaylist(id, request)));
router.post('/playlists/:id/add', pressWith(readTracksRequest, (uris, id) => spotify().addToPlaylist(id, uris)));
router.post('/playlists/:id/remove', pressWith(readTracksRequest, (uris, id) => spotify().removeFromPlaylist(id, uris)));
router.post('/playlists/:id/move', pressWith(readMoveRequest, (move, id) => spotify().moveInPlaylist(id, move)));
router.put('/playlists/:id/cover', pressWith(readCoverRequest, (image, id) => spotify().setPlaylistCover(id, image)));

export default router;
