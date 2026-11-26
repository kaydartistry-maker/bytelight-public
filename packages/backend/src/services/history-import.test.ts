import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';
import { claudeKeptPath, JsonArraySplitter, readClaudeChat, readExportElements } from './history-readers.js';
import { importStatus, previewExport, resetImportStatus, startImport } from './history-import.js';

const dir = mkdtempSync(join(tmpdir(), 'history-import-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const said = (n: number) => `This is message number ${n}, long enough to be worth keeping as a piece.`;

/** A Claude chat where the last assistant turn was regenerated once (m3 abandoned for m4). */
function claudeChat(uuid: string, createdAt: string) {
  return {
    uuid, name: `Chat ${uuid}`, created_at: createdAt,
    chat_messages: [
      { uuid: `${uuid}-m1`, parent_message_uuid: null, sender: 'human', created_at: `${createdAt.slice(0, 10)}T10:00:00Z`, content: [{ type: 'text', text: said(1) }] },
      { uuid: `${uuid}-m2`, parent_message_uuid: `${uuid}-m1`, sender: 'assistant', created_at: `${createdAt.slice(0, 10)}T10:01:00Z`, content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: said(2) }] },
      { uuid: `${uuid}-m3`, parent_message_uuid: `${uuid}-m2`, sender: 'human', created_at: `${createdAt.slice(0, 10)}T10:02:00Z`, text: 'a draft {that was} "abandoned" ]' },
      { uuid: `${uuid}-m4`, parent_message_uuid: `${uuid}-m2`, sender: 'human', created_at: `${createdAt.slice(0, 10)}T10:03:00Z`, text: said(4) },
    ],
  };
}

const exportJson = JSON.stringify([claudeChat('aaa', '2026-10-07T10:00:00Z'), claudeChat('bbb', '2026-11-02T10:00:00Z')]);

function zipOf(name: string, text: string): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(path, zipSync({ [name]: strToU8(text), 'users.json': strToU8('[]') }));
  return path;
}

function jsonOf(text: string): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, text);
  return path;
}

describe('JsonArraySplitter', () => {
  it('finds each element however the text is cut, with brackets and quotes inside strings', () => {
    const text = '[ {"a":"x]}\\"{"}, {"b":[1,{"c":2}]} ,{"d":"\\\\"} ]';
    for (let size = 1; size <= text.length; size++) {
      const s = new JsonArraySplitter();
      const got: string[] = [];
      for (let i = 0; i < text.length; i += size) got.push(...s.push(text.slice(i, i + size)));
      assert.deepEqual(got.map((g) => JSON.parse(g)), [{ a: 'x]}"{' }, { b: [1, { c: 2 }] }, { d: '\\' }], `cut every ${size}`);
      assert.ok(s.done);
    }
  });

  it('refuses something that is not an array', () => {
    assert.throws(() => new JsonArraySplitter().push('{"a":1}'), /not a JSON array/);
  });
});

describe('reading a Claude export', () => {
  it('keeps the path that was kept and drops the abandoned draft', () => {
    const { path, dropped } = claudeKeptPath(claudeChat('aaa', '2026-10-07T10:00:00Z').chat_messages);
    assert.deepEqual(path.map((m) => m.uuid), ['aaa-m1', 'aaa-m2', 'aaa-m4']);
    assert.equal(dropped, 1);
  });

  it('reads text blocks only, in order, each linked to the one before', () => {
    const chat = readClaudeChat(claudeChat('aaa', '2026-10-07T10:00:00Z'))!;
    assert.deepEqual(chat.lines.map((l) => [l.role, l.text, l.prev]), [
      ['user', said(1), null], ['assistant', said(2), 'aaa-m1'], ['user', said(4), 'aaa-m2'],
    ]);
  });

  it('streams the conversations out of a zip, wherever the file sits in it', async () => {
    const seen: string[] = [];
    await readExportElements(zipOf('data-2026/conversations.json', exportJson), (raw) => seen.push((raw as { uuid: string }).uuid));
    assert.deepEqual(seen, ['aaa', 'bbb']);
  });

  it('reads a bare conversations.json too', async () => {
    const seen: string[] = [];
    await readExportElements(jsonOf(exportJson), (raw) => seen.push((raw as { uuid: string }).uuid));
    assert.deepEqual(seen, ['aaa', 'bbb']);
  });

  it('says so when the zip has no conversations, or the file stops partway', async () => {
    await assert.rejects(readExportElements(zipOf('notes.json', '[]'), () => {}), /no conversations\.json/);
    await assert.rejects(readExportElements(jsonOf(exportJson.slice(0, 200)), () => {}), /ends partway/);
  });
});

