// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// What the Compactions page decides, checked without a browser: how it reads
// the house's answer (today's and the one from before the owner restart), how it
// drains a long list for the page numbers, and where a full summary comes from.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FETCH_SIZE, MAX_FETCHES, laneName, loadCompactions, loadSummary, previewLabel, rowsFrom, type Fetcher,
} from './compactions';

const newRow = (n: number) => ({
  id: `id${n}`, sessionId: `s${n}`, project: '-home-x-bytelight-data-heartbeat-primary', lane: 'primary', companion: null,
  whose: 'Shared room · all three', at: `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`, chars: 1000 + n,
  firstSeen: '2026-10-21T00:00:00.000Z', preview: `What we were doing on day ${n}.`, previewFrom: 'current-work',
});

/** A house that answers from a script, and remembers what it was asked. */
function house(answer: (url: string) => unknown): { fetcher: Fetcher; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetcher: async (url: string) => {
      asked.push(url);
      const body = answer(url);
      return { ok: body !== undefined, json: async () => body } as Response;
    },
  };
}

test('the house of today: each row keeps its id, says whose head it was, and previews what was changing', () => {
  const read = rowsFrom({ compactions: [newRow(1)], total: 1, hasMore: false });
  assert.ok(read);
  assert.equal(read.hasMore, false);
  assert.deepEqual(read.rows[0], {
    key: 'id1', id: 'id1', sessionId: 's1', project: '-home-x-bytelight-data-heartbeat-primary', at: '2026-10-11T00:00:00.000Z',
    chars: 1001, whose: 'Shared room · all three', preview: 'What we were doing on day 1.', previewFrom: 'current-work', cut: false,
  });
});

test('the house from before the owner restart still reads, without the strays from outside the lanes', () => {
  const read = rowsFrom({
    compactions: [
      { sessionId: 'aaa', project: '-home-x-bytelight-data-heartbeat-primary', at: '2026-10-20T10:00:00.000Z', chars: 22000, summary: 'This session is being continued', truncated: true },
      { sessionId: 'bbb', project: '-home-x-bytelight-data-heartbeat-095dabe5-b95d-4f39-b788-67b5fecae60d', at: '2026-10-20T09:00:00.000Z', chars: 7000, summary: 'short', truncated: false },
      { sessionId: 'ccc', project: '-tmp', at: '2026-10-09T06:27:54.996Z', chars: 1929, summary: 'the Archivist', truncated: false },
    ],
  });
  assert.ok(read);
  assert.equal(read.hasMore, false, 'an older house never says there is more, so the page asks once');
  assert.deepEqual(read.rows.map((r) => [r.key, r.id, r.whose, r.preview, r.previewFrom, r.cut]), [
    ['aaa|2026-10-20T10:00:00.000Z', null, 'Shared room', 'This session is being continued', null, true],
    ['bbb|2026-10-20T09:00:00.000Z', null, 'Lane 095dabe5', 'short', null, false],
  ]);
});

test('anything that is not the house\'s list is not read as one', () => {
  assert.equal(rowsFrom(null), null);
  assert.equal(rowsFrom('<!doctype html>'), null);
  assert.equal(rowsFrom({ compactions: 'nope' }), null);
  assert.deepEqual(rowsFrom({ compactions: [null, 4, { at: 3 }] })?.rows, [], 'rows that are not rows are dropped');
});

test('the page drains the whole list, so the page numbers count every squash', async () => {
  const all = Array.from({ length: FETCH_SIZE + 3 }, (_, i) => newRow(i));
  const { fetcher, asked } = house((url) => {
    const offset = Number(new URL(url, 'http://x').searchParams.get('offset'));
    const slice = all.slice(offset, offset + FETCH_SIZE);
    return { compactions: slice, total: all.length, hasMore: offset + slice.length < all.length };
  });
  const rows = await loadCompactions(fetcher);
  assert.equal(rows?.length, all.length);
  assert.deepEqual(asked, [`/api/compactions?limit=${FETCH_SIZE}&offset=0`, `/api/compactions?limit=${FETCH_SIZE}&offset=${FETCH_SIZE}`]);
});

test('an older house is asked once, and a house that always says more is stopped', async () => {
  const old = house(() => ({ compactions: [{ sessionId: 'a', project: '-home-x-bytelight-data-heartbeat-primary', at: 'then', chars: 1, summary: 'x' }] }));
  assert.equal((await loadCompactions(old.fetcher))?.length, 1);
  assert.equal(old.asked.length, 1);

  const endless = house(() => ({ compactions: [newRow(1)], total: 9999, hasMore: true }));
  await loadCompactions(endless.fetcher);
  assert.equal(endless.asked.length, MAX_FETCHES);
});

test('a first answer that is not the house\'s is a failure, not an empty page', async () => {
  assert.equal(await loadCompactions(house(() => '<!doctype html>').fetcher), null);
  assert.equal(await loadCompactions(house(() => undefined).fetcher), null);
});

test('a full summary comes from its own address, or the old way from a house that has none', async () => {
  const today = house((url) => (url === '/api/compactions/id7' ? { compaction: { ...newRow(7), summary: 'the whole text' } } : undefined));
  const [row] = rowsFrom({ compactions: [newRow(7)], hasMore: false })!.rows;
  assert.equal(await loadSummary(today.fetcher, row), 'the whole text');
  assert.deepEqual(today.asked, ['/api/compactions/id7']);

  const before = house(() => ({ compactions: [
    { sessionId: 'aaa', project: '-home-x-bytelight-data-heartbeat-primary', at: 'then', chars: 9, summary: 'the whole old text' },
  ] }));
  const [oldRow] = rowsFrom({ compactions: [{ sessionId: 'aaa', project: '-home-x-bytelight-data-heartbeat-primary', at: 'then', chars: 9, summary: 'the who', truncated: true }] })!.rows;
  assert.equal(await loadSummary(before.fetcher, oldRow), 'the whole old text');
  assert.deepEqual(before.asked, ['/api/compactions?limit=200&full=1']);

  assert.equal(await loadSummary(house(() => '<html>').fetcher, row), null, 'not the house\'s answer, so nothing');
});

test('the preview says where it came from, in their words', () => {
  assert.equal(previewLabel('current-work'), 'In the middle of');
  assert.equal(previewLabel('next-step'), 'Next up');
  assert.equal(previewLabel('pending-tasks'), 'Still to do');
  assert.equal(previewLabel('tail'), 'Where it ended');
  assert.equal(previewLabel(null), null);
});

test('a lane folder reads as a room', () => {
  assert.equal(laneName('-home-x-bytelight-data-heartbeat-primary'), 'Shared room');
  assert.equal(laneName('-home-x-bytelight-data-heartbeat-095dabe5-b95d-4f39-b788-67b5fecae60d'), 'Lane 095dabe5');
  assert.equal(laneName('-home-x-bytelight-data-heartbeat-fleet-room'), 'Lane fleet room');
});
