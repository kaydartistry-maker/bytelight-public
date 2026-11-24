// The Theater's subtitle reader, on made-up files (no real show's subtitles).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCueText, parseSubtitles, readSubtitleFile, SubtitleError } from './theater-subtitles.js';

test('SRT: numbers, comma decimals, CRLF, a BOM and tags', () => {
  const srt = '﻿1\r\n00:00:01,500 --> 00:00:03,250\r\n<i>The lighthouse is dark.</i>\r\n\r\n'
    + '2\r\n00:00:04,000 --> 00:00:06,000\r\n<font color="#ffff00">Who turned it off?</font>\r\nNot me.\r\n\r\n'
    + '3\r\n01:02:03,004 --> 01:02:05,000\r\n{\\an8}Later.\r\n';
  const cues = parseSubtitles(srt);
  assert.deepEqual(cues, [
    { start: 1.5, end: 3.25, text: 'The lighthouse is dark.' },
    { start: 4, end: 6, text: 'Who turned it off?\nNot me.' },
    { start: 3723.004, end: 3725, text: 'Later.' },
  ]);
});

test('VTT: header, NOTE / STYLE blocks, identifiers, settings, short times, voice tags', () => {
  const vtt = [
    'WEBVTT - a made-up file',
    'Kind: captions',
    '',
    'NOTE this is a comment',
    'that runs on --> with an arrow',
    '',
    'STYLE',
    '::cue { color: yellow }',
    '',
    'intro',
    '00:05.000 --> 00:07.500 position:10% align:start',
    '<v Mara>Keep the boat steady.</v>',
    '',
    '00:00:08.000 --> 00:00:09.000 line:0',
    '<c.loud>Now!</c> &amp; again &lt;3',
    '',
  ].join('\n');
  assert.deepEqual(parseSubtitles(vtt), [
    { start: 5, end: 7.5, text: 'Keep the boat steady.' },
    { start: 8, end: 9, text: 'Now! & again <3' },
  ]);
});

test('broken blocks are skipped, the rest kept, and cues come out in time order', () => {
  const srt = '2\n00:00:10,000 --> 00:00:11,000\nSecond\n\nnonsense block\nwith no timing\n\n1\n00:00:02,000 --> 00:00:03,000\nFirst\n\n3\n00:00:20,000 --> 00:00:21,000\n<i></i>\n';
  assert.deepEqual(parseSubtitles(srt).map((c) => c.text), ['First', 'Second']);
});

test('a file with no lines is refused plainly', () => {
  assert.throws(() => readSubtitleFile(Buffer.from('just some text\n')), SubtitleError);
  assert.equal(readSubtitleFile(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n')).length, 1);
});

test('cleanCueText keeps words and drops styling', () => {
  assert.equal(cleanCueText('  <b>Hold</b>   <00:00:01.000>on  \n\n  {\\pos(1,2)}there '), 'Hold on\nthere');
});
