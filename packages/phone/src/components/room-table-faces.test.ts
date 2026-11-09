import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomLines } from './RoomTable';
import { RoomBubbleContext, type RoomBubbleSettings } from './RoomBubble';
import { THEMES } from '../lib/theme';

// The Story Shelf's table, Nov 2026: Companion A and Companion B wore their dice and moon
// at the table while the chat showed their photos. Their shared lane writes
// both voices in one message with the header inline (`**🔷 Companion A —** words`),
// which is not a whole-line header, so the table's own splitter leaves it whole
// and MessageBubble's inline speaker split draws the faces. That split looks
// faces up in the roster it is handed, and the rooms never handed it one, so
// every face fell back to the sigil.

const companions = [
  { slug: 'companion-a', display_name: 'Companion A', avatar_url: '/api/files/companion-a-photo', color: null, emoji: '🔷' },
  { slug: 'companion-b', display_name: 'Companion B', avatar_url: '/api/files/companion-b-photo', color: null, emoji: '🔶' },
];

const settings: RoomBubbleSettings = { themeConfig: THEMES.burgundy, themeMode: 'dark' };

function renderTable(content: string, companionSlug: string | null) {
  return renderToStaticMarkup(
    React.createElement(
      RoomBubbleContext.Provider,
      { value: settings },
      React.createElement(RoomLines, {
        lines: [{ id: 'm1', role: 'companion', content, createdAt: '2026-11-08T12:00:00Z', companionSlug }],
        companions,
      }),
    ),
  );
}

test('the shared lane’s inline headers at the table wear the same photos the chat does', () => {
  const html = renderTable(
    '**🔷 Companion A —** Called dibs on the earpiece.\n\n**🔶 Companion B —** *At the top of the stairs.* Take your time.',
    null,
  );
  assert.match(html, /src="\/api\/files\/companion-a-photo"/, 'Companion A’s photo, not his dice');
  assert.match(html, /src="\/api\/files\/companion-b-photo"/, 'Companion B’s photo, not his moon');
});

test('whole-line headers at the table still split into photo bubbles', () => {
  const html = renderTable('**🔷 Companion A**\nHi.\n\n**🔶 Companion B**\nEvening.', null);
  assert.match(html, /src="\/api\/files\/companion-a-photo"/);
  assert.match(html, /src="\/api\/files\/companion-b-photo"/);
});
