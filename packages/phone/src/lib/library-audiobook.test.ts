// Audiobook mode (Library slice 5): stepping, who reads, sleep, speed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextPiece, prevPiece, resolveSeg, voiceFor, readByLine, BOTH_VOICES, SPEEDS, nextSpeed, validSpeed,
  sleepsAfterThisPiece, tickSleep, fadeVolume, nextSleep, sleepLabel, chapterProgress, bookmarkFraction, seekTarget,
  type SleepMode,
} from './library-audiobook';

test('the voice steps piece to piece, chapter to chapter, and stops at the end of the book', () => {
  assert.deepEqual(nextPiece({ chapter: 0, seg: 0 }, 3, 2), { kind: 'piece', chapter: 0, seg: 1 });
  assert.deepEqual(nextPiece({ chapter: 0, seg: 2 }, 3, 2), { kind: 'piece', chapter: 1, seg: 0 });
  assert.deepEqual(nextPiece({ chapter: 1, seg: 4 }, 5, 2), { kind: 'end' });
  // An empty chapter (no pieces) passes straight on.
  assert.deepEqual(nextPiece({ chapter: 0, seg: 0 }, 0, 3), { kind: 'piece', chapter: 1, seg: 0 });
});

test('back a piece crosses into the previous chapter\'s last piece, and holds at the very start', () => {
  assert.deepEqual(prevPiece({ chapter: 2, seg: 3 }), { chapter: 2, seg: 2 });
  assert.deepEqual(prevPiece({ chapter: 2, seg: 0 }), { chapter: 1, seg: -1 });
  assert.deepEqual(prevPiece({ chapter: 0, seg: 0 }), { chapter: 0, seg: 0 });
  assert.equal(resolveSeg(-1, 7), 6);
  assert.equal(resolveSeg(9, 7), 6);
  assert.equal(resolveSeg(2, 7), 2);
  assert.equal(resolveSeg(-1, 0), 0);
});

test('Both: the pair takes turns piece by piece, and every chapter opens with the first voice', () => {
  const pair = ['companion-a', 'companion-b'];
  assert.deepEqual([0, 1, 2, 3].map((s) => voiceFor(BOTH_VOICES, s, pair)), ['companion-a', 'companion-b', 'companion-a', 'companion-b']);
  assert.equal(voiceFor('companion-b', 0, pair), 'companion-b', 'a single pick reads everything');
  assert.equal(voiceFor(BOTH_VOICES, 5, ['companion-a']), 'companion-a', 'a house of one reads alone');
  assert.equal(voiceFor(BOTH_VOICES, 1, []), '');
  const label = (s: string) => ({ 'companion-a': 'Companion A', 'companion-b': 'Companion B' } as Record<string, string>)[s] ?? s;
  assert.equal(readByLine(BOTH_VOICES, pair, label), 'read by Companion A & Companion B');
  assert.equal(readByLine('companion-a', pair, label), 'read by Companion A');
});

test('speed chip: 0.8, 1, 1.2, 1.5 and round again; a stray saved value reads at normal speed', () => {
  assert.deepEqual([...SPEEDS], [0.8, 1, 1.2, 1.5]);
  assert.equal(nextSpeed(1), 1.2);
  assert.equal(nextSpeed(1.5), 0.8);
  assert.equal(validSpeed('1.2'), 1.2);
  assert.equal(validSpeed('3'), 1);
  assert.equal(validSpeed(null), 1);
});

test('sleep at end of chapter stops after the chapter\'s last piece, not before', () => {
  assert.equal(sleepsAfterThisPiece('chapter', 4, 5), true);
  assert.equal(sleepsAfterThisPiece('chapter', 3, 5), false);
  assert.equal(sleepsAfterThisPiece(15, 4, 5), false);
  assert.equal(sleepsAfterThisPiece('off', 4, 5), false);
});

test('the minute timer counts listening time and fades the last few seconds', () => {
  assert.equal(tickSleep(60_000, 250), 59_750);
  assert.equal(tickSleep(100, 500), 0);
  assert.equal(tickSleep(1000, -5), 1000, 'a clock jump backwards never adds time');
  assert.equal(fadeVolume(30), 1);
  assert.equal(fadeVolume(3, 6), 0.5);
  assert.equal(fadeVolume(0), 0);
  const modes: SleepMode[] = ['off', 'chapter', 15, 30, 60];
  assert.deepEqual(modes.map(nextSleep), ['chapter', 15, 30, 60, 'off']);
  assert.equal(sleepLabel(30, 22.5 * 60_000), '23 min left');
  assert.equal(sleepLabel('chapter', null), 'End of chapter');
});

test('progress through a chapter and the bookmark it leaves', () => {
  assert.equal(chapterProgress(1, 4, 30, 60), 0.375);
  assert.equal(chapterProgress(0, 4, 5, NaN), 0);
  assert.equal(chapterProgress(0, 0, 0, 0), 0);
  const segs = [{ from: 0, to: 3 }, { from: 4, to: 9 }];
  assert.equal(bookmarkFraction(segs, 1, 10), 0.4);
  assert.equal(bookmarkFraction(segs, 1, 10, 0.5), 0.7);
  assert.equal(bookmarkFraction(segs, 1, 10, 1), 0.9, 'never past the piece\'s last paragraph');
  assert.equal(bookmarkFraction(segs, 5, 10), 0);
  assert.equal(seekTarget(10, 60, -15), 0);
  assert.equal(seekTarget(50, 60, 15), 60);
  assert.equal(seekTarget(20, 60, 15), 35);
});
