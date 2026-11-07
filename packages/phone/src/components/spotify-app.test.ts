// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Spotify app: its promises read off the source, and its three states
// rendered on the server (playing with covers, nothing playing, and the old
// house that needs a restart), the way the phone would draw them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchSection, SpotifyHomeView, PlaylistView, type PressState } from './spotify/SpotifyViews';
import { THEMES } from '../lib/theme';
import type { SpotifyHome } from '../lib/spotify';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('./SpotifyApp.tsx');
const views = read('./spotify/SpotifyViews.tsx');
const colors = THEMES['monochrome'].dark;
const noop = () => {};

const LISTS = { ok: true as const, data: { playlists: [
  { id: '1AbCdEfGhIjKlMnOpQrStU', name: 'Sunday Mix', tracks: 5, uri: 'spotify:playlist:1AbCdEfGhIjKlMnOpQrStU', cover: 'https://mosaic.scdn.co/300/wedding' },
  { id: '2VwXyZaBcDeFgHiJkLmNoP', name: 'Late Night', tracks: 1, uri: null, cover: null },
] } };
const RECENT = { ok: true as const, data: { tracks: [
  { name: 'MY HEAD', artist: 'Layto', uri: 'spotify:track:7q', cover: 'https://i.scdn.co/image/myhead', playedAt: null },
] } };

function render(home: SpotifyHome | null): string {
  return renderToStaticMarkup(createElement(SpotifyHomeView, { home, colors, onOpenPlaylist: noop, onOpenLink: noop }));
}

test('playing: the cover big (the 640 picture, the 300 one behind it), the song and artist under it, recent covers and the playlist grid', () => {
  const html = render({
    now: { ok: true, data: { playing: true, track: { name: 'Beauty', artist: 'Layto', uri: 'spotify:track:4', cover: 'https://i.scdn.co/image/ab67616d00001e02beauty', album: 'Beauty' } } },
    recent: RECENT,
    playlists: LISTS,
  });
  assert.match(html, />Playing now</);
  assert.match(html, /src="https:\/\/i\.scdn\.co\/image\/ab67616d0000b273beauty"/, 'the big cover asks for the big picture');
  assert.match(html, />Beauty</);
  assert.match(html, />Layto</);
  assert.ok(!/>Beauty<\/div><div[^>]*>Layto<\/div><div[^>]*>Beauty</.test(html), 'an album named like its song is not said twice');
  assert.match(html, />Recently played</);
  assert.match(html, /src="https:\/\/i\.scdn\.co\/image\/myhead"/);
  assert.match(html, />MY HEAD</);
  assert.match(html, />Playlists</);
  assert.match(html, /src="https:\/\/mosaic\.scdn\.co\/300\/wedding"/);
  assert.match(html, />Sunday Mix</);
  assert.match(html, />5 songs</);
  assert.match(html, />1 song</);
  const covers = html.match(/<img\b[^>]*>/g) ?? [];
  assert.equal(covers.length, 3, `three covers drawn: ${covers.join(' ')}`);
  assert.ok(covers.every((tag) => /referrerpolicy="no-referrer"/i.test(tag)), `every cover goes without the owner address: ${covers.join(' ')}`);
});

test('nothing playing: one plain line where the cover would be, and the rest of the page still there', () => {
  const html = render({ now: { ok: true, data: { playing: false, track: null } }, recent: RECENT, playlists: LISTS });
  assert.match(html, />Nothing is playing right now\.</);
  assert.match(html, />Sunday Mix</);
});

test('the old house: only the restart line, said once', () => {
  const restart = { ok: false as const, trouble: { kind: 'restart' as const } };
  const html = render({ now: restart, recent: restart, playlists: restart });
  assert.equal((html.match(/Spotify needs the house restarted once\./g) ?? []).length, 1);
  assert.ok(!html.includes('Playlists'), 'nothing else is drawn');
  assert.match(render(null), />Loading…</);
});

test('a lapsed sign-in shows its sentence and a way to the sign-in page', () => {
  const lapsed = { ok: false as const, trouble: { kind: 'signin' as const, message: 'Lapsed, in a sentence.', authUrl: 'https://example.workers.dev/auth' } };
  const html = render({ now: lapsed, recent: lapsed, playlists: lapsed });
  assert.equal((html.match(/Lapsed, in a sentence\./g) ?? []).length, 1);
  assert.match(html, />Open the sign-in page</);
});

