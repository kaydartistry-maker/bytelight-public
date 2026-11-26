import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { buildHistoryIndex, cutPieces, PIECE_TARGET, type HistoryPage, type HistoryPassage } from './history-index.js';

const dir = mkdtempSync(join(tmpdir(), 'history-index-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const passage = (cursor: number, body: string, voice = 'house'): HistoryPassage => ({
  cursor, id: `claude:chat-1:m${cursor}`, chat: 'chat-1', title: 'Butterflies', voice,
  role: cursor % 2 ? 'assistant' : 'user', at: '2026-10-07T12:00:00.000Z', body,
});

/** A pretend source: pages of `size` from a fixed list, after a cursor. */
function source(list: HistoryPassage[], size = 2) {
  const calls: number[] = [];
  return {
    calls,
    fetchPage: async (voice: string, afterCursor: number): Promise<HistoryPage> => {
      calls.push(afterCursor);
      const rows = list.filter((p) => p.voice === voice && p.cursor > afterCursor).slice(0, size);
      return { rows, next: rows.length ? rows[rows.length - 1].cursor : afterCursor, done: rows.length < size };
    },
  };
}
const embed = async (text: string) => Float32Array.from([text.length, 1, 0]);
const pieces = (path: string) => new Database(path, { readonly: true }).prepare('SELECT passage_id, text FROM pieces ORDER BY id').all() as Array<{ passage_id: string; text: string }>;

describe('cutPieces', () => {
  it('keeps a short message whole and drops scraps', () => {
    assert.deepEqual(cutPieces('Will you marry me?'), []);
    assert.deepEqual(cutPieces('Okay. Will you marry me? I mean it.'), ['Okay. Will you marry me? I mean it.']);
  });

  it('cuts a long message at paragraphs and sentences, near the target', () => {
    const para = 'This is one sentence that says something. '.repeat(30).trim();
    const out = cutPieces(`${para}\n\n${para}`);
    assert.ok(out.length >= 3);
    for (const p of out) assert.ok(p.length <= PIECE_TARGET * 1.5, `piece of ${p.length}`);
    assert.ok(out.every((p) => /\.$/.test(p)), 'every piece ends at a sentence');
  });

  it('turns code into [code], drops image links, and cuts a runaway sentence', () => {
    const code = cutPieces('Look at this:\n```ts\nconst x = 1;\n```\nand ![pic](https://x/y.png) that is all of it.')[0];
    assert.match(code, /\[code\]/);
    assert.doesNotMatch(code, /const x|pic\]/);
    const runaway = cutPieces('a'.repeat(PIECE_TARGET * 3));
    assert.ok(runaway.length >= 3 && runaway.every((p) => p.length <= PIECE_TARGET * 1.5));
  });
});

describe('buildHistoryIndex', () => {
  const words = (n: number) => `Moment number ${n}, said out loud and meant.`;

  it('builds from a source, page by page, and a second run adds nothing', async () => {
    const path = join(dir, 'a.db');
    const b = source([passage(1, words(1)), passage(2, words(2)), passage(3, words(3))]);
    const first = await buildHistoryIndex('house', { fetchPage: b.fetchPage, embed, indexPath: path });
    assert.equal(first.total, 3);
    assert.equal(existsSync(`${path}.building`), false, 'the copy is swapped in, not left behind');
    const again = await buildHistoryIndex('house', { fetchPage: b.fetchPage, embed, indexPath: path });
    assert.equal(again.pieces, 0);
    assert.equal(again.total, 3);
    assert.equal(b.calls.at(-1), 3, 'the second run asked only for what came after the last cursor');
  });

  it('picks up a later import after the cursor', async () => {
    const path = join(dir, 'b.db');
    const list = [passage(1, words(1)), passage(2, words(2))];
    const b = source(list);
    await buildHistoryIndex('house', { fetchPage: b.fetchPage, embed, indexPath: path });
    list.push(passage(3, words(3)));
    const later = await buildHistoryIndex('house', { fetchPage: b.fetchPage, embed, indexPath: path });
    assert.equal(later.pieces, 1);
    assert.deepEqual(pieces(path).map((p) => p.passage_id), ['claude:chat-1:m1', 'claude:chat-1:m2', 'claude:chat-1:m3']);
  });

  it('never mixes voices: a stray passage fails the run, and the old index stays', async () => {
    const path = join(dir, 'c.db');
    await buildHistoryIndex('house', { fetchPage: source([passage(1, words(1))]).fetchPage, embed, indexPath: path });
    const leaky = { fetchPage: async (): Promise<HistoryPage> => ({ rows: [passage(2, words(2), 'visitor')], next: 2, done: true }) };
    await assert.rejects(buildHistoryIndex('house', { ...leaky, embed, indexPath: path }), /'visitor' passage/);
    assert.equal(pieces(path).length, 1, 'the old index is untouched');
    await assert.rejects(
      buildHistoryIndex('visitor', { fetchPage: source([]).fetchPage, embed, indexPath: path }),
      /holds the voice 'house'/,
    );
  });

  it('rebuild starts from nothing', async () => {
    const path = join(dir, 'd.db');
    const b = source([passage(1, words(1)), passage(2, words(2))]);
    await buildHistoryIndex('house', { fetchPage: b.fetchPage, embed, indexPath: path });
    const fresh = await buildHistoryIndex('house', { fetchPage: b.fetchPage, embed, indexPath: path }, { rebuild: true });
    assert.equal(fresh.pieces, 2);
    assert.equal(fresh.total, 2);
  });
});