describe('preview and import', () => {
  const passagesPath = join(dir, 'passages.db');
  const indexPath = join(dir, 'index.db');
  const embed = async (text: string) => Float32Array.from([text.length, 1, 0]);
  const run = async (path: string, month?: string, removeAfter = false) => {
    await startImport(path, { month }, { embed, passagesPath, indexPath, removeAfter });
    return importStatus();
  };
  beforeEach(() => resetImportStatus());

  it('previews without writing anything', async () => {
    const p = await previewExport(zipOf('conversations.json', exportJson), { month: '2026-10' });
    assert.equal(p.sourceLabel, 'Claude');
    assert.equal(p.readable, true);
    assert.deepEqual([p.chats, p.messages, p.dropped], [1, 3, 1]);
    assert.deepEqual(p.months, { '2026-10': { chats: 1, messages: 3, dropped: 1 }, '2026-11': { chats: 1, messages: 3, dropped: 1 } });
    assert.equal(p.sample[0].title, 'Chat aaa');
    assert.equal(existsSync(passagesPath), false);
  });

  it('names an export it cannot read yet instead of guessing', async () => {
    const gpt = JSON.stringify([{ id: 'c1', title: 'x', mapping: {}, current_node: null }]);
    const p = await previewExport(jsonOf(gpt));
    assert.equal(p.sourceLabel, 'ChatGPT');
    assert.equal(p.readable, false);
    const s = await run(jsonOf(gpt));
    assert.equal(s.state, 'failed');
    assert.match(s.error ?? '', /ChatGPT, which this house cannot read yet/);
  });

  it('imports one month, then the rest, and a repeat adds nothing', async () => {
    const zip = zipOf('conversations.json', exportJson);
    const october = await run(zip, '2026-10');
    assert.equal(october.state, 'done');
    assert.deepEqual([october.chats, october.stored, october.dropped, october.toIndex], [1, 3, 1, 3]);

    const all = await run(zip);
    assert.deepEqual([all.chats, all.stored, all.toIndex], [2, 3, 3]);

    const again = await run(zip);
    assert.deepEqual([again.state, again.stored, again.toIndex, again.pieces], ['done', 0, 0, 0]);

    const idx = new Database(indexPath, { readonly: true });
    const n = (idx.prepare('SELECT count(*) AS n FROM pieces').get() as { n: number }).n;
    const owner = (idx.prepare("SELECT value FROM meta WHERE key = 'voice'").get() as { value: string }).value;
    idx.close();
    assert.equal(n, 6);
    assert.equal(owner, 'house');
  });

  it('removes an upload the house made once it is in, and never a file it was pointed at', async () => {
    const mine = zipOf('conversations.json', exportJson);
    await run(mine, undefined, true);
    assert.equal(existsSync(mine), false);
    const theirs = zipOf('conversations.json', exportJson);
    await run(theirs, undefined, false);
    assert.equal(existsSync(theirs), true);
  });

  it('refuses a second import while one runs', async () => {
    const zip = zipOf('conversations.json', exportJson);
    const first = startImport(zip, {}, { embed, passagesPath, indexPath });
    assert.throws(() => startImport(zip, {}, { embed, passagesPath, indexPath }), /already running/);
    await first;
  });
});