test('a playlist opens to every song with its own cover', () => {
  const html = renderToStaticMarkup(createElement(PlaylistView, {
    playlist: LISTS.data.playlists[0],
    read: { ok: true, data: { id: '1AbCdEfGhIjKlMnOpQrStU', tracks: [
      { name: 'Villain', artist: 'MISSIO', uri: 'spotify:track:v', cover: 'https://i.scdn.co/image/villain' },
      { name: 'No Picture', artist: '', uri: null, cover: null },
    ] } },
    colors,
    onOpenLink: noop,
  }));
  assert.match(html, />Sunday Mix</);
  assert.match(html, />2 songs</);
  assert.match(html, /src="https:\/\/i\.scdn\.co\/image\/villain"/);
  assert.match(html, />Villain</);
  assert.match(html, />No Picture</);
});

test('back steps out one level: the playlist, then the app', () => {
  assert.match(app, /useBackHandler\(openList !== null, closePlaylist\)/);
  assert.match(app, /onClose=\{handleBack\}/);
});

test('it plays only through the house: no timer, nothing queued, no volume, no seeking', () => {
  const lib = read('../lib/spotify.ts');
  for (const [file, source] of [['SpotifyApp.tsx', app], ['SpotifyViews.tsx', views], ['lib/spotify.ts', lib]] as const) {
    assert.doesNotMatch(source, /setInterval|spotify_(?:play|pause|skip|queue)/, `${file} has no timer and never names a Spotify tool`);
    assert.doesNotMatch(source, /spotify\/(?:queue|volume|seek)|volume_percent|position_ms|kind: '(?:queue|volume|seek)'/, `${file} has no queue, volume or seeking`);
  }
  for (const [file, source] of [['SpotifyApp.tsx', app], ['SpotifyViews.tsx', views]] as const) {
    assert.doesNotMatch(source, /backdrop-blur|backdrop-filter|backdropFilter/, `${file} blurs nothing`);
    assert.doesNotMatch(source, /color-mix\(in srgb|hsla?\(/, `${file} mixes no color outside OKLCH`);
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b/i, `${file} carries no fixed hex colors`);
  }
  assert.match(app, /loadSpotifyHome\(apiFetch\)/, 'the front page reads through the house');
  assert.match(app, /loadSpotifyPlaylist\(apiFetch, id\)/, 'a playlist reads through the house');
  assert.match(app, /createSpotifyNow\(apiFetch, \{ wake: wakeSpotify \}\)/, 'what is playing and every press go through the house, by the keeper the lock screen shares');
  assert.match(app, /onPress: \(what, where\) => void spotify\.press\(what, where\)/, 'a press goes through the keeper');
  assert.match(lib, /pressAndLook\(fetcher, what, before/, 'the keeper presses, and reads what is playing after it');
  assert.match(lib, /if \(out\) return;/, 'one press at a time');
  assert.match(views, /const play = songPress\(song\);/, 'a recent song starts its album at that song');
  assert.match(views, /const play = songPress\(track, playlistUri\);/, 'a song in a list starts its playlist (or its album) at that song');
  assert.match(views, /playlistUri=\{listUri\}/, 'a playlist hands its own address to its songs');
  assert.equal((views.match(/onPress\?\.\(play, where\)/g) ?? []).length, 2, 'both kinds of song row press what songPress decided');
  assert.match(app, /searchSpotify\(apiFetch, words\)/, 'a search reads through the house');
  assert.doesNotMatch(app, /onChange=\{[^}]*searchSpotify/, 'and never as the owner types');
  assert.match(views, /onPress\?\.\(\{ kind: 'playlist', uri: listUri, songs \}, 'playlist'\)/, 'the Play button plays its own playlist');
});

const SONG = 'spotify:track:5googFqOqpopYdcvV22T3t';
const OTHER = 'spotify:track:463ahmflVo5cjEewhhbgAJ';
const EPISODE = 'spotify:episode:5googFqOqpopYdcvV22T3t';
const NOWHERE = 'Open Spotify on your phone first, then try again.';
const ready: PressState = { pressing: null, notice: null, onPress: noop };
const times = (html: string, words: string) => html.split(words).length - 1;

/** Every press button in the markup: the ones whose label says what they do. */
const pressButtons = (html: string) =>
  (html.match(/<button\b[^>]*>/g) ?? []).filter((tag) => /aria-label="(?:Play|Pause|Previous song|Next song)\b/.test(tag));

function playingHome(playing: boolean, press: PressState): string {
  return renderToStaticMarkup(createElement(SpotifyHomeView, {
    home: {
      now: { ok: true, data: { playing, track: { name: 'Beauty', artist: 'Layto', uri: SONG, cover: null, album: null } } },
      recent: { ok: true, data: { tracks: [
        { name: 'Beauty', artist: 'Layto', uri: SONG, cover: null, playedAt: null },
        { name: 'MY HEAD', artist: 'Layto', uri: OTHER, cover: null, playedAt: null },
        { name: 'An Episode', artist: '', uri: EPISODE, cover: null, playedAt: null },
      ] } },
      playlists: LISTS,
    },
    colors,
    onOpenPlaylist: noop,
    onOpenLink: noop,
    press,
  }));
}

function weddingSongs(press: PressState, nowUri: string | null = null): string {
  return renderToStaticMarkup(createElement(PlaylistView, {
    playlist: LISTS.data.playlists[0],
    read: { ok: true, data: { id: '1AbCdEfGhIjKlMnOpQrStU', tracks: [
      { name: 'Villain', artist: 'MISSIO', uri: SONG, cover: null },
      { name: 'No Picture', artist: '', uri: null, cover: null },
      { name: 'An Episode', artist: '', uri: EPISODE, cover: null },
      { name: 'Beauty', artist: 'Layto', uri: OTHER, cover: null },
    ] } },
    colors,
    onOpenLink: noop,
    press,
    nowUri,
  }));
}

test('playing: previous, pause and next under the song, and a recent song is a tap that plays it', () => {
  const html = playingHome(true, ready);
  for (const label of ['Previous song', 'Pause', 'Next song', 'Play Beauty', 'Play MY HEAD']) {
    assert.match(html, new RegExp(`<button[^>]*aria-label="${label}"`), `a button: ${label}`);
  }
  assert.doesNotMatch(html, /aria-label="Play An Episode"/, 'an episode is not offered as a tap');
  assert.doesNotMatch(html, /aria-label="Play"/, 'playing, the middle button pauses');
  const tags = pressButtons(html);
  assert.equal(tags.length, 5, `five press buttons: ${tags.join(' ')}`);
  assert.ok(tags.every((tag) => !/\bdisabled=""/.test(tag)), `none waits while nothing is out: ${tags.join(' ')}`);
  assert.match(html, /aria-label="Pause"[^>]*style="background:var\(--bytelight-selected-fill, var\(--bytelight-accent\)\);color:var\(--bytelight-on-accent\)"/,
    'the middle button wears the selected fill and its ink');
  assert.equal(times(html, 'aria-label="Playing now"'), 1, 'the song playing is marked in the recent row, once');
  assert.match(html, /aria-label="Play Beauty"(?:(?!<\/button>).)*aria-label="Playing now"/, 'on its own cover');
});

test('paused: the middle button plays, and nothing is marked as playing', () => {
  const html = playingHome(false, ready);
  assert.match(html, /<button[^>]*aria-label="Play"/, 'paused, the middle button plays');
  assert.doesNotMatch(html, /aria-label="Pause"/, 'and there is no pause');
  assert.doesNotMatch(html, /aria-label="Playing now"/, 'a paused song is not marked as playing');
});

test('while a press is out every press button waits, and only the pressed one turns', () => {
  const html = playingHome(true, { ...ready, pressing: 'now:next' });
  const tags = pressButtons(html);
  assert.equal(tags.length, 5, `five press buttons: ${tags.join(' ')}`);
  assert.ok(tags.every((tag) => /\bdisabled=""/.test(tag)), `every one waits: ${tags.join(' ')}`);
  assert.equal(times(html, 'animate-spin'), 1, 'one turns');
  assert.match(html, /aria-label="Next song"(?:(?!<\/button>).)*animate-spin/, 'the one the owner pressed');
  const looking = playingHome(true, { pressing: null, notice: null });
  assert.ok(pressButtons(looking).every((tag) => /\bdisabled=""/.test(tag)), 'drawn with nothing to press with, every button waits');
});

test('a playlist has a Play button, a tap on a song plays it, and the song playing is marked', () => {
  const html = weddingSongs(ready, OTHER);
  assert.match(html, /<button[^>]*aria-label="Play Sunday Mix"[^>]*style="background:var\(--bytelight-selected-fill, var\(--bytelight-accent\)\);color:var\(--bytelight-on-accent\)"/,
    'the playlist has its Play button, in the selected fill');
  assert.match(html, /<button[^>]*aria-label="Play Villain"/, 'a song is a tap');
  assert.match(html, /<button[^>]*aria-label="Play Beauty"/, 'so is every song');
  assert.doesNotMatch(html, /aria-label="Play No Picture"/, 'but not a song with no address');
  assert.doesNotMatch(html, /aria-label="Play An Episode"/, 'nor an episode');
  assert.equal(times(html, 'aria-label="Playing now"'), 1, 'the song playing is marked, once');
  assert.match(html, /aria-label="Play Beauty"(?:(?!<\/button>).)*aria-label="Playing now"/, 'on its own row');
  const tray = renderToStaticMarkup(createElement(PlaylistView, {
    playlist: { ...LISTS.data.playlists[1], id: 'abc' }, read: null, colors, onOpenLink: noop, press: ready,
  }));
  assert.doesNotMatch(tray, /aria-label="Play /, 'a playlist the house would not pass on has no Play button');
});

test("a press's sentence is shown by the button that made it, once", () => {
  const notice = (where: string): PressState => ({ ...ready, notice: { where, trouble: { kind: 'problem', message: NOWHERE } } });
  const first = weddingSongs(notice('song:0'));
  assert.equal(times(first, NOWHERE), 1, 'once, for a song');
  const at = first.indexOf(NOWHERE);
  assert.ok(at > first.indexOf('aria-label="Play Villain"') && at < first.indexOf('aria-label="Play Beauty"'), 'under the song the owner pressed, not another');
  const byList = weddingSongs(notice('playlist'));
  assert.equal(times(byList, NOWHERE), 1, 'once, for the playlist');
  assert.ok(byList.indexOf(NOWHERE) < byList.indexOf('aria-label="Play Villain"'), 'by the Play button, above the songs');
  const recent = playingHome(true, notice('recent:1'));
  assert.equal(times(recent, NOWHERE), 1, 'once, for a recent song');
  assert.ok(recent.indexOf(NOWHERE) > recent.indexOf('aria-label="Play MY HEAD"'), 'under the recent row');
  const old = playingHome(true, { ...ready, notice: { where: 'now:pause', trouble: { kind: 'restart' } } });
  assert.equal(times(old, 'Spotify needs the house restarted once.'), 1, 'the old house says so once, by the controls');
  assert.match(old, /aria-label="Pause"/, 'and the controls stay');
});

test('the phone opens it from the drawer', () => {
  const shell = read('../App.tsx');
  assert.match(shell, /\| 'spotify'/);
  assert.match(shell, /osState === 'spotify' && \(\s*<SpotifyApp/);
  assert.match(read('../lib/apps.ts'), /\{ id: SPOTIFY_APP_ID, name: 'Spotify', icon: Music, category: 'Tools', kind: 'screen', screen: 'spotify' \}/);
});

test('search: a box at the top, the songs it found each a tap, and plain words when there are none', () => {
  const draw = (read: Parameters<typeof SearchSection>[0]['read'], searching = false, words = 'rain') =>
    renderToStaticMarkup(createElement(SearchSection, { words, onWords: noop, onSearch: noop, onClear: noop, read, searching, colors, onOpenLink: noop, press: ready }));
  const empty = draw(null, false, '');
  assert.match(empty, /<form[^>]*role="search"/, 'a search box');
  const box = empty.match(/<input\b[^>]*>/)?.[0] ?? '';
  assert.match(box, /aria-label="Search Spotify"/, 'one search field');
  assert.match(box, /maxLength="100"/, 'that holds a hundred letters');
  assert.match(empty, /<button[^>]*type="submit"[^>]*aria-label="Search"[^>]*disabled=""/, 'with nothing typed, nothing to press');
  assert.doesNotMatch(empty, /Clear the search/, 'and nothing to clear');

  const found = draw({ ok: true, data: { query: 'rain', tracks: [
    { name: 'Rain', artist: 'Sleep Token', uri: SONG, cover: 'https://i.scdn.co/image/sundowning', albumUri: 'spotify:album:1ghzdXKc5kfvQbSpUgDpRS' },
    { name: 'An Episode', artist: '', uri: EPISODE, cover: null },
  ] } });
  assert.match(found, /<button[^>]*aria-label="Play Rain"/, 'a found song is a tap');
  assert.doesNotMatch(found, /aria-label="Play An Episode"/, 'an episode is not');
  assert.match(found, /src="https:\/\/i\.scdn\.co\/image\/sundowning"/, 'with its cover');
  assert.match(found, /aria-label="Clear the search"/, 'and a way to clear it');

  assert.match(draw({ ok: true, data: { query: 'zzzz', tracks: [] } }), /Nothing found for “zzzz”\./, 'nothing found, said plainly');
  assert.match(draw({ ok: false, trouble: { kind: 'restart' } }), /Spotify needs the house restarted once\./, 'an old house asks for the restart');
  assert.match(draw(null, true), /animate-spin/, 'a search out turns its button');

  const page = renderToStaticMarkup(createElement(SpotifyHomeView, {
    home: { now: { ok: true, data: { playing: false, track: null } }, recent: RECENT, playlists: LISTS },
    colors, onOpenPlaylist: noop, onOpenLink: noop, search: createElement('div', { id: 'the-search' }),
  }));
  assert.ok(page.indexOf('the-search') >= 0 && page.indexOf('the-search') < page.indexOf('Now playing'), 'the search sits above what is playing');
});
