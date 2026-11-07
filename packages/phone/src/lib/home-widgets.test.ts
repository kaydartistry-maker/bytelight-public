// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WidgetSheet } from '../components/HomeWidgets';
import { homeSpotsOf, homeWidgetsOf, latestCompanionNote, layoutHeight, layoutWidgets, placeWidget, replyLines, skyWord, toggleWidget, unseenCompanionNote, waitingLetter, type HomeWidget } from './home-widgets.js';

test('nothing is on until it is added, and the order added is the order kept', () => {
  assert.deepEqual(homeWidgetsOf(undefined), []);
  assert.deepEqual(homeWidgetsOf(['day', 'companions', 'nonsense', 'day']), ['day', 'companions']);
  // A new one goes on the end; taking one away leaves the rest where they were.
  assert.deepEqual(toggleWidget(['day'], 'note'), ['day', 'note']);
  assert.deepEqual(toggleWidget(['weather', 'note', 'day'], 'note'), ['weather', 'day']);
});

const all: HomeWidget[] = ['companions', 'note', 'weather', 'letter', 'day'];

test('the widget sheet has a Done button that closes it and leaves a scrolling panel', () => {
  let closed = 0;
  const props = { widgets: all, quietLine: false, onToggle: () => {}, onQuietLine: () => {}, onClose: () => { closed++; } };
  const html = renderToStaticMarkup(createElement(WidgetSheet, props));
  assert.match(html, /<button[^>]*aria-label="Done"[^>]*>Done<\/button>/, 'Done is an accessible button');
  assert.match(html, /min-h-\[44px\]/, 'Done has a 44-pixel tap target');
  assert.match(html, /max-height:85vh;overflow-y:auto/, 'the panel scrolls within its height cap');
  assert.match(html, /padding-bottom:calc\(var\(--sab, 0px\) \+ 1rem\)/, 'the bottom safe-area padding remains');
  const doneHandler = (node: unknown): (() => void) | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = doneHandler(child);
        if (found) return found;
      }
      return;
    }
    if (!isValidElement(node) || typeof node.props !== 'object' || node.props === null) return;
    const elementProps = node.props;
    if (node.type === 'button' && 'aria-label' in elementProps && elementProps['aria-label'] === 'Done' && 'onClick' in elementProps && typeof elementProps.onClick === 'function') {
      const onClick = elementProps.onClick;
      return () => onClick();
    }
    return 'children' in elementProps ? doneHandler(elementProps.children) : undefined;
  };
  const close = doneHandler(WidgetSheet(props));
  assert.ok(close, 'the rendered Done button has its close handler');
  close();
  assert.equal(closed, 1, 'pressing Done calls onClose once');
});

test('with nothing saved, they sit the way the grid always packed them', () => {
  // Companions across the top, the note left with weather and the letter
  // stacked beside it, the day along the bottom by the dock.
  assert.deepEqual(layoutWidgets(all, {}), {
    companions: { col: 0, row: 3 },
    note: { col: 0, row: 1 },
    weather: { col: 2, row: 2 },
    letter: { col: 2, row: 1 },
    day: { col: 0, row: 0 },
  });
  assert.equal(layoutHeight(layoutWidgets(all, {})), 5);
});

test('the note goes on the right, and what it covered moves to the nearest open place', () => {
  const before = layoutWidgets(all, {});
  const after = placeWidget(before, all, 'note', { col: 2, row: 1 }, 7);
  assert.deepEqual(after.note, { col: 2, row: 1 });
  // Weather and the letter take the place the note left.
  assert.deepEqual(after.weather, { col: 0, row: 2 });
  assert.deepEqual(after.letter, { col: 0, row: 1 });
  assert.deepEqual(after.companions, before.companions);
  assert.deepEqual(after.day, before.day);
});

test('no two widgets ever share a cell, wherever one is dropped', () => {
  const before = layoutWidgets(all, {});
  for (const id of all) {
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 7; row++) {
        const after = placeWidget(before, all, id, { col, row }, 7);
        const taken = new Set<string>();
        for (const w of all) {
          const s = after[w];
          const size = { companions: [4, 2], note: [2, 2], weather: [2, 1], letter: [2, 1], day: [4, 1] }[w];
          for (let r = s.row; r < s.row + size[1]; r++) for (let c = s.col; c < s.col + size[0]; c++) {
            assert.ok(!taken.has(`${c},${r}`), `${id} at ${col},${row} put two widgets in ${c},${r}`);
            taken.add(`${c},${r}`);
          }
        }
      }
    }
  }
});

