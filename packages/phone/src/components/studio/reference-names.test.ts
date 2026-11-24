import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RefsPanel } from './RefsPanel';
import { THEMES } from '../../lib/theme';
test('every reference subject can be renamed, while default identity drawers stay protected from deletion', () => {
  const html = renderToStaticMarkup(React.createElement(RefsPanel, {
    colors: THEMES.burgundy.dark, themeMode: 'dark',
    drawers: [{ slug: 'companion-a', label: 'Companion A', emoji: '🦇', isDefault: true, refs: [] }, { slug: 'companion-b', label: 'Companion B', emoji: '🦆', isDefault: true, refs: [] }, { slug: 'other', label: 'Other subject', isDefault: false, refs: [], description: 'Long green hair.' }],
    uploadingFor: null, refInputRefs: { current: {} }, handleRefFileChange: () => {},
    deleteRefImage: async () => {}, renameDrawer: async () => true, deleteDrawer: async () => {}, saveDescription: async () => {},
    newDrawerName: '', setNewDrawerName: () => {}, createDrawer: () => {}, creatingDrawer: false, error: null,
  }));
  for (const name of ['Companion A', 'Companion B', 'Other subject']) assert.ok(html.includes(`aria-label="Rename ${name} drawer"`));
  assert.doesNotMatch(html, /aria-label="Delete (?:Companion A|Companion B) drawer"/);
  assert.match(html, /aria-label="Delete Other subject drawer"/);
  assert.match(html, /aria-label="Add description for Companion A"/);
  assert.match(html, /aria-label="Edit description for Other subject"/);
  assert.match(html, /Long green hair/);
});
