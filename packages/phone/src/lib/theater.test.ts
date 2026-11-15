import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS } from './apps';
import {
  canTryAnother,
  captionAt,
  episodeLabel,
  formatClock,
  formatDuration,
  mouthLine,
  parseClockInput,
  projectPosition,
  scrubLength,
  isSubtitleMatch,
  matchLine,
  subtitleLine,
  subtitleSearchQuery,
  handoffDelay,
  HANDOFF_LINGER_MS,
  HANDOFF_MAX_WAIT_MS,
  earLine,
  isEarPairing,
  minutesLeft,
  pairingCodeLabel,
  startNightBody,
} from './theater';

const here = dirname(fileURLToPath(import.meta.url));

test('the clock runs on from the reading, and holds when paused', () => {
  assert.equal(projectPosition({ position: 100, paused: false }, 1000, 6000), 105);
  assert.equal(projectPosition({ position: 100, paused: true }, 1000, 60_000), 100);
  assert.equal(projectPosition({ position: -3, paused: true }, 0, 0), 0);
  assert.equal(formatClock(1421), '00:23:41');
});

test('her typed TV time', () => {
  assert.equal(parseClockInput('23:41'), 1421);
  assert.equal(parseClockInput('1:02:03'), 3723);
  assert.equal(parseClockInput('90'), 90);
  assert.equal(parseClockInput('1:75'), null);
  assert.equal(parseClockInput('soon'), null);
});

test('the caption never runs ahead of the clock', () => {
  const cues = [{ start: 1, end: 2, text: 'a' }, { start: 5, end: 6, text: 'b' }, { start: 9, end: 10, text: 'c' }];
  assert.deepEqual(captionAt(cues, 5).map((c) => c.text), ['a', 'b']);
  assert.deepEqual(captionAt(cues, 0.5), []);
  assert.equal(scrubLength(cues, 0), 600);
});

test('labels', () => {
  assert.equal(episodeLabel({ season: 1, episode: 3 }), 'S1 · E3');
  assert.equal(episodeLabel({ season: null, episode: null }), '');
  assert.equal(formatDuration(30), 'under a minute');
  assert.equal(formatDuration(4320), '1h 12m');
  assert.equal(formatDuration(2700), '45m');
});

