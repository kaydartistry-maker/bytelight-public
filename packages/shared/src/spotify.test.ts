// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify in the house: the one gate both doors use before anything is played.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlayableAlbumUri, isPlayablePlaylistUri, isPlayableTrackUri } from './spotify.js';

test('a song or a playlist is played only by its own Spotify address', () => {
  assert.equal(isPlayableTrackUri('spotify:track:5googFqOqpopYdcvV22T3t'), true, 'a song from the owner playlist is playable');
  assert.equal(isPlayablePlaylistUri('spotify:playlist:1AbCdEfGhIjKlMnOpQrStU'), true, 'Sunday Mix is playable');
  assert.equal(isPlayableTrackUri('spotify:playlist:1AbCdEfGhIjKlMnOpQrStU'), false, 'a playlist is not a song');
  assert.equal(isPlayablePlaylistUri('spotify:track:5googFqOqpopYdcvV22T3t'), false, 'a song is not a playlist');
});

test('anything else is refused: other kinds, short or long ids, strange letters, links and non-strings', () => {
  const refused: unknown[] = [
    'spotify:episode:5googFqOqpopYdcvV22T3t',
    'spotify:album:5googFqOqpopYdcvV22T3t',
    'spotify:track:5googFqOqpopYdcvV22T3',
    'spotify:track:5googFqOqpopYdcvV22T3tX',
    'spotify:track:5googFqOqpopYdcvV22T3-',
    'spotify:track:5googFqOqpopYdcvV22T3t ',
    ' spotify:track:5googFqOqpopYdcvV22T3t',
    'spotify:track:5googFqOqpopYdcvV22T3t\n',
    'SPOTIFY:TRACK:5googFqOqpopYdcvV22T3t',
    'spotify:track:',
    'https://open.spotify.com/track/5googFqOqpopYdcvV22T3t',
    'spotify:track:5googFqOqpopYdcvV22T3t;spotify:track:463ahmflVo5cjEewhhbgAJ',
    '',
    null,
    undefined,
    42,
    ['spotify:track:5googFqOqpopYdcvV22T3t'],
    { uri: 'spotify:track:5googFqOqpopYdcvV22T3t' },
  ];
  for (const value of refused) {
    assert.equal(isPlayableTrackUri(value), false, `not a song: ${JSON.stringify(value)}`);
    assert.equal(isPlayablePlaylistUri(value), false, `not a playlist: ${JSON.stringify(value)}`);
  }
});

test('an album is played from only by its own Spotify address', () => {
  assert.equal(isPlayableAlbumUri('spotify:album:5googFqOqpopYdcvV22T3t'), true, 'an album is an album');
  for (const value of [
    'spotify:track:5googFqOqpopYdcvV22T3t',
    'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU',
    'spotify:album:5googFqOqpopYdcvV22T3',
    'spotify:album:5googFqOqpopYdcvV22T3t ',
    'https://open.spotify.com/album/5googFqOqpopYdcvV22T3t',
    'spotify:album:5googFqOqpopYdcvV22T3t;spotify:track:463ahmflVo5cjEewhhbgAJ',
    null,
    undefined,
    { uri: 'spotify:album:5googFqOqpopYdcvV22T3t' },
  ]) {
    assert.equal(isPlayableAlbumUri(value), false, `not an album: ${JSON.stringify(value)}`);
  }
});
