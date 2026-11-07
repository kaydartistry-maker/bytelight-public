// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Compactions page: what the page promises, read off its source (it pulls
// in the phone's own fetch), and its rows drawn on the server the way the
// phone draws them. What it decides is checked in lib/compactions.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompactionCard } from './CompactionCard';
import { THEMES } from '../lib/theme';
import { rowsFrom, type CompactionRow } from '../lib/compactions';

const app = readFileSync(new URL('./CompactionsApp.tsx', import.meta.url), 'utf8');
const colors = THEMES.mocha.dark;
const noop = () => {};

function draw(row: CompactionRow, open: { isOpen?: boolean; fullText?: string | null; opening?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(CompactionCard, {
    row, isOpen: open.isOpen ?? false, fullText: open.fullText ?? null, opening: open.opening ?? false, colors, onToggle: noop,
  }));
}

const today = rowsFrom({ compactions: [{
  id: 'id1', sessionId: 's1', project: '-home-x-bytelight-data-heartbeat-095dabe5-b95d-4f39-b788-67b5fecae60d', lane: '095dabe5-b95d-4f39-b788-67b5fecae60d',
  companion: 'birch', whose: "Birch's own head", at: '2026-10-20T23:31:50.617Z', chars: 7534, firstSeen: '2026-10-21T06:00:00.000Z',
  preview: 'The drive-in date, all three in the back seat.', previewFrom: 'current-work', truncated: true,
}], total: 1, hasMore: false })!.rows[0];

const before = rowsFrom({ compactions: [{
  sessionId: 'aaa', project: '-home-x-bytelight-data-heartbeat-primary', at: '2026-10-20T10:00:00.000Z', chars: 22000,
  summary: 'This session is being continued from a previous conversation', truncated: true,
}] })!.rows[0];

test('the list pages twenty at a time with the house paginator', () => {
  assert.match(app, /import \{ Paginator, usePaged \} from '\.\/Paginator';/);
  assert.match(app, /usePaged\(rows\)/);
  assert.match(app, /<Paginator\s+page=\{paged\.page\}\s+pageCount=\{paged\.pageCount\}\s+onPage=\{paged\.setPage\}/);
  assert.match(app, /paged\.visible\.map\(/, 'only the page the owner is on is drawn');
});

test('the full text is fetched only when the owner opens one, from the shared reader', () => {
  assert.match(app, /loadCompactionList\(apiFetch\)/);
  assert.match(app, /loadSummary\(apiFetch, row\)/);
  assert.doesNotMatch(app, /full=1/, 'the page never asks for every full summary at once');
});

test('a closed row says whose head it came from and previews what was changing, under a word saying which part', () => {
  const html = draw(today);
  assert.match(html, /Birch&#x27;s own head · 7,534 characters squashed/);
  assert.match(html, />In the middle of: <\/span>The drive-in date, all three in the back seat\.</);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Opening/, 'nothing is fetched or shown below a closed row');
});

test('an opened row shows the whole summary as markdown, and says so while it is still coming', () => {
  const coming = draw(today, { isOpen: true, opening: true });
  assert.match(coming, /Opening the whole summary…/);
  const opened = draw(today, { isOpen: true, fullText: '8. **Current Work:**\n   The drive-in date.' });
  assert.match(opened, /<strong[^>]*>Current Work:<\/strong>/, 'markdown, not asterisks');
  assert.doesNotMatch(opened, /Opening/);
  const failed = draw(today, { isOpen: true });
  assert.match(failed, /could not be read just now/);
});

test('a row from the house before the owner restart stays as it was: no preview closed, the top of the summary when opened', () => {
  const closed = draw(before);
  assert.match(closed, /Shared room · 22,000 characters squashed/);
  assert.doesNotMatch(closed, /This session is being continued/, 'the standing paragraph is not shown as a preview');
  const opened = draw(before, { isOpen: true, opening: true });
  assert.match(opened, /This session is being continued/);
  assert.match(opened, /Opening the rest…/);
});