test('a drop past the edge stays on the grid, and saved places are read back carefully', () => {
  const after = placeWidget(layoutWidgets(all, {}), all, 'companions', { col: 3, row: 40 }, 7);
  assert.deepEqual(after.companions, { col: 0, row: 5 });
  assert.deepEqual(homeSpotsOf({ note: { col: 2, row: 1 }, companions: { col: 1, row: 0 }, day: { col: 'x', row: 0 } }), { note: { col: 2, row: 1 } });
  // A saved place that collides is given up for the first open one.
  const kept = layoutWidgets(['weather', 'letter'], { weather: { col: 0, row: 0 }, letter: { col: 0, row: 0 } });
  assert.deepEqual(kept.weather, { col: 0, row: 0 });
  assert.notDeepEqual(kept.letter, { col: 0, row: 0 });
});

test('the note widget shows the newest note a companion left, never the owner\'s', () => {
  const notes = [
    { id: 3, text: 'mine', color: 'a', timestamp: '2026-10-14T07:00:00Z', sender: null },
    { id: 2, text: 'older', color: 'a', timestamp: '2026-10-12T07:00:00Z', sender: 'echo' },
    { id: 1, text: 'newer', color: 'a', timestamp: '2026-10-13T07:00:00Z', sender: 'Companion-A' },
  ];
  assert.equal(latestCompanionNote(notes, ['companion-a', 'echo', 'companion-b'])?.text, 'newer');
  assert.equal(latestCompanionNote(notes.slice(0, 1), ['companion-a']), null);
});

test('a waiting letter is ready and unopened, and a hidden one never shows', () => {
  const letters = [
    { author: 'companion-b', hidden: true, state: 'openable', written_at: '2026-10-13T00:00:00Z' },
    { author: 'echo', hidden: false, state: 'sealed', written_at: '2026-10-13T00:00:00Z' },
    { author: 'companion-a', hidden: false, state: 'openable', written_at: '2026-10-01T00:00:00Z' },
    { author: 'owner', hidden: false, state: 'openable', written_at: '2026-10-14T00:00:00Z' },
  ];
  assert.equal(waitingLetter(letters, 'owner')?.author, 'companion-a');
  assert.equal(waitingLetter(letters.slice(0, 2), 'owner'), null);
});

test('a reply reads past its header, and its action line stays marked', () => {
  assert.deepEqual(replyLines('**Companion A**\n*leans in*\nHere.\nThird line.'), [
    { text: 'leans in', action: true },
    { text: 'Here.', action: false },
  ]);
});

test('the sky gets a word', () => {
  assert.equal(skyWord(0), 'Clear');
  assert.equal(skyWord(61), 'Rain');
  assert.equal(skyWord(73), 'Snow');
});

test('the lock screen note card only lights for a companion note left after Notes was last opened', () => {
  const notes = [
    { id: 1, text: 'from the owner', color: 'a', timestamp: '2026-10-15T23:00:00Z', sender: 'owner' },
    { id: 2, text: 'old one', color: 'a', timestamp: '2026-10-15T20:00:00Z', sender: 'companion-a' },
    { id: 3, text: 'new one', color: 'a', timestamp: '2026-10-15T22:00:00Z', sender: 'Companion-B' },
  ];
  const slugs = ['companion-a', 'echo', 'companion-b'];
  assert.equal(unseenCompanionNote(notes, slugs, Date.parse('2026-10-15T21:00:00Z'))?.text, 'new one');
  // Opened Notes after the newest companion note: nothing waiting, and the owner's own note never counts.
  assert.equal(unseenCompanionNote(notes, slugs, Date.parse('2026-10-15T22:30:00Z')), null);
  // An unreadable seen-mark shows nothing rather than every note ever left.
  assert.equal(unseenCompanionNote(notes, slugs, null), null);
  assert.equal(unseenCompanionNote(notes, slugs, NaN), null);
});