test('the Theater is an app tile and a screen', () => {
  const tile = APPS.find((a) => a.id === 'theater');
  assert.ok(tile);
  assert.equal(tile.category, 'Companion');
  assert.equal(tile.screen, 'theater');
  const app = readFileSync(join(here, '..', 'App.tsx'), 'utf8');
  assert.match(app, /\| 'theater'/);
  assert.match(app, /osState === 'theater' && \(\s*<TheaterApp/);
});

test('the "they\'re watching" line', () => {
  const night = { mouthOn: true, cueCount: 12 } as any;
  const clock = { position: 0, label: '', paused: false, started: true, readAt: 0 };
  assert.equal(mouthLine({ night, clock, mouth: { houseOn: true, armed: true } }), "They're watching");
  assert.equal(mouthLine({ night, clock, mouth: { houseOn: true, armed: false } }), null, 'paused');
  assert.equal(mouthLine({ night: { ...night, mouthOn: false }, clock, mouth: { houseOn: true, armed: false } }), null);
  assert.match(mouthLine({ night: { ...night, cueCount: 0 }, clock, mouth: { houseOn: true, armed: false } })!, /Load subtitles/);
  assert.match(mouthLine({ night, clock, mouth: { houseOn: false, armed: false } })!, /switched off in the house/);
  assert.equal(mouthLine({ night, clock }), null, 'an older house says nothing');
});

test('subtitles: the start form searches once there is something to search; Try another only on found files with others left', () => {
  assert.equal(subtitleSearchQuery('', '2', '7'), null);
  assert.equal(subtitleSearchQuery('Lucifer', '2', ''), null, 'half an episode waits for the other half');
  assert.equal(subtitleSearchQuery('Lucifer', '', '7'), null);
  assert.equal(subtitleSearchQuery(' Lucifer ', '2', '7'), 'title=Lucifer&season=2&episode=7');
  assert.equal(subtitleSearchQuery('The Long Night', '', ''), 'title=The+Long+Night', 'a movie');
  assert.equal(matchLine({ best: { fileId: 1, label: 'Lucifer S02E07 · HDTV.x264-LOL', release: 'HDTV.x264-LOL' }, count: 4 }), 'Found: Lucifer S02E07 · HDTV.x264-LOL');
  assert.equal(matchLine({ best: null, count: 0 }), 'No subtitles found, you can load a file');
  assert.equal(isSubtitleMatch({ best: null, count: 0 }), true);
  assert.equal(isSubtitleMatch({ error: 'x' }), false);

  const found = { cueCount: 10, subtitleSource: 'opensubtitles' as const, subtitleOthers: 2, subtitleName: 'Harbor.S01E03.WEB' };
  assert.equal(canTryAnother(found), true);
  assert.equal(canTryAnother({ ...found, subtitleOthers: 0 }), false);
  assert.equal(canTryAnother({ ...found, subtitleSource: 'upload' }), false);
  assert.equal(subtitleLine(found), 'Found: Harbor.S01E03.WEB');
  assert.equal(subtitleLine({ ...found, subtitleSource: 'upload', subtitleName: 'mine.srt' }), 'Subtitles: mine.srt');
  assert.equal(subtitleLine({ ...found, cueCount: 0 }), 'No subtitles yet');
});

test('an ended night hands off by itself: at once, or after their reply when it moved on to the next episode', () => {
  const idle = { state: 'idle' as const, note: null, at: '' };
  const waiting = { ...idle, state: 'waiting' as const };
  assert.equal(handoffDelay({ status: 'live', turn: idle, nextNightId: null }), null, 'a live night stays');
  assert.equal(handoffDelay({ status: 'ended', turn: idle }), 0, 'ended elsewhere: move on now');
  assert.equal(handoffDelay({ status: 'ended', turn: idle, nextNightId: 'n2' }), HANDOFF_LINGER_MS, 'their reply landed: a moment to read it');
  assert.equal(handoffDelay({ status: 'ended', turn: waiting, nextNightId: 'n2' }), HANDOFF_MAX_WAIT_MS, 'still answering: wait, but not forever');
});

test('the start form: on the TV it downloads the match, on the computer it never does', () => {
  const form = { title: 'Harbor', season: '2', episode: '', mode: 'tv' as const, chatty: 40, noSpoilers: true, matchFileId: 77 };
  assert.deepEqual(startNightBody(form), { title: 'Harbor', season: '2', episode: null, mode: 'tv', chatty: 40, noSpoilers: true, mouthOn: true, subtitleFileId: 77 });
  assert.equal(startNightBody({ ...form, mouthOn: false }).mouthOn, false, '"Let them react" off rides along from the start form');
  assert.equal(startNightBody({ ...form, mode: 'computer' }).mode, 'computer');
  assert.equal(startNightBody({ ...form, mode: 'computer' }).subtitleFileId, null);
  const app = readFileSync(join(here, '..', 'components', 'TheaterApp.tsx'), 'utf8');
  assert.doesNotMatch(app, /mode: 'tv'/, 'the form sends the mode she picked');
  assert.match(app, /startNightBody\(/);
  assert.match(app, /On the computer/);
});

test('the Ear: its line, its code, and how long the code lasts', () => {
  assert.equal(earLine(null), 'The Ear is not connected yet');
  assert.equal(earLine({ paired: false, listening: false }), 'The Ear is not connected yet');
  assert.equal(earLine({ paired: true, listening: false }), 'Waiting for the Ear…');
  assert.equal(earLine({ paired: true, listening: true }), 'The Ear is listening');
  assert.equal(pairingCodeLabel('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(minutesLeft(new Date(10 * 60_000).toISOString(), 0), 10);
  assert.equal(minutesLeft(new Date(61_000).toISOString(), 0), 2);
  assert.equal(minutesLeft(new Date(0).toISOString(), 5), 0);
  assert.equal(isEarPairing({ paired: false, listening: false }), true);
  assert.equal(isEarPairing({ error: 'x' }), false);
  const computer = { mouth: { houseOn: true, armed: false }, clock: { position: 0, label: '', paused: false, started: true, readAt: 0 } };
  const night = { cueCount: 0, mode: 'computer' as const, mouthOn: true } as any;
  assert.equal(mouthLine({ ...computer, night }), 'Once the Ear hears some lines they can react on their own.');
  assert.equal(mouthLine({ ...computer, night: { ...night, mode: 'tv' } }), 'Load subtitles and they can react on their own.');
});
