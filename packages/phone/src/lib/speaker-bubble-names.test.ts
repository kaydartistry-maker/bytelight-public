import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpeakerBubbles, SpeakerSegmentStack, type RosterFace } from '../components/SpeakerBubbles';
import type { ThemeColors, ThemeConfig } from './theme';

const roster: RosterFace[] = [
  { slug: 'companion-a', display_name: 'Companion A', avatar_url: '/companion-a.png', color: '#123456', emoji: '🦇' },
  { slug: 'companion-b', display_name: 'Companion B', avatar_url: '/companion-b.png', color: '#654321', emoji: '🦆' },
  { slug: 'custom-id', display_name: 'Third Companion', avatar_url: null, color: null, emoji: '🌟' },
];
const base = { roster, colors: {} as ThemeColors, textColorClass: '', isLightText: false };

test('mixed speaker bubbles render actual roster names and accessible portrait labels', () => {
  const html = renderToStaticMarkup(React.createElement(SpeakerBubbles, {
    ...base, rows: [{ speaker: 'companion-a', text: 'First line.' }, { speaker: 'companion-b', text: 'Second line.' }],
  }));
  assert.match(html, /title="Companion A"/);
  assert.match(html, /alt="Companion A"/);
  assert.match(html, /title="Companion B"/);
  assert.match(html, /alt="Companion B"/);
  assert.match(html, />Companion A<\/div>/);
  assert.match(html, />Companion B<\/div>/);
  assert.doesNotMatch(html, /Companion [AB]/);
  assert.match(html, /data-speaker="companion-a"/);
  assert.match(html, /data-speaker="companion-b"/);
});

test('arbitrary companion names and IDs are not replaced with resident names', () => {
  const html = renderToStaticMarkup(React.createElement(SpeakerBubbles, {
    ...base, rows: [{ speaker: 'custom-id', text: 'A custom companion.' }],
  }));
  assert.match(html, />Third Companion<\/div>/);
  assert.match(html, /title="Third Companion"/);
});

test('legacy name-tagged rows match their roster identity case-insensitively', () => {
  const html = renderToStaticMarkup(React.createElement(SpeakerBubbles, {
    ...base, rows: [{ speaker: 'COMPANION A', text: 'A name-tagged message.' }],
  }));
  assert.match(html, /alt="Companion A"/);
  assert.doesNotMatch(html, />COMPANION A<\/div>/);
});

test('template names are only a fallback before the roster is available', () => {
  const html = renderToStaticMarkup(React.createElement(SpeakerBubbles, {
    ...base, roster: undefined, rows: [{ speaker: 'companion-a', text: 'Loading.' }, { speaker: 'new-id', text: 'Unknown.' }],
  }));
  assert.match(html, />Companion A<\/div>/);
  assert.match(html, />new-id<\/div>/);
});

test('neutral narration stays unlabelled even when a roster is present', () => {
  const html = renderToStaticMarkup(React.createElement(SpeakerBubbles, {
    ...base, rows: [{ speaker: 'fallback', text: 'Room description.' }],
  }));
  assert.match(html, /Room description/);
  assert.doesNotMatch(html, /title=|>Companion A<|>Companion B<|>fallback</);
});

test('interleaved stored/streamed text rows use the same roster-backed labels', () => {
  const html = renderToStaticMarkup(React.createElement(SpeakerSegmentStack, {
    ...base, rows: [{ kind: 'text', speaker: 'companion-a', text: 'After a tool call.' }],
    themeConfig: {} as ThemeConfig, themeMode: 'dark',
  }));
  assert.match(html, />Companion A<\/div>/);
  assert.doesNotMatch(html, /Companion A/);
});
